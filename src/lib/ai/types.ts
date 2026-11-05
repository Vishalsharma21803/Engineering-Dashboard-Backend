import type { AiEffort, AiProvider } from "../../generated/prisma/enums.js";
import { redactSecrets } from "../redact.js";

export type { AiEffort, AiProvider };

/** A model a user can pick for AI checks. Prices are USD per million tokens. */
export interface AiModelOption {
  provider: AiProvider;
  id: string;
  label: string;
  description: string | null;
  free: boolean;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number | null;
  contextLength: number | null;
  /** Effort levels the model accepts; empty means effort cannot be chosen. */
  efforts: AiEffort[];
  /**
   * True when some providers serving this model may store or train on
   * prompts (OpenRouter free endpoints). Using it needs the user's consent.
   */
  mayCollectData: boolean;
}

export type AiErrorReason =
  | "AI_KEY_INVALID"
  | "AI_NO_CREDIT"
  | "AI_RATE_LIMITED"
  | "AI_MODEL_UNAVAILABLE"
  | "AI_PERMISSION_DENIED"
  | "AI_UPSTREAM_ERROR"
  | "AI_REQUEST_REJECTED"
  | "AI_REFUSED"
  | "AI_BAD_OUTPUT"
  | "AI_FREE_TIER_BLOCKED";

const HTTP_STATUS_BY_REASON: Record<AiErrorReason, number> = {
  // Never 401: the frontend treats any 401 as a lost Relay session.
  AI_KEY_INVALID: 424,
  AI_NO_CREDIT: 402,
  AI_RATE_LIMITED: 503,
  AI_MODEL_UNAVAILABLE: 422,
  AI_PERMISSION_DENIED: 403,
  AI_UPSTREAM_ERROR: 502,
  // The provider understood the request and refused it (bad parameter, prompt too long): retrying cannot help.
  AI_REQUEST_REJECTED: 422,
  AI_REFUSED: 422,
  AI_BAD_OUTPUT: 502,
  AI_FREE_TIER_BLOCKED: 422,
};

const MESSAGE_BY_REASON: Record<AiErrorReason, string> = {
  AI_KEY_INVALID: "The AI provider rejected this API key. Check or replace it.",
  AI_NO_CREDIT: "The AI provider account has no credit left.",
  AI_RATE_LIMITED: "The AI provider is rate limiting requests. Try again shortly.",
  AI_MODEL_UNAVAILABLE: "This model is not available for this API key.",
  AI_PERMISSION_DENIED: "This API key is not allowed to use this feature or model.",
  AI_UPSTREAM_ERROR: "The AI provider could not be reached.",
  AI_REQUEST_REJECTED: "The AI provider rejected the request.",
  AI_REFUSED: "The model declined to check this ticket.",
  AI_BAD_OUTPUT: "The model's answer was cut off or not in the expected format.",
  AI_FREE_TIER_BLOCKED:
    "OpenCode only allows its free models inside the OpenCode app (outside it they always answer \"free usage limit reached\"). Choose a paid OpenCode model (needs credit) or another provider.",
};

/** Seconds from a Retry-After header; null when absent or unusable (never 0). */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Tokens a failed call still consumed, so spend limits count them. */
export interface BilledUsage {
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  servedBy: string;
}

const MAX_DETAIL = 300;

/** The provider's own error message from a JSON error body, shortened; null when there is none. */
export function providerMessage(body: string): string | null {
  let message: unknown = null;

  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message ?? null);
  } catch {
    message = null;
  }

  return typeof message === "string" && message.trim() ? redactSecrets(message.trim()).slice(0, MAX_DETAIL) : null;
}

export class AiProviderError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly reason: AiErrorReason,
    readonly retryAfterSeconds: number | null = null,
    readonly billed: BilledUsage | null = null,
    /** What the provider itself said (shown to the user so limits are understandable). */
    readonly detail: string | null = null,
    /** What Relay found wrong itself (no answer in time, an answer that is not JSON…); never shown as the provider's words. */
    readonly diagnosis: string | null = null
  ) {
    super(`AI provider request failed (${reason})`);
    this.name = "AiProviderError";
    this.httpStatus = HTTP_STATUS_BY_REASON[reason];
  }

  get publicMessage(): string {
    return MESSAGE_BY_REASON[this.reason];
  }
}

export type KeyValidationResult =
  | { valid: true; details: Record<string, string | number | boolean | null> }
  | { valid: false; reason: AiErrorReason };
