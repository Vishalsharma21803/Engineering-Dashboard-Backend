
import { Router, type RequestHandler } from "express";
import {
  login,
  register,
  me,
  logout,
} from "../controllers/auth.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { authRateLimits } from "../middleware/rate-limit.middleware.js";

const pass: RequestHandler = (_req, _res, next) => next();

/** Auth routes; `rateLimit: false` only for tests that sign up many users. */
export function createAuthRoutes(options: { rateLimit: boolean }) {
  const router = Router();
  const limits = options.rateLimit ? authRateLimits() : { login: pass, register: pass };

  router.post("/register", limits.register, requireJson, register);
  router.post("/login", limits.login, requireJson, login);
  router.get("/me", authenticate, me);
  router.post("/logout", logout);

  return router;
}
