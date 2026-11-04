import "dotenv/config";

import { createApp } from "./app.js";
import { assertEncryptionConfigured } from "./lib/encryption.js";
import { beginShutdown, isShuttingDown, requestsInFlight, waitForRequests } from "./lib/lifecycle.js";
import { prisma } from "./lib/prisma.js";
import { assertServerConfig, describeMode, isProduction } from "./lib/server-config.js";
import { warnAboutUnclaimedSopAdminEmails } from "./lib/signup-policy.js";
import { recoverInterruptedActions } from "./services/actions/action.service.js";
import { purgeExpiredRevocations } from "./services/auth.service.js";
import { purgeStaleAiReservations } from "./services/ai/ai-usage.service.js";
import { recoverSopAiQueue, stopSopAiWorker } from "./services/sop/ai/sop-ai.service.js";

console.log(describeMode());
assertEncryptionConfigured();
assertServerConfig();

if (!process.env.TRUST_PROXY) {
  console.log("TRUST_PROXY not set: rate limits and audit IPs use the proxy's address if a proxy is in front");
}

const app = createApp();

const PORT = Number(process.env.PORT) || 4000;
/** How long a deploy waits for running requests and AI checks before exiting. */
const SHUTDOWN_GRACE_MS = 30_000;
/** An approval being applied may take minutes (large time batches); shutdown waits up to this long for it. */
const APPROVAL_GRACE_MS = 600_000;
/** How often interrupted actions and expired sign-out records are cleaned up. */
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;

function runMaintenance(): void {
  recoverInterruptedActions()
    .then((count) => {
      if (count > 0) console.warn(`Marked ${count} interrupted action(s) as failed`);
    })
    .catch((error: unknown) => console.error("Recovering interrupted actions failed:", error));
  purgeExpiredRevocations().catch((error: unknown) => console.error("Purging expired sign-out records failed:", error));
  // Spend held by an AI call that never finished (crash) stops counting after 10 minutes.
  purgeStaleAiReservations().catch((error: unknown) => console.error("Removing stale AI spend reservations failed:", error));
}

let maintenance: NodeJS.Timeout | null = null;

const server = app.listen(PORT, (error?: Error) => {
  if (error) {
    console.error(`Could not listen on port ${PORT}: ${error.message}`);
    process.exit(1);
  }

  console.log(`server is listening on port ${PORT}`);
  maintenance = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();
  // AI checks abandoned by a crashed process run again.
  recoverSopAiQueue().catch((error: unknown) => console.error("Recovering the SOP AI queue failed:", error));
  // Actions cut off mid-execution by a crash end as FAILED instead of staying EXECUTING.
  runMaintenance();

  if (isProduction()) {
    warnAboutUnclaimedSopAdminEmails().catch((error: unknown) => console.error("Checking SOP_ADMIN_EMAILS accounts failed:", error));
  }
});

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown()) {
    // A second Ctrl+C or SIGTERM does not wait any longer.
    const running = requestsInFlight();
    console.warn(`${signal} received again: exiting now, cutting off ${running.total} running request(s) (${running.approvals} approval(s))`);
    process.exit(1);
  }

  beginShutdown();
  if (maintenance) clearInterval(maintenance);
  console.log(`${signal} received: shutting down after running requests and AI checks finish (send it again to exit at once)`);
  // New requests get a 503; running ones (approvals for up to 10 minutes) and AI checks may finish; then the database is released.
  server.close();
  server.closeIdleConnections();
  const [finished] = await Promise.all([waitForRequests(SHUTDOWN_GRACE_MS, APPROVAL_GRACE_MS), stopSopAiWorker(SHUTDOWN_GRACE_MS)]);

  if (!finished) {
    const running = requestsInFlight();
    console.warn(`Shutting down with ${running.total} request(s) still running (${running.approvals} approval(s)); they are cut off`);
  }

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
