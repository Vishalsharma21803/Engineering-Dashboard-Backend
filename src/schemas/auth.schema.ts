
import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().email("Invalid email address").toLowerCase(),
  // bcrypt only uses the first 72 bytes; longer (e.g. multi-byte) passwords would be silently truncated.
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must not exceed 72 bytes"),
});

export const loginSchema = z.object({
  email: z.string().trim().email("Invalid email address").toLowerCase(),
  password: z
    .string()
    .min(1, "Password is required")
    .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must not exceed 72 bytes"),
});
