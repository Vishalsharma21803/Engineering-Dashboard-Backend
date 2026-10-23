import { defineConfig } from "vitest/config";

import { resolveTestDatabaseUrl } from "./scripts/test-db-url.mjs";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests share one test database.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: resolveTestDatabaseUrl(),
      JWT_SECRET: "test-jwt-secret-not-for-production",
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      FRONTEND_ORIGIN: "http://localhost:5173",
    },
  },
});
