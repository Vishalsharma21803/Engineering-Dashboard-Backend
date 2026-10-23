import { execFileSync } from "node:child_process";
import pg from "pg";

import { resolveTestDatabaseUrl } from "./test-db-url.mjs";

const testUrl = new URL(resolveTestDatabaseUrl());
const databaseName = testUrl.pathname.replace(/^\//, "");
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();

try {
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);

  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    console.log(`Created test database ${databaseName}`);
  }
} finally {
  await admin.end();
}

execFileSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl.toString() },
});
