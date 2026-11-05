import { afterEach, describe, expect, it, vi } from "vitest";

import { assertServerConfig, describeMode, isProduction } from "../../src/lib/server-config.js";

const saved = { ...process.env };

afterEach(() => {
  for (const key of ["NODE_ENV", "JWT_SECRET", "FRONTEND_ORIGIN", "SIGNUP_ALLOWED_EMAILS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const LONG_SECRET = "x".repeat(40);

describe("production mode", () => {
  it("is on unless NODE_ENV says development or test", () => {
    delete process.env.NODE_ENV;
    expect(isProduction()).toBe(true);
    expect(describeMode()).toBe("Mode: production (NODE_ENV=unset)");
    process.env.NODE_ENV = "production";
    expect(isProduction()).toBe(true);
    process.env.NODE_ENV = "staging";
    expect(isProduction()).toBe(true);
    process.env.NODE_ENV = "development";
    expect(isProduction()).toBe(false);
    expect(describeMode()).toBe("Mode: development (NODE_ENV=development)");
    process.env.NODE_ENV = "test";
    expect(isProduction()).toBe(false);
  });

  it("enforces the production settings when NODE_ENV is unset", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    delete process.env.NODE_ENV;
    process.env.JWT_SECRET = "short";
    delete process.env.FRONTEND_ORIGIN;

    expect(() => assertServerConfig()).toThrow(/JWT_SECRET should be at least 32[\s\S]*FRONTEND_ORIGIN must be set/);

    process.env.JWT_SECRET = LONG_SECRET;
    process.env.FRONTEND_ORIGIN = "https://relay.example.com";
    expect(() => assertServerConfig()).not.toThrow();
  });

  it("says sign-up is closed in production without an allowlist", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = LONG_SECRET;
    process.env.FRONTEND_ORIGIN = "https://relay.example.com";
    delete process.env.SIGNUP_ALLOWED_EMAILS;

    assertServerConfig();
    expect(String(log.mock.calls[0]?.[0])).toContain("Sign-up is closed");
    expect(warn).not.toHaveBeenCalled();
  });

  it("only warns in development, listing what is relaxed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = "short";
    delete process.env.FRONTEND_ORIGIN;
    delete process.env.SIGNUP_ALLOWED_EMAILS;

    expect(() => assertServerConfig()).not.toThrow();
    const text = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("JWT_SECRET should be at least 32");
    expect(text).toContain("not marked Secure");
    expect(text).toContain("anyone can sign up");
    expect(text).toContain("Do not expose this server through a tunnel");
  });

  it("refuses to start with a sign-up allowlist it cannot read", () => {
    process.env.NODE_ENV = "development";
    process.env.JWT_SECRET = LONG_SECRET;
    process.env.SIGNUP_ALLOWED_EMAILS = "ok@example.com, not-an-email, *@";

    expect(() => assertServerConfig()).toThrow(/SIGNUP_ALLOWED_EMAILS .*not-an-email, \*@/);
  });
});
