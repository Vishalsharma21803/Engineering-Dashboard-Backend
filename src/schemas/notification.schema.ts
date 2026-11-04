import { z } from "zod";

const projectNameSchema = z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u, "Invalid project name");

export const listNotificationsQuerySchema = z
  .object({
    credentialId: z.string().uuid("Invalid credential id"),
    projectName: projectNameSchema.optional(),
  })
  .strict();

export const notificationIdSchema = z.string().uuid("Invalid notification id");

export const updateNotificationSchema = z
  .object({
    status: z.enum(["UNREAD", "READ", "ABANDONED"]),
  })
  .strict();

export const readAllNotificationsSchema = z
  .object({
    credentialId: z.string().uuid("Invalid credential id"),
    projectName: projectNameSchema.optional(),
  })
  .strict();
