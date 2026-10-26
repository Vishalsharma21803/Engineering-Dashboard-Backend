import Anthropic from "@anthropic-ai/sdk";

import { AiProviderError, parseRetryAfter, providerMessage, type AiModelOption, type KeyValidationResult } from "./types.js";

const TIMEOUT_MS = 120_000;
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Claude models offered to users. Prices are Anthropic first-party rates
 * (USD per million tokens). Every current model accepts low/medium/high effort.
 */
export const CLAUDE_MODELS: AiModelOption[] = [
  {
    provider: "CLAUDE",
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Most capable. Best judgement on wording-based SOP rules.",
    free: false,
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    contextLength: 1_000_000,
    efforts: ["LOW", "MEDIUM", "HIGH"],
    mayCollectData: false,
  },
  {
    provider: "CLAUDE",
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    description: "Balanced speed, quality and cost.",
    free: false,
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    contextLength: 1_000_000,
    efforts: ["LOW", "MEDIUM", "HIGH"],
    mayCollectData: false,
  },
  {
    provider: "CLAUDE",
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    description: "Fastest and cheapest. Prices shown are for prompts up to 100K tokens.",
    free: false,
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: null,
    contextLength: 1_000_000,
    efforts: ["LOW", "MEDIUM", "HIGH"],
    mayCollectData: false,
  },
];

export function createClaudeClient(apiKey: string): Anthropic {
  // The host is fixed so an environment variable (ANTHROPIC_BASE_URL) can never send user keys elsewhere.
  return new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL, timeout: TIMEOUT_MS, maxRetries: 1 });
}

/** Maps SDK errors to provider-neutral reasons, most specific first. */
export function toClaudeError(error: unknown): AiProviderError {
  // The API error's own message (e.g. which limit was hit), without the SDK's status prefix.
  const detail =
    error instanceof Anthropic.APIError && error.error && typeof error.error === "object"
      ? providerMessage(JSON.stringify(error.error))
      : null;

  if (error instanceof Anthropic.AuthenticationError) {
    return new AiProviderError("AI_KEY_INVALID", null, null, detail);
  }

  if (error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError("AI_PERMISSION_DENIED", null, null, detail);
  }

  if (error instanceof Anthropic.NotFoundError) {
    return new AiProviderError("AI_MODEL_UNAVAILABLE", null, null, detail);
  }

  if (error instanceof Anthropic.RateLimitError) {
    return new AiProviderError("AI_RATE_LIMITED", parseRetryAfter(error.headers?.get("retry-after")), null, detail);
  }

  if (error instanceof Anthropic.BadRequestError && /credit balance/i.test(error.message)) {
    return new AiProviderError("AI_NO_CREDIT", null, null, detail);
  }

  return new AiProviderError("AI_UPSTREAM_ERROR", null, null, detail);
}

/** Lists models with the key: free, and proves the key works. */
export async function validateClaudeKey(apiKey: string): Promise<KeyValidationResult> {
  try {
    const page = await createClaudeClient(apiKey).models.list({ limit: 20 });
    const available = new Set(page.data.map((model) => model.id));

    return {
      valid: true,
      details: {
        modelsAvailable: CLAUDE_MODELS.filter((model) => available.has(model.id))
          .map((model) => model.label)
          .join(", "),
      },
    };
  } catch (error) {
    const mapped = toClaudeError(error);

    if (mapped.reason === "AI_KEY_INVALID" || mapped.reason === "AI_PERMISSION_DENIED") {
      return { valid: false, reason: mapped.reason };
    }

    throw mapped;
  }
}
