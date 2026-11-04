import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { toClaudeError } from "../../src/lib/ai/claude.js";
import { toOpenCodeError } from "../../src/lib/ai/opencode.js";
import { toOpenRouterError } from "../../src/lib/ai/openrouter.js";

const body = (message: string) => ({ type: "error", error: { type: "invalid_request_error", message } });

describe("Claude errors", () => {
  it("names a timeout, before treating it as a connection error", () => {
    const mapped = toClaudeError(new Anthropic.APIConnectionTimeoutError());
    expect(mapped).toMatchObject({ reason: "AI_UPSTREAM_ERROR", diagnosis: "no answer before the timeout (120 s)" });
  });

  it("names the network failure behind a connection error", () => {
    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.anthropic.com" } });
    const mapped = toClaudeError(new Anthropic.APIConnectionError({ cause }));
    expect(mapped).toMatchObject({ reason: "AI_UPSTREAM_ERROR", diagnosis: "ENOTFOUND: getaddrinfo ENOTFOUND api.anthropic.com" });
  });

  it("marks a bad request as rejected (not retryable), keeping the provider's words; a credit 400 stays AI_NO_CREDIT", () => {
    const rejected = toClaudeError(new Anthropic.BadRequestError(400, body("prompt is too long: 1200000 tokens > 1000000 maximum"), undefined, new Headers()));
    expect(rejected).toMatchObject({ reason: "AI_REQUEST_REJECTED", httpStatus: 422, detail: "prompt is too long: 1200000 tokens > 1000000 maximum" });
    expect(rejected.publicMessage).toBe("The AI provider rejected the request.");

    expect(toClaudeError(new Anthropic.UnprocessableEntityError(422, body("bad field"), undefined, new Headers())).reason).toBe("AI_REQUEST_REJECTED");
    expect(toClaudeError(new Anthropic.BadRequestError(400, body("Your credit balance is too low"), "Your credit balance is too low", new Headers())).reason).toBe("AI_NO_CREDIT");
  });

  it("says which HTTP status a server error had", () => {
    expect(toClaudeError(new Anthropic.InternalServerError(529, body("Overloaded"), undefined, new Headers()))).toMatchObject({
      reason: "AI_UPSTREAM_ERROR",
      detail: "Overloaded",
      diagnosis: "Anthropic answered HTTP 529 (overloaded)",
    });
    expect(toClaudeError(new Anthropic.InternalServerError(500, undefined, undefined, new Headers()))).toMatchObject({ diagnosis: "Anthropic answered HTTP 500" });
  });

  it("keeps the name and message of anything else", () => {
    expect(toClaudeError(new RangeError("odd"))).toMatchObject({ reason: "AI_UPSTREAM_ERROR", diagnosis: "RangeError: odd" });
  });
});

describe("OpenRouter and OpenCode errors", () => {
  const response = (status: number, message = "nope") => new Response(JSON.stringify({ error: { message } }), { status });

  it("marks 400 and 422 as rejected, and names the status of other failures", async () => {
    expect(await toOpenRouterError(response(400, "bad param"))).toMatchObject({ reason: "AI_REQUEST_REJECTED", detail: "bad param" });
    expect((await toOpenRouterError(response(422))).reason).toBe("AI_REQUEST_REJECTED");
    expect(await toOpenRouterError(response(500))).toMatchObject({ reason: "AI_UPSTREAM_ERROR", diagnosis: "OpenRouter answered HTTP 500" });

    expect(await toOpenCodeError(response(400, "bad param"))).toMatchObject({ reason: "AI_REQUEST_REJECTED", detail: "bad param" });
    expect((await toOpenCodeError(response(422))).reason).toBe("AI_REQUEST_REJECTED");
    expect(await toOpenCodeError(response(503))).toMatchObject({ reason: "AI_UPSTREAM_ERROR", diagnosis: "OpenCode answered HTTP 503" });
  });
});
