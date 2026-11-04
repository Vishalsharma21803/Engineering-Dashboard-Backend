
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

import { registerSchema, loginSchema } from "../schemas/auth.schema.js";
import { registerUser, loginUser, getCurrentUser, revokeToken } from "../services/auth.service.js";
import { AppError } from "../lib/app-error.js";
import { isProduction } from "../lib/server-config.js";
import { isSignupAllowed } from "../lib/signup-policy.js";
import { isSopAdmin } from "../lib/sop-admin.js";
import { sendError } from "./controller-helpers.js";

export async function register(
  req: Request,
  res: Response
): Promise<void> {
  const result = registerSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  // Before any database lookup: an address that is not invited gets the same answer whether or not it has an account.
  if (!isSignupAllowed(result.data.email)) {
    res.status(403).json({
      message: "Sign-up is by invitation only. Ask the Cockpit owner to add your email.",
      reason: "SIGNUP_NOT_ALLOWED",
    });
    return;
  }

  try {
    const user = await registerUser(result.data);

    res.status(201).json({
      message: "Registration successful",
      user,
    });
  } catch (error) {
    // EMAIL_ALREADY_REGISTERED is a 409 AppError.
    await sendError(res, error, "Signing up failed");
  }
}

export async function login(
  req: Request,
  res: Response
): Promise<void> {
  const result = loginSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  try {
    const user = await loginUser(result.data);

    if (!user) {
      res.status(401).json({
        message: "Invalid email or password",
        reason: "INVALID_CREDENTIALS",
      });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      throw new AppError(500, "SERVER_MISCONFIGURED", "Cockpit cannot sign anyone in: JWT_SECRET is not set on the server");
    }

    // jwtid: logout can end this one sign-in (other devices stay signed in).
    const token = jwt.sign(
      { sub: user.id },
      jwtSecret,
      { expiresIn: "1d", algorithm: "HS256", jwtid: randomUUID() }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    });

    res.status(200).json({
      message: "Login successful",
      user,
    });
  } catch (error) {
    await sendError(res, error, "Signing in failed");
  }
}


export async function me(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({
      message: "Authentication required",
      reason: "AUTH_REQUIRED",
    });
    return;
  }

  try {
    const user = await getCurrentUser(req.userId);

    if (!user) {
      res.status(401).json({
        message: "User no longer exists",
        reason: "USER_NOT_FOUND",
      });
      return;
    }

    res.status(200).json({ user: { ...user, isSopAdmin: isSopAdmin(user.email) } });
  } catch (error) {
    await sendError(res, error, "Loading your account failed");
  }
}

export async function logout(
  req: Request,
  res: Response
): Promise<void> {
  const token: unknown = req.cookies?.token;
  const jwtSecret = process.env.JWT_SECRET;
  let revocationFailed = false;

  // A still-valid token is revoked, so a copy of the cookie stops working too. A bad or expired one needs nothing.
  if (typeof token === "string" && token && jwtSecret) {
    try {
      const decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });

      if (typeof decoded !== "string" && typeof decoded.sub === "string" && typeof decoded.jti === "string" && typeof decoded.exp === "number") {
        await revokeToken(decoded.sub, decoded.jti, new Date(decoded.exp * 1000));
      }
    } catch (error) {
      // Signing out always clears the cookie; a revocation that could not be saved is logged and reported.
      if (!(error instanceof jwt.JsonWebTokenError)) {
        console.error("Revoking the sign-in token failed:", error);
        revocationFailed = true;
      }
    }
  }

  res.clearCookie("token", {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
  });

  // Still a success: this browser is signed out. Copies of the cookie stay valid until they expire.
  if (revocationFailed) {
    res.status(200).json({
      message: "Signed out on this device, but Cockpit could not end the session on the server. Copies of it stay valid until they expire (within 24 hours).",
      reason: "SESSION_NOT_REVOKED",
    });
    return;
  }

  res.status(200).json({
    message: "Logout successful",
  });
}