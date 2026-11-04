import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { isTokenRevoked } from "../services/auth.service.js";

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token: unknown = req.cookies?.token;

  if (typeof token !== "string" || !token) {
    res.status(401).json({
      message: "Authentication required",
      reason: "AUTH_REQUIRED",
    });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured");
    res.status(500).json({
      message: "Cockpit cannot check sign-ins: JWT_SECRET is not set on the server",
      reason: "SERVER_MISCONFIGURED",
    });
    return;
  }

  let decoded: string | jwt.JwtPayload;

  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
  } catch {
    res.status(401).json({
      message: "Invalid or expired authentication token",
      reason: "AUTH_REQUIRED",
    });
    return;
  }

  if (
    typeof decoded === "string" ||
    typeof decoded.sub !== "string"
  ) {
    res.status(401).json({
      message: "Invalid authentication token",
      reason: "AUTH_REQUIRED",
    });
    return;
  }

  // Signed out: logout revoked this token's jti (tokens issued before jti existed simply expire).
  try {
    if (typeof decoded.jti === "string" && (await isTokenRevoked(decoded.jti))) {
      res.status(401).json({
        message: "This session has ended. Sign in again.",
        reason: "AUTH_REQUIRED",
      });
      return;
    }
  } catch (error) {
    console.error("Checking the session failed:", error);
    res.status(503).json({ message: "Service unavailable", reason: "SERVICE_UNAVAILABLE" });
    return;
  }

  req.userId = decoded.sub;
  next();
}
