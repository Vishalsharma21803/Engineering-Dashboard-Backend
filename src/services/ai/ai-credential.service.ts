import { AppError } from "../../lib/app-error.js";
import { validateClaudeKey } from "../../lib/ai/claude.js";
import { validateOpenRouterKey } from "../../lib/ai/openrouter.js";
import { validateOpenCodeKey } from "../../lib/ai/opencode.js";
import type { AiProvider, KeyValidationResult } from "../../lib/ai/types.js";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";
import { prisma } from "../../lib/prisma.js";
import { ValidationStatus } from "../../generated/prisma/enums.js";

const aiCredentialSelect = {
  id: true,
  provider: true,
  label: true,
  keyHint: true,
  lastValidatedAt: true,
  lastValidationStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export async function listAiCredentials(userId: string) {
  return prisma.aiCredential.findMany({
    where: { userId },
    select: aiCredentialSelect,
    orderBy: { provider: "asc" },
  });
}

export async function createAiCredential(
  userId: string,
  input: { provider: AiProvider; apiKey: string; label?: string | undefined }
) {
  try {
    return await prisma.aiCredential.create({
      data: {
        userId,
        provider: input.provider,
        label: input.label ?? null,
        encryptedApiKey: encryptSecret(input.apiKey),
        keyHint: keyHint(input.apiKey),
      },
      select: aiCredentialSelect,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError(409, "AI_CREDENTIAL_EXISTS", "You already have a key for this provider. Replace it instead.");
    }

    throw error;
  }
}

export async function updateAiCredential(
  userId: string,
  credentialId: string,
  input: { apiKey?: string | undefined; label?: string | null | undefined }
) {
  const result = await prisma.aiCredential.updateMany({
    where: { id: credentialId, userId },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.apiKey !== undefined
        ? {
            encryptedApiKey: encryptSecret(input.apiKey),
            keyHint: keyHint(input.apiKey),
            lastValidatedAt: null,
            lastValidationStatus: null,
          }
        : {}),
    },
  });

  if (result.count === 0) {
    throw new AppError(404, "AI_CREDENTIAL_NOT_FOUND", "AI key not found");
  }

  return prisma.aiCredential.findFirstOrThrow({
    where: { id: credentialId, userId },
    select: aiCredentialSelect,
  });
}

export async function deleteAiCredential(userId: string, credentialId: string): Promise<void> {
  const credential = await prisma.aiCredential.findFirst({
    where: { id: credentialId, userId },
    select: { provider: true },
  });

  if (!credential) {
    throw new AppError(404, "AI_CREDENTIAL_NOT_FOUND", "AI key not found");
  }

  await prisma.$transaction([
    prisma.aiCredential.deleteMany({ where: { id: credentialId, userId } }),
    // A preference pointing at a deleted key would make checks fail later.
    prisma.aiPreference.updateMany({
      where: { userId, provider: credential.provider },
      data: { provider: null, model: null },
    }),
  ]);
}

/** Decrypted key for server-side calls only. Never return it to clients. */
export async function getAiApiKey(userId: string, provider: AiProvider): Promise<string | null> {
  const credential = await prisma.aiCredential.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { encryptedApiKey: true },
  });

  if (!credential) {
    return null;
  }

  try {
    return decryptSecret(credential.encryptedApiKey);
  } catch {
    throw new AppError(500, "AI_CREDENTIAL_UNREADABLE", "Stored AI key could not be read");
  }
}

export async function validateAiCredential(
  userId: string,
  credentialId: string
): Promise<KeyValidationResult & { lastValidatedAt: Date }> {
  const credential = await prisma.aiCredential.findFirst({
    where: { id: credentialId, userId },
    select: { provider: true },
  });

  if (!credential) {
    throw new AppError(404, "AI_CREDENTIAL_NOT_FOUND", "AI key not found");
  }

  const apiKey = await getAiApiKey(userId, credential.provider);

  if (!apiKey) {
    throw new AppError(404, "AI_CREDENTIAL_NOT_FOUND", "AI key not found");
  }

  const result =
    credential.provider === "CLAUDE"
      ? await validateClaudeKey(apiKey)
      : credential.provider === "OPENCODE"
        ? await validateOpenCodeKey(apiKey)
        : await validateOpenRouterKey(apiKey);
  const lastValidatedAt = new Date();

  await prisma.aiCredential.updateMany({
    where: { id: credentialId, userId },
    data: {
      lastValidatedAt,
      lastValidationStatus: result.valid ? ValidationStatus.VALID : ValidationStatus.INVALID,
    },
  });

  return { ...result, lastValidatedAt };
}
