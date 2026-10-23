import { prisma } from "../lib/prisma.js";
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

export async function listAuditLogs(
  userId: string,
  filter: { actionId?: string | undefined; from?: string | undefined; to?: string | undefined; limit: number }
) {
  return prisma.auditLog.findMany({
    where: {
      userId,
      ...(filter.actionId ? { actionId: filter.actionId } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: new Date(filter.from) } : {}),
              ...(filter.to ? { lte: new Date(filter.to) } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      actionId: true,
      event: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: filter.limit,
  });
}
