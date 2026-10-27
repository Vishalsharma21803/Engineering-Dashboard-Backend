import { pageWindow } from "../lib/pagination.js";
import { prisma } from "../lib/prisma.js";
import type { ActionScopeFilter } from "../schemas/action.schema.js";
import { actionScopeWhere } from "./actions/action-scope.js";
import type { AuditEvent } from "../generated/prisma/enums.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

type AuditWriter = Pick<Prisma.TransactionClient, "auditLog">;

export async function recordAudit(
  db: AuditWriter,
  entry: {
    userId: string;
    actionId: string | null;
    event: AuditEvent;
    metadata: Record<string, unknown>;
    context: RequestContext;
  }
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: entry.userId,
      actionId: entry.actionId,
      event: entry.event,
      metadata: entry.metadata as Prisma.InputJsonValue,
      ipAddress: entry.context.ipAddress,
      userAgent: entry.context.userAgent?.slice(0, 500) ?? null,
    },
  });
}

/** Newest first, 10 per page. With an organization or project, only entries of actions there. */
export async function listAuditLogs(
  userId: string,
  filter: { actionId?: string | undefined; from?: string | undefined; to?: string | undefined; page: number } & ActionScopeFilter
) {
  const scoped = Boolean(filter.credentialId || filter.projectId || filter.projectName);
  const where: Prisma.AuditLogWhereInput = {
    userId,
    ...(filter.actionId ? { actionId: filter.actionId } : {}),
    ...(scoped ? { action: actionScopeWhere(filter) } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: new Date(filter.from) } : {}),
            ...(filter.to ? { lte: new Date(filter.to) } : {}),
          },
        }
      : {}),
  };
  const window = pageWindow(await prisma.auditLog.count({ where }), filter.page);
  const items = await prisma.auditLog.findMany({
    where,
    select: {
      id: true,
      actionId: true,
      event: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      // What the entry is about, so the list can name it without loading every action.
      action: { select: { summary: true } },
    },
    orderBy: { createdAt: "desc" },
    skip: window.skip,
    take: window.take,
  });

  return {
    items: items.map(({ action, ...entry }) => ({ ...entry, actionSummary: action?.summary ?? null })),
    page: window.page,
    pageSize: window.pageSize,
    total: window.total,
    totalPages: window.totalPages,
  };
}
