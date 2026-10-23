import { AppError } from "../../lib/app-error.js";
import { ApprovalTicket, isTicketConsumed } from "../../lib/azure/approval-ticket.js";
import { pullRequestArtifactUri } from "../../lib/azure/artifact-links.js";
import type { AzureClient } from "../../lib/azure/client.js";
import type { RawBuild } from "../../lib/azure/azure-api.types.js";
import { textToHtml } from "../../lib/html-to-text.js";
import type { UpdatableWorkField } from "../../schemas/action.schema.js";
import { asNumber, asString } from "../azure/mappers.js";
import { getBuild } from "../azure/pipelines.service.js";
import { WORK_ITEM_FIELDS, extractLinks, getWorkItem } from "../azure/work-items.service.js";
import {
  WORK_FIELD_REFERENCE,
  loadRetryableStage,
  loadRunningBuild,
  loadWorkItemForAction,
} from "./prepare.js";

/**
 * The ONLY module allowed to write to Azure DevOps. It is invoked by
 * action.service after an action row moved PENDING → APPROVED → EXECUTING.
 */

const COMMENTS_API_VERSION = "7.1-preview.4";
const JSON_PATCH = "application/json-patch+json";

export interface ApprovedAction {
  id: string;
  kind: string;
  projectId: string;
  target: Record<string, unknown>;
  params: Record<string, unknown>;
  baseRev: number | null;
}

export interface ExecutionResult {
  result: Record<string, unknown>;
  verification: { verified: boolean; checks: Array<{ check: string; passed: boolean }> };
}

type PatchOperation =
  | { op: "test"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown };

function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];

  if (typeof value !== "number") {
    throw new Error(`INVALID_STORED_PARAM:${key}`);
  }

  return value;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];

  if (typeof value !== "string") {
    throw new Error(`INVALID_STORED_PARAM:${key}`);
  }

  return value;
}

async function assertFreshWorkItem(client: AzureClient, action: ApprovedAction) {
  const workItem = await loadWorkItemForAction(
    client,
    action.projectId,
    numberParam(action.target, "workItemId")
  );

  if (action.baseRev !== null && workItem.rev !== action.baseRev) {
    throw new AppError(
      409,
      "ACTION_STALE",
      "The work item changed after this action was proposed. Propose it again."
    );
  }

  return workItem;
}

async function patchWorkItem(
  client: AzureClient,
  ticket: ApprovalTicket,
  workItemId: number,
  baseRev: number | null,
  operations: PatchOperation[]
) {
  const guarded: PatchOperation[] =
    baseRev === null ? operations : [{ op: "test", path: "/rev", value: baseRev }, ...operations];

  return client.write<{ id: number; rev: number }>(
    ticket,
    "PATCH",
    ["_apis", "wit", "workitems", String(workItemId)],
    guarded,
    { contentType: JSON_PATCH }
  );
}

type Verification = ExecutionResult["verification"];

/** The write already happened; a failed read-back must not turn it into a failure. */
async function safeVerify(fn: () => Promise<Verification>): Promise<Verification> {
  try {
    return await fn();
  } catch {
    return { verified: false, checks: [{ check: "read back from Azure DevOps", passed: false }] };
  }
}

async function verifyFields(
  client: AzureClient,
  workItemId: number,
  expected: Record<string, unknown>
): Promise<ExecutionResult["verification"]> {
  const fresh = await getWorkItem(client, workItemId, { cacheTtlMs: 0 });
  const checks = Object.entries(expected).map(([field, value]) => ({
    check: field,
    passed: fresh.fields[field] === value,
  }));

  return { verified: checks.every((check) => check.passed), checks };
}

/** Wraps any execution error with whether the Azure write was already sent. */
export class ExecutionFailure extends Error {
  constructor(
    readonly error: unknown,
    readonly writeSent: boolean
  ) {
    super(error instanceof Error ? error.message : "Execution failed");
    this.name = "ExecutionFailure";
  }
}

export async function executeAction(
  client: AzureClient,
  action: ApprovedAction
): Promise<ExecutionResult> {
  const ticket = ApprovalTicket.issue(action.id, client.credentialId);

  try {
    return await runAction(client, action, ticket);
  } catch (error) {
    throw new ExecutionFailure(error, isTicketConsumed(ticket));
  }
}

async function runAction(
  client: AzureClient,
  action: ApprovedAction,
  ticket: ApprovalTicket
): Promise<ExecutionResult> {
  const params = action.params;

  switch (action.kind) {
    case "WORK_ITEM_COMMENT": {
      const workItem = await assertFreshWorkItem(client, action);
      const comment = await client.write<{ id: number }>(
        ticket,
        "POST",
        [action.projectId, "_apis", "wit", "workItems", String(workItem.id), "comments"],
        { text: textToHtml(stringParam(params, "text")) },
        { apiVersion: COMMENTS_API_VERSION }
      );

      return {
        result: { workItemId: workItem.id, commentId: comment?.id ?? null },
        verification: {
          verified: typeof comment?.id === "number",
          checks: [{ check: "comment created", passed: typeof comment?.id === "number" }],
        },
      };
    }

    case "WORK_ITEM_UPDATE_FIELDS": {
      const workItem = await assertFreshWorkItem(client, action);
      const expected: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(params)) {
        const reference = WORK_FIELD_REFERENCE[key as UpdatableWorkField];

        if (!reference || typeof value !== "number") {
          throw new Error(`INVALID_STORED_PARAM:${key}`);
        }

        expected[reference] = value;
      }

      const updated = await patchWorkItem(
        client,
        ticket,
        workItem.id,
        action.baseRev,
        Object.entries(expected).map(([field, value]) => ({
          op: "add",
          path: `/fields/${field}`,
          value,
        }))
      );

      return {
        result: { workItemId: workItem.id, rev: updated?.rev ?? null },
        verification: await safeVerify(() => verifyFields(client, workItem.id, expected)),
      };
    }

    case "WORK_ITEM_TRANSITION_STATE":
    case "WORK_ITEM_CLOSE_AFTER_MERGE": {
      const workItem = await assertFreshWorkItem(client, action);
      const expected: Record<string, unknown> = {
        [WORK_ITEM_FIELDS.state]: stringParam(params, "state"),
      };

      if (params.remainingWork !== undefined) {
        expected[WORK_ITEM_FIELDS.remainingWork] = numberParam(params, "remainingWork");
      }

      const updated = await patchWorkItem(
        client,
        ticket,
        workItem.id,
        action.baseRev,
        Object.entries(expected).map(([field, value]) => ({
          op: "add",
          path: `/fields/${field}`,
          value,
        }))
      );

      return {
        result: {
          workItemId: workItem.id,
          rev: updated?.rev ?? null,
          previousState: asString(workItem.fields[WORK_ITEM_FIELDS.state]),
          previousRemainingWork: asNumber(workItem.fields[WORK_ITEM_FIELDS.remainingWork]),
        },
        verification: await safeVerify(() => verifyFields(client, workItem.id, expected)),
      };
    }

    case "WORK_ITEM_LINK_PR": {
      const workItem = await assertFreshWorkItem(client, action);
      const pullRequest = {
        projectId: stringParam(params, "pullRequestProjectId"),
        repositoryId: stringParam(params, "repositoryId"),
        pullRequestId: numberParam(params, "pullRequestId"),
      };
      const updated = await patchWorkItem(client, ticket, workItem.id, action.baseRev, [
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "ArtifactLink",
            url: pullRequestArtifactUri(pullRequest),
            attributes: { name: "Pull Request" },
          },
        },
      ]);

      return {
        result: { workItemId: workItem.id, rev: updated?.rev ?? null, ...pullRequest },
        verification: await safeVerify(async () => {
          const fresh = await getWorkItem(client, workItem.id, { cacheTtlMs: 0 });
          const linked = extractLinks(fresh).pullRequests.some(
            (link) =>
              link.repositoryId.toLowerCase() === pullRequest.repositoryId.toLowerCase() &&
              link.pullRequestId === pullRequest.pullRequestId
          );
          return { verified: linked, checks: [{ check: "pull request linked", passed: linked }] };
        }),
      };
    }

    case "PIPELINE_QUEUE_RUN": {
      const definitionId = numberParam(action.target, "definitionId");
      const build = await client.write<RawBuild>(
        ticket,
        "POST",
        [action.projectId, "_apis", "build", "builds"],
        { definition: { id: definitionId }, sourceBranch: stringParam(params, "sourceBranch") }
      );
      return {
        result: {
          buildId: build?.id ?? null,
          buildNumber: build?.buildNumber ?? null,
          status: build?.status ?? null,
        },
        verification: await safeVerify(async () => {
          if (!build) {
            return { verified: false, checks: [{ check: "run queued", passed: false }] };
          }

          const fresh = await getBuild(client, action.projectId, build.id, { cacheTtlMs: 0 });
          const queued = fresh.definitionId === definitionId;
          return { verified: queued, checks: [{ check: "run queued", passed: queued }] };
        }),
      };
    }

    case "BUILD_RETRY_STAGE": {
      const buildId = numberParam(action.target, "buildId");
      const stageRefName = stringParam(params, "stageRefName");
      await loadRetryableStage(client, action.projectId, buildId, stageRefName);
      await client.write(
        ticket,
        "PATCH",
        [action.projectId, "_apis", "build", "builds", String(buildId), "stages", stageRefName],
        { state: "retry", forceRetryAllJobs: false }
      );
      return {
        result: { buildId, stageRefName },
        verification: await safeVerify(async () => {
          const fresh = await getBuild(client, action.projectId, buildId, { cacheTtlMs: 0 });
          const restarted = fresh.status !== "completed";
          return { verified: restarted, checks: [{ check: "run restarted", passed: restarted }] };
        }),
      };
    }

    case "BUILD_CANCEL": {
      const buildId = numberParam(action.target, "buildId");
      await loadRunningBuild(client, action.projectId, buildId);
      await client.write(
        ticket,
        "PATCH",
        [action.projectId, "_apis", "build", "builds", String(buildId)],
        { status: "cancelling" }
      );
      return {
        result: { buildId },
        verification: await safeVerify(async () => {
          const fresh = await getBuild(client, action.projectId, buildId, { cacheTtlMs: 0 });
          const cancelling = fresh.status === "cancelling" || fresh.result === "canceled";
          return { verified: cancelling, checks: [{ check: "run cancelling", passed: cancelling }] };
        }),
      };
    }

    default:
      throw new Error(`UNSUPPORTED_ACTION_KIND:${action.kind}`);
  }
}
