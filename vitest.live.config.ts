import { defineConfig } from "vitest/config";

/**
 * Real Azure DevOps read-only checks. Skipped unless AZURE_LIVE_ORG_URL
 * and AZURE_LIVE_PAT are set.
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      // AzureClient does not touch the database; prisma.ts only needs a value.
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://unused@localhost:5432/unused_test",
    },
  },
});
