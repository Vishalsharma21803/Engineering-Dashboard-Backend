import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";
import credentialRoutes from "./routes/credential.routes.js";
import azureRoutes from "./routes/azure.routes.js";
import actionRoutes from "./routes/action.routes.js";
import auditLogRoutes from "./routes/audit-log.routes.js";
import triageRoutes from "./routes/triage.routes.js";

export function createApp() {
  const app = express();

  const allowedOrigins = (
    process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"
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
  app.use(express.json());
  app.use(cookieParser());

  app.get("/", (_req, res) => {
    res.json({ message: "all is working fine" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/credentials", credentialRoutes);
  app.use("/api/azure/:credentialId", azureRoutes);
  app.use("/api/actions", actionRoutes);
  app.use("/api/audit-logs", auditLogRoutes);
  app.use("/api/triage", triageRoutes);

  return app;
}
