import type { NextFunction, Request, Response } from "express";

import { prisma } from "./prisma.js";

/** SOP owners are configured on the server: SOP_ADMIN_EMAILS=a@x.com,b@x.com */
export function isSopAdmin(email: string): boolean {
  const owners = (process.env.SOP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return owners.includes(email.trim().toLowerCase());
}

export async function isUserSopAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user !== null && isSopAdmin(user.email);
}

export async function requireSopAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.userId
    ? await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } })
    : null;

  if (!user) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  if (!isSopAdmin(user.email)) {
    res.status(403).json({ message: "Only SOP owners can change this setting", reason: "SOP_ADMIN_REQUIRED" });
    return;
  }

  next();
}
