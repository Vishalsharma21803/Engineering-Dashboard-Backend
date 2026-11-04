import type { Request, Response } from "express";

import {
  listNotificationsQuerySchema,
  notificationIdSchema,
  readAllNotificationsSchema,
  updateNotificationSchema,
} from "../schemas/notification.schema.js";
import {
  listNotifications,
  markAllNotificationsRead,
  setNotificationStatus,
} from "../services/notifications/notification.service.js";
import { sendError, sendValidationError } from "./controller-helpers.js";

function getUserId(req: Request, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }

  return req.userId;
}

export async function listNotificationsController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = listNotificationsQuerySchema.safeParse(req.query);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const notifications = await listNotifications(userId, result.data.credentialId, result.data.projectName);
    res.status(200).json({ notifications });
  } catch (error) {
    await sendError(res, error, "Listing notifications failed");
  }
}

/** Read, unread or abandoned. Never removes the notification and never writes to Azure DevOps. */
export async function updateNotificationController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const idResult = notificationIdSchema.safeParse(req.params.id);

  if (!idResult.success) {
    res.status(400).json({ message: "Validation failed", errors: [{ field: "id", message: "Invalid notification id" }] });
    return;
  }

  const result = updateNotificationSchema.safeParse(req.body);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const notification = await setNotificationStatus(userId, idResult.data, result.data.status);
    res.status(200).json({ message: "Notification updated", notification });
  } catch (error) {
    await sendError(res, error, "Updating notification failed");
  }
}

export async function readAllNotificationsController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = readAllNotificationsSchema.safeParse(req.body);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const count = await markAllNotificationsRead(userId, result.data.credentialId, result.data.projectName);
    res.status(200).json({ message: "Notifications marked as read", count });
  } catch (error) {
    await sendError(res, error, "Marking notifications as read failed");
  }
}
