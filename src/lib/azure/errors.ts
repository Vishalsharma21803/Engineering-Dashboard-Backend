export type AzureErrorReason =
  | "AZURE_PAT_INVALID"
  | "AZURE_INSUFFICIENT_SCOPE"
  | "AZURE_NOT_FOUND"
  | "AZURE_THROTTLED"
  | "AZURE_CONFLICT"
  | "AZURE_BAD_REQUEST"
  | "AZURE_UPSTREAM_ERROR";

const HTTP_STATUS_BY_REASON: Record<AzureErrorReason, number> = {
  // Never 401: the frontend treats any 401 as a lost Relay session.
  AZURE_PAT_INVALID: 424,
  AZURE_INSUFFICIENT_SCOPE: 403,
  AZURE_NOT_FOUND: 404,
  AZURE_THROTTLED: 503,
  AZURE_CONFLICT: 409,
  AZURE_BAD_REQUEST: 422,
  AZURE_UPSTREAM_ERROR: 502,
};

const MESSAGE_BY_REASON: Record<AzureErrorReason, string> = {
  AZURE_PAT_INVALID:
    "The Azure DevOps PAT is invalid or expired. Update the credential.",
  AZURE_INSUFFICIENT_SCOPE:
    "The Azure DevOps PAT does not have permission for this resource",
  AZURE_NOT_FOUND: "The Azure DevOps resource was not found",
  AZURE_THROTTLED:
    "Azure DevOps is rate limiting requests. Try again shortly.",
  AZURE_CONFLICT:
    "The Azure DevOps resource changed. Refresh and try again.",
  AZURE_BAD_REQUEST: "Azure DevOps rejected the request",
  AZURE_UPSTREAM_ERROR: "Azure DevOps request failed",
};

export class AzureApiError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly reason: AzureErrorReason,
    readonly upstreamStatus: number | null,
    readonly retryAfterSeconds: number | null = null,
    readonly upstreamMessage: string | null = null
  ) {
    super(
      upstreamStatus === null
        ? `Azure DevOps request failed (${reason})`
        : `Azure DevOps request failed with status ${upstreamStatus} (${reason})`
    );
    this.name = "AzureApiError";
    this.httpStatus = HTTP_STATUS_BY_REASON[reason];
  }

  get publicMessage(): string {
    return MESSAGE_BY_REASON[this.reason];
  }
}

export function reasonForStatus(status: number): AzureErrorReason {
  if (status === 203 || status === 401 || (status >= 300 && status < 400)) {
    return "AZURE_PAT_INVALID";
  }

  if (status === 403) {
    return "AZURE_INSUFFICIENT_SCOPE";
  }

  if (status === 404) {
    return "AZURE_NOT_FOUND";
  }

  if (status === 429) {
    return "AZURE_THROTTLED";
  }

  if (status === 409 || status === 412) {
    return "AZURE_CONFLICT";
  }

  if (status === 400) {
    return "AZURE_BAD_REQUEST";
  }

  return "AZURE_UPSTREAM_ERROR";
}
