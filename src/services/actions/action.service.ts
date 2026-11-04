import { createHash } from "node:crypto";

import { AppError } from "../../lib/app-error.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  ActionStatus,
  AuditEvent,
  type ActionKind,
} from "../../generated/prisma/enums.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { pageWindow, type Page } from "../../lib/pagination.js";
import { isSolidtimeAction, type ActionScopeFilter, type ProposeActionInput } from "../../schemas/action.schema.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import { getSolidtimeConnection, markSolidtimeInvalid, solidtimeClientFor } from "../solidtime/connection.service.js";
import { SolidtimeExecutionFailure, executeSolidtimeAction, prepareSolidtimeAction } from "./solidtime-actions.js";
import { actionScopeWhere } from "./action-scope.js";
import type { ScopeStatus, WriteScopeArea } from "../../types/azure.types.js";
import { recordAudit, type RequestContext } from "../audit.service.js";
import {
  createAzureClientForCredential,
  markCredentialInvalid,
} from "../azure/azure-context.service.js";
import { forgetDashboardLists } from "../work-item-list/dashboard-lists.service.js";
import { forgetMyWorkSnapshots } from "../work-item-list/my-work.service.js";
import { logFallback } from "../../lib/log-fallback.js";
import { ExecutionFailure, executeAction, type ExecutionResult } from "./executor.js";
import { prepareAction, type PreparedAction } from "./prepare.js";

export const ACTION_TTL_MS = 15 * 60_000;

const actionSelect = {
  id: true,
  credentialId: true,
  organizationUrl: true,
  projectId: true,
  kind: true,
  source: true,
  target: true,
  params: true,
  preview: true,
  summary: true,
  payloadHash: true,
  baseRev: true,
  status: true,
  expiresAt: true,
  decidedAt: true,
  executedAt: true,
  result: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ActionDto = Prisma.ProposedActionGetPayload<{ select: typeof actionSelect }>;

const WRITE_SCOPE_KINDS: Record<WriteScopeArea, ActionKind[]> = {
  work: [
    "WORK_ITEM_COMMENT",
    "WORK_ITEM_UPDATE_FIELDS",
    "WORK_ITEM_TRANSITION_STATE",
    "WORK_ITEM_LINK_PR",
    "WORK_ITEM_CLOSE_AFTER_MERGE",
    "WORK_ITEM_EDIT_TEXT",
    "WORK_ITEM_SET_CATEGORY",
    "WORK_ITEM_ADD_TAGS",
    "WORK_ITEMS_UPDATE_TIME",
  ],
  build: ["PIPELINE_QUEUE_RUN", "BUILD_RETRY_STAGE", "BUILD_CANCEL"],
};

/** Execution failed after the action was claimed; carries the final action row. */
export class ActionExecutionError extends AppError {
  constructor(
    status: number,
    reason: string,
    message: string,
    readonly action: ActionDto
  ) {
    super(status, reason, message);
    this.name = "ActionExecutionError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

/** Binds an approval to the exact change that was previewed. */
export function computePayloadHash(payload: {
  credentialId: string;
  organizationUrl: string;
  kind: string;
  target: unknown;
  params: unknown;
  baseRev: number | null;
}): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * An action still EXECUTING this long after approval, and this long since its
 * last sign of life, was cut off (process crash or a failed final write). A
 * batch records progress after each item (at most every HEARTBEAT_MS), so a
 * long but live run is never taken for a dead one.
 */
export const EXECUTION_STALE_MS = 30 * 60_000;
const HEARTBEAT_MS = 30_000;

/** Actions this process is running now: never recovered, however long they take. */
const executing = new Set<string>();

/**
 * Marks actions abandoned mid-execution as FAILED (EXECUTION_INTERRUPTED), with
 * an audit entry, so they do not stay "executing" forever. Whether the change
 * reached Azure DevOps or Solidtime is unknown, and the message says so.
 */
export async function recoverInterruptedActions(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - EXECUTION_STALE_MS);
  const stale = await prisma.proposedAction.findMany({
    where: {
      status: ActionStatus.EXECUTING,
      decidedAt: { lt: staleBefore },
      // Last sign of life: the claim, or the latest progress of a batch.
      updatedAt: { lt: staleBefore },
      ...(executing.size > 0 ? { id: { notIn: [...executing] } } : {}),
    },
    select: { id: true, userId: true },
  });
  let recovered = 0;

  for (const { id, userId } of stale) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.proposedAction.updateMany({
        where: { id, status: ActionStatus.EXECUTING },
        data: {
          status: ActionStatus.FAILED,
          executedAt: now,
          errorCode: "EXECUTION_INTERRUPTED",
          errorMessage: "Cockpit stopped before this change finished. Check the ticket or time entry to see whether it was applied before proposing it again.",
          result: { writeSent: "unknown" },
        },
      });

      if (updated.count > 0) {
        recovered += 1;
        await recordAudit(tx, {
          userId,
          actionId: id,
          event: AuditEvent.EXECUTION_FAILED,
          metadata: { errorCode: "EXECUTION_INTERRUPTED", writeSent: "unknown" },
          context: { ipAddress: null, userAgent: null },
        });
      }
    });
  }

  return recovered;
}

export async function expireStaleActions(userId: string, context: RequestContext): Promise<void> {
  const stale = await prisma.proposedAction.findMany({
    where: { userId, status: ActionStatus.PENDING, expiresAt: { lte: new Date() } },
    select: { id: true },
  });

  for (const { id } of stale) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.proposedAction.updateMany({
        where: { id, userId, status: ActionStatus.PENDING },
        data: { status: ActionStatus.EXPIRED },
      });

      if (updated.count > 0) {
        await recordAudit(tx, {
          userId,
          actionId: id,
          event: AuditEvent.EXPIRED,
          metadata: {},
          context,
        });
      }
    });
  }
}

export async function proposeAction(
  userId: string,
  input: ProposeActionInput,
  context: RequestContext
): Promise<ActionDto> {
  if (isSolidtimeAction(input)) {
    const { client, connection } = await solidtimeFor(userId, input.credentialId);
    // Read-only: reads Solidtime to check the change and build the preview.
    const prepared = await prepareSolidtimeAction(client, connection, input);
    return saveProposal(userId, input, client.baseUrl, prepared, context);
  }

  const client = await createAzureClientForCredential(userId, input.credentialId, {
    refresh: true,
  });

  if (!client) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
  }

  // Read-only: fetches current Azure state to build the preview.
  const prepared = await prepareAction(client, input);
  return saveProposal(userId, input, client.organizationUrl, prepared, context);
}

/** A Solidtime connection with its chosen organization, for proposing or running a change. */
async function solidtimeFor(userId: string, credentialId: string) {
  const client = await solidtimeClientFor(userId, credentialId, { refresh: true });

  if (!client) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
  }

  const connection = await getSolidtimeConnection(userId, credentialId);

  if (!connection.organizationId || !connection.memberId) {
    throw new AppError(409, "SOLIDTIME_ORGANIZATION_NOT_CHOSEN", "Choose a Solidtime organization for this connection first");
  }

  return { client, connection: { ...connection, organizationId: connection.organizationId, memberId: connection.memberId } };
}

async function saveProposal(
  userId: string,
  input: ProposeActionInput,
  organizationUrl: string,
  prepared: PreparedAction,
  context: RequestContext
): Promise<ActionDto> {
  const payloadHash = computePayloadHash({
    credentialId: input.credentialId,
    organizationUrl,
    kind: input.kind,
    target: prepared.target,
    params: prepared.params,
    baseRev: prepared.baseRev,
  });

  return prisma.$transaction(async (tx) => {
    const action = await tx.proposedAction.create({
      data: {
        userId,
        credentialId: input.credentialId,
        organizationUrl,
        projectId: prepared.projectId,
        kind: input.kind,
        source: input.source,
        target: prepared.target as Prisma.InputJsonValue,
        params: prepared.params as Prisma.InputJsonValue,
        preview: prepared.preview as unknown as Prisma.InputJsonValue,
        summary: prepared.summary,
        payloadHash,
        baseRev: prepared.baseRev,
        expiresAt: new Date(Date.now() + ACTION_TTL_MS),
      },
      select: actionSelect,
    });

    await recordAudit(tx, {
      userId,
      actionId: action.id,
      event: AuditEvent.PROPOSED,
      metadata: {
        kind: action.kind,
        source: action.source,
        organizationUrl: action.organizationUrl,
        projectId: action.projectId,
        target: prepared.target,
        preview: prepared.preview,
        payloadHash,
      },
      context,
    });

    return action;
  });
}

async function findOwnedAction(userId: string, actionId: string): Promise<ActionDto> {
  const action = await prisma.proposedAction.findFirst({
    where: { id: actionId, userId },
    select: actionSelect,
  });

  if (!action) {
    throw new AppError(404, "ACTION_NOT_FOUND", "Action not found");
  }

  return action;
}

function notPending(action: ActionDto): AppError {
  return action.status === ActionStatus.EXPIRED
    ? new AppError(409, "ACTION_EXPIRED", "This action expired. Propose it again.")
    : new AppError(409, "ACTION_NOT_PENDING", `This action is already ${action.status.toLowerCase()}`);
}

interface ClassifiedFailure {
  status: number;
  code: string;
  message: string;
  patInvalid: boolean;
}

function classifyFailure(failure: ExecutionFailure): ClassifiedFailure {
  const classified = classifyFirstError(failure);
  // A time batch: a later ticket's 401 still marks the PAT invalid, whatever the answer says.
  return failure.partial?.refusedBy === "AZURE_PAT_INVALID" ? { ...classified, patInvalid: true } : classified;
}

function classifyFirstError(failure: ExecutionFailure): ClassifiedFailure {
  const error = failure.error;

  // A batch where some write may have landed (a ticket's outcome is unknown): whatever the first error was, say so, ticket by ticket.
  // Writes Azure refused outright (403, 401, 400 …) applied nothing and keep their own answer below.
  const items = Array.isArray(failure.partial?.items) ? (failure.partial?.items as Array<{ status?: unknown }>) : [];

  if (failure.writeSent && items.some((item) => item.status === "unknown")) {
    const checks = Array.isArray(failure.partial?.checks) ? (failure.partial?.checks as Array<{ check?: unknown }>) : [];
    const lines = checks.map((entry) => entry.check).filter((line): line is string => typeof line === "string");
    return {
      status: 502,
      code: "OUTCOME_UNKNOWN",
      message: `Azure DevOps may have applied part of this change. Check the tickets before proposing it again.${lines.length > 0 ? ` ${lines.join(" · ")}` : ""}`,
      patInvalid: false,
    };
  }

  if (error instanceof AppError) {
    return { status: error.status, code: error.reason, message: error.message, patInvalid: false };
  }

  if (error instanceof AzureApiError) {
    if (
      failure.writeSent &&
      (error.upstreamStatus === null || error.reason === "AZURE_UPSTREAM_ERROR")
    ) {
      return {
        status: 502,
        code: "OUTCOME_UNKNOWN",
        message:
          "Azure DevOps did not confirm the change. Check Azure DevOps before proposing it again.",
        patInvalid: false,
      };
    }

    if (failure.writeSent && error.reason === "AZURE_CONFLICT") {
      return {
        status: 409,
        code: "ACTION_STALE",
        message: "The resource changed after this action was proposed. Propose it again.",
        patInvalid: false,
      };
    }

    return {
      status: error.httpStatus,
      code: error.reason,
      message: error.upstreamMessage
        ? `${error.publicMessage}: ${error.upstreamMessage}`
        : error.publicMessage,
      patInvalid: error.reason === "AZURE_PAT_INVALID",
    };
  }

  console.error("Action execution failed:", failure.message);

  return failure.writeSent
    ? { status: 500, code: "EXECUTION_ERROR", message: "The change may have been applied. Check Azure DevOps.", patInvalid: false }
    : {
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Running the change failed because of an unexpected server error. Nothing was sent to Azure DevOps. The details are in the server log.",
        patInvalid: false,
      };
}

function classifySolidtimeFailure(failure: SolidtimeExecutionFailure): ClassifiedFailure {
  const error = failure.error;

  if (failure.writeSent && (!(error instanceof SolidtimeApiError) || error.solidtimeReason === "SOLIDTIME_UPSTREAM_ERROR")) {
    return {
      status: 502,
      code: "OUTCOME_UNKNOWN",
      message: "Solidtime did not confirm the change. Check Solidtime before proposing it again.",
      patInvalid: false,
    };
  }

  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.reason,
      message: failure.writeSent ? `${error.message} Part of the change may already be saved; check Solidtime.` : error.message,
      patInvalid: error instanceof SolidtimeApiError && error.solidtimeReason === "SOLIDTIME_TOKEN_INVALID",
    };
  }

  console.error("Solidtime action failed:", failure.message);
  return failure.writeSent
    ? { status: 500, code: "EXECUTION_ERROR", message: "The change may have been applied. Check Solidtime.", patInvalid: false }
    : {
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Running the change failed because of an unexpected server error. Nothing was sent to Solidtime. The details are in the server log.",
        patInvalid: false,
      };
}

/** How one approved action is run on its platform. `onProgress` is called as a batch moves on. */
interface Runner {
  run: (onProgress: () => Promise<void>) => Promise<ExecutionResult>;
  classify: (error: unknown) => { classified: ClassifiedFailure; writeSent: boolean; partial?: Record<string, unknown> | null };
  markInvalid: () => Promise<void>;
}

async function runnerFor(userId: string, action: ActionDto): Promise<Runner> {
  const credentialId = action.credentialId;

  if (!credentialId) {
    throw new AppError(409, "CREDENTIAL_REMOVED", "The credential for this action was removed");
  }

  const changed = () =>
    new AppError(409, "CREDENTIAL_CHANGED", "The connection now points somewhere else. Propose the action again.");

  if (action.kind.startsWith("SOLIDTIME_")) {
    const client = await solidtimeClientFor(userId, credentialId, { refresh: true });

    if (!client) {
      throw new AppError(409, "CREDENTIAL_REMOVED", "The credential for this action was removed");
    }

    const connection = await getSolidtimeConnection(userId, credentialId);

    // The server, organization or member must be the ones the preview was built for.
    if (client.baseUrl !== action.organizationUrl || connection.organizationId !== action.projectId || !connection.memberId) {
      throw changed();
    }

    const ready = { ...connection, organizationId: action.projectId, memberId: connection.memberId };

    return {
      run: (onProgress) => executeSolidtimeAction(client, ready, { kind: action.kind, target: asRecord(action.target), params: asRecord(action.params) }, onProgress),
      classify: (error) => {
        const failure = error instanceof SolidtimeExecutionFailure ? error : new SolidtimeExecutionFailure(error, false);
        const classified = classifySolidtimeFailure(failure);
        const saved = failure.partial && typeof failure.partial.savedCount === "number" ? ` ${failure.partial.savedCount} of ${String(failure.partial.totalCount)} entries were saved.` : "";
        return { classified: { ...classified, message: `${classified.message}${saved}` }, writeSent: failure.writeSent, partial: failure.partial };
      },
      markInvalid: () => markSolidtimeInvalid(credentialId),
    };
  }

  const client = await createAzureClientForCredential(userId, credentialId, { refresh: true });

  if (!client) {
    throw new AppError(409, "CREDENTIAL_REMOVED", "The credential for this action was removed");
  }

  // The credential may have been pointed at another organization since the preview.
  if (client.organizationUrl !== action.organizationUrl) {
    throw new AppError(
      409,
      "CREDENTIAL_CHANGED",
      "The credential now points to a different organization. Propose the action again."
    );
  }

  return {
    run: (onProgress) =>
      executeAction(
        client,
        {
          id: action.id,
          kind: action.kind,
          projectId: action.projectId,
          target: asRecord(action.target),
          params: asRecord(action.params),
          baseRev: action.baseRev,
        },
        onProgress
      ),
    classify: (error) => {
      const failure = error instanceof ExecutionFailure ? error : new ExecutionFailure(error, false);
      // Per-ticket outcomes of a batch are kept with the result, like a Solidtime batch's saved entries.
      return {
        classified: classifyFailure(failure),
        writeSent: failure.writeSent,
        partial: failure.partial ? { items: failure.partial.items, ...(failure.partial.refusedBy ? { refusedBy: failure.partial.refusedBy } : {}) } : null,
      };
    },
    markInvalid: () => markCredentialInvalid(userId, credentialId),
  };
}

/** An Azure change (even a failed one may have landed) makes the remembered dashboard lists stale. */
function forgetListsAfterChange(userId: string, action: ActionDto): void {
  if (action.credentialId && !action.kind.startsWith("SOLIDTIME_")) {
    forgetMyWorkSnapshots(userId, action.credentialId);
    forgetDashboardLists(userId, action.credentialId);
  }
}

export async function approveAction(
  userId: string,
  actionId: string,
  payloadHash: string,
  context: RequestContext
): Promise<{ action: ActionDto; verification: ExecutionResult["verification"] }> {
  await expireStaleActions(userId, context);

  const action = await findOwnedAction(userId, actionId);

  if (action.status !== ActionStatus.PENDING) {
    throw notPending(action);
  }

  if (action.payloadHash !== payloadHash) {
    throw new AppError(
      409,
      "PAYLOAD_MISMATCH",
      "The approved payload does not match the proposed action"
    );
  }

  const runner = await runnerFor(userId, action);

  // Single-use claim: concurrent approvals race on this conditional update.
  const claimed = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const approved = await tx.proposedAction.updateMany({
      where: {
        id: actionId,
        userId,
        status: ActionStatus.PENDING,
        payloadHash,
        expiresAt: { gt: now },
      },
      data: { status: ActionStatus.APPROVED, decidedAt: now },
    });

    if (approved.count === 0) {
      return false;
    }

    await recordAudit(tx, {
      userId,
      actionId,
      event: AuditEvent.APPROVED,
      metadata: { payloadHash },
      context,
    });

    await tx.proposedAction.updateMany({
      where: { id: actionId, status: ActionStatus.APPROVED },
      data: { status: ActionStatus.EXECUTING },
    });

    await recordAudit(tx, {
      userId,
      actionId,
      event: AuditEvent.EXECUTION_STARTED,
      metadata: {},
      context,
    });

    return true;
  });

  if (!claimed) {
    throw notPending(await findOwnedAction(userId, actionId));
  }

  let execution: ExecutionResult;
  let lastBeat = Date.now();
  // A long batch shows it is alive, so the stale-run sweep (here or in another process) leaves it alone.
  const heartbeat = async () => {
    if (Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();

    try {
      await prisma.proposedAction.updateMany({ where: { id: actionId, status: ActionStatus.EXECUTING }, data: { updatedAt: new Date() } });
    } catch (error) {
      logFallback("Recording the progress of a running change failed", error);
    }
  };

  executing.add(actionId);

  // Held until the outcome is written, so this process's stale-run sweep never ends the run in between.
  try {
    try {
      execution = await runner.run(heartbeat);
    } catch (error) {
      forgetListsAfterChange(userId, action);
      const { classified, writeSent, partial } = runner.classify(error);
      const failure = { writeSent, ...(partial ?? {}) };

      if (classified.patInvalid) {
        await runner.markInvalid();
      }

      const failed = await prisma.$transaction(async (tx) => {
        const failedData = {
          status: ActionStatus.FAILED,
          executedAt: new Date(),
          errorCode: classified.code,
          errorMessage: classified.message,
          result: failure as Prisma.InputJsonValue,
        };
        const updated = await tx.proposedAction.updateMany({
          where: { id: actionId, status: ActionStatus.EXECUTING },
          data: failedData,
        });
        // Ended as interrupted meanwhile (another process's sweep): the real outcome replaces the guess, so the row says what the answer says.
        const recovered =
          updated.count === 0
            ? await tx.proposedAction.updateMany({
                where: { id: actionId, status: ActionStatus.FAILED, errorCode: "EXECUTION_INTERRUPTED" },
                data: failedData,
              })
            : { count: 0 };
        const row = await tx.proposedAction.findUniqueOrThrow({ where: { id: actionId }, select: actionSelect });

        if (updated.count === 0 && recovered.count === 0) {
          return row;
        }

        await recordAudit(tx, {
          userId,
          actionId,
          event: AuditEvent.EXECUTION_FAILED,
          metadata: { errorCode: classified.code, ...failure, ...(recovered.count > 0 ? { afterInterrupted: true } : {}) },
          context,
        });

        return row;
      });

      throw new ActionExecutionError(classified.status, classified.code, classified.message, failed);
    }

    forgetListsAfterChange(userId, action);

    // A time batch that wrote some tickets before Azure refused the PAT itself: the credential is invalid now.
    if (execution.result.refusedBy === "AZURE_PAT_INVALID") {
      await runner.markInvalid();
    }

    const succeeded = await prisma.$transaction(async (tx) => {
      // Still EXECUTING (see the failure path): the change did run, so it is recorded as succeeded unless already ended.
      const updated = await tx.proposedAction.updateMany({
        where: { id: actionId, status: ActionStatus.EXECUTING },
        data: {
          status: ActionStatus.SUCCEEDED,
          executedAt: new Date(),
          result: { ...execution.result, verification: execution.verification } as Prisma.InputJsonValue,
        },
      });
      // Ended as interrupted meanwhile (another process's sweep): the change did run, so it is recorded as succeeded.
      const recovered =
        updated.count === 0
          ? await tx.proposedAction.updateMany({
              where: { id: actionId, status: ActionStatus.FAILED, errorCode: "EXECUTION_INTERRUPTED" },
              data: {
                status: ActionStatus.SUCCEEDED,
                executedAt: new Date(),
                errorCode: null,
                errorMessage: null,
                result: { ...execution.result, verification: execution.verification } as Prisma.InputJsonValue,
              },
            })
          : { count: 0 };
      const row = await tx.proposedAction.findUniqueOrThrow({ where: { id: actionId }, select: actionSelect });

      if (updated.count === 0 && recovered.count === 0) {
        console.error(`Action ${actionId} finished after it was already ended as ${row.status}; its result was not recorded.`);
        return row;
      }

      await recordAudit(tx, {
        userId,
        actionId,
        event: AuditEvent.EXECUTION_SUCCEEDED,
        metadata: { result: execution.result, verification: execution.verification, ...(recovered.count > 0 ? { afterInterrupted: true } : {}) },
        context,
      });

      return row;
    });

    return { action: succeeded, verification: execution.verification };
  } finally {
    executing.delete(actionId);
  }
}

export async function rejectAction(
  userId: string,
  actionId: string,
  reason: string | undefined,
  context: RequestContext
): Promise<ActionDto> {
  await expireStaleActions(userId, context);

  const rejected = await prisma.$transaction(async (tx) => {
    const updated = await tx.proposedAction.updateMany({
      where: { id: actionId, userId, status: ActionStatus.PENDING },
      data: {
        status: ActionStatus.REJECTED,
        decidedAt: new Date(),
        result: { rejectionReason: reason ?? null },
      },
    });

    if (updated.count === 0) {
      return false;
    }

    await recordAudit(tx, {
      userId,
      actionId,
      event: AuditEvent.REJECTED,
      metadata: { reason: reason ?? null },
      context,
    });

    return true;
  });

  const action = await findOwnedAction(userId, actionId);

  if (!rejected) {
    throw notPending(action);
  }

  return action;
}

/** Newest first, 10 per page. */
export async function listActions(
  userId: string,
  filter: { status?: ActionStatus | undefined; history: boolean; page: number } & ActionScopeFilter,
  context: RequestContext
): Promise<Page<ActionDto>> {
  await expireStaleActions(userId, context);

  const where: Prisma.ProposedActionWhereInput = {
    userId,
    ...(filter.status ? { status: filter.status } : filter.history ? { status: { not: ActionStatus.PENDING } } : {}),
    ...actionScopeWhere(filter),
  };
  const window = pageWindow(await prisma.proposedAction.count({ where }), filter.page);
  const items = await prisma.proposedAction.findMany({
    where,
    select: actionSelect,
    orderBy: { createdAt: "desc" },
    skip: window.skip,
    take: window.take,
  });

  return { items, page: window.page, pageSize: window.pageSize, total: window.total, totalPages: window.totalPages };
}

export async function getAction(
  userId: string,
  actionId: string,
  context: RequestContext
): Promise<ActionDto> {
  await expireStaleActions(userId, context);
  return findOwnedAction(userId, actionId);
}

/** Write scopes cannot be probed safely; learn them from executed actions. */
export async function learnedWriteScopes(
  credentialId: string
): Promise<Record<WriteScopeArea, ScopeStatus>> {
  const entries = await Promise.all(
    (Object.entries(WRITE_SCOPE_KINDS) as Array<[WriteScopeArea, ActionKind[]]>).map(
      async ([area, kinds]) => {
        const latest = await prisma.proposedAction.findFirst({
          where: {
            credentialId,
            kind: { in: kinds },
            OR: [
              { status: ActionStatus.SUCCEEDED },
              {
                status: ActionStatus.FAILED,
                errorCode: "AZURE_INSUFFICIENT_SCOPE",
                // A refused pre-write read says nothing about write scope.
                result: { path: ["writeSent"], equals: true },
              },
              // A time batch answered by another ticket's error, where one ticket's write was refused for scope.
              { status: ActionStatus.FAILED, result: { path: ["refusedBy"], equals: "AZURE_INSUFFICIENT_SCOPE" } },
            ],
          },
          orderBy: { executedAt: "desc" },
          select: { status: true },
        });

        const status: ScopeStatus = !latest
          ? "unknown"
          : latest.status === ActionStatus.SUCCEEDED
            ? "granted"
            : "missing";

        return [area, status] as const;
      }
    )
  );

  return Object.fromEntries(entries) as Record<WriteScopeArea, ScopeStatus>;
}
