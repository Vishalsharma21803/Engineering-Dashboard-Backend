import { AiProviderError, parseRetryAfter, providerMessage, type AiModelOption, type KeyValidationResult } from "./types.js";
import { networkFailure } from "../log-fallback.js";

/** OpenCode's pay-as-you-go gateway (opencode.ai/console). Keys come from opencode.ai/auth. */
export const OPENCODE_BASE_URL = "https://opencode.ai/inference";
export const OPENCODE_CHAT_PATH = "/openai/v1/chat/completions";

const TIMEOUT_MS = 120_000;
const MODELS_CACHE_TTL_MS = 60 * 60_000;
/** A free model used for the $0 key check. */
const KEY_CHECK_MODEL = "deepseek-v4.1-flash-free";

interface CatalogEntry {
  id: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number | null;
  /** The provider may keep or train on prompts (free trials); needs the user's consent. */
  mayCollectData: boolean;
  description: string;
}

/**
 * OpenCode models served on its OpenAI-compatible chat endpoint. Its model
 * list has no prices or capabilities, so they are kept here (USD per 1M
 * tokens, from opencode.ai/docs/zen). Claude, GPT and Gemini on OpenCode use
 * other API shapes and are not offered; use the Claude provider for Claude.
 */
const CATALOG: CatalogEntry[] = [
  { id: "deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash (free)", input: 0, output: 0, cacheRead: null, mayCollectData: false, description: "Free for a limited time. Zero retention, no training. OpenCode may only allow it inside its own app." },
  { id: "glm-5.3-flash-free", label: "GLM 5.3 Flash (free)", input: 0, output: 0, cacheRead: null, mayCollectData: false, description: "Free for a limited time. Zero retention, no training. OpenCode may only allow it inside its own app." },
  { id: "big-pickle", label: "Big Pickle (free)", input: 0, output: 0, cacheRead: null, mayCollectData: true, description: "Free for a limited time; data may be used to improve the model." },
  { id: "mimo-v2.6-flash-free", label: "MiMo V2.6 Flash (free)", input: 0, output: 0, cacheRead: null, mayCollectData: true, description: "Free for a limited time; data may be used to improve the model." },
  { id: "flint-40b-free", label: "Flint 40B (free)", input: 0, output: 0, cacheRead: null, mayCollectData: true, description: "Free for a limited time; data may be used and is kept 30 days." },
  { id: "beam-free", label: "Beam (free)", input: 0, output: 0, cacheRead: null, mayCollectData: true, description: "Free for a limited time; data kept 30 days. Not available in some regions." },
  { id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra (free)", input: 0, output: 0, cacheRead: null, mayCollectData: true, description: "NVIDIA trial: logged, no confidential data." },
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash", input: 0.15, output: 0.5, cacheRead: 0.03, mayCollectData: false, description: "Very cheap." },
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", input: 0.3, output: 1.2, cacheRead: 0.006, mayCollectData: false, description: "Cheap and fast." },
  { id: "minimax-m3", label: "MiniMax M3", input: 0.3, output: 1.2, cacheRead: 0.06, mayCollectData: false, description: "Cheap." },
  { id: "kimi-k2.5", label: "Kimi K2.5", input: 0.6, output: 3, cacheRead: 0.1, mayCollectData: false, description: "Balanced." },
  { id: "mistral-large-4", label: "Mistral Large 4", input: 0.68, output: 2.09, cacheRead: 0.07, mayCollectData: false, description: "Balanced (discounted price)." },
  { id: "glm-5.3", label: "GLM 5.3", input: 1.4, output: 4.4, cacheRead: 0.26, mayCollectData: false, description: "Stronger reasoning." },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", input: 1.74, output: 3.48, cacheRead: 0.145, mayCollectData: false, description: "Stronger reasoning." },
  { id: "qwen3.8-max", label: "Qwen 3.8 Max", input: 2, output: 6, cacheRead: 0.25, mayCollectData: false, description: "Strongest of these." },
];

let modelsCache: { expiresAt: number; ids: Set<string> } | null = null;

/** Exposed for tests. */
export function clearOpenCodeModelsCache(): void {
  modelsCache = null;
}

function toOption(entry: CatalogEntry): AiModelOption {
  const free = entry.input === 0 && entry.output === 0;
  return {
    provider: "OPENCODE",
    id: entry.id,
    label: entry.label,
    description: entry.description,
    free,
    inputPerMTok: entry.input,
    outputPerMTok: entry.output,
    cacheReadPerMTok: entry.cacheRead,
    contextLength: null,
    // OpenCode does not document an effort setting on this endpoint.
    efforts: [],
    mayCollectData: entry.mayCollectData,
  };
}

export async function openCodeFetch(path: string, apiKey: string | null, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<Response> {
  try {
    return await fetch(`${OPENCODE_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "EngineerCockpit/1.0",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AiProviderError("AI_UPSTREAM_ERROR", null, null, null, networkFailure(error));
  }
}

/**
 * OpenCode refuses its free models outside the OpenCode app: 403 FreeTierError, or
 * 429 FreeUsageLimitError ("Free models work in OpenCode") with a Retry-After until
 * midnight UTC. The 429 is not a quota that refills for outside apps; it is permanent.
 */
async function isFreeTierRefusal(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }

  const text = await response.clone().text().catch(() => "");
  return /FreeTierError|FreeUsageLimitError|free.?tier/i.test(text);
}

export async function toOpenCodeError(response: Response): Promise<AiProviderError> {
  const detail = providerMessage(await response.clone().text().catch(() => ""));
  const reason =
    (await isFreeTierRefusal(response))
      ? "AI_FREE_TIER_BLOCKED"
      : response.status === 401
        ? "AI_KEY_INVALID"
        : response.status === 402
          ? "AI_NO_CREDIT"
          : response.status === 403
            ? "AI_PERMISSION_DENIED"
            : response.status === 404
              ? "AI_MODEL_UNAVAILABLE"
              : response.status === 429
                ? "AI_RATE_LIMITED"
                : "AI_UPSTREAM_ERROR";

  return new AiProviderError(
    reason,
    reason === "AI_RATE_LIMITED" ? parseRetryAfter(response.headers.get("retry-after")) : null,
    null,
    detail
  );
}

/** Catalog models that OpenCode still lists (retired ones drop out). Cached for an hour. */
export async function listOpenCodeModels(): Promise<AiModelOption[]> {
  if (!modelsCache || modelsCache.expiresAt <= Date.now()) {
    const response = await openCodeFetch("/v1/models", null);

    if (!response.ok) {
      throw await toOpenCodeError(response);
    }

    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    modelsCache = {
      expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
      ids: new Set((payload.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string")),
    };
  }

  const live = modelsCache.ids;
  return CATALOG.filter((entry) => live.has(entry.id)).map(toOption);
}

/**
 * Costs nothing: a 1-token request to a free model. 401 = bad key. Any other
 * answer means OpenCode knows the key, and tells whether free models work
 * from Cockpit (200) or only inside OpenCode (403 FreeTierError).
 */
export async function validateOpenCodeKey(apiKey: string): Promise<KeyValidationResult> {
  const response = await openCodeFetch(OPENCODE_CHAT_PATH, apiKey, {
    method: "POST",
    body: { model: KEY_CHECK_MODEL, max_tokens: 1, messages: [{ role: "user", content: "OK" }] },
  });

  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    return { valid: false, reason: "AI_KEY_INVALID" };
  }

  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { valid: true, details: { freeModelsUsable: true } };
  }

  if (await isFreeTierRefusal(response)) {
    return { valid: true, details: { freeModelsUsable: false } };
  }

  if (response.status === 402 || response.status === 429) {
    return { valid: true, details: { freeModelsUsable: null } };
  }

  throw await toOpenCodeError(response);
}
