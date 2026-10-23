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
import type { ProposeActionInput } from "../../schemas/action.schema.js";
import type { ScopeStatus, WriteScopeArea } from "../../types/azure.types.js";
import { recordAudit, type RequestContext } from "../audit.service.js";
import {
  createAzureClientForCredential,
  markCredentialInvalid,
} from "../azure/azure-context.service.js";
import { ExecutionFailure, executeAction, type ExecutionResult } from "./executor.js";
import { prepareAction } from "./prepare.js";

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
  const client = await createAzureClientForCredential(userId, input.credentialId, {
    refresh: true,
  });

  if (!client) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
  }

  // Read-only: fetches current Azure state to build the preview.
  const prepared = await prepareAction(client, input);
  const payloadHash = computePayloadHash({
    credentialId: input.credentialId,
    organizationUrl: client.organizationUrl,
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
        organizationUrl: client.organizationUrl,
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

  const credentialId = action.credentialId;
  const client = credentialId
    ? await createAzureClientForCredential(userId, credentialId, { refresh: true })
    : null;

  if (!credentialId || !client) {
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
    execution = await executeAction(client, {
      id: action.id,
      kind: action.kind,
      projectId: action.projectId,
      target: asRecord(action.target),
      params: asRecord(action.params),
      baseRev: action.baseRev,
    });
  } catch (error) {
    const failure =
      error instanceof ExecutionFailure ? error : new ExecutionFailure(error, false);
    const classified = classifyFailure(failure);

    if (classified.patInvalid) {
      await markCredentialInvalid(userId, credentialId);
    }

    const failed = await prisma.$transaction(async (tx) => {
      const updated = await tx.proposedAction.update({
        where: { id: actionId },
        data: {
          status: ActionStatus.FAILED,
          executedAt: new Date(),
          errorCode: classified.code,
          errorMessage: classified.message,
          result: { writeSent: failure.writeSent },
        },
        select: actionSelect,
      });

      await recordAudit(tx, {
        userId,
        actionId,
        event: AuditEvent.EXECUTION_FAILED,
        metadata: { errorCode: classified.code, writeSent: failure.writeSent },
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

export async function listActions(
  userId: string,
  filter: { status?: ActionStatus | undefined; credentialId?: string | undefined; limit: number },
  context: RequestContext
): Promise<ActionDto[]> {
  await expireStaleActions(userId, context);

  return prisma.proposedAction.findMany({
    where: {
      userId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.credentialId ? { credentialId: filter.credentialId } : {}),
    },
    select: actionSelect,
    orderBy: { createdAt: "desc" },
    take: filter.limit,
  });
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
