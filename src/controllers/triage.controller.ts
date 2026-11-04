import type { Request, Response } from "express";

import {
  listTriageQuerySchema,
  triageIdSchema,
  upsertTriageSchema,
} from "../schemas/triage.schema.js";
import {
  deleteTriageMark,
  listTriageMarks,
  upsertTriageMark,
} from "../services/triage.service.js";
import { sendError, sendValidationError } from "./controller-helpers.js";

function getUserId(req: Request, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json({
      message: "Authentication required",
      reason: "AUTH_REQUIRED",
    });
    return null;
  }

  return req.userId;
}

export async function listTriageController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = listTriageQuerySchema.safeParse(req.query);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const marks = await listTriageMarks(userId, result.data.credentialId);
    res.status(200).json({ marks });
  } catch (error) {
    await sendError(res, error, "Listing triage marks failed");
  }
}

/** Creates or replaces the mark for one item. Never writes to Azure DevOps. */
export async function upsertTriageController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const result = upsertTriageSchema.safeParse(req.body);

  if (!result.success) {
    sendValidationError(res, result.error);
    return;
  }

  try {
    const mark = await upsertTriageMark(userId, result.data);
    res.status(200).json({ message: "Triage saved", mark });
  } catch (error) {
    await sendError(res, error, "Saving triage mark failed");
  }
}

export async function deleteTriageController(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req, res);

  if (!userId) {
    return;
  }

  const idResult = triageIdSchema.safeParse(req.params.id);

  if (!idResult.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: [{ field: "id", message: "Invalid triage mark id" }],
    });
    return;
  }

  try {
    await deleteTriageMark(userId, idResult.data);
    res.status(200).json({ message: "Triage cleared" });
  } catch (error) {
    await sendError(res, error, "Clearing triage mark failed");
  }
}
