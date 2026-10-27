import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { server } from "../setup.js";
import { VALID_CLAUDE_KEY, createFakeAi, fakeAiHandlers } from "../support/fake-ai.js";
import { EMPLOYEE_TOKEN, SOLIDTIME_URL } from "../support/fake-solidtime.js";
import { installFakeAzure, installFakeSolidtime, resetDatabase, signIn, type Agent } from "../support/harness.js";

let agent: Agent;

beforeEach(async () => {
  await resetDatabase();
  installFakeAzure();
  installFakeSolidtime();
  server.use(...fakeAiHandlers(createFakeAi()));
  agent = await signIn();
});

const connect = (body: Record<string, unknown>) => agent.post("/api/credentials/connect").send(body);

describe("platform registry", () => {
  it("lists every platform with its fields, and nothing that runs on the server", async () => {
    const { platforms } = (await agent.get("/api/credentials/platforms").expect(200)).body;
    expect(platforms.map((platform: { id: string; category: string }) => [platform.id, platform.category])).toEqual([
      ["azure", "integration"],
      ["solidtime", "integration"],
      ["claude", "ai"],
      ["openrouter", "ai"],
      ["opencode", "ai"],
    ]);
    const azure = platforms.find((platform: { id: string }) => platform.id === "azure");
    expect(azure.fields).toEqual([
      expect.objectContaining({ name: "organizationUrl", type: "url", required: true }),
      expect.objectContaining({ name: "patToken", type: "secret", required: true }),
    ]);
    expect(platforms.find((platform: { id: string }) => platform.id === "claude")).toMatchObject({ aiProvider: "CLAUDE", fields: [expect.objectContaining({ name: "apiKey", type: "secret" })] });
    expect(JSON.stringify(platforms)).not.toContain("connect");
  });

  it("adds an Azure DevOps credential through the platform's own rules, into the same list as before", async () => {
    const created = (await connect({ platform: "azure", label: "Team", fields: { organizationUrl: "https://dev.azure.com/Fake-Org", patToken: "fake-pat-token-0123456789abcdefghij", extra: "ignored" } }).expect(201)).body;
    expect(created).toMatchObject({ kind: "credential", name: "Team", record: { platform: "AZURE", organizationUrl: "https://dev.azure.com/fake-org", label: "Team" } });
    expect(JSON.stringify(created)).not.toContain("fake-pat-token");

    const { credentials } = (await agent.get("/api/credentials").expect(200)).body;
    expect(credentials).toEqual([expect.objectContaining({ id: created.id, label: "Team" })]);

    // Same organization again: refused like the old endpoint.
    expect((await connect({ platform: "azure", fields: { organizationUrl: "https://dev.azure.com/fake-org", patToken: "fake-pat-token-0123456789abcdefghij" } }).expect(409)).body.reason).toBe("CREDENTIAL_ALREADY_EXISTS");
  });

  it("reports field errors by field name", async () => {
    const response = (await connect({ platform: "azure", label: "", fields: { organizationUrl: "http://example.com", patToken: "short" } }).expect(400)).body;
    expect(response.errors.map((error: { field: string }) => error.field).sort()).toEqual(["organizationUrl", "patToken"]);
    await connect({ platform: "nope", fields: {} }).expect(400);
    await connect({ platform: "azure", fields: {}, surprise: true }).expect(400);
  });

  it("connects Solidtime and AI providers with their existing services", async () => {
    const solidtime = (await connect({ platform: "solidtime", label: "Company", fields: { baseUrl: SOLIDTIME_URL, token: EMPLOYEE_TOKEN } }).expect(201)).body;
    expect(solidtime).toMatchObject({ kind: "solidtime", name: "Company" });
    expect((await agent.get("/api/solidtime/connections").expect(200)).body.connections).toEqual([expect.objectContaining({ credentialId: solidtime.id, label: "Company" })]);

    // A key for the wrong provider is refused on its field.
    const wrong = (await connect({ platform: "openrouter", fields: { apiKey: VALID_CLAUDE_KEY } }).expect(400)).body;
    expect(wrong.errors).toEqual([expect.objectContaining({ field: "apiKey" })]);

    const claude = (await connect({ platform: "claude", fields: { apiKey: VALID_CLAUDE_KEY } }).expect(201)).body;
    expect(claude).toMatchObject({ kind: "ai", name: "Claude (Anthropic)", record: { provider: "CLAUDE", keyHint: "cdef" } });
    expect(await prisma.aiCredential.count()).toBe(1);
    expect((await connect({ platform: "claude", fields: { apiKey: VALID_CLAUDE_KEY } }).expect(409)).body.reason).toBe("AI_CREDENTIAL_EXISTS");
  });
});
