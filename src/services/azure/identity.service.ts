import type { AzureClient } from "../../lib/azure/client.js";
import type { RawConnectionData } from "../../lib/azure/azure-api.types.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import type { AzureIdentity } from "../../types/azure.types.js";

const IDENTITY_CACHE_TTL_MS = 10 * 60_000;

export async function getIdentity(client: AzureClient): Promise<AzureIdentity> {
  const data = await client.get<RawConnectionData>(["_apis", "connectionData"], {
    apiVersion: null,
    cacheTtlMs: IDENTITY_CACHE_TTL_MS,
  });

  const user = data.authenticatedUser;

  if (!user?.id) {
    throw new AzureApiError("AZURE_PAT_INVALID", 200);
  }

  return {
    id: user.id,
    displayName:
      user.customDisplayName ?? user.providerDisplayName ?? "Unknown user",
    email: user.properties?.Account?.$value ?? null,
  };
}
