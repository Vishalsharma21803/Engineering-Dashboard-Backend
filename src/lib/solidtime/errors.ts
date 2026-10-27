import { AppError } from "../app-error.js";
import { redactSecrets } from "../redact.js";

export type SolidtimeErrorReason =
  | "SOLIDTIME_TOKEN_INVALID"
  | "SOLIDTIME_FORBIDDEN"
  | "SOLIDTIME_NOT_FOUND"
  | "SOLIDTIME_THROTTLED"
  | "SOLIDTIME_REJECTED"
  | "SOLIDTIME_UPSTREAM_ERROR";

// Never 401: the frontend treats any 401 as a lost Cockpit session.
const STATUS: Record<SolidtimeErrorReason, number> = {
  SOLIDTIME_TOKEN_INVALID: 424,
  SOLIDTIME_FORBIDDEN: 403,
  SOLIDTIME_NOT_FOUND: 404,
  SOLIDTIME_THROTTLED: 503,
  SOLIDTIME_REJECTED: 422,
  SOLIDTIME_UPSTREAM_ERROR: 502,
};

const MESSAGE: Record<SolidtimeErrorReason, string> = {
  SOLIDTIME_TOKEN_INVALID: "The Solidtime API token is invalid or expired. Update the connection.",
  SOLIDTIME_FORBIDDEN: "Your Solidtime role does not allow this",
  SOLIDTIME_NOT_FOUND: "That Solidtime item was not found",
  SOLIDTIME_THROTTLED: "Solidtime is rate limiting requests. Try again shortly.",
  SOLIDTIME_REJECTED: "Solidtime rejected the request",
  SOLIDTIME_UPSTREAM_ERROR: "Solidtime could not be reached",
};

/** A failed Solidtime call; an AppError, so it reaches the browser as { message, reason }. */
export class SolidtimeApiError extends AppError {
  constructor(
    readonly solidtimeReason: SolidtimeErrorReason,
    readonly upstreamStatus: number | null,
    /** What Solidtime said (validation text, e.g. "time_entry_still_running"), secrets removed. */
    readonly upstreamMessage: string | null = null,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(
      STATUS[solidtimeReason],
      solidtimeReason,
      upstreamMessage ? `${MESSAGE[solidtimeReason]}: ${redactSecrets(upstreamMessage).slice(0, 300)}` : MESSAGE[solidtimeReason]
    );
    this.name = "SolidtimeApiError";
  }
}

export function reasonForSolidtimeStatus(status: number): SolidtimeErrorReason {
  if (status === 401) return "SOLIDTIME_TOKEN_INVALID";
  if (status === 403) return "SOLIDTIME_FORBIDDEN";
  if (status === 404) return "SOLIDTIME_NOT_FOUND";
  if (status === 429) return "SOLIDTIME_THROTTLED";
  if (status === 400 || status === 409 || status === 422) return "SOLIDTIME_REJECTED";
  return "SOLIDTIME_UPSTREAM_ERROR";
}

/** Solidtime errors are { error, key, message } (400) or Laravel validation { message, errors }. */
export function solidtimeErrorText(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const record = body as { key?: unknown; message?: unknown; errors?: unknown };
  const firstFieldError =
    record.errors && typeof record.errors === "object"
      ? Object.values(record.errors as Record<string, unknown>)
          .flat()
          .find((value): value is string => typeof value === "string")
      : undefined;
  const parts = [typeof record.message === "string" ? record.message : null, firstFieldError ?? null, typeof record.key === "string" ? `(${record.key})` : null];
  const text = [...new Set(parts.filter((part): part is string => Boolean(part)))].join(" ");

  return text || null;
}
