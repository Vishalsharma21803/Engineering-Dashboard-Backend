import type { TokenUsage } from "../../lib/ai/pricing.js";
import type { AiProvider } from "../../lib/ai/types.js";
import { prisma } from "../../lib/prisma.js";

/** Days and months are counted in UTC so limits reset at one well-defined moment. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function recordAiUsage(entry: {
  userId: string;
  provider: AiProvider;
  model: string;
  purpose: string;
  usage: TokenUsage;
  costUsd: number;
}): Promise<void> {
  await prisma.aiUsage.create({
    data: {
      userId: entry.userId,
      provider: entry.provider,
      model: entry.model,
      purpose: entry.purpose,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      costUsd: entry.costUsd,
    },
  });
}

export async function spentSince(userId: string, since: Date): Promise<number> {
  const result = await prisma.aiUsage.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { costUsd: true },
  });

  return result._sum.costUsd ?? 0;
}

export async function getUsageSummary(userId: string, now = new Date()) {
  const [today, month, calls] = await Promise.all([
    spentSince(userId, startOfUtcDay(now)),
    spentSince(userId, startOfUtcMonth(now)),
    prisma.aiUsage.count({ where: { userId, createdAt: { gte: startOfUtcDay(now) } } }),
  ]);

  return {
    todayUsd: Math.round(today * 10_000) / 10_000,
    monthUsd: Math.round(month * 10_000) / 10_000,
    callsToday: calls,
    resetsAt: new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
