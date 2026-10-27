import { prisma } from "../lib/prisma.js";
import { encryptSecret } from "../lib/encryption.js";
import { Platform, ValidationStatus } from "../generated/prisma/enums.js";
import type { Prisma } from "../generated/prisma/client.js";
import type {
  CreateCredentialInput,
  UpdateCredentialInput,
} from "../types/credential.types.js";

const credentialSelect = {
  id: true,
  platform: true,
  organizationUrl: true,
  label: true,
  lastValidatedAt: true,
  lastValidationStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function createCredential(
  userId: string,
  input: CreateCredentialInput
) {
  try {
    return await prisma.credential.create({
      data: {
        userId,
        platform: input.platform,
        organizationUrl: input.organizationUrl,
        label: input.label ?? null,
        encryptedPatToken: encryptSecret(input.patToken),
      },
      select: credentialSelect,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error("CREDENTIAL_ALREADY_EXISTS");
    }

    throw error;
  }
}

export async function updateCredential(
  userId: string,
  credentialId: string,
  input: UpdateCredentialInput
) {
  const data: Prisma.CredentialUpdateManyMutationInput = {};

  if (input.organizationUrl !== undefined) {
    data.organizationUrl = input.organizationUrl;
  }

  if (input.label !== undefined) {
    data.label = input.label;
  }

  if (input.patToken !== undefined) {
    data.encryptedPatToken = encryptSecret(input.patToken);
  }

  if (
    input.organizationUrl !== undefined ||
    input.patToken !== undefined
  ) {
    data.lastValidatedAt = null;
    data.lastValidationStatus = null;
  }

  try {
    // This path edits Azure credentials only; Solidtime connections have their own.
    const result = await prisma.credential.updateMany({
      where: {
        id: credentialId,
        userId,
        platform: Platform.AZURE,
      },
      data,
    });

    if (result.count === 0) {
      return null;
    }

    return await prisma.credential.findFirst({
      where: {
        id: credentialId,
        userId,
      },
      select: credentialSelect,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error("CREDENTIAL_ALREADY_EXISTS");
    }

    throw error;
  }
}

export async function listCredentials(userId: string) {
  return prisma.credential.findMany({
    where: { userId },
    select: credentialSelect,
    orderBy: { createdAt: "desc" },
  });
}

/** Only credentials of the given platform: an Azure route can never load a Solidtime token, and the other way round. */
export async function getCredentialWithSecret(
  userId: string,
  credentialId: string,
  platform: Platform = Platform.AZURE
) {
  return prisma.credential.findFirst({
    where: {
      id: credentialId,
      userId,
      platform,
    },
    select: {
      id: true,
      organizationUrl: true,
      encryptedPatToken: true,
    },
  });
}

export async function deleteCredential(
  userId: string,
  credentialId: string
): Promise<boolean> {
  const result = await prisma.credential.deleteMany({
    where: {
      id: credentialId,
      userId,
    },
  });

  return result.count > 0;
}

export async function recordValidationResult(
  userId: string,
  credentialId: string,
  status: ValidationStatus
): Promise<Date> {
  const validatedAt = new Date();

  await prisma.credential.updateMany({
    where: {
      id: credentialId,
      userId,
    },
    data: {
      lastValidatedAt: validatedAt,
      lastValidationStatus: status,
    },
  });

  return validatedAt;
}
