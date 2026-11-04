import type { Request, Response } from "express";

import {
  createCredentialSchema,
  credentialIdSchema,
  updateCredentialSchema,
} from "../schemas/credential.schema.js";
import {
  createCredential,
  deleteCredential,
  getCredentialWithSecret,
  listCredentials,
  recordValidationResult,
  updateCredential,
} from "../services/credential.service.js";
import {
  AzureDevOpsUpstreamError,
  validateAzurePat,
} from "../services/azure.service.js";
import { decryptSecret } from "../lib/encryption.js";
import { ValidationStatus } from "../generated/prisma/enums.js";
import { noteFailureCause } from "../middleware/failure-log.middleware.js";
import { sendError } from "./controller-helpers.js";

function getAuthenticatedUserId(
  req: Request,
  res: Response
): string | null {
  if (!req.userId) {
    res.status(401).json({
      message: "Authentication required",
      reason: "AUTH_REQUIRED",
    });
    return null;
  }

  return req.userId;
}

function sendInvalidId(res: Response): void {
  res.status(400).json({
    message: "Validation failed",
    errors: [
      {
        field: "id",
        message: "Invalid credential id",
      },
    ],
  });
}

export async function createCredentialController(
  req: Request,
  res: Response
): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);

  if (!userId) {
    return;
  }

  const result = createCredentialSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  try {
    const credential = await createCredential(userId, result.data);

    res.status(201).json({
      message: "Credential saved",
      credential,
    });
  } catch (error) {
    // A duplicate organization is a 409 AppError (CREDENTIAL_ALREADY_EXISTS).
    await sendError(res, error, "Saving the Azure DevOps connection failed");
  }
}

export async function updateCredentialController(
  req: Request,
  res: Response
): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);

  if (!userId) {
    return;
  }

  const idResult = credentialIdSchema.safeParse(req.params.id);

  if (!idResult.success) {
    sendInvalidId(res);
    return;
  }

  const result = updateCredentialSchema.safeParse(req.body ?? {});

  if (!result.success) {
    res.status(400).json({
      message: "Validation failed",
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  try {
    const credential = await updateCredential(
      userId,
      idResult.data,
      result.data
    );

    if (!credential) {
      res.status(404).json({
        message: "Credential not found",
        reason: "CREDENTIAL_NOT_FOUND",
      });
      return;
    }

    res.status(200).json({
      message: "Credential updated",
      credential,
    });
  } catch (error) {
    // A duplicate organization is a 409 AppError (CREDENTIAL_ALREADY_EXISTS).
    await sendError(res, error, "Updating the Azure DevOps connection failed");
  }
}

export async function listCredentialsController(
  req: Request,
  res: Response
): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);

  if (!userId) {
    return;
  }

  try {
    const credentials = await listCredentials(userId);

    res.status(200).json({ credentials });
  } catch (error) {
    await sendError(res, error, "Loading your connections failed");
  }
}

export async function validateCredentialController(
  req: Request,
  res: Response
): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);

  if (!userId) {
    return;
  }

  const idResult = credentialIdSchema.safeParse(req.params.id);

  if (!idResult.success) {
    sendInvalidId(res);
    return;
  }

  let credential: Awaited<
    ReturnType<typeof getCredentialWithSecret>
  >;

  try {
    credential = await getCredentialWithSecret(
      userId,
      idResult.data
    );
  } catch (error) {
    await sendError(res, error, "Loading the credential failed");
    return;
  }

  if (!credential) {
    res.status(404).json({
      message: "Credential not found",
      reason: "CREDENTIAL_NOT_FOUND",
    });
    return;
  }

  let patToken: string;

  try {
    patToken = decryptSecret(credential.encryptedPatToken);
  } catch (error) {
    // The decryption error goes to the log line; the user gets a stable reason.
    noteFailureCause(res, error, `Decrypting credential ${credential.id} failed`);
    res.status(500).json({
      message: "Stored credential could not be read",
      reason: "CREDENTIAL_UNREADABLE",
    });
    return;
  }

  try {
    const validation = await validateAzurePat(
      credential.organizationUrl,
      patToken
    );

    const status = validation.valid
      ? ValidationStatus.VALID
      : ValidationStatus.INVALID;

    const lastValidatedAt = await recordValidationResult(
      userId,
      credential.id,
      status
    );

    if (validation.valid) {
      res.status(200).json({
        valid: true,
        lastValidatedAt,
      });
      return;
    }

    res.status(200).json({
      valid: false,
      reason: validation.reason,
      lastValidatedAt,
    });
  } catch (error) {
    let lastValidatedAt: Date | null = null;

    try {
      lastValidatedAt = await recordValidationResult(
        userId,
        credential.id,
        ValidationStatus.ERROR
      );
    } catch (recordError) {
      console.error(
        "Recording validation result failed:",
        recordError instanceof Error
          ? recordError.message
          : "Unknown error"
      );
    }

    if (error instanceof AzureDevOpsUpstreamError) {
      noteFailureCause(res, error, "Validating the credential with Azure DevOps failed");
      res.status(502).json({
        message: "Unable to validate the credential with Azure DevOps",
        reason: "UPSTREAM_ERROR",
        lastValidatedAt,
      });
      return;
    }

    await sendError(res, error, "Validating the credential failed");
  }
}

export async function deleteCredentialController(
  req: Request,
  res: Response
): Promise<void> {
  const userId = getAuthenticatedUserId(req, res);

  if (!userId) {
    return;
  }

  const idResult = credentialIdSchema.safeParse(req.params.id);

  if (!idResult.success) {
    sendInvalidId(res);
    return;
  }

  try {
    const deleted = await deleteCredential(userId, idResult.data);

    if (!deleted) {
      res.status(404).json({
        message: "Credential not found",
        reason: "CREDENTIAL_NOT_FOUND",
      });
      return;
    }

    res.status(200).json({
      message: "Credential deleted",
    });
  } catch (error) {
    await sendError(res, error, "Deleting the credential failed");
  }
}
