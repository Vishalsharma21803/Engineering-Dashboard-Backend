import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { authRateLimits } from "../../src/middleware/rate-limit.middleware.js";
import { purgeExpiredRevocations } from "../../src/services/auth.service.js";
import { FAKE_ORG_URL, FAKE_PAT } from "../support/fake-azure.js";
import { getApp, installFakeAzure, resetDatabase, signIn } from "../support/harness.js";

const savedEnv = { ...process.env };

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  for (const key of ["NODE_ENV", "SIGNUP_ALLOWED_EMAILS", "SOP_ADMIN_EMAILS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

const account = (email: string) => ({ name: "Sec Tester", email, password: "password123", confirmPassword: "password123" });

describe("security headers", () => {
  it("sends helmet's headers on API responses", async () => {
    const response = await request(getApp()).get("/");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toContain("max-age=");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("sign-in and sign-up limits", () => {
  it("blocks an account from an address after 10 failed sign-ins (successful ones do not count), not other accounts", async () => {
    const app = createApp({ authRateLimit: true, logFailures: false });
    await request(app).post("/api/auth/register").send(account("limit@example.com")).expect(201);
    await request(app).post("/api/auth/register").send(account("colleague@example.com")).expect(201);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post("/api/auth/login").send({ email: "limit@example.com", password: "password123" }).expect(200);
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app).post("/api/auth/login").send({ email: "limit@example.com", password: "wrong-password" }).expect(401);
    }

    const blocked = await request(app).post("/api/auth/login").send({ email: " LIMIT@example.com", password: "password123" }).expect(429);
    expect(blocked.body).toMatchObject({ reason: "TOO_MANY_REQUESTS" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Someone else behind the same address (an office, a proxy) still signs in.
    await request(app).post("/api/auth/login").send({ email: "colleague@example.com", password: "password123" }).expect(200);
    // 17 bcrypt checks.
  }, 30_000);

  it("caps failed sign-ins per address across all accounts", async () => {
    const app = express();
    app.use(express.json());
    app.post("/login", authRateLimits({ perAddressLoginLimit: 3 }).login, (_req, res) => void res.status(401).json({ message: "Invalid email or password" }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).post("/login").send({ email: `spray${attempt}@example.com`, password: "x" }).expect(401);
    }

    const blocked = await request(app).post("/login").send({ email: "spray9@example.com", password: "x" }).expect(429);
    expect(blocked.body.message).toContain("from this network");
  });

  it("refuses a sign-in without a JSON body cleanly (the limiter keys on the address alone)", async () => {
    const app = createApp({ authRateLimit: true, logFailures: false });
    const response = await request(app).post("/api/auth/login").set("Content-Type", "text/plain").send("email=a@example.com").expect(415);
    expect(response.body.reason).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("allows 10 sign-ups an hour from one address", async () => {
    const app = createApp({ authRateLimit: true, logFailures: false });

    for (let index = 0; index < 10; index += 1) {
      await request(app).post("/api/auth/register").send(account(`many${index}@example.com`)).expect(201);
    }

    await request(app).post("/api/auth/register").send(account("one-more@example.com")).expect(429);
  }, 30_000);
});

describe("signing out", () => {
  it("ends that session for good, even for a copied cookie, and leaves other sessions signed in", async () => {
    const app = getApp();
    await request(app).post("/api/auth/register").send(account("out@example.com")).expect(201);
    const signIn = async () => (await request(app).post("/api/auth/login").send({ email: "out@example.com", password: "password123" }).expect(200)).headers["set-cookie"] as unknown as string[];
    const laptop = await signIn();
    const phone = await signIn();

    await request(app).get("/api/auth/me").set("Cookie", laptop).expect(200);
    await request(app).post("/api/auth/logout").set("Cookie", laptop).expect(200);

    const replayed = await request(app).get("/api/auth/me").set("Cookie", laptop).expect(401);
    expect(replayed.body.message).toBe("This session has ended. Sign in again.");
    await request(app).get("/api/auth/me").set("Cookie", phone).expect(200);

    // Signing out without (or with a broken) cookie still works.
    await request(app).post("/api/auth/logout").expect(200);
    await request(app).post("/api/auth/logout").set("Cookie", ["token=not-a-jwt"]).expect(200);

    // Revocations are dropped once the token would have expired anyway.
    expect(await prisma.revokedToken.count()).toBe(1);
    expect(await purgeExpiredRevocations(new Date(Date.now() + 2 * 86_400_000))).toBe(1);
  });

  it("still signs out (clears the cookie) when the revocation cannot be saved", async () => {
    const app = getApp();
    await request(app).post("/api/auth/register").send(account("db-down@example.com")).expect(201);
    const cookie = (await request(app).post("/api/auth/login").send({ email: "db-down@example.com", password: "password123" }).expect(200)).headers["set-cookie"] as unknown as string[];
    const failing = vi.spyOn(prisma.revokedToken, "upsert").mockRejectedValueOnce(new Error("database unavailable"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    expect(String(response.headers["set-cookie"])).toMatch(/token=;/);
    // The user is told that copies of the session were not ended.
    expect(response.body).toMatchObject({ reason: "SESSION_NOT_REVOKED", message: expect.stringContaining("Signed out on this device") });
    failing.mockRestore();
    quiet.mockRestore();
  });

  it("counts a token another logout revoked at the same moment as revoked", async () => {
    const app = getApp();
    await request(app).post("/api/auth/register").send(account("twice@example.com")).expect(201);
    const cookie = (await request(app).post("/api/auth/login").send({ email: "twice@example.com", password: "password123" }).expect(200)).headers["set-cookie"] as unknown as string[];
    // The other logout won the insert: this one's upsert hits the unique key.
    const racing = vi.spyOn(prisma.revokedToken, "upsert").mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on jti"), { code: "P2002" }));

    const response = await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    expect(response.body).toEqual({ message: "Logout successful" });
    racing.mockRestore();
  });
});

describe("who may sign up", () => {
  const register = (email: string) => request(getApp()).post("/api/auth/register").send(account(email));

  it("is closed in production without SIGNUP_ALLOWED_EMAILS (also for existing emails), while existing users still sign in", async () => {
    await register("existing@example.com").expect(201);
    delete process.env.NODE_ENV;
    delete process.env.SIGNUP_ALLOWED_EMAILS;

    const refused = await register("new@example.com").expect(403);
    expect(refused.body).toEqual({ message: "Sign-up is by invitation only. Ask the Relay owner to add your email.", reason: "SIGNUP_NOT_ALLOWED" });
    // No hint whether the address has an account.
    expect((await register("existing@example.com").expect(403)).body.reason).toBe("SIGNUP_NOT_ALLOWED");

    await request(getApp()).post("/api/auth/login").send({ email: "existing@example.com", password: "password123" }).expect(200);
  });

  it("lets in listed addresses, listed domains and SOP owners", async () => {
    process.env.NODE_ENV = "production";
    process.env.SIGNUP_ALLOWED_EMAILS = "invited@example.com, *@team.example.com";
    process.env.SOP_ADMIN_EMAILS = "owner@example.com";

    await register("invited@example.com").expect(201);
    await register("anyone@team.example.com").expect(201);
    await register("owner@example.com").expect(201);
    await register("stranger@example.com").expect(403);
    await register("anyone@other.example.com").expect(403);
    // An invited address that already has an account is told so.
    expect((await register("invited@example.com").expect(409)).body).toEqual({ message: "Email is already registered", reason: "EMAIL_ALREADY_REGISTERED" });
  });

  it("is open outside production when no list is set", async () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    process.env.NODE_ENV = "development";
    await register("dev@example.com").expect(201);
  });

  it("answers two sign-ups with the same email at once with one account and one 409", async () => {
    const statuses = (await Promise.all([register("twice@example.com"), register("twice@example.com")])).map((response) => response.status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { email: "twice@example.com" } })).toBe(1);
  });

  it("marks the sign-in cookie Secure unless NODE_ENV says development or test", async () => {
    await register("cookie@example.com").expect(201);
    const signIn = async () => String((await request(getApp()).post("/api/auth/login").send({ email: "cookie@example.com", password: "password123" }).expect(200)).headers["set-cookie"]);

    expect(await signIn()).not.toMatch(/Secure/);
    delete process.env.NODE_ENV;
    expect(await signIn()).toMatch(/; Secure/);
  });
});

describe("error answers", () => {
  it("answers an unknown API route with JSON", async () => {
    const response = await request(getApp()).get("/api/nope").expect(404);
    expect(response.body).toEqual({ message: "No API endpoint GET /api/nope", reason: "ROUTE_NOT_FOUND" });
  });

  it("leaves routes outside /api added after the app is built alone (the e2e server's test routes)", async () => {
    const app = createApp({ authRateLimit: false, logFailures: false });
    app.post("/__e2e/reset", (_req, res) => res.json({ ok: true }));
    expect((await request(app).post("/__e2e/reset").expect(200)).body).toEqual({ ok: true });
  });

  it("names an unsupported body charset instead of a generic error", async () => {
    const response = await request(getApp()).post("/api/auth/login").set("Content-Type", "application/json; charset=latin9").send('{"email":"a@example.com"}').expect(415);
    expect(response.body).toEqual({ message: "The request body's encoding or charset is not supported", reason: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("answers an unexpected crash with a 500 that says where the details are", async () => {
    const agent = await signIn();
    vi.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(new Error("database unavailable"));

    const response = await agent.put("/api/sop/rulebook").send({ content: "" }).expect(500);
    expect(response.body).toEqual({ message: "The request failed because of an unexpected server error. The details are in the server log.", reason: "INTERNAL_ERROR" });
  });

  it("gives auth and credential failures a reason and says what failed", async () => {
    installFakeAzure();
    await request(getApp()).get("/api/auth/me").expect(401, { message: "Authentication required", reason: "AUTH_REQUIRED" });
    const agent = await signIn("reasons@example.com");
    expect((await request(getApp()).post("/api/auth/login").send({ email: "reasons@example.com", password: "wrong-password" }).expect(401)).body.reason).toBe("INVALID_CREDENTIALS");

    await agent.post("/api/credentials").send({ platform: "AZURE", organizationUrl: FAKE_ORG_URL, patToken: FAKE_PAT }).expect(201);
    const duplicate = await agent.post("/api/credentials").send({ platform: "AZURE", organizationUrl: FAKE_ORG_URL, patToken: FAKE_PAT }).expect(409);
    expect(duplicate.body).toEqual({ message: "A credential for this Azure DevOps organization already exists", reason: "CREDENTIAL_ALREADY_EXISTS" });
    expect((await agent.delete("/api/credentials/aaaaaaaa-0000-4000-8000-00000000dead").expect(404)).body.reason).toBe("CREDENTIAL_NOT_FOUND");

    vi.spyOn(prisma.credential, "findMany").mockRejectedValueOnce(new Error("database unavailable"));
    const failed = await agent.get("/api/credentials").expect(500);
    expect(failed.body).toEqual({ message: "Loading your connections failed because of an unexpected server error. The details are in the server log.", reason: "INTERNAL_ERROR" });
  });
});
