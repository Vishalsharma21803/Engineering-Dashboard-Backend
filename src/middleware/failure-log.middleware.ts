import type { NextFunction, Request, Response } from "express";

import { AzureApiError } from "../lib/azure/errors.js";
import { AiProviderError } from "../lib/ai/types.js";
import { redactSecrets } from "../lib/redact.js";

/** Kept on `res.locals` by error handlers so the log line can say what really went wrong. */
const CAUSE = "failureCause";
const LABEL = "failureLabel";

/** Remembers the error behind a failed response, and what was being done, for the log line. */
export function noteFailureCause(res: Response, error: unknown, label?: string): void {
  res.locals[CAUSE] = error;
  if (label) res.locals[LABEL] = label;
}

/** What the user was not shown: provider and upstream messages, or the error itself. */
function describeCause(error: unknown): string | null {
  if (error instanceof AiProviderError) {
    return [error.message, error.detail ? `provider said: ${error.detail}` : null, error.diagnosis].filter(Boolean).join(" · ");
  }

  if (error instanceof AzureApiError) {
    return [error.message, error.upstreamMessage ? `Azure details: ${error.upstreamMessage}` : null].filter(Boolean).join(" · ");
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return error === undefined ? null : String(error);
}

/** Errors nobody expected (no API reason): their stack is what makes them fixable. */
function isUnexpected(error: unknown): error is Error {
  return error instanceof Error && !(error instanceof AiProviderError) && !(error instanceof AzureApiError) && !("reason" in error);
}

/** A signed-out browser checking its session: normal, not a failure worth a line. */
const isSessionCheck = (req: Request, status: number) => status === 401 && req.method === "GET" && req.originalUrl.split("?")[0] === "/api/auth/me";

/**
 * Logs every response that ends in an error (4xx as a warning, 5xx as an
 * error) with what the user was told and, when known, the real cause. No
 * request bodies, cookies or query strings: they can carry tokens.
 */
export function logFailedRequests(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  const json = res.json.bind(res);
  let body: { message?: unknown; reason?: unknown } | null = null;

  res.json = (payload: unknown) => {
    if (res.statusCode >= 400 && payload && typeof payload === "object") body = payload as typeof body;
    return json(payload);
  };

  res.on("finish", () => {
    const status = res.statusCode;
    if (status < 400 || isSessionCheck(req, status)) return;

    const cause: unknown = res.locals[CAUSE];
    const label = typeof res.locals[LABEL] === "string" ? (res.locals[LABEL] as string) : null;
    const reason = typeof body?.reason === "string" ? body.reason : null;
    const message = typeof body?.message === "string" ? body.message : null;
    const causeText = describeCause(cause);
    const line = [
      `${status} ${req.method} ${req.originalUrl.split("?")[0]}`,
      `${Date.now() - started} ms`,
      req.userId ? `user ${req.userId}` : null,
      label,
      reason,
      message ? `"${message}"` : null,
      // Only when it adds something: an AppError's cause is the message the user already got.
      causeText && !(message && causeText.endsWith(message)) ? `cause: ${redactSecrets(causeText)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    if (status >= 500) {
      console.error(`Request failed: ${line}`);
      if (isUnexpected(cause) && cause.stack) console.error(cause.stack);
    } else {
      console.warn(`Request refused: ${line}`);
    }
  });

  next();
}
