import { afterEach, describe, expect, it } from "vitest";

import { assertPublicHost, isBlockedAddress, setSolidtimeResolverForTests } from "../../src/lib/solidtime/address-guard.js";
import { solidtimeTestResolver } from "../support/fake-solidtime.js";

const saved = { ...process.env };

afterEach(() => {
  for (const key of ["NODE_ENV", "SOLIDTIME_ALLOWED_HOSTS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setSolidtimeResolverForTests(solidtimeTestResolver);
});

const resolvesTo = (addresses: string[]) => setSolidtimeResolverForTests(async () => addresses);

describe("blocked addresses", () => {
  it("blocks private, loopback, link-local and other internal ranges, IPv4 and IPv6", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.168.1.10",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:10.0.0.5",
      "::ffff:7f00:1",
      "64:ff9b::a00:5",
      "::7f00:1",
      "::a00:5",
      "::10.0.0.5",
      "2002:a00:5::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "not-an-address",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    for (const address of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "::ffff:8.8.8.8", "2606:4700::1111", "2001:4860:4860::8888"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("assertPublicHost", () => {
  it("passes a host that resolves to public addresses only", async () => {
    resolvesTo(["93.184.215.14", "2606:4700::1111"]);
    await expect(assertPublicHost("time.example.com")).resolves.toBeUndefined();
  });

  it("refuses a host when any of its addresses is internal", async () => {
    resolvesTo(["93.184.215.14", "10.0.0.5"]);
    await expect(assertPublicHost("time.example.com")).rejects.toMatchObject({ status: 422, reason: "SOLIDTIME_ADDRESS_BLOCKED" });
  });

  it("checks IP literals directly, IPv6 ones without their brackets", async () => {
    resolvesTo(["93.184.215.14"]);
    await expect(assertPublicHost("169.254.169.254")).rejects.toMatchObject({ reason: "SOLIDTIME_ADDRESS_BLOCKED" });
    await expect(assertPublicHost("[fd00::1]")).rejects.toMatchObject({ reason: "SOLIDTIME_ADDRESS_BLOCKED" });
    await expect(assertPublicHost("[::ffff:a00:5]")).rejects.toMatchObject({ reason: "SOLIDTIME_ADDRESS_BLOCKED" });
    await expect(assertPublicHost("[2606:4700::1111]")).resolves.toBeUndefined();
  });

  it("allows an internal host the owner listed in SOLIDTIME_ALLOWED_HOSTS", async () => {
    resolvesTo(["192.168.1.20"]);
    process.env.SOLIDTIME_ALLOWED_HOSTS = "time.lan";
    await expect(assertPublicHost("time.lan")).resolves.toBeUndefined();
    await expect(assertPublicHost("other.lan")).rejects.toMatchObject({ reason: "SOLIDTIME_ADDRESS_BLOCKED" });
  });

  it("allows localhost outside production only", async () => {
    resolvesTo(["127.0.0.1"]);
    process.env.NODE_ENV = "development";
    await expect(assertPublicHost("localhost")).resolves.toBeUndefined();
    await expect(assertPublicHost("[::1]")).resolves.toBeUndefined();

    process.env.NODE_ENV = "production";
    await expect(assertPublicHost("localhost")).rejects.toMatchObject({ reason: "SOLIDTIME_ADDRESS_BLOCKED" });
    await expect(assertPublicHost("127.0.0.1")).rejects.toMatchObject({ reason: "SOLIDTIME_ADDRESS_BLOCKED" });
  });

  it("says when the host cannot be resolved", async () => {
    setSolidtimeResolverForTests(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.example"), { code: "ENOTFOUND" });
    });
    await expect(assertPublicHost("nowhere.example")).rejects.toMatchObject({
      reason: "SOLIDTIME_UPSTREAM_ERROR",
      message: "Solidtime could not be reached: nowhere.example could not be resolved (ENOTFOUND)",
    });
  });

  it("reuses a resolved host for a minute", async () => {
    let lookups = 0;
    setSolidtimeResolverForTests(async () => {
      lookups += 1;
      return ["93.184.215.14"];
    });
    await assertPublicHost("time.example.com");
    await assertPublicHost("time.example.com");
    expect(lookups).toBe(1);
  });
});
