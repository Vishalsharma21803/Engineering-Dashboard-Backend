import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { AppError } from "../app-error.js";
import { isProduction } from "../server-config.js";
import { SolidtimeApiError } from "./errors.js";
import { LOCAL_HOSTS, allowedSolidtimeHosts } from "./url.js";

/**
 * The backend calls the Solidtime address a user typed in, with their token,
 * so that address must not lead into Relay's own network (cloud metadata,
 * databases, admin panels). Every call checks where the host resolves to and
 * refuses private, loopback, link-local and other internal ranges. Self-hosted
 * Solidtime on a private network is allowed by listing it in
 * SOLIDTIME_ALLOWED_HOSTS.
 *
 * Remaining gap: fetch resolves the name again, so a DNS server that answers
 * differently between the check and the call (DNS rebinding) is not stopped.
 * Closing it needs a custom connect-time lookup (an undici dispatcher).
 */

type Resolver = (hostname: string) => Promise<string[]>;

const RESOLVE_CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 1_000;

const BLOCKED = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  // NAT64 addresses can carry any IPv4 address, internal ones included.
  ["64:ff9b::", 96],
  // So can the deprecated IPv4-compatible (::10.0.0.5), 6to4 and Teredo forms.
  ["::", 96],
  ["2002::", 16],
  ["2001::", 32],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}
// IPv4-mapped IPv6 addresses (::ffff:10.0.0.5) need no rule of their own: BlockList checks them against the IPv4 ranges.

const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

let resolver: Resolver = systemResolver;
const resolved = new Map<string, { expiresAt: number; addresses: string[] }>();

/** Tests resolve their fake hosts (e.g. solidtime.test) without real DNS; null restores the system resolver. */
export function setSolidtimeResolverForTests(next: Resolver | null): void {
  resolver = next ?? systemResolver;
  resolved.clear();
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function addressesOf(host: string): Promise<string[]> {
  if (isIP(host)) {
    return [host];
  }

  const cached = resolved.get(host);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.addresses;
  }

  let addresses: string[];

  try {
    addresses = await resolver(host);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new SolidtimeApiError("SOLIDTIME_UPSTREAM_ERROR", null, `${host} could not be resolved (${typeof code === "string" ? code : "DNS lookup failed"})`);
  }

  if (resolved.size >= MAX_CACHE_ENTRIES) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }

  resolved.set(host, { expiresAt: Date.now() + RESOLVE_CACHE_MS, addresses });
  return addresses;
}

/** Throws before anything is sent when the Solidtime host resolves to an internal address. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const name = hostname.toLowerCase();

  // Explicitly allowed by the owner, or a local server outside production (same rules as normalizeSolidtimeUrl).
  if (allowedSolidtimeHosts().includes(name) || (!isProduction() && LOCAL_HOSTS.has(name))) {
    return;
  }

  // URL.hostname keeps the brackets of an IPv6 literal ("[::1]").
  const addresses = await addressesOf(name.replace(/^\[(.*)\]$/, "$1"));

  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new AppError(
      422,
      "SOLIDTIME_ADDRESS_BLOCKED",
      "This Solidtime address points to a private or internal network. Ask the Relay owner to allow it (SOLIDTIME_ALLOWED_HOSTS)."
    );
  }
}
