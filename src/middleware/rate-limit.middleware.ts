import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

const MINUTE = 60_000;

function limiter(options: { windowMs: number; limit: number; skipSuccessfulRequests?: boolean; message: string }): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Same error shape as the rest of the API; Retry-After tells the client when to try again.
    handler: (_req, res, _next, used) => {
      res.setHeader("Retry-After", String(Math.ceil(used.windowMs / 1000)));
      res.status(429).json({ message: options.message, reason: "TOO_MANY_REQUESTS" });
    },
  });
}

/**
 * Brute-force guards for the unauthenticated auth routes, per client IP (set
 * TRUST_PROXY behind a reverse proxy so the IP is the client's). Counts are
 * kept in this process's memory.
 */
export function authRateLimits(): { login: RequestHandler; register: RequestHandler } {
  return {
    // Only failed sign-ins count, so a team behind one office IP is not locked out by normal use.
    login: limiter({ windowMs: 15 * MINUTE, limit: 10, skipSuccessfulRequests: true, message: "Too many failed sign-in attempts. Try again in 15 minutes." }),
    register: limiter({ windowMs: 60 * MINUTE, limit: 10, message: "Too many accounts created from this network. Try again in an hour." }),
  };
}
