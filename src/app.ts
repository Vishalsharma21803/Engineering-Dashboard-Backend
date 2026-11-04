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

  // Logged with its stack by logFailedRequests.
  noteFailureCause(res, error);
  res
    .status(typeof status === "number" && status >= 400 && status < 600 ? status : 500)
    .json({ message: "Something went wrong", reason: "INTERNAL_ERROR" });
}

export interface AppOptions {
  /** Rate limits on sign-in and sign-up. Off only in tests that sign up many users from one address. */
  authRateLimit?: boolean;
  /** Log every failed request (on by default; off in tests, where failures are the point). */
  logFailures?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const app = express();

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

  app.use(handleUnexpectedError);

  return app;
}
