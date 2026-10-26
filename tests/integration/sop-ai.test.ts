import { beforeEach, describe, expect, it } from "vitest";

import { clearOpenCodeModelsCache } from "../../src/lib/ai/opencode.js";
import { clearOpenRouterModelsCache } from "../../src/lib/ai/openrouter.js";
import { prisma } from "../../src/lib/prisma.js";
import { recoverSopAiQueue, waitForSopAiIdle } from "../../src/services/sop/ai/sop-ai.service.js";
import { server } from "../setup.js";
import { VALID_CLAUDE_KEY, VALID_OPENCODE_KEY, VALID_OPENROUTER_KEY, createFakeAi, fakeAiHandlers, type FakeAi } from "../support/fake-ai.js";
import { writeRequests, type FakeAzure } from "../support/fake-azure.js";
import { installFakeAzure, resetDatabase, setupUser, type Agent } from "../support/harness.js";
import { useAlphaRulebook } from "../support/test-rulebook.js";

let ai: FakeAi;
let azure: FakeAzure;
let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  clearOpenRouterModelsCache();
  clearOpenCodeModelsCache();
  azure = installFakeAzure();
  ai = createFakeAi();
  server.use(...fakeAiHandlers(ai));
  ({ agent, credentialId } = await setupUser());
  await useAlphaRulebook();
});

async function useClaude(overrides: Record<string, unknown> = {}) {
  await agent.post("/api/ai/credentials").send({ provider: "CLAUDE", apiKey: VALID_CLAUDE_KEY }).expect(201);
  await agent
    .put("/api/ai/preferences")
    .send({ provider: "CLAUDE", model: "claude-sonnet-5-5", effort: "HIGH", dailyLimitUsd: 2, acceptDataCollection: false, ...overrides })
    .expect(200);
}

async function check(workItemIds: number[], force = false) {
  // refresh=true is what the Refresh button sends: Azure reads bypass the cache.
  const response = await agent.post(`/api/sop/ai/${credentialId}/check?refresh=true`).send({ workItemIds, force }).expect(200);
  await waitForSopAiIdle();
  return response.body as { queued: number[]; unchanged: number[]; skipped: Array<{ workItemId: number; reason: string }> };
}

async function results(ids: number[]) {
  const response = await agent.get(`/api/sop/ai/${credentialId}/results?ids=${ids.join(",")}`).expect(200);
  return new Map<number, any>(response.body.checks.map((row: { workItemId: number }) => [row.workItemId, row]));
}

const judgeCalls = () => ai.requests.filter((request) => request.method === "POST");

describe("AI SOP checks", () => {
  it("needs an AI provider first", async () => {
    const response = await agent.post(`/api/sop/ai/${credentialId}/check`).send({ workItemIds: [101] }).expect(422);
    expect(response.body.reason).toBe("AI_NOT_CONFIGURED");
  });

  it("checks applicable tickets with Claude, verifies the answer and records the cost", async () => {
    await useClaude();
    ai.verdicts = (rules) =>
      rules.map((ruleId) => ({
        ruleId,
        verdict: "fail",
        reason: "No plan is written down.",
        advice: "Write the approach as 3-5 concrete steps.",
        quotes: ["Implement login", "a sentence that is not in the ticket"],
        fix: { target: "comment", text: "Approach:\n1. Add the login form\n2. Call the auth API" },
      }));

    const queued = await check([101, 102, 103, 104, 106]);

    expect(queued.queued).toEqual([101, 102, 106]);
    expect(queued.skipped).toEqual([
      { workItemId: 103, reason: "NO_AI_RULES" },
      { workItemId: 104, reason: "PROJECT_NOT_CONFIGURED" },
    ]);

    const byId = await results([101, 102, 106]);
    const first = byId.get(101);
    expect(first).toMatchObject({ status: "DONE", provider: "CLAUDE", model: "claude-sonnet-5-5", costUsd: 0.004 });
    expect(first.results).toEqual([
      {
        ruleId: "T-05",
        ruleTitle: "Approach is described",
        severity: "medium",
        verdict: "fail",
        reason: "No plan is written down.",
        advice: "Write the approach as 3-5 concrete steps.",
        quotes: ["Implement login"],
        fix: { target: "comment", text: "Approach:\n1. Add the login form\n2. Call the auth API" },
        note: "1 quote(s) could not be found in the ticket and were removed.",
      },
    ]);

    // Ticket 102's title is not "Implement login": no quote survives, so the verdict is not trusted.
    expect(byId.get(102).results[0]).toMatchObject({ verdict: "unsure", quotes: [], fix: null });

    const call = judgeCalls()[0];
    expect(call?.beta).toContain("server-side-fallback-2026-07-01");
    expect(call?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema" } },
      system: [{ type: "text", cache_control: { type: "ephemeral" } }],
    });
    expect(JSON.stringify(call?.body)).toContain("Judge these rules for the ticket below: T-05.");

    const usage = await prisma.aiUsage.findMany();
    expect(usage).toHaveLength(3);
    expect(usage[0]).toMatchObject({ purpose: "sop-check", inputTokens: 1000, outputTokens: 200 });
    expect(writeRequests(azure)).toEqual([]);
  });

  it("re-checks only changed tickets unless forced", async () => {
    await useClaude();
    await check([101, 102]);
    expect(judgeCalls()).toHaveLength(2);

    expect((await check([101, 102])).unchanged).toEqual([101, 102]);
    expect(judgeCalls()).toHaveLength(2);

    const item = azure.workItems.get(102)!;
    item.rev += 1;
    expect(await check([101, 102])).toMatchObject({ queued: [102], unchanged: [101] });
    expect(judgeCalls()).toHaveLength(3);

    expect((await check([101], true)).queued).toEqual([101]);
    expect(judgeCalls()).toHaveLength(4);
  });

  it("does not use Haiku's fallback, and changing the model re-checks", async () => {
    await useClaude({ model: "claude-haiku-5-5", effort: "LOW" });
    await check([101]);
    expect(judgeCalls()[0]?.body).not.toHaveProperty("fallbacks");
    expect(judgeCalls()[0]?.beta ?? "").not.toContain("server-side-fallback");

    await agent.put("/api/ai/preferences").send({ provider: "CLAUDE", model: "claude-opus-5-5", effort: "LOW", dailyLimitUsd: 2, acceptDataCollection: false }).expect(200);
    expect((await check([101])).queued).toEqual([101]);
  });

  it("stops at the daily limit and on refusals, and pauses when rate limited", async () => {
    await useClaude({ dailyLimitUsd: 0 });
    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "SKIPPED", errorReason: "DAILY_LIMIT_REACHED" });
    expect(judgeCalls()).toHaveLength(0);

    await agent.put("/api/ai/preferences").send({ provider: "CLAUDE", model: "claude-sonnet-5-5", effort: "HIGH", dailyLimitUsd: 2, acceptDataCollection: false }).expect(200);
    ai.claudeStopReason = "refusal";
    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "FAILED", errorReason: "AI_REFUSED" });

    ai.claudeStopReason = "end_turn";
    ai.rateLimitNext = 1;
    await check([102]);
    const paused = await prisma.sopAiCheck.findFirstOrThrow({ where: { workItemId: 102 } });
    expect(paused).toMatchObject({ status: "QUEUED", errorReason: "AI_RATE_LIMITED" });
    expect(paused.notBefore!.getTime()).toBeGreaterThan(Date.now());
  });

  it("pauses all of the user's checks for 60s when a 429 has no Retry-After", async () => {
    await useClaude();
    ai.rateLimitNext = 1;
    ai.retryAfter = null;
    const started = Date.now();
    await check([101]);

    const row = await prisma.sopAiCheck.findFirstOrThrow({ where: { workItemId: 101 } });
    expect(row.status).toBe("QUEUED");
    expect(row.notBefore!.getTime() - started).toBeGreaterThanOrEqual(59_000);

    // Other tickets queued later wait for the same pause instead of hitting the limit again.
    await check([102]);
    expect(judgeCalls()).toHaveLength(1);
    // "Try now" (force) makes one real attempt despite the pause; it succeeds once the limit is gone.
    await check([101], true);
    expect(judgeCalls()).toHaveLength(2);
    expect((await results([101])).get(101)).toMatchObject({ status: "DONE", errorDetail: null, notBefore: null });
  });

  it("a rate limit at one provider does not hold back checks after switching provider", async () => {
    await agent.post("/api/ai/credentials").send({ provider: "OPENROUTER", apiKey: VALID_OPENROUTER_KEY }).expect(201);
    await agent.put("/api/ai/preferences").send({ provider: "OPENROUTER", model: "deepseek/deepseek-r1", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false }).expect(200);
    ai.rateLimitNext = 1;
    await check([101, 102]);

    const paused = await results([101, 102]);
    // The provider's own words are kept, so people can see which limit was hit.
    expect(paused.get(101)).toMatchObject({ status: "QUEUED", errorReason: "AI_RATE_LIMITED", errorDetail: "Rate limited", provider: "OPENROUTER", model: "deepseek/deepseek-r1", notBefore: expect.any(String) });

    // Same provider and model: still paused.
    expect((await check([101, 102])).unchanged).toEqual([101, 102]);

    // Another model at the same provider is not held back by that model's limit.
    await agent.put("/api/ai/preferences").send({ provider: "OPENROUTER", model: "deepseek/deepseek-chat:free", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: true }).expect(200);
    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "DONE", model: "deepseek/deepseek-chat:free" });

    await useClaude();
    await check([101, 102]);
    const after = await results([101, 102]);
    expect(after.get(101)).toMatchObject({ status: "DONE", provider: "CLAUDE", notBefore: null });
    expect(after.get(102)).toMatchObject({ status: "DONE", provider: "CLAUDE" });
  });

  it("a $0 daily limit still runs free models (\"0 = only free models\"), and records the model used", async () => {
    await agent.post("/api/ai/credentials").send({ provider: "OPENCODE", apiKey: VALID_OPENCODE_KEY }).expect(201);
    ai.openCodeFreeBlocked = false;
    await agent
      .put("/api/ai/preferences")
      .send({ provider: "OPENCODE", model: "deepseek-v4.1-flash-free", effort: "MEDIUM", dailyLimitUsd: 0, acceptDataCollection: false })
      .expect(200);
    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "DONE", provider: "OPENCODE", model: "deepseek-v4.1-flash-free" });

    // A paid model at $0 is skipped, and the row names the model it was skipped for.
    await agent.put("/api/ai/preferences").send({ provider: "OPENCODE", model: "glm-5.3-flash", effort: "MEDIUM", dailyLimitUsd: 0, acceptDataCollection: false }).expect(200);
    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "SKIPPED", errorReason: "DAILY_LIMIT_REACHED", model: "glm-5.3-flash" });
  });

  it("counts the cost of unusable answers against the daily limit", async () => {
    await useClaude();
    ai.badJson = true;
    await check([101]);

    expect((await results([101])).get(101)).toMatchObject({ status: "FAILED", errorReason: "AI_BAD_OUTPUT" });
    expect(await prisma.aiUsage.findFirstOrThrow()).toMatchObject({ purpose: "sop-check", costUsd: 0.004 });
  });

  it("skips tickets snoozed or abandoned in triage", async () => {
    await useClaude();
    const user = await prisma.user.findFirstOrThrow();
    await prisma.triageMark.create({ data: { userId: user.id, credentialId, itemKey: "wi:101", status: "SNOOZED", snoozedUntil: new Date(Date.now() + 86_400_000), signals: [] } });
    await prisma.triageMark.create({ data: { userId: user.id, credentialId, itemKey: "wi:102", status: "ACKNOWLEDGED", signals: [] } });

    expect(await check([101, 102])).toMatchObject({ queued: [102], skipped: [{ workItemId: 101, reason: "TRIAGED" }] });

    // The dashboard stores project marks lower-cased.
    await prisma.triageMark.create({ data: { userId: user.id, credentialId, itemKey: "project:alpha", status: "ABANDONED", signals: [] } });
    expect((await check([106])).skipped).toEqual([{ workItemId: 106, reason: "TRIAGED" }]);
  });

  it("uses OpenRouter with strict JSON and no data collection unless accepted", async () => {
    await agent.post("/api/ai/credentials").send({ provider: "OPENROUTER", apiKey: VALID_OPENROUTER_KEY }).expect(201);
    await agent
      .put("/api/ai/preferences")
      .send({ provider: "OPENROUTER", model: "deepseek/deepseek-r1", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false })
      .expect(200);

    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "DONE", provider: "OPENROUTER", model: "deepseek/deepseek-r1" });
    expect(judgeCalls()[0]?.body).toMatchObject({
      model: "deepseek/deepseek-r1",
      reasoning: { effort: "medium" },
      response_format: { type: "json_schema", json_schema: { name: "sop_verdicts", strict: true } },
      provider: { require_parameters: true, data_collection: "deny" },
    });

    await agent
      .put("/api/ai/preferences")
      .send({ provider: "OPENROUTER", model: "deepseek/deepseek-chat:free", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: true })
      .expect(200);
    await check([101]);
    expect(judgeCalls()[1]?.body).toMatchObject({ provider: { data_collection: "allow" } });
    expect(judgeCalls()[1]?.body).not.toHaveProperty("reasoning");
  });

  it("uses OpenCode paid models with strict JSON, and explains when free models are refused", async () => {
    await agent.post("/api/ai/credentials").send({ provider: "OPENCODE", apiKey: VALID_OPENCODE_KEY }).expect(201);
    await agent
      .put("/api/ai/preferences")
      .send({ provider: "OPENCODE", model: "glm-5.3-flash", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false })
      .expect(200);

    await check([101]);
    // 1000 input x $0.15 + 200 output x $0.50 per million tokens.
    expect((await results([101])).get(101)).toMatchObject({ status: "DONE", provider: "OPENCODE", model: "glm-5.3-flash", costUsd: 0.00025 });
    const call = ai.requests.find((request) => request.host === "opencode");
    expect(call?.apiKey).toBe(VALID_OPENCODE_KEY);
    expect(call?.body).toMatchObject({ model: "glm-5.3-flash", response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(call?.body).not.toHaveProperty("provider");

    await agent
      .put("/api/ai/preferences")
      .send({ provider: "OPENCODE", model: "deepseek-v4.1-flash-free", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false })
      .expect(200);
    await check([102]);
    // OpenCode's real answer: 429 FreeUsageLimitError with a Retry-After to midnight. Not a pause: a block.
    expect((await results([102])).get(102)).toMatchObject({ status: "FAILED", errorReason: "AI_FREE_TIER_BLOCKED", notBefore: null });

    ai.openCodeFreeBlockStyle = "403";
    await check([102], true);
    expect((await results([102])).get(102)).toMatchObject({ status: "FAILED", errorReason: "AI_FREE_TIER_BLOCKED" });

    ai.openCodeFreeBlocked = false;
    await check([102], true);
    expect((await results([102])).get(102)).toMatchObject({ status: "DONE", costUsd: 0 });

    ai.openCodeNoCredit = true;
    await agent.put("/api/ai/preferences").send({ provider: "OPENCODE", model: "deepseek-v4.1-flash", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false }).expect(200);
    await check([106]);
    expect((await results([106])).get(106)).toMatchObject({ status: "FAILED", errorReason: "AI_NO_CREDIT" });
  });

  it("re-queues runs abandoned by a crashed process, but not live ones", async () => {
    await useClaude();
    await check([101, 102]);
    const rows = await prisma.sopAiCheck.findMany({ orderBy: { workItemId: "asc" } });
    // 101 was claimed 20 minutes ago by a process that died; 102 is being run right now by another instance.
    await prisma.sopAiCheck.update({ where: { id: rows[0]!.id }, data: { status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60_000) } });
    await prisma.sopAiCheck.update({ where: { id: rows[1]!.id }, data: { status: "RUNNING", startedAt: new Date() } });

    await recoverSopAiQueue();
    await waitForSopAiIdle();

    expect((await results([101])).get(101)).toMatchObject({ status: "DONE" });
    expect((await results([102])).get(102)).toMatchObject({ status: "RUNNING" });
    // A live run is not re-queued (it would be paid for twice).
    expect((await check([102], true)).unchanged).toEqual([102]);
  });

  it("keeps results private to the user who ran them", async () => {
    await useClaude();
    await check([101]);

    const other = await setupUser();
    await other.agent.get(`/api/sop/ai/${credentialId}/results?ids=101`).expect(404);
    const own = await other.agent.get(`/api/sop/ai/${other.credentialId}/results?ids=101`).expect(200);
    expect(own.body.checks).toEqual([]);
  });

  it("validates requests", async () => {
    await agent.post(`/api/sop/ai/${credentialId}/check`).send({ workItemIds: [] }).expect(400);
    await agent.get(`/api/sop/ai/${credentialId}/results?ids=abc`).expect(400);
  });
});
