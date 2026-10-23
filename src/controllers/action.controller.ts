import type { Request, Response } from "express";

import {
  actionIdSchema,
  approveActionSchema,
  listActionsQuerySchema,
  listAuditLogsQuerySchema,
  proposeActionSchema,
  rejectActionSchema,
} from "../schemas/action.schema.js";
import {
  approveAction,
  getAction,
  listActions,
  proposeAction,
  rejectAction,
} from "../services/actions/action.service.js";
import { listAuditLogs } from "../services/audit.service.js";
import { getRequestContext, sendError, sendValidationError } from "./controller-helpers.js";

function getUserId(req: Request, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }

  return req.userId;
}

function parseActionId(req: Request, res: Response): string | null {
  const result = actionIdSchema.safeParse(req.params.id);

  if (!result.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: [{ field: "id", message: "Invalid action id" }],
    });
    return null;
  }

  return result.data;
}

/** Creates a PENDING action with a preview. Never writes to Azure DevOps. */
export async function proposeActionController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = proposeActionSchema.safeParse(req.body);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const action = await proposeAction(userId, result.data, getRequestContext(req));
    res.status(201).json({ message: "Action proposed", action });
  } catch (error) {
    await sendError(res, error, "Proposing action failed", {
      userId,
      credentialId: result.data.credentialId,
    });
  }
}

export async function listActionsController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = listActionsQuerySchema.safeParse(req.query);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const actions = await listActions(userId, result.data, getRequestContext(req));
    res.status(200).json({ actions });
  } catch (error) {
    await sendError(res, error, "Listing actions failed");
  }
}

export async function getActionController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);
  const actionId = userId ? parseActionId(req, res) : null;

  if (!userId || !actionId) {
    return;
  }

  try {
    const action = await getAction(userId, actionId, getRequestContext(req));
    res.status(200).json({ action });
  } catch (error) {
    await sendError(res, error, "Fetching action failed");
  }
}

/** The only endpoint that changes Azure DevOps, and only for an approved, matching payload. */
export async function approveActionController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);
  const actionId = userId ? parseActionId(req, res) : null;

  if (!userId || !actionId) {
    return;
  }

  const result = approveActionSchema.safeParse(req.body ?? {});

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const { action, verification } = await approveAction(
      userId,
      actionId,
      result.data.payloadHash,
      getRequestContext(req)
    );
    res.status(200).json({ message: "Action executed", action, verification });
  } catch (error) {
    await sendError(res, error, "Approving action failed");
  }
}

export async function rejectActionController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);
  const actionId = userId ? parseActionId(req, res) : null;

  if (!userId || !actionId) {
    return;
  }

  const result = rejectActionSchema.safeParse(req.body ?? {});

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const action = await rejectAction(userId, actionId, result.data.reason, getRequestContext(req));
    res.status(200).json({ message: "Action rejected", action });
  } catch (error) {
    await sendError(res, error, "Rejecting action failed");
  }
}

export async function listAuditLogsController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = listAuditLogsQuerySchema.safeParse(req.query);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const auditLogs = await listAuditLogs(userId, result.data);
    res.status(200).json({ auditLogs });
  } catch (error) {
    await sendError(res, error, "Listing audit logs failed");
  }
}
