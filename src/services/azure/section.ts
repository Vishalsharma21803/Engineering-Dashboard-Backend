import { AzureApiError } from "../../lib/azure/errors.js";
import type { Section } from "../../types/azure.types.js";
import { logFallback } from "../../lib/log-fallback.js";

/**
 * Runs one dashboard section. A missing scope or upstream failure only
 * degrades that section; an invalid PAT still fails the whole request.
 */
export async function toSection<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { status: "ok", data: await fn(), reason: null };
  } catch (error) {
    if (error instanceof AzureApiError) {
      if (error.reason === "AZURE_PAT_INVALID") {
        throw error;
      }

      if (error.reason !== "AZURE_INSUFFICIENT_SCOPE") logFallback("An Azure section could not be read", error);

      return {
        status:
          error.reason === "AZURE_INSUFFICIENT_SCOPE" ? "forbidden" : "error",
        data: null,
        reason: error.reason,
      };
    }

    console.error(
      "Azure section failed:",
      error instanceof Error ? error.message : "Unknown error"
    );

    return { status: "error", data: null, reason: "INTERNAL_ERROR" };
  }
}

export function sectionData<T>(section: Section<T>, fallback: T): T {
  return section.status === "ok" && section.data !== null
    ? section.data
    : fallback;
}
