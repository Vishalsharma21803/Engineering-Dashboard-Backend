import type { NextFunction, Request, Response } from "express";

import { sendError } from "../controllers/controller-helpers.js";
import { credentialIdSchema } from "../schemas/credential.schema.js";
import { refreshQuerySchema } from "../schemas/azure.schema.js";
import { getSolidtimeConnection, solidtimeClientFor } from "../services/solidtime/connection.service.js";

/**
 * Resolves :credentialId to the signed-in user's own Solidtime connection
 * (never an Azure credential) and attaches a client. The organization must be
 * chosen first.
 */
export async function loadSolidtimeConnection(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    res.status(401).json({
      message: "Authentication required",
      reason: "AUTH_REQUIRED",
    });
    return;
  }

  const idResult = credentialIdSchema.safeParse(req.params.credentialId);

  if (!idResult.success) {
    res.status(400).json({ message: "Validation failed", errors: [{ field: "credentialId", message: "Invalid credential id" }] });
    return;
  }

  try {
    const refresh = refreshQuerySchema.safeParse(req.query);
    const client = await solidtimeClientFor(req.userId, idResult.data, { refresh: refresh.success ? refresh.data.refresh : false });

    if (!client) {
      res.status(404).json({ message: "Solidtime connection not found", reason: "CREDENTIAL_NOT_FOUND" });
      return;
    }

    const connection = await getSolidtimeConnection(req.userId, idResult.data);

    if (!connection.organizationId || !connection.memberId) {
      res.status(409).json({ message: "Choose a Solidtime organization for this connection first", reason: "SOLIDTIME_ORGANIZATION_NOT_CHOSEN" });
      return;
    }

    req.solidtime = { client, connection: { ...connection, organizationId: connection.organizationId, memberId: connection.memberId } };
    next();
  } catch (error) {
    await sendError(res, error, "Loading Solidtime connection failed");
  }
}
