import {
  assertTicketUsable,
  consumeTicket,
  type ApprovalTicket,
} from "./approval-ticket.js";
import { clearAzureCache, getCached, setCached } from "./cache.js";
import { AzureApiError, reasonForStatus } from "./errors.js";
import { createLimiter, type Limiter } from "./limiter.js";

export const AZURE_API_VERSION = "7.1";

const TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_RETRY_AFTER_SECONDS = 10;
const CONCURRENCY_PER_CREDENTIAL = 5;
const CONTINUATION_HEADER = "x-ms-continuationtoken";
const CONNECTION_DATA_PATH = ["_apis", "connectionData"];
const PAT_LIVENESS_CACHE_KEY = "pat-liveness";

/**
 * Azure DevOps exposes these read-only queries as POST. Every other
 * non-GET request must go through write() with an ApprovalTicket.
 */
const READ_POST_PATHS = ["_apis/wit/wiql", "_apis/wit/workitemsbatch"];

export type AzureHost = "core" | "vsrm";
export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  host?: AzureHost;
  /** null omits the api-version parameter. */
  apiVersion?: string | null;
  query?: Query;
}

export interface ReadOptions extends RequestOptions {
  /** 0 disables caching for this request. */
  cacheTtlMs?: number;
}

export interface WriteOptions extends RequestOptions {
  contentType?: string;
}

export interface AzurePage<T> {
  data: T;
  continuationToken: string | null;
}

export interface AzureClientConfig {
  credentialId: string;
  organizationUrl: string;
  patToken: string;
  /** Bypass cached reads (results are still cached for later requests). */
  refresh?: boolean;
}

const limiters = new Map<string, Limiter>();

function limiterFor(credentialId: string): Limiter {
  let limiter = limiters.get(credentialId);

  if (!limiter) {
    limiter = createLimiter(CONCURRENCY_PER_CREDENTIAL);
    limiters.set(credentialId, limiter);
  }

  return limiter;
}

export function toReleaseManagementUrl(organizationUrl: string): string {
  const url = new URL(organizationUrl);

  if (url.hostname === "dev.azure.com") {
    return `https://vsrm.dev.azure.com${url.pathname.replace(/\/+$/, "")}`;
  }

  const organization = url.hostname.slice(0, -".visualstudio.com".length);
  return `https://${organization}.vsrm.visualstudio.com`;
}

function encodeSegments(segments: readonly string[]): string {
  return segments
    .map((segment) => {
      if (segment === "" || segment === "." || segment === "..") {
        throw new Error("INVALID_AZURE_PATH_SEGMENT");
      }

      return encodeURIComponent(segment);
    })
    .join("/");
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AzureClient {
  readonly credentialId: string;
  readonly organizationUrl: string;
  readonly #authorization: string;
  readonly #refresh: boolean;
  readonly #limit: Limiter;

  constructor(config: AzureClientConfig) {
    this.credentialId = config.credentialId;
    this.organizationUrl = config.organizationUrl;
    this.#authorization = `Basic ${Buffer.from(
      `:${config.patToken}`,
      "utf8"
    ).toString("base64")}`;
    this.#refresh = config.refresh ?? false;
    this.#limit = limiterFor(config.credentialId);
  }

  buildUrl(segments: readonly string[], options: RequestOptions = {}): URL {
    const base = new URL(
      options.host === "vsrm"
        ? toReleaseManagementUrl(this.organizationUrl)
        : this.organizationUrl
    );
    const url = new URL(base.origin);

    url.pathname = `${base.pathname.replace(/\/+$/, "")}/${encodeSegments(
      segments
    )}`;

    const apiVersion =
      options.apiVersion === undefined ? AZURE_API_VERSION : options.apiVersion;

    if (apiVersion !== null) {
      url.searchParams.set("api-version", apiVersion);
    }

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async get<T>(segments: readonly string[], options: ReadOptions = {}): Promise<T> {
    const page = await this.getPage<T>(segments, options);
    return page.data;
  }

  async getPage<T>(
    segments: readonly string[],
    options: ReadOptions = {}
  ): Promise<AzurePage<T>> {
    const url = this.buildUrl(segments, options);
    return this.#cachedRead<T>("GET", url, undefined, options.cacheTtlMs);
  }

  /** Follows x-ms-continuationtoken for list endpoints returning { value: T[] }. */
  async getAll<T>(
    segments: readonly string[],
    options: ReadOptions & { maxPages?: number } = {}
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    const maxPages = options.maxPages ?? 10;
    let continuationToken: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
      const result: AzurePage<{ value?: T[] }> = await this.getPage<{
        value?: T[];
      }>(segments, {
        ...options,
        query: { ...options.query, continuationToken },
      });

      items.push(...(result.data.value ?? []));
      continuationToken = result.continuationToken;

      if (!continuationToken) {
        return { items, truncated: false };
      }
    }

    return { items, truncated: true };
  }

  /** POST for Azure endpoints that are reads (WIQL, work item batch). */
  async readPost<T>(
    segments: readonly string[],
    body: unknown,
    options: ReadOptions = {}
  ): Promise<T> {
    const path = segments.join("/");

    if (!READ_POST_PATHS.some((allowed) => path.endsWith(allowed))) {
      throw new Error("WRITE_WITHOUT_APPROVAL");
    }

    const url = this.buildUrl(segments, options);
    const page = await this.#cachedRead<T>(
      "POST",
      url,
      JSON.stringify(body),
      options.cacheTtlMs
    );

    return page.data;
  }

  /**
   * The only way to change anything in Azure DevOps. Each ticket allows
   * exactly one request and is never retried.
   */
  async write<T>(
    ticket: ApprovalTicket,
    method: "POST" | "PATCH",
    segments: readonly string[],
    body: unknown,
    options: WriteOptions = {}
  ): Promise<T | undefined> {
    assertTicketUsable(ticket, this.credentialId);

    const url = this.buildUrl(segments, options);
    consumeTicket(ticket);

    try {
      const page = await this.#request<T>(
        method,
        url,
        JSON.stringify(body),
        options.contentType,
        true
      );
      return page.data;
    } finally {
      clearAzureCache(this.credentialId);
    }
  }

  async #cachedRead<T>(
    method: "GET" | "POST",
    url: URL,
    body: string | undefined,
    cacheTtlMs: number | undefined
  ): Promise<AzurePage<T>> {
    const ttl = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cacheKey = `${method} ${url.toString()} ${body ?? ""}`;

    if (ttl > 0 && !this.#refresh) {
      const cached = getCached<AzurePage<T>>(this.credentialId, cacheKey);

      if (cached) {
        return cached;
      }
    }

    const page = await this.#readWithRetry<T>(method, url, body);

    if (ttl > 0) {
      setCached(this.credentialId, cacheKey, page, ttl);
    }

    return page;
  }

  async #readWithRetry<T>(
    method: "GET" | "POST",
    url: URL,
    body: string | undefined
  ): Promise<AzurePage<T>> {
    try {
      return await this.#request<T>(method, url, body);
    } catch (error) {
      if (
        error instanceof AzureApiError &&
        error.reason === "AZURE_THROTTLED" &&
        error.retryAfterSeconds !== null &&
        error.retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
      ) {
        await wait(error.retryAfterSeconds * 1000);
        return this.#request<T>(method, url, body);
      }

      throw error;
    }
  }

  async #request<T>(
    method: string,
    url: URL,
    body: string | undefined,
    contentType?: string,
    isWrite = false
  ): Promise<AzurePage<T>> {
    try {
      const response = await this.#limit(() =>
        this.#send(method, url, body, contentType)
      );
      return await this.#parse<T>(response, isWrite);
    } catch (error) {
      if (error instanceof AzureApiError) {
        throw await this.#classifyUnauthorized(error, url);
      }

      throw error;
    }
  }

  /**
   * Azure answers 401 both for a dead PAT and for a live PAT missing the
   * scope. connectionData accepts any live PAT, so it tells them apart.
   */
  async #classifyUnauthorized(error: AzureApiError, url: URL): Promise<AzureApiError> {
    if (
      error.reason !== "AZURE_PAT_INVALID" ||
      error.upstreamStatus !== 401 ||
      url.pathname.endsWith(`/${CONNECTION_DATA_PATH.join("/")}`)
    ) {
      return error;
    }

    let patIsLive = getCached<boolean>(this.credentialId, PAT_LIVENESS_CACHE_KEY);

    if (patIsLive === undefined) {
      try {
        const response = await this.#limit(() =>
          this.#send(
            "GET",
            this.buildUrl(CONNECTION_DATA_PATH, { apiVersion: null }),
            undefined
          )
        );
        const contentType = response.headers.get("content-type") ?? "";
        patIsLive =
          response.status === 200 &&
          contentType.toLowerCase().includes("application/json");
        await response.body?.cancel().catch(() => undefined);
      } catch {
        return error;
      }

      setCached(this.credentialId, PAT_LIVENESS_CACHE_KEY, patIsLive, DEFAULT_CACHE_TTL_MS);
    }

    return patIsLive ? new AzureApiError("AZURE_INSUFFICIENT_SCOPE", 401) : error;
  }

  async #send(
    method: string,
    url: URL,
    body: string | undefined,
    contentType = "application/json"
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.#authorization,
    };

    if (body !== undefined) {
      headers["Content-Type"] = contentType;
    }

    try {
      return await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AzureApiError("AZURE_UPSTREAM_ERROR", null);
    }
  }

  async #parse<T>(response: Response, isWrite = false): Promise<AzurePage<T>> {
    const continuationToken = response.headers.get(CONTINUATION_HEADER);

    if (response.status >= 200 && response.status < 300 && response.status !== 203) {
      if (response.status === 204) {
        return { data: undefined as T, continuationToken };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const isJson = contentType.toLowerCase().includes("application/json");

      // A 2xx to an authenticated write means it was accepted, whatever the body.
      if (isWrite && !isJson) {
        await response.body?.cancel().catch(() => undefined);
        return { data: undefined as T, continuationToken };
      }

      // Azure answers some unauthenticated reads with an HTML sign-in page.
      if (!isJson) {
        throw new AzureApiError("AZURE_PAT_INVALID", response.status);
      }

      try {
        return { data: (await response.json()) as T, continuationToken };
      } catch {
        if (isWrite) {
          return { data: undefined as T, continuationToken };
        }

        throw new AzureApiError("AZURE_UPSTREAM_ERROR", response.status);
      }
    }

    const reason = reasonForStatus(response.status);
    const upstreamMessage =
      reason === "AZURE_BAD_REQUEST" || reason === "AZURE_CONFLICT"
        ? await readUpstreamMessage(response)
        : null;

    if (upstreamMessage === null) {
      await response.body?.cancel().catch(() => undefined);
    }

    throw new AzureApiError(
      reason,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
      upstreamMessage
    );
  }
}

const MAX_UPSTREAM_MESSAGE_LENGTH = 300;

/** Azure validation errors ({ message }) explain rejected writes, e.g. a required field. */
async function readUpstreamMessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { message?: unknown };

    return typeof payload.message === "string"
      ? payload.message.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH)
      : null;
  } catch {
    return null;
  }
}
