import { HttpResponse, delay, http, type HttpHandler } from "msw";

/**
 * Fake Anthropic and OpenRouter endpoints. Keys are accepted only if they
 * are in the valid sets; every request is recorded for assertions.
 */
export const VALID_CLAUDE_KEY = "sk-ant-test-valid-key-0123456789abcdef";
export const INVALID_CLAUDE_KEY = "sk-ant-test-revoked-key-0123456789abcd";
export const VALID_OPENROUTER_KEY = "sk-or-v1-test-valid-key-0123456789abcd";
export const INVALID_OPENROUTER_KEY = "sk-or-v1-test-revoked-0123456789abcdef";
export const VALID_OPENCODE_KEY = "oc-test-valid-key-0123456789abcdef";

/** What opencode.ai/inference/v1/models returns (ids only, like the real API). */
export const OPENCODE_MODEL_IDS = ["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "big-pickle", "glm-5.3-flash", "deepseek-v4.1-flash", "claude-sonnet-5-5", "gpt-5.4"];

export interface RecordedAiRequest {
  host: "anthropic" | "openrouter" | "opencode";
  method: string;
  path: string;
  apiKey: string | null;
  body?: Record<string, unknown>;
  beta?: string | null;
}

export interface FakeVerdict {
  ruleId: string;
  verdict: "pass" | "fail" | "unsure";
  reason: string;
  advice: string;
  quotes: string[];
  fix: { target: string; text: string };
}

/** The rule ids a judge request asks about ("Review these rules for the ticket below: A, B."). */
export function requestedRules(userText: string): string[] {
  const match = /Review these rules for the ticket below: ([^\n]+)\./.exec(userText);
  return match?.[1] ? match[1].split(", ") : [];
}

export interface FakeTimeEstimate {
  ticketId: number;
  hours: number;
  confidence: "low" | "medium" | "high";
  reason: string;
}

/** The ticket ids a timesheet estimate request asks about ("- ticketId 103: ..."). */
export function requestedTickets(userText: string): number[] | null {
  if (!userText.includes("Check the hours for these tickets:")) return null;
  return [...userText.matchAll(/^- ticketId (\d+):/gm)].map((match) => Number(match[1]));
}

/** The judge's answer: time estimates for a timesheet prompt, otherwise SOP verdicts. */
function answerFor(fake: FakeAi, userText: string): unknown {
  const tickets = requestedTickets(userText);
  return tickets ? { estimates: fake.timeEstimates(tickets, userText) } : { results: fake.verdicts(requestedRules(userText), userText) };
}

function defaultVerdicts(rules: string[]): FakeVerdict[] {
  return rules.map((ruleId) => ({ ruleId, verdict: "fail", reason: `Fake verdict for ${ruleId}.`, advice: `Fake advice for ${ruleId}.`, quotes: [], fix: { target: "none", text: "" } }));
}

export const OPENROUTER_MODELS = [
  {
    id: "deepseek/deepseek-chat:free",
    name: "DeepSeek Chat (free)",
    context_length: 128000,
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["structured_outputs", "response_format", "temperature"],
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    context_length: 128000,
    pricing: { prompt: "0.0000005", completion: "0.000002" },
    supported_parameters: ["structured_outputs", "reasoning"],
    reasoning: { supported_efforts: ["high", "medium", "low", "minimal"], mandatory: true },
  },
  {
    id: "vendor/no-json-model",
    name: "No JSON Model",
    context_length: 8000,
    pricing: { prompt: "0.000001", completion: "0.000001" },
    supported_parameters: ["temperature"],
  },
];

export function createFakeAi() {
  return {
    requests: [] as RecordedAiRequest[],
    claudeModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    openRouterDown: false,
    /** Builds the judge's answer from the rule ids asked about and the ticket text. */
    verdicts: (rules: string[], _ticket: string): FakeVerdict[] => defaultVerdicts(rules),
    /** Hours for a timesheet estimate request (1 h each by default). */
    timeEstimates: (tickets: number[], _prompt: string): FakeTimeEstimate[] => tickets.map((ticketId) => ({ ticketId, hours: 1, confidence: "medium", reason: `Fake estimate for #${ticketId}.` })),
    claudeStopReason: "end_turn" as "end_turn" | "refusal" | "max_tokens",
    /** Claude answers after this long (ms), e.g. to overlap two calls. */
    answerDelayMs: 0,
    /** Answer the next N judge calls with 429. */
    rateLimitNext: 0,
    /** Retry-After sent with a 429; null = no header. */
    retryAfter: "3600" as string | null,
    /** Return text that is not valid JSON. */
    badJson: false,
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    /** OpenCode refuses its free models outside the OpenCode app (true today). */
    openCodeFreeBlocked: true,
    /** How it refuses: today it answers 429 FreeUsageLimitError; it has also used 403 FreeTierError. */
    openCodeFreeBlockStyle: "429" as "429" | "403",
    /** OpenCode account without credit: paid models answer 402. */
    openCodeNoCredit: false,
  };
}

export type FakeAi = ReturnType<typeof createFakeAi>;

export function fakeAiHandlers(fake: FakeAi): HttpHandler[] {
  return [
    http.post(/^https:\/\/api\.anthropic\.com\/v1\/messages/, async ({ request }) => {
      const apiKey =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key");
      const body = (await request.json()) as Record<string, unknown>;
      fake.requests.push({ host: "anthropic", method: "POST", path: "/v1/messages", apiKey, body, beta: request.headers.get("anthropic-beta") });

      if (apiKey !== VALID_CLAUDE_KEY) {
        return HttpResponse.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
      }

      if (fake.rateLimitNext > 0) {
        fake.rateLimitNext -= 1;
        return HttpResponse.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: fake.retryAfter ? { "retry-after": fake.retryAfter } : {} });
      }

      if (fake.answerDelayMs > 0) {
        await delay(fake.answerDelayMs);
      }

      const messages = body.messages as Array<{ content: string }>;
      const ticket = messages[0]?.content ?? "";

      return HttpResponse.json({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: body.model,
        content: fake.claudeStopReason === "refusal" ? [] : [{ type: "text", text: fake.badJson ? "{not json" : JSON.stringify(answerFor(fake, ticket)) }],
        stop_reason: fake.claudeStopReason,
        stop_sequence: null,
        usage: {
          input_tokens: fake.usage.input,
          output_tokens: fake.usage.output,
          cache_read_input_tokens: fake.usage.cacheRead,
          cache_creation_input_tokens: fake.usage.cacheWrite,
        },
      });
    }),
    http.get("https://opencode.ai/inference/v1/models", () =>
      HttpResponse.json({ object: "list", data: OPENCODE_MODEL_IDS.map((id) => ({ id, object: "model", created: 1, owned_by: "opencode" })) })
    ),
    http.post("https://opencode.ai/inference/openai/v1/chat/completions", async ({ request }) => {
      const apiKey = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      const body = (await request.json()) as Record<string, unknown>;
      fake.requests.push({ host: "opencode", method: "POST", path: "/openai/v1/chat/completions", apiKey, body });

      if (apiKey !== VALID_OPENCODE_KEY) {
        return HttpResponse.json({ error: { type: "AuthError", message: "Invalid API key." } }, { status: 401 });
      }

      const model = String(body.model);
      const free = model.endsWith("-free") || model === "big-pickle";

      if (free && fake.openCodeFreeBlocked) {
        return fake.openCodeFreeBlockStyle === "429"
          ? HttpResponse.json(
              {
                type: "error",
                error: {
                  type: "FreeUsageLimitError",
                  message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
                },
              },
              { status: 429, headers: { "retry-after": "57352" } }
            )
          : HttpResponse.json(
              { type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } },
              { status: 403 }
            );
      }

      if (!free && fake.openCodeNoCredit) {
        return HttpResponse.json({ error: { type: "CreditsError", message: "Insufficient balance" } }, { status: 402 });
      }

      const messages = body.messages as Array<{ role: string; content: string }>;
      const ticket = messages.find((message) => message.role === "user")?.content ?? "";

      return HttpResponse.json({
        id: "oc-fake",
        model,
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answerFor(fake, ticket)) } }],
        usage: { prompt_tokens: fake.usage.input, completion_tokens: fake.usage.output },
      });
    }),
    http.post("https://openrouter.ai/api/v1/chat/completions", async ({ request }) => {
      const apiKey = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      const body = (await request.json()) as Record<string, unknown>;
      fake.requests.push({ host: "openrouter", method: "POST", path: "/chat/completions", apiKey, body });

      if (apiKey !== VALID_OPENROUTER_KEY) {
        return HttpResponse.json({ error: { code: 401, message: "No auth credentials found" } }, { status: 401 });
      }

      if (fake.rateLimitNext > 0) {
        fake.rateLimitNext -= 1;
        return HttpResponse.json({ error: { code: 429, message: "Rate limited" } }, { status: 429, headers: fake.retryAfter ? { "retry-after": fake.retryAfter } : {} });
      }

      const messages = body.messages as Array<{ role: string; content: string }>;
      const ticket = messages.find((message) => message.role === "user")?.content ?? "";

      return HttpResponse.json({
        id: "gen-fake",
        model: body.model,
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answerFor(fake, ticket)) } }],
        usage: { prompt_tokens: fake.usage.input, completion_tokens: fake.usage.output },
      });
    }),
    http.get("https://api.anthropic.com/v1/models", ({ request }) => {
      // SDK 1.x sends the key as a bearer token; older SDKs used x-api-key.
      const apiKey =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key");
      fake.requests.push({ host: "anthropic", method: "GET", path: "/v1/models", apiKey });

      if (apiKey !== VALID_CLAUDE_KEY) {
        return HttpResponse.json(
          { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
          { status: 401 }
        );
      }

      return HttpResponse.json({
        data: fake.claudeModels.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })),
        has_more: false,
        first_id: fake.claudeModels[0],
        last_id: fake.claudeModels.at(-1),
      });
    }),
    http.get("https://openrouter.ai/api/v1/key", ({ request }) => {
      const apiKey = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      fake.requests.push({ host: "openrouter", method: "GET", path: "/key", apiKey });

      if (apiKey !== VALID_OPENROUTER_KEY) {
        return HttpResponse.json({ error: { code: 401, message: "No auth credentials found" } }, { status: 401 });
      }

      return HttpResponse.json({
        data: {
          label: "test",
          limit: null,
          limit_remaining: null,
          usage: 0,
          is_free_tier: true,
          free_model_daily_requests: { used: 3, limit: 50, remaining: 47 },
        },
      });
    }),
    http.get("https://openrouter.ai/api/v1/models", ({ request }) => {
      fake.requests.push({
        host: "openrouter",
        method: "GET",
        path: "/models",
        apiKey: request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null,
      });

      if (fake.openRouterDown) {
        return HttpResponse.json({ error: "unavailable" }, { status: 503 });
      }

      const wanted = new URL(request.url).searchParams.get("supported_parameters");
      const data = wanted
        ? OPENROUTER_MODELS.filter((model) => model.supported_parameters.includes(wanted))
        : OPENROUTER_MODELS;

      return HttpResponse.json({ data });
    }),
  ];
}
