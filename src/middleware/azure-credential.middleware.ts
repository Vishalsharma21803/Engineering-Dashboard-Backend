import type { NextFunction, Request, Response } from "express";

import { sendError } from "../controllers/controller-helpers.js";
import { credentialIdSchema } from "../schemas/credential.schema.js";
import { refreshQuerySchema } from "../schemas/azure.schema.js";
import { createAzureClientForCredential } from "../services/azure/azure-context.service.js";

/** Resolves :credentialId for the signed-in user and attaches an Azure client. */
export async function loadAzureCredential(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({
      message: "Authentication required",
      reason: "AUTH_REQUIRED",
    });
    return;
  }

  const idResult = credentialIdSchema.safeParse(req.params.credentialId);

  if (!idResult.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: [{ field: "credentialId", message: "Invalid credential id" }],
    });
    return;
  }

  const refresh = refreshQuerySchema.safeParse(req.query);

  try {
    const client = await createAzureClientForCredential(req.userId, idResult.data, {
      refresh: refresh.success ? refresh.data.refresh : false,
    });

    if (!client) {
      res.status(404).json({ message: "Credential not found" });
      return;
    }

    req.azure = { client, credentialId: idResult.data };
    next();
  } catch (error) {
    await sendError(res, error, "Loading Azure credential failed");
  }
}
