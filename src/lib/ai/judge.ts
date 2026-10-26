import type { z } from "zod";

import { createClaudeClient, toClaudeError } from "./claude.js";
import { OPENCODE_CHAT_PATH, openCodeFetch, toOpenCodeError } from "./opencode.js";
import { openRouterFetch, toOpenRouterError } from "./openrouter.js";
import type { TokenUsage } from "./pricing.js";
import { AiProviderError, type AiEffort, type AiProvider, type BilledUsage } from "./types.js";

const MAX_OUTPUT_TOKENS = 16_000;
const EFFORT: Record<AiEffort, "low" | "medium" | "high"> = { LOW: "low", MEDIUM: "medium", HIGH: "high" };

/**
 * Models with server-side refusal fallback ("default" picks Anthropic's
 * recommended model per refusal category). Haiku 5.5 has none.
 */
const CLAUDE_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface JudgeRequest<T> {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** null when the model does not accept an effort setting. */
  effort: AiEffort | null;
  /** Stable instructions; cached by Claude across tickets. */
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** JSON Schema of `schema` for strict structured output (all providers). */
  jsonSchema: Record<string, unknown>;
  /** OpenRouter: let providers that may store prompts serve the request (user consented). */
  allowDataCollection: boolean;
}

export interface JudgeResponse<T> {
  data: T;
  usage: TokenUsage;
  /** The model that produced the answer (differs from the request after a refusal fallback). */
  servedBy: string;
}

/** Parses the model's JSON; a failure still reports what the call cost. */
function parseOutput<T>(text: string | null | undefined, schema: z.ZodType<T>, billed: BilledUsage): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    throw new AiProviderError("AI_BAD_OUTPUT", null, billed);
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    throw new AiProviderError("AI_BAD_OUTPUT", null, billed);
  }

  return result.data;
}

async function judgeWithClaude<T>(request: JudgeRequest<T>): Promise<JudgeResponse<T>> {
  const client = createClaudeClient(request.apiKey);
  const fallback = CLAUDE_FALLBACK_MODELS.has(request.model);

  let response;
  try {
    // create (not parse): we validate the JSON ourselves so a bad answer still reports its usage.
    response = await client.beta.messages.create(
      {
        model: request.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        output_config: {
          format: { type: "json_schema", schema: request.jsonSchema },
          ...(request.effort ? { effort: EFFORT[request.effort] } : {}),
        },
        messages: [{ role: "user", content: request.user }],
      },
      // The SOP queue handles rate limits itself (it pauses instead of waiting in-process).
      { maxRetries: 0 }
    );
  } catch (error) {
    throw toClaudeError(error);
  }

  const billed: BilledUsage = {
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    servedBy: response.model,
  };

  if (response.stop_reason === "refusal") {
    throw new AiProviderError("AI_REFUSED", null, billed);
  }

  if (response.stop_reason === "max_tokens") {
    throw new AiProviderError("AI_BAD_OUTPUT", null, billed);
  }

  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  return { data: parseOutput(text, request.schema, billed), ...billed };
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** OpenAI-compatible chat completions with schema-checked JSON (OpenRouter, OpenCode). */
async function judgeWithChatCompletions<T>(
  request: JudgeRequest<T>,
  send: (body: Record<string, unknown>) => Promise<Response>,
  toError: (response: Response) => AiProviderError | Promise<AiProviderError>,
  extraBody: Record<string, unknown>
): Promise<JudgeResponse<T>> {
  const response = await send({
    model: request.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "sop_verdicts", strict: true, schema: request.jsonSchema },
    },
    ...extraBody,
  });

  if (!response.ok) {
    throw await toError(response);
  }

  let payload: ChatCompletion;

  try {
    payload = (await response.json()) as ChatCompletion;
  } catch {
    throw new AiProviderError("AI_BAD_OUTPUT");
  }

  const choice = payload.choices?.[0];
  const cached = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const billed: BilledUsage = {
    usage: {
      inputTokens: Math.max(0, (payload.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    servedBy: payload.model ?? request.model,
  };

  if (choice?.message?.refusal) {
    throw new AiProviderError("AI_REFUSED", null, billed);
  }

  if (choice?.finish_reason === "length") {
    throw new AiProviderError("AI_BAD_OUTPUT", null, billed);
  }

  return { data: parseOutput(choice?.message?.content, request.schema, billed), ...billed };
}

function judgeWithOpenRouter<T>(request: JudgeRequest<T>): Promise<JudgeResponse<T>> {
  return judgeWithChatCompletions(
    request,
    (body) => openRouterFetch("/chat/completions", request.apiKey, { method: "POST", body }),
    toOpenRouterError,
    {
      ...(request.effort ? { reasoning: { effort: EFFORT[request.effort] } } : {}),
      // Only route to providers that honour structured output, and only to
      // ones that may keep prompts when the user accepted that.
      provider: { require_parameters: true, data_collection: request.allowDataCollection ? "allow" : "deny" },
    }
  );
}

function judgeWithOpenCode<T>(request: JudgeRequest<T>): Promise<JudgeResponse<T>> {
  return judgeWithChatCompletions(
    request,
    (body) => openCodeFetch(OPENCODE_CHAT_PATH, request.apiKey, { method: "POST", body }),
    toOpenCodeError,
    {}
  );
}

/** One structured-output call to the user's chosen provider. */
export async function judge<T>(request: JudgeRequest<T>): Promise<JudgeResponse<T>> {
  switch (request.provider) {
    case "CLAUDE":
      return judgeWithClaude(request);
    case "OPENCODE":
      return judgeWithOpenCode(request);
    default:
      return judgeWithOpenRouter(request);
  }
}
