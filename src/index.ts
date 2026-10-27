import "dotenv/config";

import { createApp } from "./app.js";
import { assertEncryptionConfigured } from "./lib/encryption.js";
import { prisma } from "./lib/prisma.js";
import { assertServerConfig } from "./lib/server-config.js";
import { recoverInterruptedActions } from "./services/actions/action.service.js";
import { purgeExpiredRevocations } from "./services/auth.service.js";
import { recoverSopAiQueue, stopSopAiWorker } from "./services/sop/ai/sop-ai.service.js";

assertEncryptionConfigured();
assertServerConfig();

const app = createApp();

const PORT = Number(process.env.PORT) || 3000;
/** How long a deploy waits for in-flight AI checks before exiting. */
const SHUTDOWN_GRACE_MS = 30_000;
/** How often interrupted actions and expired sign-out records are cleaned up. */
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;

function runMaintenance(): void {
  recoverInterruptedActions()
    .then((count) => {
      if (count > 0) console.warn(`Marked ${count} interrupted action(s) as failed`);
    })
    .catch((error: unknown) => console.error("Recovering interrupted actions failed:", error));
  purgeExpiredRevocations().catch((error: unknown) => console.error("Purging expired sign-out records failed:", error));
}

const maintenance = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
maintenance.unref();

const server = app.listen(PORT, () => {
  console.log(`server is listening on port ${PORT}`);
  // AI checks abandoned by a crashed process run again.
  recoverSopAiQueue().catch((error: unknown) => console.error("Recovering the SOP AI queue failed:", error));
  // Actions cut off mid-execution by a crash end as FAILED instead of staying EXECUTING.
  runMaintenance();
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(maintenance);
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
