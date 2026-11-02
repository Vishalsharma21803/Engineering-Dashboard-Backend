import { createHash } from "node:crypto";

import { AppError } from "../../../lib/app-error.js";
import type { AzureClient } from "../../../lib/azure/client.js";
import { AzureApiError } from "../../../lib/azure/errors.js";
import { CLAUDE_MODELS } from "../../../lib/ai/claude.js";
import { judge } from "../../../lib/ai/judge.js";
import { estimateCostUsd } from "../../../lib/ai/pricing.js";
import { AiProviderError, type AiModelOption } from "../../../lib/ai/types.js";
import { prisma } from "../../../lib/prisma.js";
import { getAiApiKey } from "../../ai/ai-credential.service.js";
import { findModel } from "../../ai/ai-models.service.js";
import { getAiPreference } from "../../ai/ai-preference.service.js";
import { recordAiUsage, spentSince, startOfUtcDay } from "../../ai/ai-usage.service.js";
import { createAzureClientForCredential } from "../../azure/azure-context.service.js";
import { getWorkItem, getWorkItemsByIds, toWorkItemSummaries, workItemProjectName, workItemType } from "../../azure/work-items.service.js";
import { AI_REVIEW, type BuiltinCheckName } from "../builtin-checks.js";
import { buildDossier, kindOf } from "../dossier.js";
import { linkedSolidtimeFor } from "../../solidtime/connection.service.js";
import { trackedHoursByTicket } from "../../solidtime/reports.service.js";
import { findProjectProfile } from "../rulebook.merge.js";
import { getEffectiveRulebook } from "../rulebook.service.js";
import type { ComplianceResult } from "../../../types/azure.types.js";
import type { ProjectProfile, RuleCard } from "../rulebook.types.js";
import { evaluateDossier, type RulebookForChecks } from "../sop-evaluator.js";
import { VERDICT_JSON_SCHEMA, buildSystemPrompt, buildUserPrompt, quotableText, verdictSchema, type ReviewItem } from "./sop-ai-prompt.js";
import { verifyVerdicts } from "./sop-ai-verifier.js";
import { fallbackTo, logFallback } from "../../../lib/log-fallback.js";

export const MAX_CHECKS_PER_REQUEST = 200;
const MAX_RUNNING_PER_USER = 2;
const MAX_RUNNING_GLOBAL = 6;
const DEFAULT_RATE_LIMIT_PAUSE_SECONDS = 60;
const USAGE_PURPOSE = "sop-check";

/** Reasons that clear up on their own; such checks run again on the next request even if nothing changed. */
const RETRYABLE_REASONS = new Set(["DAILY_LIMIT_REACHED", "AI_RATE_LIMITED", "AI_UPSTREAM_ERROR", "AI_BAD_OUTPUT", "INTERNAL_ERROR"]);

export type EnqueueSkipReason = "PROJECT_NOT_CONFIGURED" | "NO_AI_RULES" | "TRIAGED" | "NOT_FOUND";

export interface EnqueueResult {
  queued: number[];
  unchanged: number[];
  skipped: Array<{ workItemId: number; reason: EnqueueSkipReason }>;
}

/** Whether the AI review looks at this rule: AI-only rules, and code rules whose check it can clear or draft for. */
function reviewable(card: RuleCard): boolean {
  return card.checker === "ai" || AI_REVIEW[card.uses as BuiltinCheckName] !== undefined;
}

function reviewCardsFor(rulebook: RulebookForChecks, profile: ProjectProfile, type: string): RuleCard[] {
  const kind = kindOf(profile, type);
  return kind === null ? [] : rulebook.cards.filter((card) => card.severity !== "off" && card.appliesTo.includes(kind) && reviewable(card));
}

/**
 * What the AI reviews for this ticket, from the code result: gaps (and to-dos
 * and notices) of rules it can clear or draft for, found items whose quality
 * it judges, and AI-only rules that apply now.
 */
export function reviewItems(result: ComplianceResult, cards: RuleCard[]): ReviewItem[] {
  const findings = new Map([...result.violations, ...result.todos, ...result.notices].map((finding) => [finding.ruleId, finding]));
  const passed = new Set(result.passedRules.map((rule) => rule.ruleId));
  const aiRules = new Set(result.aiRules.map((rule) => rule.ruleId));

  return cards.flatMap((card): ReviewItem[] => {
    if (card.checker === "ai") {
      return aiRules.has(card.id) ? [{ card, mode: "ai-rule", codeMessage: null }] : [];
    }

    const kind = AI_REVIEW[card.uses as BuiltinCheckName];
    const found = findings.get(card.id);

    if (found) {
      return [{ card, mode: kind === "judge" ? "gap" : "draft", codeMessage: found.message }];
    }

    return kind === "judge" && passed.has(card.id) ? [{ card, mode: "quality", codeMessage: null }] : [];
  });
}

/** Anything that changes the answer: the ticket revision, the rules and the model settings. */
function inputHash(
  rev: number,
  cards: RuleCard[],
  profile: ProjectProfile,
  settings: { provider: string; model: string; effort: string },
  trackedHours: number | null = null
): string {
  // The whole project set-up counts: stages decide which rules apply, categories what a fix may suggest.
  const { line: _line, ...project } = profile;
  return createHash("sha256")
    .update(
      JSON.stringify({
        rev,
        settings,
        project,
        cards: cards.map((card) =>
          card.checker === "ai"
            ? [card.id, card.severity, card.when, card.rule, card.passesWhen, card.failsWhen, card.passExample, card.failExample, card.suggestedFix]
            : [card.id, card.severity, card.when, card.rule, card.uses, card.params]
        ),
        // Tracked time is part of what the AI sees; a change (to the quarter hour) re-checks.
        ...(trackedHours === null ? {} : { trackedHours }),
      })
    )
    .digest("hex");
}

/**
 * Solidtime hours per ticket for AI checks: empty when no connection is
 * linked, null when Solidtime could not be read (so nothing is re-checked
 * just because Solidtime was briefly unavailable).
 */
async function trackedHoursFor(userId: string, azureCredentialId: string, ids: number[]): Promise<Map<number, number> | null> {
  try {
    const linked = await linkedSolidtimeFor(userId, azureCredentialId, { background: true });
    if (!linked || ids.length === 0) return new Map();
    const { hours } = await trackedHoursByTicket(linked.client, linked.connection, ids);
    return new Map([...hours].map(([id, value]) => [id, Math.round(value * 4) / 4]));
  } catch (error) {
    logFallback("Reading tracked hours for an SOP AI check failed", error);
    return null;
  }
}

async function hiddenByTriage(userId: string, credentialId: string, now: Date) {
  const marks = await prisma.triageMark.findMany({
    where: {
      userId,
      credentialId,
      OR: [{ status: "ABANDONED" }, { status: "SNOOZED", snoozedUntil: { gt: now } }],
    },
    select: { itemKey: true },
  });
  // Project keys are stored lower-cased by the dashboard; compare case-insensitively.
  return new Set(marks.map((mark) => mark.itemKey.toLowerCase()));
}

/**
 * Queues AI checks for tickets whose input changed since their last check
 * (or every one when `force`). Results are private to this user.
 */
export async function enqueueAiChecks(
  client: AzureClient,
  userId: string,
  credentialId: string,
  workItemIds: number[],
  options: { force?: boolean; now?: Date } = {}
): Promise<EnqueueResult> {
  const now = options.now ?? new Date();
  const preference = await getAiPreference(userId);

  if (!preference.provider || !preference.model) {
    throw new AppError(422, "AI_NOT_CONFIGURED", "Choose an AI provider and model on the Credentials page first");
  }

  if (!(await getAiApiKey(userId, preference.provider))) {
    throw new AppError(422, "AI_KEY_REQUIRED", "Add an API key for your AI provider first");
  }

  const ids = [...new Set(workItemIds)].slice(0, MAX_CHECKS_PER_REQUEST);
  const settings = { provider: preference.provider, model: preference.model, effort: preference.effort };
  const [rulebook, hidden, rawItems, existing] = await Promise.all([
    getEffectiveRulebook(userId),
    hiddenByTriage(userId, credentialId, now),
    ids.length ? getWorkItemsByIds(client, ids) : Promise.resolve([]),
    prisma.sopAiCheck.findMany({ where: { userId, credentialId, workItemId: { in: ids } } }),
  ]);
  const tracked = await trackedHoursFor(userId, credentialId, ids);
  const previous = new Map(existing.map((row) => [row.workItemId, row]));
  // A rate-limit pause applies to the user's key at that provider, so newly queued tickets for the
  // same provider wait for it too. Switching provider (e.g. OpenRouter → OpenCode) is not held back.
  const paused = await prisma.sopAiCheck.findFirst({
    where: { userId, status: "QUEUED", errorReason: "AI_RATE_LIMITED", provider: preference.provider, model: preference.model, notBefore: { gt: now } },
    orderBy: { notBefore: "desc" },
    select: { notBefore: true },
  });
  // "Try now" (force) makes one real attempt even during a pause; a new 429 pauses again.
  const pauseUntil = options.force ? null : (paused?.notBefore ?? null);
  const found = new Map(rawItems.map((raw) => [raw.id, raw]));
  const result: EnqueueResult = { queued: [], unchanged: [], skipped: [] };

  for (const id of ids) {
    const raw = found.get(id);

    if (!raw) {
      result.skipped.push({ workItemId: id, reason: "NOT_FOUND" });
      continue;
    }

    const projectName = workItemProjectName(raw);
    const profile = findProjectProfile(rulebook.projects, projectName);

    if (!profile) {
      result.skipped.push({ workItemId: id, reason: "PROJECT_NOT_CONFIGURED" });
      continue;
    }

    if (hidden.has(`wi:${id}`) || hidden.has(`project:${projectName.toLowerCase()}`)) {
      result.skipped.push({ workItemId: id, reason: "TRIAGED" });
      continue;
    }

    const cards = reviewCardsFor(rulebook, profile, workItemType(raw));

    if (cards.length === 0) {
      result.skipped.push({ workItemId: id, reason: "NO_AI_RULES" });
      continue;
    }

    const before = previous.get(id);
    // Solidtime unreadable: use the hours the last check was made with, so nothing is re-checked just for that.
    const hours = tracked === null ? (before?.trackedHours ?? null) : (tracked.get(id) ?? null);
    const hash = inputHash(raw.rev, cards, profile, settings, hours);
    const retryable = before && (before.status === "FAILED" || before.status === "SKIPPED") && RETRYABLE_REASONS.has(before.errorReason ?? "");

    // A live running check is never re-queued: it would run (and be paid for) twice.
    // An abandoned one (older than STALE_RUN_MS) may be.
    const runningNow = before?.status === "RUNNING" && before.startedAt !== null && now.getTime() - before.startedAt.getTime() < STALE_RUN_MS;

    if (runningNow || (before && before.inputHash === hash && !options.force && !retryable)) {
      result.unchanged.push(id);
      continue;
    }

    await prisma.sopAiCheck.upsert({
      where: { userId_credentialId_workItemId: { userId, credentialId, workItemId: id } },
      create: {
        userId,
        credentialId,
        workItemId: id,
        projectName,
        inputHash: hash,
        trackedHours: hours,
        notBefore: pauseUntil,
        ...(pauseUntil ? { errorReason: "AI_RATE_LIMITED", provider: preference.provider, model: preference.model } : {}),
      },
      // Earlier results stay visible (marked as re-checking) until the new ones arrive.
      // A rate-limit pause still in force is kept, even when forced.
      update: {
        projectName,
        inputHash: hash,
        trackedHours: hours,
        status: "QUEUED",
        notBefore: pauseUntil,
        ...(pauseUntil
          ? { errorReason: "AI_RATE_LIMITED", provider: preference.provider, model: preference.model }
          : { errorReason: null, errorDetail: null }),
      },
    });
    result.queued.push(id);
  }

  if (result.queued.length > 0) {
    kickSopAiWorker();
  }

  return result;
}

export async function listAiChecks(userId: string, credentialId: string, workItemIds: number[]) {
  const rows = await prisma.sopAiCheck.findMany({
    where: { userId, credentialId, workItemId: { in: workItemIds.slice(0, MAX_CHECKS_PER_REQUEST) } },
    select: {
      workItemId: true,
      status: true,
      results: true,
      ticketRev: true,
      errorReason: true,
      errorDetail: true,
      provider: true,
      model: true,
      costUsd: true,
      notBefore: true,
      finishedAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    /** Set while a check waits out a provider rate limit. */
    notBefore: row.notBefore?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

const TIMING_WINDOW_DAYS = 30;

/**
 * How long this user's AI reviews took per model over the last 30 days (time
 * running, not waiting in the queue), and how many waited on a rate limit, so
 * the AI settings can say whether the chosen model is slow.
 */
export async function getSopCheckTiming(userId: string, now = new Date()) {
  const since = new Date(now.getTime() - TIMING_WINDOW_DAYS * 24 * 60 * 60_000);
  const rows = await prisma.sopAiCheck.findMany({
    where: { userId, updatedAt: { gte: since }, model: { not: null } },
    select: { provider: true, model: true, status: true, errorReason: true, startedAt: true, finishedAt: true, results: true },
  });
  const byModel = new Map<string, { provider: string | null; model: string; durations: number[]; rateLimited: number; failed: number }>();

  for (const row of rows) {
    const key = `${row.provider ?? ""}|${row.model ?? ""}`;
    const entry = byModel.get(key) ?? { provider: row.provider, model: row.model ?? "", durations: [], rateLimited: 0, failed: 0 };

    // A review with nothing to ask the AI finishes at once; it would make the model look faster than it is.
    const askedAi = Array.isArray(row.results) && row.results.length > 0;

    if (row.status === "DONE" && askedAi && row.startedAt && row.finishedAt) {
      entry.durations.push((row.finishedAt.getTime() - row.startedAt.getTime()) / 1000);
    }

    if (row.errorReason === "AI_RATE_LIMITED") entry.rateLimited += 1;
    if (row.status === "FAILED") entry.failed += 1;
    byModel.set(key, entry);
  }

  return {
    days: TIMING_WINDOW_DAYS,
    models: [...byModel.values()]
      .map(({ durations, ...entry }) => ({
        ...entry,
        checks: durations.length,
        averageSeconds: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
        maxSeconds: durations.length ? Math.round(Math.max(...durations)) : null,
      }))
      .sort((a, b) => b.checks - a.checks),
  };
}

/* ------------------------------------------------------------------ worker */

/**
 * A run older than this was abandoned (its process died or crashed mid-run):
 * the AI call itself times out after 2 minutes, so 10 minutes is safely past
 * any live run, including one owned by another server instance.
 */
export const STALE_RUN_MS = 10 * 60_000;

const runningByUser = new Map<string, number>();
let runningGlobal = 0;
let draining: Promise<void> | null = null;
let kickAgain = false;
let stopping = false;
let wakeTimer: NodeJS.Timeout | null = null;
/** Checks this process is running now (handed back to the queue if it shuts down before they finish). */
const runningHere = new Set<string>();

function adjustRunning(userId: string, delta: 1 | -1) {
  runningGlobal += delta;
  const next = (runningByUser.get(userId) ?? 0) + delta;

  if (next > 0) {
    runningByUser.set(userId, next);
  } else {
    runningByUser.delete(userId);
  }
}

/** Abandoned runs go back to the queue; they never stay RUNNING forever. */
async function requeueStaleRuns(): Promise<void> {
  await prisma.sopAiCheck.updateMany({
    where: { status: "RUNNING", OR: [{ startedAt: null }, { startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }] },
    data: { status: "QUEUED" },
  });
}

/** Last resort when a run failed outside its own error handling (e.g. a database blip). */
async function markRunFailed(id: string): Promise<void> {
  await prisma.sopAiCheck
    .updateMany({ where: { id, status: "RUNNING" }, data: { status: "FAILED", errorReason: "INTERNAL_ERROR", finishedAt: new Date() } })
    .catch((error: unknown) => console.error("Marking SOP AI check as failed did not work:", { checkId: id, error }));
}

/** Only an update that still matches the run's input lands; a re-queued check is left alone. */
async function finish(id: string, hash: string, data: Parameters<typeof prisma.sopAiCheck.updateMany>[0]["data"]) {
  await prisma.sopAiCheck.updateMany({ where: { id, inputHash: hash, status: "RUNNING" }, data: { finishedAt: new Date(), ...data } });
}

function pricingFor(model: AiModelOption, servedBy: string): AiModelOption {
  return model.id === servedBy ? model : (CLAUDE_MODELS.find((candidate) => candidate.id === servedBy) ?? model);
}

async function runCheck(id: string): Promise<void> {
  const row = await prisma.sopAiCheck.findUnique({ where: { id } });

  if (!row) {
    return;
  }

  let done = (data: Parameters<typeof finish>[2]) => finish(row.id, row.inputHash, data);

  try {
    const preference = await getAiPreference(row.userId);

    if (!preference.provider || !preference.model) {
      return await done({ status: "SKIPPED", errorReason: "AI_NOT_CONFIGURED" });
    }

    // Every outcome records the provider and model it was attempted with, so a skipped
    // or failed check never shows the model of an earlier run.
    const attempt = { provider: preference.provider, model: preference.model };
    const record = done;
    done = (data) => record({ ...attempt, ...data });

    const apiKey = await getAiApiKey(row.userId, preference.provider);

    if (!apiKey) {
      return await done({ status: "SKIPPED", errorReason: "AI_KEY_REQUIRED" });
    }

    const model = await findModel(preference.provider, preference.model, preference.provider === "OPENROUTER" ? apiKey : null);

    if (!model) {
      return await done({ status: "FAILED", errorReason: "AI_MODEL_UNAVAILABLE" });
    }

    // The limit guards spend: free models cost nothing, so they always run ("0 = only free models").
    if (!model.free && (await spentSince(row.userId, startOfUtcDay(new Date()))) >= preference.dailyLimitUsd) {
      return await done({ status: "SKIPPED", errorReason: "DAILY_LIMIT_REACHED" });
    }

    if (model.mayCollectData && !preference.dataCollectionAcceptedAt) {
      return await done({ status: "SKIPPED", errorReason: "DATA_COLLECTION_NOT_ACCEPTED" });
    }

    // Fresh reads: the AI must judge the ticket as it is now.
    const client = await createAzureClientForCredential(row.userId, row.credentialId, { refresh: true });

    if (!client) {
      return await done({ status: "FAILED", errorReason: "CREDENTIAL_NOT_FOUND" });
    }

    const raw = await getWorkItem(client, row.workItemId);
    const [summary] = await toWorkItemSummaries(client, [raw]);
    const rulebook = await getEffectiveRulebook(row.userId);
    const profile = summary ? findProjectProfile(rulebook.projects, summary.projectName) : null;

    if (!summary || !profile) {
      return await done({ status: "SKIPPED", errorReason: "PROJECT_NOT_CONFIGURED", results: [] });
    }

    const dossier = await buildDossier(client, summary, raw, profile, new Set(["updates", "comments", "pullRequests", "prThreads", "relatedItems"]));
    // The AI reviews what code found on the ticket as it is now.
    const items = reviewItems(evaluateDossier(dossier, rulebook, new Date()), reviewCardsFor(rulebook, profile, summary.type));
    const judged = { ticketRev: raw.rev };

    if (items.length === 0) {
      return await done({ status: "DONE", errorDetail: null, results: [], errorReason: null, provider: preference.provider, model: model.id, costUsd: 0, ...judged });
    }

    const response = await judge({
      provider: preference.provider,
      apiKey,
      model: model.id,
      effort: model.efforts.includes(preference.effort) ? preference.effort : null,
      system: buildSystemPrompt(),
      // The hours the check was queued with (part of its input hash).
      user: buildUserPrompt(dossier, items, { trackedHours: row.trackedHours }),
      schema: verdictSchema,
      jsonSchema: VERDICT_JSON_SCHEMA,
      allowDataCollection: preference.dataCollectionAcceptedAt !== null,
    });
    const costUsd = estimateCostUsd(pricingFor(model, response.servedBy), response.usage);

    await recordAiUsage({ userId: row.userId, provider: preference.provider, model: response.servedBy, purpose: USAGE_PURPOSE, usage: response.usage, costUsd });

    const results = verifyVerdicts(response.data, items, quotableText(dossier), profile);
    await done({ status: "DONE", errorDetail: null, results: results as object[], errorReason: null, provider: preference.provider, model: response.servedBy, costUsd, ...judged });
  } catch (error) {
    if (error instanceof AiProviderError && error.billed) {
      // Failed answers (refusals, cut-off or invalid JSON) are still billed; count them against the limit.
      const preference = await getAiPreference(row.userId);
      const model = preference.provider && preference.model ? await findModel(preference.provider, preference.model, null).catch(fallbackTo("Looking up the AI model's prices failed; the cost may be under-counted", null)) : null;
      const pricing = model ? pricingFor(model, error.billed.servedBy) : CLAUDE_MODELS.find((candidate) => candidate.id === error.billed?.servedBy);

      if (preference.provider) {
        await recordAiUsage({
          userId: row.userId,
          provider: preference.provider,
          model: error.billed.servedBy,
          purpose: USAGE_PURPOSE,
          usage: error.billed.usage,
          costUsd: pricing ? estimateCostUsd(pricing, error.billed.usage) : 0,
        });
      }
    }

    if (error instanceof AiProviderError && error.reason === "AI_RATE_LIMITED") {
      logFallback(`SOP AI check ${row.id} rate limited; queued again`, error);
      const limitedPreference = await getAiPreference(row.userId);
      const limitedProvider = limitedPreference.provider;
      const notBefore = new Date(Date.now() + (error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_PAUSE_SECONDS) * 1000);
      await prisma.sopAiCheck.updateMany({
        where: { id: row.id, inputHash: row.inputHash, status: "RUNNING" },
        data: {
          status: "QUEUED",
          notBefore,
          errorReason: "AI_RATE_LIMITED",
          errorDetail: error.detail,
          provider: limitedProvider,
          model: limitedPreference.model,
        },
      });
      // The provider limits the key, not the ticket: hold this user's other queued checks too.
      // The provider is recorded so switching to another provider releases them (see enqueue).
      await prisma.sopAiCheck.updateMany({
        where: { userId: row.userId, status: "QUEUED", OR: [{ notBefore: null }, { notBefore: { lt: notBefore } }] },
        data: { notBefore, errorReason: "AI_RATE_LIMITED", errorDetail: error.detail, provider: limitedProvider, model: limitedPreference.model },
      });
      return;
    }

    const reason =
      error instanceof AiProviderError || error instanceof AzureApiError || error instanceof AppError ? error.reason : "INTERNAL_ERROR";

    if (reason === "INTERNAL_ERROR") {
      console.error("SOP AI check failed:", error);
    } else {
      // Stored on the check for the user; logged so the server sees it too.
      logFallback(`SOP AI check ${row.id} failed (${reason})`, error);
    }

    await done({ status: "FAILED", errorReason: reason, errorDetail: error instanceof AiProviderError ? error.detail : null });
  }
}

function scheduleWake(at: Date) {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
  }

  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    kickSopAiWorker();
  }, Math.max(0, at.getTime() - Date.now()));
  wakeTimer.unref();
}

async function drain(): Promise<void> {
  const active = new Set<Promise<void>>();
  await requeueStaleRuns();

  for (;;) {
    if (stopping) {
      await Promise.all(active);
      return;
    }

    const now = new Date();
    const candidates = await prisma.sopAiCheck.findMany({
      where: { status: "QUEUED", OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
      // Newest first: the ticket someone just opened is the one they are waiting for.
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, userId: true },
    });

    for (const candidate of candidates) {
      if (runningGlobal >= MAX_RUNNING_GLOBAL) {
        break;
      }

      if ((runningByUser.get(candidate.userId) ?? 0) >= MAX_RUNNING_PER_USER) {
        continue;
      }

      // Atomic claim: another process (or loop) may take the same row.
      const claimed = await prisma.sopAiCheck.updateMany({
        where: { id: candidate.id, status: "QUEUED" },
        data: { status: "RUNNING", startedAt: new Date() },
      });

      if (claimed.count === 0) {
        continue;
      }

      adjustRunning(candidate.userId, 1);
      runningHere.add(candidate.id);
      const run: Promise<void> = runCheck(candidate.id)
        .catch(async (error: unknown) => {
          console.error("SOP AI worker error:", { checkId: candidate.id, error });
          await markRunFailed(candidate.id);
        })
        .finally(() => {
          adjustRunning(candidate.userId, -1);
          runningHere.delete(candidate.id);
          active.delete(run);
        });
      active.add(run);
    }

    if (active.size === 0) {
      const [waiting, running] = await Promise.all([
        prisma.sopAiCheck.findFirst({ where: { status: "QUEUED", notBefore: { gt: now } }, orderBy: { notBefore: "asc" }, select: { notBefore: true } }),
        // A run left RUNNING by a process that died is re-queued once it is stale; wake up for that too.
        prisma.sopAiCheck.findFirst({ where: { status: "RUNNING", startedAt: { not: null } }, orderBy: { startedAt: "asc" }, select: { startedAt: true } }),
      ]);
      const wakes = [waiting?.notBefore?.getTime(), running?.startedAt ? running.startedAt.getTime() + STALE_RUN_MS : undefined].filter((at): at is number => at !== undefined);

      if (wakes.length > 0) {
        scheduleWake(new Date(Math.min(...wakes)));
      }

      return;
    }

    await Promise.race(active);
  }
}

/** Starts processing queued checks in this process (no-op if already running or shutting down). */
export function kickSopAiWorker(): void {
  if (stopping) {
    return;
  }

  if (draining) {
    kickAgain = true;
    return;
  }

  draining = drain()
    .catch((error: unknown) => console.error("SOP AI queue failed:", error))
    .finally(() => {
      draining = null;

      if (kickAgain) {
        kickAgain = false;
        kickSopAiWorker();
      }
    });
}

/** Resolves when nothing is being processed. For tests and shutdown. */
export async function waitForSopAiIdle(): Promise<void> {
  while (draining) {
    await draining;
  }
}

/**
 * On startup: re-queue runs abandoned by a crashed process and resume the queue.
 * Live runs of other instances are left alone (they are younger than STALE_RUN_MS).
 */
export async function recoverSopAiQueue(): Promise<void> {
  await requeueStaleRuns();
  kickSopAiWorker();
}

/**
 * For shutdown: claim no new checks and wait (up to `timeoutMs`) for the
 * running ones, so paid AI calls are not cut off mid-flight. Checks still
 * running after that go back to the queue, so the next start runs them again
 * instead of leaving them RUNNING.
 */
export async function stopSopAiWorker(timeoutMs: number): Promise<void> {
  stopping = true;

  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }

  await Promise.race([waitForSopAiIdle(), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);

  if (runningHere.size > 0) {
    await prisma.sopAiCheck.updateMany({ where: { id: { in: [...runningHere] }, status: "RUNNING" }, data: { status: "QUEUED", startedAt: null } });
  }
}
