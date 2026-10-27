import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

/**
 * Backend for Playwright: the real app on the test database, with Azure
 * DevOps replaced by the in-memory fake org. Never used in development.
 */

function resolveE2eDatabaseUrl(): string {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  const env = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const value = process.env.TEST_DATABASE_URL ?? env.DATABASE_URL;

  if (!value) {
    throw new Error("Set TEST_DATABASE_URL or DATABASE_URL in backend/.env");
  }

  const url = new URL(value);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
  return url.toString();
}

const port = Number(process.env.E2E_PORT ?? 3100);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = resolveE2eDatabaseUrl();
process.env.JWT_SECRET = "e2e-jwt-secret-not-for-production";
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.FRONTEND_ORIGIN = process.env.E2E_FRONTEND_ORIGIN ?? "http://localhost:5174";

// Imported after env is set: prisma.ts reads DATABASE_URL at import time.
const { createApp } = await import("../../src/app.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { clearAzureCache } = await import("../../src/lib/azure/cache.js");
const { ME, addFakeTasks, createFakeAzure, fakeAzureHandlers } = await import("../support/fake-azure.js");
const { createFakeAi, fakeAiHandlers } = await import("../support/fake-ai.js");
const { addEntry, createFakeSolidtime, fakeSolidtimeHandlers } = await import("../support/fake-solidtime.js");
const { clearSolidtimeCache } = await import("../../src/lib/solidtime/client.js");
const { clearOpenRouterModelsCache } = await import("../../src/lib/ai/openrouter.js");
const { clearOpenCodeModelsCache } = await import("../../src/lib/ai/opencode.js");
const { clearMyWorkSnapshots } = await import("../../src/services/work-item-list/my-work.service.js");
const { clearDashboardLists } = await import("../../src/services/work-item-list/dashboard-lists.service.js");
const { useAlphaRulebook } = await import("../support/test-rulebook.js");

const blockExternal = http.all(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, ({ request }) => {
  console.error(`Unmocked external request blocked: ${request.method} ${request.url}`);
  return HttpResponse.error();
});

// A second, nearly empty organization with a different project, for org-switching tests.
const SECOND_ORG = "https://dev.azure.com/fake-org-2";
const GAMMA = { id: "eeeeeeee-0000-4000-8000-000000000005", name: "Gamma", state: "wellFormed", visibility: "private" };
const secondOrg = http.all(`${SECOND_ORG}/*`, ({ request }) => {
  const path = new URL(request.url).pathname.replace(/^\/fake-org-2/, "").toLowerCase();

  if (path === "/_apis/connectiondata") {
    return HttpResponse.json({ authenticatedUser: { id: "11111111-1111-4111-8111-111111111111", providerDisplayName: "Dev Example" } });
  }
  if (path === "/_apis/projects") return HttpResponse.json({ count: 1, value: [GAMMA] });
  if (path.startsWith("/_apis/projects/") && !path.includes("/teams")) return HttpResponse.json(GAMMA);
  if (path.endsWith("/_apis/wit/wiql")) return HttpResponse.json({ workItems: [] });
  return HttpResponse.json({ count: 0, value: [] });
});

let fake = createFakeAzure();
let fakeAi = createFakeAi();
let fakeSolidtime = createFakeSolidtime();
const server = setupServer(...fakeAzureHandlers(fake), ...fakeAiHandlers(fakeAi), ...fakeSolidtimeHandlers(fakeSolidtime), secondOrg, blockExternal);
server.listen({ onUnhandledFrame: "bypass" });

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "ProposedAction", "Credential", "User", "AppSetting", "Rulebook", "SopProject", "SopProjectChange" CASCADE'
  );
  clearAzureCache();
  fake = createFakeAzure();
  fakeAi = createFakeAi();
  fakeSolidtime = createFakeSolidtime();
  clearSolidtimeCache();
  clearOpenRouterModelsCache();
  clearOpenCodeModelsCache();
  clearMyWorkSnapshots();
  clearDashboardLists();
  server.resetHandlers(...fakeAzureHandlers(fake), ...fakeAiHandlers(fakeAi), ...fakeSolidtimeHandlers(fakeSolidtime), secondOrg, blockExternal);
}

await reset();

const app = createApp();

// Test-only inspection of what reached "Azure DevOps".
app.post("/__e2e/reset", async (_req, res) => {
  await reset();
  res.json({ ok: true });
});

// Makes the fake AI fail every rule with this fix, e.g. { "target": "comment", "text": "..." }.
app.post("/__e2e/ai-fix", (req, res) => {
  const fix = req.body as { target: string; text: string };
  fakeAi.verdicts = (rules) =>
    rules.map((ruleId) => ({ ruleId, verdict: "fail", reason: `Fake verdict for ${ruleId}.`, advice: `Fake advice for ${ruleId}.`, quotes: [], fix }));
  res.json({ ok: true });
});

// Adds open Alpha tasks assigned to the developer, for pagination tests: { "count": 23 }.
app.post("/__e2e/tickets", (req, res) => {
  const count = Math.min(Number((req.body as { count?: unknown }).count) || 0, 200);
  addFakeTasks(fake, count);
  res.json({ ok: true, count });
});

// Yesterday (UTC) for the Time → Draft tab: #102 Completed Work +2 h, #103 edited and resolved (no hours), a 30 min standup already in Solidtime.
app.post("/__e2e/draft-activity", (_req, res) => {
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const at = (time: string) => `${day}T${time}:00Z`;
  fake.updates.set(102, [{ id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("11:00") }, "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: 0, newValue: 2 } } }]);
  fake.updates.set(103, [
    { id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("13:00") }, "System.Title": { oldValue: "Crash", newValue: "Crash on save" } } },
    { id: 2, rev: 5, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("15:00") }, "System.State": { oldValue: "Active", newValue: "Resolved" } } },
  ]);
  addEntry(fakeSolidtime, { start: at("08:00"), end: at("08:30"), description: "Standup" });
  res.json({ ok: true, day });
});

// A finished Solidtime entry for the developer: { "description": "#101 Implement login", "hours": 2 } (ends now).
app.post("/__e2e/solidtime-entry", (req, res) => {
  const { description, hours } = req.body as { description: string; hours: number };
  const end = new Date();
  const start = new Date(end.getTime() - Number(hours) * 3_600_000);
  const iso = (at: Date) => `${at.toISOString().slice(0, 19)}Z`;
  addEntry(fakeSolidtime, { start: iso(start), end: iso(end), description: String(description) });
  res.json({ ok: true });
});

// Default SOP rules covering the fake Alpha project (Beta stays unconfigured).
app.post("/__e2e/rulebook", async (_req, res) => {
  await useAlphaRulebook();
  res.json({ ok: true });
});

app.get("/__e2e/requests", (_req, res) => {
  res.json({
    requests: fake.requests.map((request) => ({
      method: request.method,
      path: request.path,
      isWrite: request.isWrite,
      body: request.body,
    })),
  });
});

// What reached "Solidtime" (entries as stored there).
app.get("/__e2e/solidtime", (_req, res) => {
  res.json({ entries: fakeSolidtime.entries, writes: fakeSolidtime.requests.filter((request) => request.method !== "GET").map((request) => ({ method: request.method, path: request.path })) });
});

app.get("/__e2e/work-items/:id", (req, res) => {
  const item = fake.workItems.get(Number(req.params.id));
  res.json({ workItem: item ?? null, comments: fake.comments.get(Number(req.params.id)) ?? [] });
});

app.listen(port, () => {
  console.log(`e2e backend listening on port ${port}`);
});
