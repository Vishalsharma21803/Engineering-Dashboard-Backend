import { MAX_OUTPUT_TOKENS } from "../../lib/ai/judge.js";
import { estimateCostUsd, type TokenUsage } from "../../lib/ai/pricing.js";
import type { AiModelOption, AiProvider } from "../../lib/ai/types.js";
import { prisma } from "../../lib/prisma.js";

/** Days and months are counted in UTC so limits reset at one well-defined moment. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface UsageEntry {
  userId: string;
  provider: AiProvider;
  model: string;
  purpose: string;
  usage: TokenUsage;
  costUsd: number;
}

function usageRow(entry: UsageEntry) {
  return {
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
  };
}

export async function recordAiUsage(entry: UsageEntry): Promise<void> {
  await prisma.aiUsage.create(usageRow(entry));
}

/**
 * Reservation rows hold a call's worst-case cost while it runs, so parallel
 * calls (two SOP checks and a draft estimate) cannot all pass the daily limit
 * check and overshoot it. They count against the limit but never show as spent.
 */
export const RESERVED_PURPOSE_PREFIX = "reserved:";
/** A reservation older than this belongs to a call that died (AI calls time out after 2 minutes). */
export const STALE_RESERVATION_MS = 10 * 60_000;

/** The most a call can cost: the prompt (about 3 characters a token) plus a full-length answer. */
export function worstCaseCostUsd(model: AiModelOption, promptChars: number): number {
  return estimateCostUsd(model, { inputTokens: Math.ceil(promptChars / 3), outputTokens: MAX_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

/**
 * Under a per-user lock: null when today's spend (reservations included)
 * already reached the limit, otherwise the id of a new reservation of
 * `maxCostUsd`. Settle or release it when the call ends.
 */
export async function reserveAiSpend(input: { userId: string; provider: AiProvider; model: string; purpose: string; maxCostUsd: number; limitUsd: number; now?: Date }): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`;
    const spent = await tx.aiUsage.aggregate({ where: { userId: input.userId, createdAt: { gte: startOfUtcDay(input.now ?? new Date()) } }, _sum: { costUsd: true } });

    if ((spent._sum.costUsd ?? 0) >= input.limitUsd) {
      return null;
    }

    const row = await tx.aiUsage.create({
      data: { userId: input.userId, provider: input.provider, model: input.model, purpose: `${RESERVED_PURPOSE_PREFIX}${input.purpose}`, costUsd: input.maxCostUsd },
      select: { id: true },
    });
    return row.id;
  });
}

/** Replaces a reservation (if any) with what the call really used. */
export async function settleAiSpend(reservationId: string | null, entry: UsageEntry): Promise<void> {
  await prisma.$transaction([
    ...(reservationId ? [prisma.aiUsage.deleteMany({ where: { id: reservationId, purpose: { startsWith: RESERVED_PURPOSE_PREFIX } } })] : []),
    prisma.aiUsage.create(usageRow(entry)),
  ]);
}

/**
 * Records what a paid call cost (see settleAiSpend). A failed write is tried once more; if that fails too,
 * the reservation (if any) stays as the spend record and the real cost is logged loudly. Never throws: the
 * call's answer is still used, so a paid call is never repeated because recording it failed.
 */
export async function recordAiSpend(reservationId: string | null, entry: UsageEntry): Promise<void> {
  try {
    await settleAiSpend(reservationId, entry);
  } catch (first) {
    console.warn(`Recording AI spend (${entry.costUsd} USD, ${entry.purpose}) failed; trying once more:`, first);

    try {
      // Settling swaps the reservation for the usage row in one transaction: a reservation that is gone means the
      // first try did commit (only its answer was lost), so trying again would count the call twice.
      if (reservationId && !(await prisma.aiUsage.findUnique({ where: { id: reservationId }, select: { id: true } }))) {
        return;
      }

      await settleAiSpend(reservationId, entry);
    } catch (error) {
      console.error(
        `Recording AI spend failed twice: ${entry.costUsd} USD (${entry.provider} ${entry.model}, ${entry.purpose}) for user ${entry.userId} is not in the usage records.${
          reservationId ? ` Its reservation ${reservationId} is kept in its place.` : ""
        }`,
        error
      );
    }
  }
}

/** Drops a reservation when the call was not billed. */
export async function releaseAiSpend(reservationId: string): Promise<void> {
  await prisma.aiUsage.deleteMany({ where: { id: reservationId, purpose: { startsWith: RESERVED_PURPOSE_PREFIX } } });
}

/** For maintenance: removes reservations left by calls that died (crash, restart). Returns how many. */
export async function purgeStaleAiReservations(now = new Date()): Promise<number> {
  const { count } = await prisma.aiUsage.deleteMany({
    where: { purpose: { startsWith: RESERVED_PURPOSE_PREFIX }, createdAt: { lt: new Date(now.getTime() - STALE_RESERVATION_MS) } },
  });
  return count;
}

/** Spend since a moment, for the limit check: open reservations count (see reserveAiSpend) unless `billedOnly`. */
export async function spentSince(userId: string, since: Date, options: { billedOnly?: boolean } = {}): Promise<number> {
  const result = await prisma.aiUsage.aggregate({
    where: { userId, createdAt: { gte: since }, ...(options.billedOnly ? { NOT: { purpose: { startsWith: RESERVED_PURPOSE_PREFIX } } } : {}) },
    _sum: { costUsd: true },
  });

  return result._sum.costUsd ?? 0;
}

export async function getUsageSummary(userId: string, now = new Date()) {
  // Reservations are worst-case placeholders for calls still running: not spent (yet).
  const [today, month, calls] = await Promise.all([
    spentSince(userId, startOfUtcDay(now), { billedOnly: true }),
    spentSince(userId, startOfUtcMonth(now), { billedOnly: true }),
    prisma.aiUsage.count({ where: { userId, createdAt: { gte: startOfUtcDay(now) }, NOT: { purpose: { startsWith: RESERVED_PURPOSE_PREFIX } } } }),
  ]);

  return {
    todayUsd: Math.round(today * 10_000) / 10_000,
    monthUsd: Math.round(month * 10_000) / 10_000,
    callsToday: calls,
    resetsAt: new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
