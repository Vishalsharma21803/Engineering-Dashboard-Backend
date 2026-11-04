import { isProduction } from "../server-config.js";

/**
 * The Solidtime server address a user enters (cloud or self-hosted). The
 * backend calls it with the user's token, so only https is accepted, nothing
 * that could smuggle credentials or a different target, and, when
 * SOLIDTIME_ALLOWED_HOSTS is set, only the hosts listed there. Plain http is
 * allowed for localhost outside production (local servers and tests).
 */
export type NormalizedSolidtimeUrl = { ok: true; url: string } | { ok: false; message: string };

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function allowedSolidtimeHosts(): string[] {
  return (process.env.SOLIDTIME_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeSolidtimeUrl(value: string): NormalizedSolidtimeUrl {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, message: "Enter the Solidtime address, for example https://app.solidtime.io" };
  }

  const host = url.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(host) && !isProduction();

  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, message: "The Solidtime address must use HTTPS" };
  }

  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, message: "The Solidtime address must not contain credentials, a query or a fragment" };
  }

  const allowed = allowedSolidtimeHosts();

  if (allowed.length > 0 && !allowed.includes(host)) {
    return { ok: false, message: "This Solidtime server is not allowed here (SOLIDTIME_ALLOWED_HOSTS)" };
  }

  // People paste the app URL or the API URL; both mean the same server.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api(\/v1)?$/i, "");

  return { ok: true, url: `${url.protocol}//${url.host}${path}` };
}
