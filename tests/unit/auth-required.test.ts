import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { listActionsController } from "../../src/controllers/action.controller.js";
import { listAiCredentialsController } from "../../src/controllers/ai.controller.js";
import { listProjectsController } from "../../src/controllers/azure.controller.js";
import { listNotificationsController } from "../../src/controllers/notification.controller.js";
import { connectPlatformController } from "../../src/controllers/platform.controller.js";
import { catalogController, listConnectionsController, timeCsvController } from "../../src/controllers/solidtime.controller.js";
import { getDefaultRulebookController, testSopRulesController } from "../../src/controllers/sop.controller.js";
import { listTriageController } from "../../src/controllers/triage.controller.js";
import { requireSopAdmin } from "../../src/lib/sop-admin.js";
import { loadAzureCredential } from "../../src/middleware/azure-credential.middleware.js";
import { loadSolidtimeConnection } from "../../src/middleware/solidtime-connection.middleware.js";

type Guard = (req: Request, res: Response, next: NextFunction) => unknown;

/** Calls a handler for a request with no signed-in user and returns what it answered. */
async function answerWithoutUser(handler: Guard) {
  const answer: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      answer.status = code;
      return res;
    },
    json(body: unknown) {
      answer.body = body;
      return res;
    },
  } as unknown as Response;
  await handler({ params: {}, query: {}, body: {}, cookies: {} } as unknown as Request, res, () => undefined);
  return answer;
}

describe("401 answers", () => {
  it("every guard that finds no signed-in user names the reason AUTH_REQUIRED", async () => {
    const guards: Record<string, Guard> = {
      listActionsController,
      listAiCredentialsController,
      listProjectsController,
      listNotificationsController,
      connectPlatformController,
      listConnectionsController,
      catalogController,
      timeCsvController,
      getDefaultRulebookController,
      testSopRulesController,
      listTriageController,
      requireSopAdmin,
      loadAzureCredential,
      loadSolidtimeConnection,
    };

    for (const [name, guard] of Object.entries(guards)) {
      expect(await answerWithoutUser(guard), name).toEqual({ status: 401, body: { message: "Authentication required", reason: "AUTH_REQUIRED" } });
    }
  });
});
