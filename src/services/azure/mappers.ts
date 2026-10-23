import type { RawBuild, RawIdentity } from "../../lib/azure/azure-api.types.js";
import type { BuildSummary, IdentityRef } from "../../types/azure.types.js";

export function toIdentityRef(raw: unknown): IdentityRef | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const identity = raw as RawIdentity;

  return {
    id: identity.id ?? null,
    displayName: identity.displayName ?? identity.uniqueName ?? "Unknown",
    uniqueName: identity.uniqueName ?? null,
  };
}

export function requireIdentityRef(raw: unknown): IdentityRef {
  return (
    toIdentityRef(raw) ?? { id: null, displayName: "Unknown", uniqueName: null }
  );
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toBuildSummary(raw: RawBuild): BuildSummary {
  return {
    id: raw.id,
    buildNumber: raw.buildNumber ?? String(raw.id),
    definitionId: raw.definition?.id ?? 0,
    definitionName: raw.definition?.name ?? "Unknown pipeline",
    projectName: raw.project?.name ?? null,
    status: raw.status ?? "none",
    result: raw.result && raw.result !== "none" ? raw.result : null,
    sourceBranch: raw.sourceBranch ?? null,
    sourceVersion: raw.sourceVersion ?? null,
    reason: raw.reason ?? null,
    requestedFor: toIdentityRef(raw.requestedFor),
    queueTime: raw.queueTime ?? null,
    startTime: raw.startTime ?? null,
    finishTime: raw.finishTime ?? null,
    webUrl: raw._links?.web?.href ?? null,
  };
}

export function stripRefPrefix(ref: string | null | undefined): string | null {
  return ref ? ref.replace(/^refs\/heads\//, "") : null;
}
