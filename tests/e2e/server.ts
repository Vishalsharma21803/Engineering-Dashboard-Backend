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
const { createFakeAzure, fakeAzureHandlers } = await import("../support/fake-azure.js");

const blockExternal = http.all(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, ({ request }) => {
  console.error(`Unmocked external request blocked: ${request.method} ${request.url}`);
  return HttpResponse.error();
});

let fake = createFakeAzure();
const server = setupServer(...fakeAzureHandlers(fake), blockExternal);
server.listen({ onUnhandledFrame: "bypass" });

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "ProposedAction", "Credential", "User" CASCADE'
  );
  clearAzureCache();
  fake = createFakeAzure();
  server.resetHandlers(...fakeAzureHandlers(fake), blockExternal);
}

await reset();

const app = createApp();

// Test-only inspection of what reached "Azure DevOps".
app.post("/__e2e/reset", async (_req, res) => {
  await reset();
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

app.get("/__e2e/work-items/:id", (req, res) => {
  const item = fake.workItems.get(Number(req.params.id));
  res.json({ workItem: item ?? null, comments: fake.comments.get(Number(req.params.id)) ?? [] });
});

app.listen(port, () => {
  console.log(`e2e backend listening on port ${port}`);
});
