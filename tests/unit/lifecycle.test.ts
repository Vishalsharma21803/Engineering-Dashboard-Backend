import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { beginShutdown, requestsInFlight, resetLifecycleForTests, trackRequests, waitForRequests } from "../../src/lib/lifecycle.js";

afterEach(() => {
  resetLifecycleForTests();
});

/** An app whose requests stay open until released. */
function slowApp() {
  const releases: Array<() => void> = [];
  const app = express();
  app.use(trackRequests);
  app.all("/{*path}", async (_req, res) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    res.json({ ok: true });
  });
  return { app, release: () => releases.splice(0).forEach((release) => release()) };
}

const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("request tracking", () => {
  it("counts each request once (finish and close both fire) and drops back to zero", async () => {
    const app = express();
    app.use(trackRequests);
    app.get("/", (_req, res) => void res.json({ ok: true }));

    await request(app).get("/").expect(200);
    await request(app).get("/").expect(200);
    expect(requestsInFlight()).toEqual({ total: 0, approvals: 0 });
  });

  it("waits for running requests, and gives up after the grace period", async () => {
    const { app, release } = slowApp();
    const running = request(app).get("/work").then((response) => response.status);
    await until(() => requestsInFlight().total === 1);

    expect(await waitForRequests(20)).toBe(false);

    const waiting = waitForRequests(5_000);
    release();
    expect(await waiting).toBe(true);
    expect(await running).toBe(200);
    expect(await waitForRequests(20)).toBe(true);
  });

  it("waits longer while an approval is being applied", async () => {
    const { app, release } = slowApp();
    const running = request(app).post("/api/actions/abc/approve").send({}).then((response) => response.status);
    await until(() => requestsInFlight().approvals === 1);

    const waiting = waitForRequests(10, 5_000);
    // Well past the normal grace period, the approval may still finish.
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();
    expect(await waiting).toBe(true);
    expect(await running).toBe(200);
  });

  it("recognises an approval whatever the letter case, as Express routing does", async () => {
    const { app, release } = slowApp();
    const running = request(app).post("/api/Actions/abc/APPROVE").send({}).then((response) => response.status);
    await until(() => requestsInFlight().total === 1);
    expect(requestsInFlight().approvals).toBe(1);
    release();
    expect(await running).toBe(200);
  });

  it("stops waiting for other requests once the approvals are done", async () => {
    const approvals = slowApp();
    const others = slowApp();
    const approval = request(approvals.app).post("/api/actions/abc/approve").send({}).then((response) => response.status);
    const other = request(others.app).get("/slow").then((response) => response.status);
    await until(() => requestsInFlight().total === 2);

    const waiting = waitForRequests(10, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    approvals.release();
    expect(await approval).toBe(200);
    // The other request is past its grace period: cut off.
    expect(await waiting).toBe(false);
    others.release();
    expect(await other).toBe(200);
  });
});

describe("shutting down", () => {
  it("answers new requests with a readable 503 the browser may read (CORS headers included)", async () => {
    const app = createApp({ authRateLimit: false, logFailures: false });
    beginShutdown();

    const response = await request(app).get("/api/auth/me").set("Origin", "http://localhost:5173").expect(503);
    expect(response.body).toEqual({ message: "Cockpit is restarting. Try again in a moment.", reason: "SERVER_RESTARTING" });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers.connection).toBe("close");
    await request(app).get("/health").expect(503);
  });
});
