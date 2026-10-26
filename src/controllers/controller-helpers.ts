import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";

import { AppError } from "../lib/app-error.js";
import { AzureApiError } from "../lib/azure/errors.js";
import { AiProviderError } from "../lib/ai/types.js";
import { ActionExecutionError } from "../services/actions/action.service.js";
import type { RequestContext } from "../services/audit.service.js";
import { markCredentialInvalid } from "../services/azure/azure-context.service.js";

export function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    message: "Validation failed",
    errors: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export function getRequestContext(req: Request): RequestContext {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

/** Maps service errors to the API error shape: { message, reason, ... }. */
export async function sendError(
  res: Response,
  error: unknown,
  label: string,
  credential?: { userId: string; credentialId: string }
): Promise<void> {
  if (error instanceof ActionExecutionError) {
    res.status(error.status).json({
      message: error.message,
      reason: error.reason,
      action: error.action,
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({ message: error.message, reason: error.reason });
    return;
  }

  if (error instanceof AiProviderError) {
    if (error.retryAfterSeconds !== null) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }

    res.status(error.httpStatus).json({ message: error.publicMessage, reason: error.reason });
    return;
  }

  if (error instanceof AzureApiError) {
    if (error.reason === "AZURE_PAT_INVALID" && credential) {
      await markCredentialInvalid(credential.userId, credential.credentialId);
    }

    if (error.retryAfterSeconds !== null) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }

    res.status(error.httpStatus).json({
      message: error.upstreamMessage
        ? `${error.publicMessage}: ${error.upstreamMessage}`
        : error.publicMessage,
      reason: error.reason,
    });
    return;
  }

  console.error(`${label}:`, error instanceof Error ? error.message : "Unknown error");

  res.status(500).json({ message: "Internal server error" });
}

/** Rejects state-changing requests that are not JSON (cheap CSRF hardening). */
export function requireJson(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && !req.is("application/json")) {
    res.status(415).json({
      message: "Content-Type must be application/json",
      reason: "UNSUPPORTED_MEDIA_TYPE",
    });
    return;
  }

  next();
}
