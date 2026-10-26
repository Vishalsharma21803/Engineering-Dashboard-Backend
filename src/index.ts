import "dotenv/config";

import { createApp } from "./app.js";
import { assertEncryptionConfigured } from "./lib/encryption.js";
import { prisma } from "./lib/prisma.js";
import { assertServerConfig } from "./lib/server-config.js";
import { recoverSopAiQueue, stopSopAiWorker } from "./services/sop/ai/sop-ai.service.js";

assertEncryptionConfigured();
assertServerConfig();

const app = createApp();

const PORT = Number(process.env.PORT) || 3000;
/** How long a deploy waits for in-flight AI checks before exiting. */
const SHUTDOWN_GRACE_MS = 30_000;

const server = app.listen(PORT, () => {
  console.log(`server is listening on port ${PORT}`);
  // AI checks abandoned by a crashed process run again.
  recoverSopAiQueue().catch((error: unknown) => console.error("Recovering the SOP AI queue failed:", error));
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received: shutting down`);
  // Stop accepting requests, let running AI checks finish, then release the database.
  server.close();
  await stopSopAiWorker(SHUTDOWN_GRACE_MS);
  await prisma.$disconnect();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      console.error("Shutdown failed:", error);
      process.exit(1);
    });
  });
}
