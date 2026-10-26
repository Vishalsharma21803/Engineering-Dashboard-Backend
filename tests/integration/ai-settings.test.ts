import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { estimateCostUsd } from "../../src/lib/ai/pricing.js";
import { CLAUDE_MODELS } from "../../src/lib/ai/claude.js";
import { clearOpenCodeModelsCache } from "../../src/lib/ai/opencode.js";
import { clearOpenRouterModelsCache } from "../../src/lib/ai/openrouter.js";
import { prisma } from "../../src/lib/prisma.js";
import { recordAiUsage } from "../../src/services/ai/ai-usage.service.js";
import { server } from "../setup.js";
import {
  INVALID_CLAUDE_KEY,
  VALID_CLAUDE_KEY,
  VALID_OPENCODE_KEY,
  VALID_OPENROUTER_KEY,
  createFakeAi,
  fakeAiHandlers,
  type FakeAi,
} from "../support/fake-ai.js";
import { resetDatabase, signIn, type Agent } from "../support/harness.js";

let fake: FakeAi;
let agent: Agent;

beforeEach(async () => {
  await resetDatabase();
  clearOpenRouterModelsCache();
  clearOpenCodeModelsCache();
  fake = createFakeAi();
  server.use(...fakeAiHandlers(fake));
  agent = await signIn();
});

afterEach(() => {
  delete process.env.SOP_ADMIN_EMAILS;
});

async function addKey(provider: "CLAUDE" | "OPENROUTER", apiKey: string) {
  const response = await agent.post("/api/ai/credentials").send({ provider, apiKey }).expect(201);
  return response.body.credential as { id: string; keyHint: string };
}

function expectNoKeys(body: unknown) {
  const text = JSON.stringify(body);
  for (const key of [VALID_CLAUDE_KEY, INVALID_CLAUDE_KEY, VALID_OPENROUTER_KEY]) {
    expect(text).not.toContain(key);
  }
  expect(text).not.toContain("encryptedApiKey");
}

describe("OpenCode", () => {
  it("checks a key for free, reports whether free models work outside OpenCode, and lists only usable models", async () => {
    const credential = (await agent.post("/api/ai/credentials").send({ provider: "OPENCODE", apiKey: VALID_OPENCODE_KEY }).expect(201)).body.credential;

    const validation = await agent.post(`/api/ai/credentials/${credential.id}/validate`).expect(200);
    // OpenCode answers the free-model probe with 429 FreeUsageLimitError: free models are blocked, not "unknown".
    expect(validation.body).toMatchObject({ valid: true, details: { freeModelsUsable: false } });
    expect(fake.requests.find((request) => request.host === "opencode")?.body).toMatchObject({ model: "deepseek-v4.1-flash-free", max_tokens: 1 });

    const models = (await agent.get("/api/ai/models?provider=OPENCODE").expect(200)).body.models;
    // Catalog models OpenCode still lists, on the chat endpoint only (no Claude/GPT).
    expect(models.map((model: { id: string }) => model.id)).toEqual(["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "big-pickle", "glm-5.3-flash", "deepseek-v4.1-flash"]);
    expect(models.find((model: { id: string }) => model.id === "big-pickle")).toMatchObject({ free: true, mayCollectData: true });
    expect(models.find((model: { id: string }) => model.id === "glm-5.3-flash")).toMatchObject({ free: false, inputPerMTok: 0.15, outputPerMTok: 0.5 });

    // Data-collecting free models need the data notice.
    const refused = await agent.put("/api/ai/preferences").send({ provider: "OPENCODE", model: "big-pickle", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false }).expect(422);
    expect(refused.body.reason).toBe("DATA_COLLECTION_NOT_ACCEPTED");
    expectNoKeys(validation.body);
    expect(JSON.stringify(validation.body)).not.toContain(VALID_OPENCODE_KEY);
  });

  it("rejects a key OpenCode does not know", async () => {
    const credential = (await agent.post("/api/ai/credentials").send({ provider: "OPENCODE", apiKey: "oc-wrong-key-0123456789abcdefghij" }).expect(201)).body.credential;
    const validation = await agent.post(`/api/ai/credentials/${credential.id}/validate`).expect(200);
    expect(validation.body).toMatchObject({ valid: false, reason: "AI_KEY_INVALID" });
  });
});

describe("AI keys", () => {
  it("stores keys encrypted and only ever returns the last 4 characters", async () => {
    const credential = await addKey("CLAUDE", VALID_CLAUDE_KEY);
    expect(credential.keyHint).toBe(VALID_CLAUDE_KEY.slice(-4));

    const list = await agent.get("/api/ai/credentials").expect(200);
    expect(list.body.credentials).toHaveLength(1);
    expectNoKeys(list.body);

    const stored = await prisma.aiCredential.findFirstOrThrow();
    expect(stored.encryptedApiKey).not.toContain(VALID_CLAUDE_KEY);
  });

  it("rejects keys that do not match the provider, and duplicates", async () => {
    const wrongPrefix = await agent.post("/api/ai/credentials").send({ provider: "CLAUDE", apiKey: VALID_OPENROUTER_KEY });
    expect(wrongPrefix.status).toBe(400);

    await addKey("CLAUDE", VALID_CLAUDE_KEY);
    const duplicate = await agent.post("/api/ai/credentials").send({ provider: "CLAUDE", apiKey: VALID_CLAUDE_KEY });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.reason).toBe("AI_CREDENTIAL_EXISTS");
  });

  it("validates a Claude key with the provider and records the result", async () => {
    const credential = await addKey("CLAUDE", VALID_CLAUDE_KEY);
    const response = await agent.post(`/api/ai/credentials/${credential.id}/validate`).expect(200);

    expect(response.body).toMatchObject({ valid: true });
    expect(response.body.details.modelsAvailable).toContain("Claude Opus 5.5");
    expect(fake.requests.at(-1)).toMatchObject({ host: "anthropic", apiKey: VALID_CLAUDE_KEY });

    const list = await agent.get("/api/ai/credentials").expect(200);
    expect(list.body.credentials[0].lastValidationStatus).toBe("VALID");
  });

  it("reports a rejected key without logging the user out of Cockpit", async () => {
    const credential = await addKey("CLAUDE", INVALID_CLAUDE_KEY);
    const response = await agent.post(`/api/ai/credentials/${credential.id}/validate`).expect(200);

    expect(response.body).toMatchObject({ valid: false, reason: "AI_KEY_INVALID" });
    await agent.get("/api/auth/me").expect(200);
  });

  it("validates an OpenRouter key and shows free-tier usage", async () => {
    const credential = await addKey("OPENROUTER", VALID_OPENROUTER_KEY);
    const response = await agent.post(`/api/ai/credentials/${credential.id}/validate`).expect(200);

    expect(response.body).toMatchObject({
      valid: true,
      details: { paidBefore: false, freeRequestsToday: 3, freeRequestsDailyLimit: 50 },
    });
  });

  it("replacing a key resets its validation; deleting it clears the AI settings that used it", async () => {
    const credential = await addKey("CLAUDE", VALID_CLAUDE_KEY);
    await agent.post(`/api/ai/credentials/${credential.id}/validate`).expect(200);

    const updated = await agent
      .patch(`/api/ai/credentials/${credential.id}`)
      .send({ apiKey: INVALID_CLAUDE_KEY })
      .expect(200);
    expect(updated.body.credential).toMatchObject({ keyHint: INVALID_CLAUDE_KEY.slice(-4), lastValidationStatus: null });

    await agent.patch(`/api/ai/credentials/${credential.id}`).send({ apiKey: VALID_CLAUDE_KEY }).expect(200);
    await agent
      .put("/api/ai/preferences")
      .send({ provider: "CLAUDE", model: "claude-sonnet-5-5", effort: "HIGH", dailyLimitUsd: 5, acceptDataCollection: false })
      .expect(200);

    await agent.delete(`/api/ai/credentials/${credential.id}`).expect(200);
    const preference = await agent.get("/api/ai/preferences").expect(200);
    expect(preference.body.preference).toMatchObject({ provider: null, model: null, effort: "HIGH", dailyLimitUsd: 5 });
  });

  it("keeps keys private to their owner", async () => {
    const credential = await addKey("CLAUDE", VALID_CLAUDE_KEY);
    const intruder = await signIn();

    expect((await intruder.get("/api/ai/credentials").expect(200)).body.credentials).toEqual([]);
    await intruder.post(`/api/ai/credentials/${credential.id}/validate`).expect(404);
    await intruder.delete(`/api/ai/credentials/${credential.id}`).expect(404);
    await intruder.patch(`/api/ai/credentials/${credential.id}`).send({ label: "x" }).expect(404);
  });
});

describe("AI models", () => {
  it("offers the three current Claude models with prices and efforts", async () => {
    const response = await agent.get("/api/ai/models?provider=CLAUDE").expect(200);
    expect(response.body.models.map((model: { id: string }) => model.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(response.body.models[0]).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20, efforts: ["LOW", "MEDIUM", "HIGH"] });
  });

  it("offers only OpenRouter models that can return schema-checked JSON, flagging free ones", async () => {
    const response = await agent.get("/api/ai/models?provider=OPENROUTER").expect(200);
    const models = response.body.models as Array<{ id: string; free: boolean; mayCollectData: boolean; efforts: string[]; inputPerMTok: number }>;

    expect(models.map((model) => model.id)).toEqual(["deepseek/deepseek-chat:free", "deepseek/deepseek-r1"]);
    expect(models[0]).toMatchObject({ free: true, mayCollectData: true, efforts: [] });
    expect(models[1]).toMatchObject({ free: false, mayCollectData: false, efforts: ["LOW", "MEDIUM", "HIGH"], inputPerMTok: 0.5 });
  });

  it("lets only SOP owners restrict the OpenRouter model list", async () => {
    await agent.put("/api/ai/settings/openrouter-models").send({ modelIds: ["deepseek/deepseek-r1"] }).expect(403);

    const me = (await agent.get("/api/auth/me").expect(200)).body.user;
    expect(me.isSopAdmin).toBe(false);
    process.env.SOP_ADMIN_EMAILS = `someone@else.com, ${me.email.toUpperCase()}`;
    expect((await agent.get("/api/auth/me").expect(200)).body.user.isSopAdmin).toBe(true);

    await agent.put("/api/ai/settings/openrouter-models").send({ modelIds: ["deepseek/deepseek-r1", " deepseek/deepseek-r1 "] }).expect(200);
    const settings = (await agent.get("/api/ai/settings/openrouter-models").expect(200)).body;
    expect(settings.modelIds).toEqual(["deepseek/deepseek-r1"]);
    // The full catalog stays visible to owners so they can widen the list again.
    expect(settings.models).toHaveLength(2);

    const models = (await agent.get("/api/ai/models?provider=OPENROUTER").expect(200)).body.models;
    expect(models.map((model: { id: string }) => model.id)).toEqual(["deepseek/deepseek-r1"]);
  });

  it("reports an OpenRouter outage clearly", async () => {
    fake.openRouterDown = true;
    const response = await agent.get("/api/ai/models?provider=OPENROUTER").expect(502);
    expect(response.body.reason).toBe("AI_UPSTREAM_ERROR");
  });
});

describe("AI settings", () => {
  it("requires a key for the chosen provider", async () => {
    const response = await agent
      .put("/api/ai/preferences")
      .send({ provider: "CLAUDE", model: "claude-opus-5-5", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false })
      .expect(422);
    expect(response.body.reason).toBe("AI_KEY_REQUIRED");
  });

  it("rejects models Cockpit doesn't offer and unsupported effort levels", async () => {
    await addKey("OPENROUTER", VALID_OPENROUTER_KEY);

    const unknown = await agent
      .put("/api/ai/preferences")
      .send({ provider: "OPENROUTER", model: "vendor/no-json-model", effort: "MEDIUM", dailyLimitUsd: 2, acceptDataCollection: false })
      .expect(422);
    expect(unknown.body.reason).toBe("AI_MODEL_NOT_OFFERED");
  });

  it("requires consent before a model whose providers may keep ticket text", async () => {
    await addKey("OPENROUTER", VALID_OPENROUTER_KEY);
    const choice = { provider: "OPENROUTER", model: "deepseek/deepseek-chat:free", effort: "MEDIUM", dailyLimitUsd: 0 };

    const refused = await agent.put("/api/ai/preferences").send({ ...choice, acceptDataCollection: false }).expect(422);
    expect(refused.body.reason).toBe("DATA_COLLECTION_NOT_ACCEPTED");

    const accepted = await agent.put("/api/ai/preferences").send({ ...choice, acceptDataCollection: true }).expect(200);
    expect(accepted.body.preference.dataCollectionAcceptedAt).toEqual(expect.any(String));
  });

  it("saves a Claude choice with effort and daily limit", async () => {
    await addKey("CLAUDE", VALID_CLAUDE_KEY);
    const response = await agent
      .put("/api/ai/preferences")
      .send({ provider: "CLAUDE", model: "claude-haiku-5-5", effort: "LOW", dailyLimitUsd: 0.5, acceptDataCollection: false })
      .expect(200);

    expect(response.body.preference).toMatchObject({ provider: "CLAUDE", model: "claude-haiku-5-5", effort: "LOW", dailyLimitUsd: 0.5, dataCollectionAcceptedAt: null });
  });

  it("validates limits", async () => {
    await agent
      .put("/api/ai/preferences")
      .send({ provider: null, model: null, effort: "MEDIUM", dailyLimitUsd: 1000, acceptDataCollection: false })
      .expect(400);
  });

  it("defaults to no provider, medium effort and a $2 daily limit", async () => {
    const response = await agent.get("/api/ai/preferences").expect(200);
    expect(response.body.preference).toMatchObject({ provider: null, model: null, effort: "MEDIUM", dailyLimitUsd: 2 });
  });
});

describe("AI usage", () => {
  it("summarises today's and this month's spend", async () => {
    const me = (await agent.get("/api/auth/me").expect(200)).body.user;
    const opus = CLAUDE_MODELS[0]!;
    const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 50_000, cacheWriteTokens: 0 };
    const cost = estimateCostUsd(opus, usage);

    expect(cost).toBeCloseTo(10_000 * 4e-6 + 1_000 * 20e-6 + 50_000 * 0.2e-6, 6);

    await recordAiUsage({ userId: me.id, provider: "CLAUDE", model: opus.id, purpose: "sop-check", usage, costUsd: cost });
    await recordAiUsage({ userId: me.id, provider: "CLAUDE", model: opus.id, purpose: "sop-check", usage, costUsd: cost });

    const response = await agent.get("/api/ai/usage").expect(200);
    expect(response.body.usage).toMatchObject({ callsToday: 2 });
    expect(response.body.usage.todayUsd).toBeCloseTo(cost * 2, 4);
    expect(response.body.usage.monthUsd).toBeCloseTo(cost * 2, 4);
  });
});
