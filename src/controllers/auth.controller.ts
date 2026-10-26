
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

import { registerSchema, loginSchema } from "../schemas/auth.schema.js";
import { registerUser, loginUser, getCurrentUser } from "../services/auth.service.js";
import { isSopAdmin } from "../lib/sop-admin.js";

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

  try {
    const user = await registerUser(result.data);

    res.status(201).json({
      message: "Registration successful",
      user,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "EMAIL_ALREADY_REGISTERED"
    ) {
      res.status(409).json({
        message: "Email is already registered",
      });
      return;
    }

    console.error("Registration failed:", error);

    res.status(500).json({
      message: "Internal server error",
    });
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
      });
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      console.error("JWT_SECRET is not configured");

      res.status(500).json({
        message: "Internal server error",
      });
      return;
    }

    const token = jwt.sign(
      { sub: user.id },
      jwtSecret,
      { expiresIn: "1d", algorithm: "HS256" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    });

    res.status(200).json({
      message: "Login successful",
      user,
    });
  } catch (error) {
    console.error("Login failed:", error);

    res.status(500).json({
      message: "Internal server error",
    });
  }
}


export async function me(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({
      message: "Authentication required",
    });
    return;
  }

  try {
    const user = await getCurrentUser(req.userId);

    if (!user) {
      res.status(401).json({
        message: "User no longer exists",
      });
      return;
    }

    res.status(200).json({ user: { ...user, isSopAdmin: isSopAdmin(user.email) } });
  } catch (error) {
    console.error("Fetching current user failed:", error);

    res.status(500).json({
      message: "Internal server error",
    });
  }
}

export function logout(
  _req: Request,
  res: Response
): void {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  res.status(200).json({
    message: "Logout successful",
  });
}