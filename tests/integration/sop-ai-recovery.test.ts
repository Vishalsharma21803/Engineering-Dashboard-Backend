import { delay, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { STALE_RUN_MS, kickSopAiWorker, stopSopAiWorker, waitForSopAiIdle } from "../../src/services/sop/ai/sop-ai.service.js";
import { server } from "../setup.js";
import { VALID_CLAUDE_KEY, createFakeAi, fakeAiHandlers } from "../support/fake-ai.js";
import { installFakeAzure, resetDatabase, setupUser, type Agent } from "../support/harness.js";
import { useAlphaRulebook } from "../support/test-rulebook.js";

let agent: Agent;
let credentialId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  installFakeAzure();
  server.use(...fakeAiHandlers(createFakeAi()));
  ({ agent, credentialId } = await setupUser());
  userId = (await prisma.credential.findUniqueOrThrow({ where: { id: credentialId } })).userId;
  await useAlphaRulebook();
});

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5_000) => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("AI checks left running", () => {
  it("wakes up when a run abandoned by another process turns stale, and runs it again", async () => {
    // RUNNING since just under the stale limit: not re-queued yet, and nothing else is queued to wake the worker.
    const row = await prisma.sopAiCheck.create({
      data: { userId, credentialId, workItemId: 101, projectName: "Alpha", inputHash: "abandoned", status: "RUNNING", startedAt: new Date(Date.now() - STALE_RUN_MS + 300) },
    });
    kickSopAiWorker();
    await waitForSopAiIdle();
    expect((await prisma.sopAiCheck.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("RUNNING");

    // Once stale, the scheduled wake re-queues and runs it (no AI set up here, so it ends SKIPPED instead of hanging).
    await waitFor(async () => (await prisma.sopAiCheck.findUniqueOrThrow({ where: { id: row.id } })).status !== "RUNNING");
    await waitForSopAiIdle();
    expect(await prisma.sopAiCheck.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SKIPPED", errorReason: "AI_NOT_CONFIGURED" });
  });

  // Last in this file: the worker stays stopped afterwards.
  it("hands checks still running at shutdown back to the queue", async () => {
    await agent.post("/api/ai/credentials").send({ provider: "CLAUDE", apiKey: VALID_CLAUDE_KEY }).expect(201);
    await agent.put("/api/ai/preferences").send({ provider: "CLAUDE", model: "claude-sonnet-5-5", effort: "LOW", dailyLimitUsd: 2, acceptDataCollection: false }).expect(200);
    // The AI call never answers before the deploy's grace period ends.
    server.use(http.post(/^https:\/\/api\.anthropic\.com\/v1\/messages/, async () => {
      await delay("infinite");
    }));

    await agent.post(`/api/sop/ai/${credentialId}/check`).send({ workItemIds: [101] }).expect(200);
    await waitFor(async () => (await prisma.sopAiCheck.count({ where: { status: "RUNNING" } })) === 1);

    await stopSopAiWorker(100);
    expect(await prisma.sopAiCheck.findFirstOrThrow({ where: { workItemId: 101 } })).toMatchObject({ status: "QUEUED", startedAt: null });
  });
});
