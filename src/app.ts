import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";

import { createAuthRoutes } from "./routes/auth.routes.js";
import credentialRoutes from "./routes/credential.routes.js";
import solidtimeRoutes from "./routes/solidtime.routes.js";
import azureRoutes from "./routes/azure.routes.js";
import actionRoutes from "./routes/action.routes.js";
import auditLogRoutes from "./routes/audit-log.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import triageRoutes from "./routes/triage.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import sopRoutes from "./routes/sop.routes.js";
import { refuseWhileShuttingDown, trackRequests } from "./lib/lifecycle.js";
import { prisma } from "./lib/prisma.js";
import { logFailedRequests, noteFailureCause } from "./middleware/failure-log.middleware.js";

/** Last-resort handler: JSON errors in the API's shape, never a stack trace. */
function handleUnexpectedError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = (error as { status?: unknown }).status;
  const type = (error as { type?: unknown }).type;

  if (type === "entity.parse.failed") {
    res.status(400).json({ message: "The request body is not valid JSON", reason: "INVALID_JSON" });
    return;
  }

  if (type === "entity.too.large") {
    res.status(413).json({ message: "The request body is too large", reason: "PAYLOAD_TOO_LARGE" });
    return;
  }

  // Logged (with the stack when unexpected) by logFailedRequests.
  noteFailureCause(res, error);

  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    res.status(415).json({ message: "The request body's encoding or charset is not supported", reason: "UNSUPPORTED_MEDIA_TYPE" });
    return;
  }

  if (type === "request.aborted") {
    res.status(400).json({ message: "The request was cancelled before its body arrived", reason: "REQUEST_ABORTED" });
    return;
  }

  if (type === "request.size.invalid") {
    res.status(400).json({ message: "The request body does not match its Content-Length", reason: "INVALID_BODY" });
    return;
  }

  // Client errors raised by Express or its parsers (http-errors) carry a message meant for the caller.
  if (typeof status === "number" && status >= 400 && status < 500) {
    const exposed = (error as { expose?: unknown }).expose === true && error instanceof Error && error.message;
    res.status(status).json({ message: exposed || "The request could not be processed", reason: "BAD_REQUEST" });
    return;
  }

  res
    .status(typeof status === "number" && status >= 500 && status < 600 ? status : 500)
    .json({ message: "The request failed because of an unexpected server error. The details are in the server log.", reason: "INTERNAL_ERROR" });
}

export interface AppOptions {
  /** Rate limits on sign-in and sign-up. Off only in tests that sign up many users from one address. */
  authRateLimit?: boolean;
  /** Log every failed request (on by default; off in tests, where failures are the point). */
  logFailures?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const app = express();

  // Counted from the very first middleware, so shutdown waits for every running request.
  app.use(trackRequests);
  app.disable("x-powered-by");
  // Security headers (HSTS, nosniff, frame and referrer policies, a strict CSP). The API serves only JSON.
  app.use(helmet());

  // Behind a reverse proxy (TRUST_PROXY=1 or a hop count/list), req.ip in audit logs is the client's, not the proxy's.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set("trust proxy", Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }

  const allowedOrigins = (
    process.env.FRONTEND_ORIGIN ?? "http://localhost:5180"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );
  app.use(refuseWhileShuttingDown);
  if (options.logFailures ?? true) app.use(logFailedRequests);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/", (_req, res) => {
    res.json({ message: "all is working fine" });
  });

  // Readiness: the API is only useful when the database answers.
  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok" });
    } catch (error) {
      console.error("Health check: the database did not answer:", error instanceof Error ? error.message : error);
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use("/api/auth", createAuthRoutes({ rateLimit: options.authRateLimit ?? true }));
  app.use("/api/credentials", credentialRoutes);
  app.use("/api/azure/:credentialId", azureRoutes);
  app.use("/api/actions", actionRoutes);
  app.use("/api/audit-logs", auditLogRoutes);
  app.use("/api/triage", triageRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/ai", aiRoutes);
  app.use("/api/sop", sopRoutes);
  app.use("/api/solidtime", solidtimeRoutes);

  // Only under /api: anything mounted after createApp (e.g. the e2e server's test routes) still answers.
  app.use("/api", (req: Request, res: Response) => {
    res.status(404).json({ message: `No API endpoint ${req.method} ${req.baseUrl}${req.path}`, reason: "ROUTE_NOT_FOUND" });
  });
  app.use(handleUnexpectedError);

  return app;
}
