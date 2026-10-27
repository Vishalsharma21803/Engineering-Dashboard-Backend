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
  const error = failure.error;

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

  return {
    status: 500,
    code: "EXECUTION_ERROR",
    message: failure.writeSent
      ? "The change may have been applied. Check Azure DevOps."
      : "Internal server error",
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
  return { status: 500, code: "EXECUTION_ERROR", message: failure.writeSent ? "The change may have been applied. Check Solidtime." : "Internal server error", patInvalid: false };
}

/** How one approved action is run on its platform. */
interface Runner {
  run: () => Promise<ExecutionResult>;
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
      run: () => executeSolidtimeAction(client, ready, { kind: action.kind, target: asRecord(action.target), params: asRecord(action.params) }),
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
    run: () =>
      executeAction(client, {
        id: action.id,
        kind: action.kind,
        projectId: action.projectId,
        target: asRecord(action.target),
        params: asRecord(action.params),
        baseRev: action.baseRev,
      }),
    classify: (error) => {
      const failure = error instanceof ExecutionFailure ? error : new ExecutionFailure(error, false);
      return { classified: classifyFailure(failure), writeSent: failure.writeSent };
    },
    markInvalid: () => markCredentialInvalid(userId, credentialId),
  };
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

  try {
    execution = await runner.run();
  } catch (error) {
    const { classified, writeSent, partial } = runner.classify(error);
    const failure = { writeSent, ...(partial ?? {}) };

    if (classified.patInvalid) {
      await runner.markInvalid();
    }

    const failed = await prisma.$transaction(async (tx) => {
      const updated = await tx.proposedAction.update({
        where: { id: actionId },
        data: {
          status: ActionStatus.FAILED,
          executedAt: new Date(),
          errorCode: classified.code,
          errorMessage: classified.message,
          result: failure as Prisma.InputJsonValue,
        },
        select: actionSelect,
      });

      await recordAudit(tx, {
        userId,
        actionId,
        event: AuditEvent.EXECUTION_FAILED,
        metadata: { errorCode: classified.code, ...failure },
        context,
      });

      return updated;
    });

    throw new ActionExecutionError(classified.status, classified.code, classified.message, failed);
  }

  const succeeded = await prisma.$transaction(async (tx) => {
    const updated = await tx.proposedAction.update({
      where: { id: actionId },
      data: {
        status: ActionStatus.SUCCEEDED,
        executedAt: new Date(),
        result: { ...execution.result, verification: execution.verification } as Prisma.InputJsonValue,
      },
      select: actionSelect,
    });

    await recordAudit(tx, {
      userId,
      actionId,
      event: AuditEvent.EXECUTION_SUCCEEDED,
      metadata: { result: execution.result, verification: execution.verification },
      context,
    });

    return updated;
  });

  return { action: succeeded, verification: execution.verification };
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
