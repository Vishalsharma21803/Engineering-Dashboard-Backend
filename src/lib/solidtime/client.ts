import { SolidtimeApiError, reasonForSolidtimeStatus, solidtimeErrorText } from "./errors.js";
import { assertPublicHost } from "./address-guard.js";
import { networkFailure } from "../log-fallback.js";

const TIMEOUT_MS = 15_000;
const BACKGROUND_TIMEOUT_MS = 5_000;
/** Reads are reused briefly so one screen does not spend the 200-a-minute limit. */
const READ_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 2_000;
const MAX_RETRY_WAIT_S = 5;

type Query = Record<string, string | number | boolean | undefined | null | string[]>;

const readCache = new Map<string, { expiresAt: number; body: unknown }>();

/** Exposed for tests. */
export function clearSolidtimeCache(credentialId?: string): void {
  if (credentialId === undefined) {
    readCache.clear();
    return;
  }

  for (const key of readCache.keys()) {
    if (key.startsWith(`${credentialId}|`)) readCache.delete(key);
  }
}

function toSearch(query: Query): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      // Solidtime reads array filters as key[]=a&key[]=b.
      value.forEach((item) => search.append(`${key}[]`, item));
    } else {
      search.set(key, String(value));
    }
  }

  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Network failures that happen before the request reaches Solidtime (nothing can have been applied). */
const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/** Whether a failed fetch may have delivered the request: only a failure to connect at all proves it did not. */
function mayHaveBeenSent(error: unknown): boolean {
  const code = error instanceof Error ? (error as { cause?: { code?: unknown } }).cause?.code : undefined;
  return !(typeof code === "string" && NOT_CONNECTED_CODES.has(code));
}

/** Thrown when a write may have reached Solidtime before failing, so the outcome is unknown. */
export class SolidtimeWriteError extends Error {
  constructor(
    readonly cause: unknown,
    readonly writeSent: boolean
  ) {
    super(cause instanceof Error ? cause.message : "Solidtime write failed");
    this.name = "SolidtimeWriteError";
  }
}

/**
 * One user's Solidtime connection for one request. The token lives only in a
 * private field and is never logged or returned. Writes are used only by the
 * approved-action runner.
 */
export class SolidtimeClient {
  readonly credentialId: string;
  readonly baseUrl: string;
  readonly #token: string;
  readonly #refresh: boolean;
  readonly #timeoutMs: number;
  readonly #waitOnLimit: boolean;

  constructor(options: {
    credentialId: string;
    baseUrl: string;
    token: string;
    refresh?: boolean;
    /** Background reads (dashboard nudges, AI, reports) use a short timeout and never wait out a rate limit. */
    background?: boolean;
  }) {
    this.credentialId = options.credentialId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#refresh = options.refresh ?? false;
    this.#timeoutMs = options.background ? BACKGROUND_TIMEOUT_MS : TIMEOUT_MS;
    this.#waitOnLimit = !options.background;
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = `${this.baseUrl}/api/v1/${path}${toSearch(query)}`;
    const key = `${this.credentialId}|${url}`;
    const cached = readCache.get(key);

    if (cached && cached.expiresAt > Date.now() && !this.#refresh) {
      return cached.body as T;
    }

    const body = await this.#send<T>("GET", url, undefined, this.#waitOnLimit);

    if (readCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = readCache.keys().next().value;
      if (oldest !== undefined) readCache.delete(oldest);
    }

    readCache.set(key, { expiresAt: Date.now() + READ_CACHE_MS, body });
    return body;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.#write<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.#write<T>("PUT", path, body);
  }

  async delete(path: string): Promise<void> {
    await this.#write<unknown>("DELETE", path, undefined);
  }

  async #write<T>(method: string, path: string, body: unknown): Promise<T> {
    // Anything this connection read may now be out of date.
    for (const key of readCache.keys()) {
      if (key.startsWith(`${this.credentialId}|`)) readCache.delete(key);
    }

    return this.#send<T>(method, `${this.baseUrl}/api/v1/${path}`, body, false);
  }

  async #send<T>(method: string, url: string, body: unknown, retryOnLimit: boolean): Promise<T> {
    // Outside the try: a refused or unresolvable address is never "may have been sent".
    await assertPublicHost(new URL(url).hostname);

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const failure = new SolidtimeApiError("SOLIDTIME_UPSTREAM_ERROR", null, networkFailure(error));
      // A write that timed out or lost its connection may still have been applied; one that never connected was not.
      throw method === "GET" ? failure : new SolidtimeWriteError(failure, mayHaveBeenSent(error));
    }

    if (response.status === 429 && retryOnLimit) {
      const wait = Number(response.headers.get("retry-after"));

      if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_WAIT_S) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        return this.#send<T>(method, url, body, false);
      }
    }

    if (response.status === 204) {
      return undefined as T;
    }

    let text: string;

    try {
      text = await response.text();
    } catch (error) {
      const failure = new SolidtimeApiError("SOLIDTIME_UPSTREAM_ERROR", response.status, networkFailure(error));
      // The answer was cut off: a write Solidtime accepted or failed inside may have been applied.
      throw method === "GET" ? failure : new SolidtimeWriteError(failure, response.ok || response.status >= 500 || response.status === 408);
    }

    let parsed: unknown = null;

    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const failure = new SolidtimeApiError(
        reasonForSolidtimeStatus(response.status),
        response.status,
        solidtimeErrorText(parsed),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
      );
      // A refusal (4xx) was not applied; a server or gateway error (5xx, 408) may have been, after the write ran.
      throw method === "GET" ? failure : new SolidtimeWriteError(failure, response.status >= 500 || response.status === 408);
    }

    if (parsed === null) {
      throw method === "GET" ? new SolidtimeApiError("SOLIDTIME_UPSTREAM_ERROR", response.status) : new SolidtimeWriteError(new SolidtimeApiError("SOLIDTIME_UPSTREAM_ERROR", response.status), true);
    }

    return parsed as T;
  }
}
