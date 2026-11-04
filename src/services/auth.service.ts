
import bcrypt from "bcrypt";
import { AppError } from "../lib/app-error.js";
import { prisma } from "../lib/prisma.js";
import type { LoginInput, RegisterInput } from "../types/auth.types.js";

/** A bcrypt hash (cost 12) of a random value; compared against when the email is unknown. */
const DUMMY_HASH = bcrypt.hashSync(Math.random().toString(36), 12);

export async function registerUser(input: RegisterInput) {
  const hashedPassword = await bcrypt.hash(input.password, 12);

  // The unique email index decides, so two sign-ups with one address at once end in a 409, not a 500.
  try {
    return await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "P2002") {
      throw new AppError(409, "EMAIL_ALREADY_REGISTERED", "Email is already registered");
    }

    throw error;
  }
}

export async function loginUser(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
  });

  if (!user) {
    // Same work as a real check, so response time does not reveal which emails have accounts.
    await bcrypt.compare(input.password, DUMMY_HASH);
    return null;
  }

  const passwordMatches = await bcrypt.compare(
    input.password,
    user.password
  );

  if (!passwordMatches) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
  };
}



export async function getCurrentUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
    },
  });
}

/** Ends one sign-in before it expires: its jti is refused from now on. Tokens without a jti (older sign-ins) just expire. */
export async function revokeToken(userId: string, jti: string, expiresAt: Date): Promise<void> {
  try {
    await prisma.revokedToken.upsert({ where: { jti }, create: { jti, userId, expiresAt }, update: {} });
  } catch (error) {
    // A simultaneous logout with the same token inserted the row first: the token is revoked either way.
    if ((error as { code?: unknown } | null)?.code !== "P2002") {
      throw error;
    }
  }
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  return (await prisma.revokedToken.findUnique({ where: { jti }, select: { jti: true } })) !== null;
}

/** Revocations of tokens that have expired anyway are no longer needed. */
export async function purgeExpiredRevocations(now = new Date()): Promise<number> {
  return (await prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}
