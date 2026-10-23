import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const PAYLOAD_VERSION = "v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();

  if (!encodedKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
  }

  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key"
    );
  }

  return key;
}

export function assertEncryptionConfigured(): void {
  getEncryptionKey();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    PAYLOAD_VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");

  if (parts.length !== 4) {
    throw new Error("INVALID_ENCRYPTED_VALUE");
  }

  const [version, ivValue, authTagValue, ciphertextValue] = parts;

  if (
    version !== PAYLOAD_VERSION ||
    !ivValue ||
    !authTagValue ||
    !ciphertextValue
  ) {
    throw new Error("INVALID_ENCRYPTED_VALUE");
  }

  const iv = Buffer.from(ivValue, "base64");
  const authTag = Buffer.from(authTagValue, "base64");
  const ciphertext = Buffer.from(ciphertextValue, "base64");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("INVALID_ENCRYPTED_VALUE");
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      getEncryptionKey(),
      iv
    );

    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("INVALID_ENCRYPTED_VALUE");
  }
}
