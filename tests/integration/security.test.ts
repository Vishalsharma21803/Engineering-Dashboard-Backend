import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { purgeExpiredRevocations } from "../../src/services/auth.service.js";
import { getApp, resetDatabase } from "../support/harness.js";

beforeEach(async () => {
  await resetDatabase();
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
  it("blocks an address after 10 failed sign-ins, while successful ones do not count", async () => {
    const app = createApp({ authRateLimit: true, logFailures: false });
    await request(app).post("/api/auth/register").send(account("limit@example.com")).expect(201);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post("/api/auth/login").send({ email: "limit@example.com", password: "password123" }).expect(200);
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app).post("/api/auth/login").send({ email: "limit@example.com", password: "wrong-password" }).expect(401);
    }

    const blocked = await request(app).post("/api/auth/login").send({ email: "limit@example.com", password: "password123" }).expect(429);
    expect(blocked.body).toMatchObject({ reason: "TOO_MANY_REQUESTS" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // 16 bcrypt checks.
  }, 30_000);

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
    failing.mockRestore();
    quiet.mockRestore();
  });
});
