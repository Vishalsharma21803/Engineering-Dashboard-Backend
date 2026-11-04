import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearAzureCache } from "../../src/lib/azure/cache.js";
import { clearOpenCodeModelsCache } from "../../src/lib/ai/opencode.js";
import { clearOpenRouterModelsCache } from "../../src/lib/ai/openrouter.js";
import { prisma } from "../../src/lib/prisma.js";
import { getUsageSummary, purgeStaleAiReservations, recordAiSpend, reserveAiSpend, settleAiSpend, spentSince, startOfUtcDay } from "../../src/services/ai/ai-usage.service.js";
import { recoverSopAiQueue, waitForSopAiIdle } from "../../src/services/sop/ai/sop-ai.service.js";
import { server } from "../setup.js";
import { VALID_CLAUDE_KEY, VALID_OPENCODE_KEY, VALID_OPENROUTER_KEY, createFakeAi, fakeAiHandlers, type FakeAi } from "../support/fake-ai.js";
import { writeRequests, type FakeAzure } from "../support/fake-azure.js";
import { installFakeAzure, resetDatabase, setupUser, type Agent } from "../support/harness.js";
import { ALPHA_RULEBOOK, useAlphaRulebook } from "../support/test-rulebook.js";

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
        quotes: ["use JWT in httpOnly cookie", "a sentence that is not in the ticket", "login"],
        fix: { target: "comment", text: "Approach:\n1. Add the login form\n2. Call the auth API" },
      }));

    const queued = await check([101, 102, 103, 104, 106]);

    // 103 has no AI-only rule, but code rules the AI may draft for (here: nothing failing, so no AI call).
    expect(queued.queued).toEqual([101, 102, 103, 106]);
    expect(queued.skipped).toEqual([{ workItemId: 104, reason: "PROJECT_NOT_CONFIGURED" }]);

    const byId = await results([101, 102, 106]);
    const first = byId.get(101);
    expect(first).toMatchObject({ status: "DONE", provider: "CLAUDE", model: "claude-sonnet-5-5", costUsd: 0.004 });
    expect(first.results).toEqual([
      {
        ruleId: "T-05",
        ruleTitle: "Approach is described",
        severity: "medium",
        review: "ai-rule",
        verdict: "fail",
        reason: "No plan is written down.",
        advice: "Write the approach as 3-5 concrete steps.",
        quotes: ["use JWT in httpOnly cookie"],
        fix: { target: "comment", text: "Approach:\n1. Add the login form\n2. Call the auth API" },
        note: "1 quote(s) were too short to prove anything and were removed. 1 quote(s) could not be found in the ticket and were removed.",
        codeMessage: null,
        verifier: 2,
      },
    ]);

    // Ticket 102 has no such comment: no quote survives, so the verdict is not trusted.
    expect(byId.get(102).results[0]).toMatchObject({ verdict: "unsure", quotes: [], fix: null });

    const call = judgeCalls()[0];
    expect(call?.beta).toContain("server-side-fallback-2026-07-01");
    expect(call?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema" } },
      system: [{ type: "text", cache_control: { type: "ephemeral" } }],
    });
    expect(JSON.stringify(call?.body)).toContain("Review these rules for the ticket below: T-05.");

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
    // The newest request runs first: 101 is queued last, so it meets the rate limit.
    await check([102, 101]);

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

  it("re-checks when a pull request changes without a new ticket revision", async () => {
    await useClaude();
    await check([101]);
    expect((await check([101])).unchanged).toEqual([101]);

    const pr = azure.pullRequests.find((candidate) => candidate.pullRequestId === 1)!;
    pr.status = "completed";
    pr.closedDate = new Date().toISOString();
    clearAzureCache();
    expect((await check([101])).queued).toEqual([101]);
  });

  it("does not re-check (and pay again) because a pull request or comments read failed for a moment", async () => {
    await useClaude();
    await check([101]);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    server.use(http.get(/\/pullrequests\/\d+/, () => HttpResponse.json({ message: "Server error" }, { status: 500 })));
    clearAzureCache();
    expect((await check([101])).unchanged).toEqual([101]);
    server.use(http.get(/\/workItems\/101\/comments/i, () => HttpResponse.json({ message: "Server error" }, { status: 500 })));
    clearAzureCache();
    expect((await check([101])).unchanged).toEqual([101]);
    expect(judgeCalls()).toHaveLength(1);

    // Still failing, but the model settings changed: that is a real change, so it is checked again.
    await agent
      .put("/api/ai/preferences")
      .send({ provider: "CLAUDE", model: "claude-sonnet-5-5", effort: "LOW", dailyLimitUsd: 2, acceptDataCollection: false })
      .expect(200);
    clearAzureCache();
    expect((await check([101])).queued).toEqual([101]);
    quiet.mockRestore();
  });

  it("holds a call's worst case while it runs, so parallel calls cannot overshoot the daily limit", async () => {
    const { id: userId } = await prisma.user.findFirstOrThrow();
    const reserve = () => reserveAiSpend({ userId, provider: "CLAUDE", model: "claude-sonnet-5-5", purpose: "sop-check", maxCostUsd: 0.6, limitUsd: 0.5 });
    const [first, second] = await Promise.all([reserve(), reserve()]);
    const kept = first ?? second;

    // One fits under the limit; the other sees it (spent + reserved >= limit) and is refused.
    expect([first, second].filter((id) => id === null)).toHaveLength(1);
    expect(await spentSince(userId, startOfUtcDay(new Date()))).toBeCloseTo(0.6);
    // A reservation is not spending: the usage summary leaves it out.
    expect(await getUsageSummary(userId)).toMatchObject({ todayUsd: 0, callsToday: 0 });

    const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await settleAiSpend(kept, { userId, provider: "CLAUDE", model: "claude-sonnet-5-5", purpose: "sop-check", usage, costUsd: 0.01 });
    expect(await prisma.aiUsage.findMany({ select: { purpose: true, costUsd: true } })).toEqual([{ purpose: "sop-check", costUsd: 0.01 }]);
    expect(await getUsageSummary(userId)).toMatchObject({ todayUsd: 0.01, callsToday: 1 });

    // A reservation left by a call that died is removed by maintenance after 10 minutes.
    const leftover = await reserve();
    expect(leftover).not.toBeNull();
    expect(await purgeStaleAiReservations()).toBe(0);
    expect(await purgeStaleAiReservations(new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(await prisma.aiUsage.count()).toBe(1);
  });

  it("releases the held amount when a call is not billed, and settles it with the real cost when it is", async () => {
    await useClaude();
    ai.rateLimitNext = 1;
    await check([101]);
    expect((await results([101])).get(101)).toMatchObject({ status: "QUEUED", errorReason: "AI_RATE_LIMITED" });
    expect(await prisma.aiUsage.count()).toBe(0);

    // Billed (an unusable answer): the reservation becomes the real cost. Forced: the rate-limit pause holds the queue.
    ai.badJson = true;
    await check([102], true);
    expect(await prisma.aiUsage.findMany({ select: { purpose: true, costUsd: true } })).toEqual([{ purpose: "sop-check", costUsd: 0.004 }]);
  });

  it("keeps a paid answer when recording its cost fails, holding the reservation as the record, and never pays for it again", async () => {
    await useClaude();
    const transaction = prisma.$transaction.bind(prisma);
    // Settling (delete the reservation + add the usage row, one batch transaction) fails, also when tried again.
    const failing = vi.spyOn(prisma, "$transaction").mockImplementation(((arg: unknown, ...rest: unknown[]) =>
      Array.isArray(arg) ? Promise.reject(new Error("database unavailable")) : transaction(...([arg, ...rest] as [never]))) as typeof prisma.$transaction);
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await check([101]);
    const settleTries = failing.mock.calls.filter(([arg]) => Array.isArray(arg)).length;
    failing.mockRestore();
    expect(settleTries).toBe(2);
    expect((await results([101])).get(101)).toMatchObject({ status: "DONE", costUsd: 0.004 });
    expect(await prisma.aiUsage.findMany({ select: { purpose: true } })).toEqual([{ purpose: "reserved:sop-check" }]);
    expect(String(loud.mock.calls[0]?.[0])).toContain("Recording AI spend failed twice");
    loud.mockRestore();

    // Done: the next visit does not run (and pay for) it again.
    expect((await check([101])).unchanged).toEqual([101]);
    expect(judgeCalls()).toHaveLength(1);
  });

  it("does not count a call twice when the first record committed but its answer was lost", async () => {
    const { id: userId } = await prisma.user.findFirstOrThrow();
    const reservation = await reserveAiSpend({ userId, provider: "CLAUDE", model: "claude-sonnet-5-5", purpose: "sop-check", maxCostUsd: 0.6, limitUsd: 5 });
    const transaction = prisma.$transaction.bind(prisma);
    // The settle commits, then the connection drops before the reply.
    const lost = vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
      await transaction(...(args as [never]));
      throw new Error("Connection reset after COMMIT");
    }) as typeof prisma.$transaction);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

    await recordAiSpend(reservation, { userId, provider: "CLAUDE", model: "claude-sonnet-5-5", purpose: "sop-check", usage, costUsd: 0.004 });
    lost.mockRestore();
    // The first failure is logged with its cause.
    expect(warned.mock.calls[0]?.[1]).toMatchObject({ message: "Connection reset after COMMIT" });
    warned.mockRestore();
    expect(await prisma.aiUsage.findMany({ select: { purpose: true, costUsd: true } })).toEqual([{ purpose: "sop-check", costUsd: 0.004 }]);
  });

  it("serves users fairly: one user's long queue does not hold back another's check", async () => {
    const { id: busyUser } = await prisma.user.findFirstOrThrow();
    const other = await setupUser();
    const otherUser = await prisma.user.findFirstOrThrow({ where: { id: { not: busyUser } } });
    // Neither user has an AI model set, so each check ends at once; only the order they start in matters.
    await prisma.sopAiCheck.create({ data: { userId: otherUser.id, credentialId: other.credentialId, workItemId: 1, projectName: "Alpha", inputHash: "x" } });
    await prisma.sopAiCheck.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({ userId: busyUser, credentialId, workItemId: 1000 + index, projectName: "Alpha", inputHash: "x" })),
    });

    await recoverSopAiQueue();
    await waitForSopAiIdle();
    const rows = await prisma.sopAiCheck.findMany({ select: { userId: true, startedAt: true } });
    const otherStarted = rows.find((row) => row.userId === otherUser.id)!.startedAt!.getTime();
    const before = rows.filter((row) => row.userId === busyUser && row.startedAt!.getTime() < otherStarted);
    expect(rows.every((row) => row.startedAt !== null)).toBe(true);
    expect(before.length).toBeLessThan(3);
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

describe("AI review of code gaps", () => {
  const APPROACH_RULE = `
---
id: T-07
title: Approach before starting
checker: code
uses: approach-present
params: { min_steps: 3 }
applies_to: [task]
when: before-active
---
**Rule:** A technical approach with 3 steps.
`;

  const detail = async () => (await agent.get(`/api/azure/${credentialId}/projects/Alpha/work-items/101`).expect(200)).body.workItem.compliance;

  it("clears a gap the AI shows is met (with a real quote), everywhere, until the ticket changes", async () => {
    await prisma.rulebook.update({ where: { version: 1 }, data: { content: `${ALPHA_RULEBOOK}${APPROACH_RULE}` } });
    await useClaude();
    // #101's only approach is one line, so code finds a gap.
    expect((await detail()).violations).toEqual([expect.objectContaining({ ruleId: "T-07", phase: "earlier" })]);

    ai.verdicts = (rules) =>
      rules.map((ruleId) => ({
        ruleId,
        verdict: "pass",
        reason: "The approach is written as one sentence but covers the steps.",
        advice: "",
        quotes: ruleId === "T-07" ? ["use JWT in httpOnly cookie"] : [],
        fix: { target: "none", text: "" },
      }));
    await check([101]);
    const prompt = JSON.stringify(judgeCalls()[0]?.body);
    expect(prompt).toContain("RULE T-07 (GAP)");
    expect(prompt).toContain("Code found:\\n<<<\\nThe approach has 1 step; it needs at least 3.\\n>>>");

    const cleared = await detail();
    expect(cleared.violations).toEqual([]);
    expect(cleared.cleared).toEqual([{ ruleId: "T-07", ruleTitle: "Approach before starting", reason: expect.stringContaining("covers the steps"), quotes: ["use JWT in httpOnly cookie"] }]);
    expect(cleared.aiReview).toMatchObject({ status: "DONE", outdated: false });

    // The dashboard shows the saved review without calling the AI.
    const calls = judgeCalls().length;
    const dashboard = (await agent.get(`/api/azure/${credentialId}/dashboard`).expect(200)).body.dashboard;
    const fromDashboard = dashboard.sections.compliance.data.find((result: { workItemId: number }) => result.workItemId === 101);
    expect(fromDashboard).toMatchObject({ violations: [], cleared: [expect.objectContaining({ ruleId: "T-07" })] });
    expect(judgeCalls()).toHaveLength(calls);

    // The ticket changed: the clear no longer applies until it is reviewed again.
    azure.workItems.get(101)!.rev += 1;
    clearAzureCache();
    const changed = await detail();
    expect(changed).toMatchObject({ cleared: [], aiReview: { outdated: true } });
    expect(changed.violations).toEqual([expect.objectContaining({ ruleId: "T-07" })]);
  });

  it("reports how long the user's checks take per model", async () => {
    await useClaude();
    ai.verdicts = (rules) => rules.map((ruleId) => ({ ruleId, verdict: "pass", reason: "ok", advice: "", quotes: [], fix: { target: "none", text: "" } }));
    await check([101, 102]);
    const timing = (await agent.get("/api/ai/sop-check-timing").expect(200)).body.timing;
    expect(timing).toMatchObject({ days: 30, models: [{ provider: "CLAUDE", model: "claude-sonnet-5-5", checks: 2, averageSeconds: expect.any(Number), rateLimited: 0, failed: 0 }] });
  });
});
