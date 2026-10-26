import { AiProviderError, parseRetryAfter, providerMessage, type AiEffort, type AiModelOption, type KeyValidationResult } from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const TIMEOUT_MS = 120_000;
const MODELS_CACHE_TTL_MS = 60 * 60_000;
const EFFORT_VALUES: Record<string, AiEffort> = { low: "LOW", medium: "MEDIUM", high: "HIGH" };

interface RawOpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_parameters?: string[];
  reasoning?: { supported_efforts?: string[] | null } | null;
}

let modelsCache: { expiresAt: number; models: AiModelOption[] } | null = null;

/** Exposed for tests. */
export function clearOpenRouterModelsCache(): void {
  modelsCache = null;
}

function headers(apiKey: string | null): Record<string, string> {
  return {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    "X-OpenRouter-Title": "Engineer Cockpit",
  };
}

export async function openRouterFetch(
  path: string,
  apiKey: string | null,
  init: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<Response> {
  try {
    return await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...headers(apiKey),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AiProviderError("AI_UPSTREAM_ERROR");
  }
}

export async function toOpenRouterError(response: Response): Promise<AiProviderError> {
  const detail = providerMessage(await response.text().catch(() => ""));

  switch (response.status) {
    case 401:
      return new AiProviderError("AI_KEY_INVALID", null, null, detail);
    case 402:
      return new AiProviderError("AI_NO_CREDIT", null, null, detail);
    case 403:
      return new AiProviderError("AI_PERMISSION_DENIED", null, null, detail);
    case 404:
      return new AiProviderError("AI_MODEL_UNAVAILABLE", null, null, detail);
    case 429:
      return new AiProviderError("AI_RATE_LIMITED", parseRetryAfter(response.headers.get("retry-after")), null, detail);
    default:
      return new AiProviderError("AI_UPSTREAM_ERROR", null, null, detail);
  }
}

function perMillion(value: string | undefined): number {
  const perToken = Number(value ?? "0");
  return Number.isFinite(perToken) && perToken > 0 ? Math.round(perToken * 1_000_000 * 10_000) / 10_000 : 0;
}

export function toModelOption(raw: RawOpenRouterModel): AiModelOption {
  const input = perMillion(raw.pricing?.prompt);
  const output = perMillion(raw.pricing?.completion);
  const free = raw.id.endsWith(":free") || (input === 0 && output === 0);
  const supported = raw.supported_parameters ?? [];
  const reasoningSupported = supported.includes("reasoning") || raw.reasoning !== undefined && raw.reasoning !== null;
  const allowedEfforts = raw.reasoning?.supported_efforts;

  const efforts: AiEffort[] = !reasoningSupported
    ? []
    : allowedEfforts === null || allowedEfforts === undefined
      ? ["LOW", "MEDIUM", "HIGH"]
      : (["low", "medium", "high"] as const)
          .filter((effort) => allowedEfforts.includes(effort))
          .map((effort) => EFFORT_VALUES[effort] as AiEffort);

  const cacheRead = raw.pricing?.input_cache_read;

  return {
    provider: "OPENROUTER",
    id: raw.id,
    label: raw.name ?? raw.id,
    description: raw.description ? raw.description.slice(0, 200) : null,
    free,
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: cacheRead ? perMillion(cacheRead) : null,
    contextLength: raw.context_length ?? null,
    efforts,
    mayCollectData: free,
  };
}

/**
 * Models that can return schema-checked JSON (required for SOP verdicts),
 * cached for an hour. The model list is public; the key is sent when present.
 */
export async function listOpenRouterModels(apiKey: string | null): Promise<AiModelOption[]> {
  if (modelsCache && modelsCache.expiresAt > Date.now()) {
    return modelsCache.models;
  }

  const response = await openRouterFetch("/models?supported_parameters=structured_outputs", apiKey);

  if (!response.ok) {
    throw await toOpenRouterError(response);
  }

  const payload = (await response.json()) as { data?: RawOpenRouterModel[] };
  const models = (payload.data ?? [])
    .filter((model) => (model.supported_parameters ?? []).includes("structured_outputs"))
    .map(toModelOption)
    .sort((a, b) => Number(b.free) - Number(a.free) || a.label.localeCompare(b.label));

  modelsCache = { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models };
  return models;
}

interface RawKeyInfo {
  data?: {
    label?: string;
    limit?: number | null;
    limit_remaining?: number | null;
    usage?: number;
    is_free_tier?: boolean;
    free_model_daily_requests?: { used?: number; limit?: number; remaining?: number };
  };
}

export async function validateOpenRouterKey(apiKey: string): Promise<KeyValidationResult> {
  const response = await openRouterFetch("/key", apiKey);

  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { valid: false, reason: response.status === 401 ? "AI_KEY_INVALID" : "AI_PERMISSION_DENIED" };
  }

  if (!response.ok) {
    throw await toOpenRouterError(response);
  }

  const info = ((await response.json()) as RawKeyInfo).data ?? {};

  return {
    valid: true,
    details: {
      creditLimit: info.limit ?? null,
      creditRemaining: info.limit_remaining ?? null,
      paidBefore: info.is_free_tier === undefined ? null : !info.is_free_tier,
      freeRequestsToday: info.free_model_daily_requests?.used ?? null,
      freeRequestsDailyLimit: info.free_model_daily_requests?.limit ?? null,
    },
  };
}
