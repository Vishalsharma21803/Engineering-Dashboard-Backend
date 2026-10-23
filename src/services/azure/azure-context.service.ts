import { AppError } from "../../lib/app-error.js";
import { AzureClient } from "../../lib/azure/client.js";
import { decryptSecret } from "../../lib/encryption.js";
import { ValidationStatus } from "../../generated/prisma/enums.js";
import {
  getCredentialWithSecret,
  recordValidationResult,
} from "../credential.service.js";

/**
 * Decrypts the PAT for one request. The token only lives inside the
 * returned client (in a private field) and is never logged or returned.
 */
export async function createAzureClientForCredential(
  userId: string,
  credentialId: string,
  options: { refresh?: boolean } = {}
): Promise<AzureClient | null> {
  const credential = await getCredentialWithSecret(userId, credentialId);

  if (!credential) {
    return null;
  }

  let patToken: string;

  try {
    patToken = decryptSecret(credential.encryptedPatToken);
  } catch {
    console.error("Decrypting credential failed:", credential.id);
    throw new AppError(500, "CREDENTIAL_UNREADABLE", "Stored credential could not be read");
  }

  return new AzureClient({
    credentialId: credential.id,
    organizationUrl: credential.organizationUrl,
    patToken,
    refresh: options.refresh ?? false,
  });
}

/** Keeps the credential list honest when Azure rejects the PAT mid-session. */
export async function markCredentialInvalid(userId: string, credentialId: string): Promise<void> {
  try {
    await recordValidationResult(userId, credentialId, ValidationStatus.INVALID);
  } catch (error) {
    console.error(
      "Recording validation result failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}
