import { AppError } from "../../lib/app-error.js";
import { ApprovalTicket, isTicketConsumed } from "../../lib/azure/approval-ticket.js";
import { pullRequestArtifactUri } from "../../lib/azure/artifact-links.js";
import type { AzureClient } from "../../lib/azure/client.js";
import type { RawBuild, RawWorkItem } from "../../lib/azure/azure-api.types.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { htmlToText, textToHtml } from "../../lib/html-to-text.js";
import type { EditableTextField, UpdatableWorkField } from "../../schemas/action.schema.js";
import { asNumber, asString } from "../azure/mappers.js";
import { getBuild } from "../azure/pipelines.service.js";
import { WORK_ITEM_FIELDS, extractLinks, getWorkItem } from "../azure/work-items.service.js";
import {
  TEXT_FIELD_REFERENCE,
  WORK_FIELD_REFERENCE,
  isHtmlField,
  loadRetryableStage,
  loadRunningBuild,
  loadWorkItemForAction,
  splitTags,
  type TimeBatchItem,
} from "./prepare.js";
import { logFallback } from "../../lib/log-fallback.js";

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

function normalizeFieldValue(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function fieldLabel(reference: string): string {
  return reference.split(".").at(-1)?.replace(/([a-z])([A-Z])/g, "$1 $2") ?? reference;
}

/**
 * Re-reads the work item and refuses only if a field this action changes
 * was modified since the preview. Comments and unrelated edits create new
 * revisions in Azure DevOps and must not invalidate the proposal.
 */
async function assertFreshWorkItem(client: AzureClient, action: ApprovedAction) {
  const workItem = await loadWorkItemForAction(
    client,
    action.projectId,
    numberParam(action.target, "workItemId")
  );

  const expected = action.params.expected;

  if (expected && typeof expected === "object") {
    assertExpectedFields(workItem, expected as Record<string, unknown>);
  } else if (action.baseRev !== null && workItem.rev !== action.baseRev) {
    // Proposals created before field-level guards still use the whole-item revision.
    throw new AppError(
      409,
      "ACTION_STALE",
      "The work item changed after this action was proposed. Propose it again."
    );
  }

  return workItem;
}

/** Refuses when a field the change writes no longer holds the value the preview showed. */
function assertExpectedFields(workItem: RawWorkItem, expected: Record<string, unknown>): void {
  for (const [reference, before] of Object.entries(expected)) {
    const current = normalizeFieldValue(workItem.fields[reference]);

    if (current !== normalizeFieldValue(before)) {
      throw new AppError(
        409,
        "ACTION_STALE",
        `${fieldLabel(reference)} changed in Azure DevOps after this was proposed ` +
          `(was ${before ?? "empty"}, now ${current ?? "empty"}). Propose it again.`
      );
    }
  }
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
  } catch (error) {
    logFallback("Reading a written work item back from Azure DevOps failed", error);
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

type FieldComparison = "exact" | "html" | "tags";

/** The single field an edit/category/tags action writes, as Azure expects it. */
function singleFieldWrite(action: ApprovedAction): { reference: string; value: string; compare: FieldComparison } {
  const params = action.params;

  switch (action.kind) {
    case "WORK_ITEM_EDIT_TEXT": {
      const field = stringParam(params, "field") as EditableTextField;
      const reference = TEXT_FIELD_REFERENCE[field];

      if (!reference) {
        throw new Error("INVALID_STORED_PARAM:field");
      }

      const text = stringParam(params, "text");
      return isHtmlField(field)
        ? { reference, value: textToHtml(text), compare: "html" }
        : { reference, value: text, compare: "exact" };
    }
    case "WORK_ITEM_SET_CATEGORY":
      return { reference: stringParam(params, "field"), value: stringParam(params, "value"), compare: "exact" };
    case "WORK_ITEM_ADD_TAGS":
      return { reference: WORK_ITEM_FIELDS.tags, value: stringParam(params, "tags"), compare: "tags" };
    default:
      throw new Error(`UNSUPPORTED_ACTION_KIND:${action.kind}`);
  }
}

function sameValue(compare: FieldComparison, stored: unknown, wanted: string): boolean {
  if (compare === "html") {
    return htmlToText(asString(stored)).trim() === htmlToText(wanted).trim();
  }

  if (compare === "tags") {
    const normalize = (value: unknown) => splitTags(value).map((tag) => tag.toLowerCase()).sort().join(";");
    return normalize(stored) === normalize(wanted);
  }

  return stored === wanted;
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
  if (action.kind === "WORK_ITEMS_UPDATE_TIME") {
    return executeTimeBatch(client, action);
  }

  const ticket = ApprovalTicket.issue(action.id, client.credentialId);

  try {
    return await runAction(client, action, ticket);
  } catch (error) {
    throw new ExecutionFailure(error, isTicketConsumed(ticket));
  }
}

function storedTimeItems(params: Record<string, unknown>): TimeBatchItem[] {
  const items = params.items;

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("INVALID_STORED_PARAM:items");
  }

  return items as TimeBatchItem[];
}

/** The PAT itself is refused: every later ticket would fail the same way. */
function stopsTheBatch(error: unknown): boolean {
  return error instanceof AzureApiError && (error.reason === "AZURE_PAT_INVALID" || error.reason === "AZURE_INSUFFICIENT_SCOPE");
}

function hoursLabel(item: TimeBatchItem): string {
  return Object.entries(item.fields)
    .map(([reference, value]) => `${fieldLabel(reference)} ${value} h`)
    .join(", ");
}

/**
 * One approval covers the listed tickets; each write still gets its own
 * single-use ticket. A ticket changed since the preview is skipped (and
 * reported) while the others are written. Nothing written at all is a failure.
 */
async function executeTimeBatch(client: AzureClient, action: ApprovedAction): Promise<ExecutionResult> {
  const items = storedTimeItems(action.params);
  const outcomes: Array<{ workItemId: number; status: "updated" | "unverified" | "stale" | "failed" | "unknown" | "not-attempted"; message?: string }> = [];
  let firstError: unknown = null;
  let anyWriteSent = false;
  let stopped = false;

  for (const item of items) {
    if (stopped) {
      outcomes.push({ workItemId: item.workItemId, status: "not-attempted" });
      continue;
    }

    const ticket = ApprovalTicket.issue(action.id, client.credentialId);

    try {
      const workItem = await loadWorkItemForAction(client, item.projectId, item.workItemId);
      assertExpectedFields(workItem, item.expected);
      await patchWorkItem(
        client,
        ticket,
        workItem.id,
        workItem.rev,
        Object.entries(item.fields).map(([field, value]) => ({ op: "add", path: `/fields/${field}`, value }))
      );
      const verification = await safeVerify(() => verifyFields(client, workItem.id, item.fields));
      outcomes.push({ workItemId: item.workItemId, status: verification.verified ? "updated" : "unverified" });
    } catch (error) {
      const writeSent = isTicketConsumed(ticket);
      anyWriteSent ||= writeSent;
      firstError ??= error;
      stopped = stopsTheBatch(error);
      const stale = error instanceof AppError && error.reason === "ACTION_STALE";
      outcomes.push({
        workItemId: item.workItemId,
        status: writeSent ? "unknown" : stale ? "stale" : "failed",
        message: error instanceof Error ? error.message : "Failed",
      });
    }
  }

  if (!outcomes.some((outcome) => outcome.status === "updated" || outcome.status === "unverified")) {
    throw new ExecutionFailure(firstError, anyWriteSent);
  }

  const describe = (outcome: (typeof outcomes)[number], item: TimeBatchItem): string => {
    switch (outcome.status) {
      case "updated":
        return `#${item.workItemId}: ${hoursLabel(item)}`;
      case "unverified":
        return `#${item.workItemId}: written, but reading it back did not match`;
      case "stale":
        return `#${item.workItemId}: changed in Azure DevOps since the check, not updated`;
      case "unknown":
        return `#${item.workItemId}: Azure DevOps did not confirm; check the ticket`;
      case "not-attempted":
        return `#${item.workItemId}: not attempted`;
      default:
        return `#${item.workItemId}: not updated (${outcome.message ?? "failed"})`;
    }
  };
  const checks = outcomes.map((outcome, index) => ({ check: describe(outcome, items[index]!), passed: outcome.status === "updated" }));

  return {
    result: { items: outcomes },
    verification: { verified: checks.every((check) => check.passed), checks },
  };
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
        if (key === "expected") {
          continue;
        }

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
        workItem.rev,
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
        workItem.rev,
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

    case "WORK_ITEM_EDIT_TEXT":
    case "WORK_ITEM_SET_CATEGORY":
    case "WORK_ITEM_ADD_TAGS": {
      const workItem = await assertFreshWorkItem(client, action);
      const write = singleFieldWrite(action);
      const updated = await patchWorkItem(client, ticket, workItem.id, workItem.rev, [
        { op: "add", path: `/fields/${write.reference}`, value: write.value },
      ]);

      return {
        // The previous value is kept in the audit trail so the change can be undone by hand.
        result: {
          workItemId: workItem.id,
          rev: updated?.rev ?? null,
          field: write.reference,
          previousValue: normalizeFieldValue(workItem.fields[write.reference]),
        },
        verification: await safeVerify(async () => {
          const fresh = await getWorkItem(client, workItem.id, { cacheTtlMs: 0 });
          const passed = sameValue(write.compare, fresh.fields[write.reference], write.value);
          return { verified: passed, checks: [{ check: write.reference, passed }] };
        }),
      };
    }

    case "WORK_ITEM_LINK_PR": {
      const workItem = await assertFreshWorkItem(client, action);
      const pullRequest = {
        projectId: stringParam(params, "pullRequestProjectId"),
        repositoryId: stringParam(params, "repositoryId"),
        pullRequestId: numberParam(params, "pullRequestId"),
      };
      const alreadyLinked = extractLinks(workItem).pullRequests.some(
        (link) =>
          link.repositoryId.toLowerCase() === pullRequest.repositoryId.toLowerCase() &&
          link.pullRequestId === pullRequest.pullRequestId
      );

      if (alreadyLinked) {
        throw new AppError(409, "ACTION_STALE", "This pull request was linked after the action was proposed.");
      }

      const updated = await patchWorkItem(client, ticket, workItem.id, workItem.rev, [
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
