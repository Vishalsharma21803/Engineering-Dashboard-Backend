import { logFallback, networkFailure } from "../lib/log-fallback.js";

const AZURE_DEVOPS_API_VERSION = "7.1";
const AZURE_DEVOPS_TIMEOUT_MS = 10_000;
const PROJECTS_PAGE_SIZE = "1";

export type PatValidationReason =
  | "INVALID_PAT"
  | "INSUFFICIENT_SCOPE"
  | "ORGANIZATION_NOT_FOUND";

export type PatValidationResult =
  | { valid: true }
  | { valid: false; reason: PatValidationReason };

export class AzureDevOpsUpstreamError extends Error {
  constructor(readonly status: number | null) {
    super(
      status === null
        ? "Azure DevOps request failed"
        : `Azure DevOps request failed with status ${status}`
    );
    this.name = "AzureDevOpsUpstreamError";
  }
}

export async function validateAzurePat(
  organizationUrl: string,
  patToken: string
): Promise<PatValidationResult> {
  // Append rather than resolve: "/_apis" would drop the /<org> path segment.
  const url = new URL(
    `${organizationUrl.replace(/\/+$/, "")}/_apis/projects`
  );

  url.searchParams.set("api-version", AZURE_DEVOPS_API_VERSION);
  url.searchParams.set("$top", PROJECTS_PAGE_SIZE);

  const authorization = `Basic ${Buffer.from(
    `:${patToken}`,
    "utf8"
  ).toString("base64")}`;

  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(AZURE_DEVOPS_TIMEOUT_MS),
    });
  } catch (error) {
    logFallback("Validating an Azure DevOps token: no answer from Azure", new Error(networkFailure(error)));
    throw new AzureDevOpsUpstreamError(null);
  }

  // Only the status and content type matter: the body is released so the connection can be reused.
  await response.body?.cancel().catch(() => undefined);

  if (response.status === 200) {
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return { valid: false, reason: "INVALID_PAT" };
    }

    return { valid: true };
  }

  if (
    response.status === 203 ||
    response.status === 401 ||
    (response.status >= 300 && response.status < 400)
  ) {
    return { valid: false, reason: "INVALID_PAT" };
  }

  if (response.status === 403) {
    return { valid: false, reason: "INSUFFICIENT_SCOPE" };
  }

  if (response.status === 404) {
    return { valid: false, reason: "ORGANIZATION_NOT_FOUND" };
  }

  throw new AzureDevOpsUpstreamError(response.status);
}
