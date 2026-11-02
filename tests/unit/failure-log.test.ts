import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendError } from "../../src/controllers/controller-helpers.js";
import { AiProviderError } from "../../src/lib/ai/types.js";
import { logFailedRequests } from "../../src/middleware/failure-log.middleware.js";

function appFailingWith(error: unknown) {
  const app = express();
  app.use(logFailedRequests);
  app.get("/api/fail", (_req, res) => void sendError(res, error, "Doing the thing failed"));
  app.get("/api/ok", (_req, res) => void res.json({ ok: true }));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failed request log", () => {
  it("logs a refused request with what the user was told and the real cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await request(appFailingWith(new AiProviderError("AI_NO_CREDIT", null, null, "Insufficient credits"))).get("/api/fail?token=secret");

    expect(response.status).toBe(402);
    // The user sees the provider's own words too.
    expect(response.body.message).toBe("The AI provider account has no credit left. (Insufficient credits)");
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("402 GET /api/fail");
    expect(line).toContain("Doing the thing failed");
    expect(line).toContain("AI_NO_CREDIT");
    expect(line).toContain("provider said: Insufficient credits");
    // Query strings can carry tokens: never logged.
    expect(line).not.toContain("secret");
  });

  it("logs an unexpected crash as an error with its stack, and tells the user what failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await request(appFailingWith(new TypeError("boom"))).get("/api/fail");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "Doing the thing failed because of an unexpected server error. The details are in the server log.", reason: "INTERNAL_ERROR" });
    expect(String(error.mock.calls[0]?.[0])).toContain("cause: TypeError: boom");
    expect(String(error.mock.calls[1]?.[0])).toContain("TypeError: boom\n");
  });

  it("stays quiet for successful requests", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await request(appFailingWith(null)).get("/api/ok").expect(200);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
