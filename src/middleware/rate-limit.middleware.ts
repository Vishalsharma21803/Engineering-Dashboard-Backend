import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const MINUTE = 60_000;

function limiter(options: {
  windowMs: number;
  limit: number;
  skipSuccessfulRequests?: boolean;
  message: string;
  keyGenerator?: (req: Request) => string;
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
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
 * One account from one address. Without TRUST_PROXY behind a proxy every
 * client shares the proxy's address, so keying on the address alone would let
 * one person lock everyone out. No JSON body (refused later): the address alone.
 */
function accountKey(req: Request): string {
  const address = ipKeyGenerator(req.ip ?? "");
  const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? `${address}|${email.trim().toLowerCase()}` : address;
}

/** Runs two limiters one after the other as one handler. */
function both(first: RequestHandler, second: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void first(req, res, (error?: unknown) => (error ? next(error) : void second(req, res, next)));
  };
}

/**
 * Brute-force guards for the unauthenticated auth routes, per client IP (set
 * TRUST_PROXY behind a reverse proxy so the IP is the client's). Counts are
 * kept in this process's memory.
 */
export function authRateLimits(options: { perAddressLoginLimit?: number } = {}): { login: RequestHandler; register: RequestHandler } {
  return {
    // Only failed sign-ins count, so a team behind one office IP is not locked out by normal use.
    login: both(
      // A ceiling per address against password spraying across many accounts.
      limiter({
        windowMs: 15 * MINUTE,
        limit: options.perAddressLoginLimit ?? 100,
        skipSuccessfulRequests: true,
        message: "Too many failed sign-in attempts from this network. Try again in 15 minutes.",
      }),
      limiter({ windowMs: 15 * MINUTE, limit: 10, skipSuccessfulRequests: true, message: "Too many failed sign-in attempts. Try again in 15 minutes.", keyGenerator: accountKey })
    ),
    register: limiter({ windowMs: 60 * MINUTE, limit: 10, message: "Too many accounts created from this network. Try again in an hour." }),
  };
}
