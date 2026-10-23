import type { AzureClient } from "../../lib/azure/client.js";
import type { RawList, RawProject } from "../../lib/azure/azure-api.types.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import type {
  Capabilities,
  ScopeStatus,
  WriteScopeArea,
} from "../../types/azure.types.js";
import { getIdentity } from "./identity.service.js";

async function probe(fn: () => Promise<unknown>): Promise<ScopeStatus> {
  try {
    await fn();
    return "granted";
  } catch (error) {
    if (error instanceof AzureApiError) {
      if (error.reason === "AZURE_PAT_INVALID") {
        throw error;
      }

      if (error.reason === "AZURE_INSUFFICIENT_SCOPE") {
        return "missing";
      }
    }

    return "unknown";
  }
}

/**
 * A PAT cannot list its own scopes, so each read area is probed with one
 * cheap request. Write scopes cannot be probed without writing; they are
 * learned from executed actions (see learnedWriteScopes).
 */
export async function getCapabilities(
  client: AzureClient,
  writeScopes: Record<WriteScopeArea, ScopeStatus>
): Promise<Capabilities> {
  const identity = await getIdentity(client);
  let projectId = null as string | null;

  const project = await probe(async () => {
    const data = await client.get<RawList<RawProject>>(["_apis", "projects"], {
      query: { $top: 1 },
      cacheTtlMs: 0,
    });
    projectId = data.value?.[0]?.id ?? null;
  });

  const probeProjectId = projectId;
  const inProject = (fn: (id: string) => Promise<unknown>) =>
    probeProjectId === null
      ? Promise.resolve<ScopeStatus>("unknown")
      : probe(() => fn(probeProjectId));

  const [work, code, build, release, environment] = await Promise.all([
    probe(() =>
      client.readPost(
        ["_apis", "wit", "wiql"],
        { query: "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0" },
        { query: { $top: 1 }, cacheTtlMs: 0 }
      )
    ),
    inProject((id) => client.get([id, "_apis", "git", "repositories"], { cacheTtlMs: 0 })),
    inProject((id) =>
      client.get([id, "_apis", "build", "definitions"], { query: { $top: 1 }, cacheTtlMs: 0 })
    ),
    inProject((id) =>
      client.get([id, "_apis", "release", "definitions"], {
        host: "vsrm",
        query: { $top: 1 },
        cacheTtlMs: 0,
      })
    ),
    inProject((id) =>
      client.get([id, "_apis", "distributedtask", "environments"], {
        apiVersion: "7.1-preview.1",
        query: { $top: 1 },
        cacheTtlMs: 0,
      })
    ),
  ]);

  return {
    identity,
    scopes: { project, work, code, build, release, environment },
    writeScopes,
  };
}
