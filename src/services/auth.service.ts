
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import type { LoginInput, RegisterInput } from "../types/auth.types.js";

/** A bcrypt hash (cost 12) of a random value; compared against when the email is unknown. */
const DUMMY_HASH = bcrypt.hashSync(Math.random().toString(36), 12);

export async function registerUser(input: RegisterInput) {
  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
  });

  if (existingUser) {
    throw new Error("EMAIL_ALREADY_REGISTERED");
  }

  const hashedPassword = await bcrypt.hash(input.password, 12);

  return prisma.user.create({
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
