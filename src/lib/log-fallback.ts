import { AzureApiError } from "./azure/errors.js";
import { AiProviderError } from "./ai/types.js";
import { redactSecrets } from "./redact.js";

/**
 * A read that failed but has a fallback (a missing name, an unknown count):
 * the page still works, so the user is not stopped, but the server log says
 * what went wrong instead of the failure disappearing.
 */
export function logFallback(what: string, error: unknown): void {
  const detail =
    error instanceof AzureApiError
      ? `${error.message}${error.upstreamMessage ? ` · Azure details: ${error.upstreamMessage}` : ""}`
      : error instanceof AiProviderError
        ? [error.message, error.detail ? `provider said: ${error.detail}` : null, error.diagnosis].filter(Boolean).join(" · ")
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
  console.warn(`${what} (continuing without it): ${redactSecrets(detail)}`);
}

/** `.catch(fallbackTo("Reading X failed", []))`: log, then use the fallback. */
export const fallbackTo =
  <T>(what: string, value: T) =>
  (error: unknown): T => {
    logFallback(what, error);
    return value;
  };

/** Why a request never got an answer (timeout, DNS, refused connection…), for messages and logs. */
export function networkFailure(error: unknown): string {
  if (!(error instanceof Error)) return "the request failed";
  if (error.name === "TimeoutError") return "no answer before the timeout";
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  const message = typeof cause?.message === "string" ? cause.message : error.message;
  return code ? `${code}: ${message}` : message;
}
