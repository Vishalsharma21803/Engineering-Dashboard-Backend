import { afterEach, describe, expect, it } from "vitest";

import { isSignupAllowed, parseSignupAllowList } from "../../src/lib/signup-policy.js";

const saved = { ...process.env };

afterEach(() => {
  for (const key of ["NODE_ENV", "SIGNUP_ALLOWED_EMAILS", "SOP_ADMIN_EMAILS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("parseSignupAllowList", () => {
  it("reads exact addresses and *@domain entries, trimmed and lower-cased", () => {
    const { list, invalid } = parseSignupAllowList(" Ana@Example.com ,*@Company.IO,, bob@x.org ");
    expect(invalid).toEqual([]);
    expect([...list!.exact]).toEqual(["ana@example.com", "bob@x.org"]);
    expect([...list!.domains]).toEqual(["company.io"]);
  });

  it("treats unset or blank as no list", () => {
    expect(parseSignupAllowList(undefined)).toEqual({ list: null, invalid: [] });
    expect(parseSignupAllowList(" , ")).toEqual({ list: null, invalid: [] });
  });

  it("reports entries that are neither an address nor *@domain", () => {
    expect(parseSignupAllowList("a@x.com,nobody,*@,*.x.com,a*@x.com,@x.com").invalid).toEqual(["nobody", "*@", "*.x.com", "a*@x.com", "@x.com"]);
  });
});

describe("isSignupAllowed", () => {
  it("follows the allowlist when it is set", () => {
    process.env.NODE_ENV = "development";
    process.env.SIGNUP_ALLOWED_EMAILS = "ana@example.com,*@company.io";
    delete process.env.SOP_ADMIN_EMAILS;

    expect(isSignupAllowed("Ana@Example.com")).toBe(true);
    expect(isSignupAllowed("someone@company.io")).toBe(true);
    expect(isSignupAllowed("someone@sub.company.io")).toBe(false);
    expect(isSignupAllowed("someone@example.com")).toBe(false);
  });

  it("is open outside production and closed in production when unset, except for SOP owners", () => {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
    process.env.SOP_ADMIN_EMAILS = "owner@example.com";

    process.env.NODE_ENV = "test";
    expect(isSignupAllowed("anyone@example.com")).toBe(true);
    process.env.NODE_ENV = "development";
    expect(isSignupAllowed("anyone@example.com")).toBe(true);

    delete process.env.NODE_ENV;
    expect(isSignupAllowed("anyone@example.com")).toBe(false);
    expect(isSignupAllowed("owner@example.com")).toBe(true);
  });
});
