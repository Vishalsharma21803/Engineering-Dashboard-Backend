import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/app-error.js";
import { prisma } from "../../lib/prisma.js";
import type { BuildSummary, ComplianceResult, Recommendation, WorkItemSummary } from "../../types/azure.types.js";
import type { TimeCheck } from "../solidtime/time-nudges.service.js";

export type NotificationKind = "pullRequest" | "pipeline" | "approvals" | "timeDay" | "timer" | "timeUntracked" | "closedTicket";
export type NotificationStatusValue = "UNREAD" | "READ" | "ABANDONED";

/** Where Open goes. */
export interface NotificationTarget {
  type: "workItem" | "pullRequest" | "build" | "time" | "actions";
  projectName: string | null;
  id: number;
  repositoryId?: string;
  solidtimeCredentialId?: string;
}

/** What is wrong right now, before it is stored. */
export interface NotificationCandidate {
  key: string;
  kind: NotificationKind;
  projectName: string | null;
  title: string;
  reasons: string[];
  target: NotificationTarget;
  signals: string[];
}

const NO_TIME_SIGNAL = "TIME:CLOSED_NO_TIME";

/** Per pipeline and branch, like the list's snooze. */
export const pipelineNotificationKey = (projectName: string, build: Pick<BuildSummary, "definitionId" | "sourceBranch">) => `pipeline:${projectName}:${build.definitionId}:${build.sourceBranch ?? ""}`;
const NO_TIME_REASON = "No time tracked";
const closedKey = (id: number) => `closed:wi:${id}`;
const CLOSED_KEY = /^closed:wi:(\d+)$/;

const notificationSelect = {
  id: true,
  key: true,
  kind: true,
  projectName: true,
  title: true,
  reasons: true,
  target: true,
  status: true,
  firstSeenAt: true,
  updatedAt: true,
} as const;

async function assertOwnedCredential(userId: string, credentialId: string): Promise<void> {
  const credential = await prisma.credential.findFirst({ where: { id: credentialId, userId }, select: { id: true } });

  if (!credential) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
  }
}

/**
 * One per closed ticket: every SOP gap it still has, and "No time tracked" when none is.
 * A gap stored before stays until its rule is seen to pass (or an AI review clears it): a rule
 * that was skipped this time (data unavailable), an outdated AI review, or SOP checks switched off prove nothing.
 */
function closedTicketCandidate(item: WorkItemSummary, compliance: ComplianceResult | undefined, noTime: boolean, previous: StoredGap[] = []): NotificationCandidate | null {
  if (item.stateCategory !== "Completed") {
    return null;
  }

  const gaps = (compliance?.configured ? compliance.violations : []).map((gap) => ({ signal: `SOP:${gap.ruleId}`, reason: gap.message.replace(/\.$/, "") }));
  // Only a pass proves it: the code check passed, the AI review cleared it, or the current AI review explicitly passed an AI-only rule.
  // A to-do (window still open), a notice (a failing check shown as a note), "unsure" or no verdict proves nothing.
  const judged = new Set(compliance?.configured ? [...compliance.passedRules, ...compliance.cleared, ...(compliance.aiPassed ?? [])].map((rule) => `SOP:${rule.ruleId}`) : []);
  const still = previous.filter((gap) => !judged.has(gap.signal) && !gaps.some((current) => current.signal === gap.signal));
  const all = [...gaps, ...still];

  if (all.length === 0 && !noTime) {
    return null;
  }

  return {
    key: closedKey(item.id),
    kind: "closedTicket",
    projectName: item.projectName,
    title: `#${item.id} ${item.title}`,
    reasons: [...all.map((gap) => gap.reason), ...(noTime ? [NO_TIME_REASON] : [])],
    target: { type: "workItem", projectName: item.projectName, id: item.id },
    signals: [...all.map((gap) => gap.signal), ...(noTime ? [NO_TIME_SIGNAL] : [])],
  };
}

/** A closed ticket's SOP gap as stored (its signal and its words). */
export interface StoredGap {
  signal: string;
  reason: string;
}

export interface NotificationInput {
  recommendations: Recommendation[];
  builds: BuildSummary[];
  /** My tickets read now (open, and closed within the compliance window), with their SOP results. */
  workItems: WorkItemSummary[];
  compliance: ComplianceResult[];
  time: TimeCheck;
  /** Closed tickets already flagged "No time tracked", so the flag holds while Solidtime cannot be read. */
  flaggedNoTime: Set<number>;
  /** Closed tickets' SOP gaps already stored, kept until their rule is seen to pass. */
  previousGaps?: Map<number, StoredGap[]>;
}

/** Everything that needs me outside the ticket list, from what the dashboard just read. */
export function notificationCandidates(input: NotificationInput): NotificationCandidate[] {
  const buildsById = new Map(input.builds.map((build) => [build.id, build]));
  const candidates: NotificationCandidate[] = [];
  const closedNoTime = new Set<number>();

  for (const recommendation of input.recommendations) {
    const { target } = recommendation;

    if (recommendation.category === "REVIEW" && target.type === "pullRequest" && target.repositoryId) {
      candidates.push({
        key: recommendation.id,
        kind: "pullRequest",
        projectName: target.projectName,
        title: recommendation.title,
        reasons: recommendation.reasons,
        target: { type: "pullRequest", projectName: target.projectName, id: target.id, repositoryId: target.repositoryId },
        signals: recommendation.signals,
      });
    } else if (recommendation.category === "FAILED_PIPELINE" && target.type === "build") {
      const build = buildsById.get(target.id);

      if (build?.projectName) {
        candidates.push({
          // Per pipeline and branch, like the list's snooze: a newer failed run is a new signal on the same notification.
          key: pipelineNotificationKey(build.projectName, build),
          kind: "pipeline",
          projectName: build.projectName,
          title: recommendation.title,
          reasons: recommendation.reasons,
          target: { type: "build", projectName: build.projectName, id: build.id },
          signals: recommendation.signals,
        });
      }
    } else if (recommendation.category === "TIME" && target.type === "time" && target.key) {
      candidates.push({
        key: target.key,
        kind: target.key === "time:timer" ? "timer" : "timeDay",
        projectName: null,
        title: recommendation.title,
        reasons: recommendation.reasons,
        target: { type: "time", projectName: null, id: 0, ...(target.solidtimeCredentialId ? { solidtimeCredentialId: target.solidtimeCredentialId } : {}) },
        signals: recommendation.signals,
      });
    } else if (recommendation.category === "TIME" && target.type === "workItem") {
      if (recommendation.id.endsWith(":closed-no-time")) {
        closedNoTime.add(target.id);
      } else {
        candidates.push({
          key: recommendation.id,
          kind: "timeUntracked",
          projectName: target.projectName,
          title: recommendation.title,
          reasons: recommendation.reasons,
          target: { type: "workItem", projectName: target.projectName, id: target.id },
          signals: recommendation.signals,
        });
      }
    }
  }

  return [...candidates, ...closedTicketCandidates(input.workItems, input.compliance, input, closedNoTime)];
}

/** Closed tickets' notifications (SOP gaps and missing time), from tickets and their SOP results. */
export function closedTicketCandidates(
  items: WorkItemSummary[],
  compliance: ComplianceResult[],
  input: Pick<NotificationInput, "time" | "flaggedNoTime" | "previousGaps">,
  flaggedNow = new Set<number>()
): NotificationCandidate[] {
  const complianceById = new Map(compliance.map((result) => [result.workItemId, result]));
  return items.flatMap((item) => closedTicketCandidate(item, complianceById.get(item.id), noTimeFor(item.id, input, flaggedNow), input.previousGaps?.get(item.id)) ?? []);
}

/**
 * "No time tracked" on a closed ticket: flagged now (closed in the last days with no time), or flagged
 * before and still without time. While Solidtime cannot be read, an earlier flag holds.
 */
function noTimeFor(id: number, input: Pick<NotificationInput, "time" | "flaggedNoTime">, flaggedNow: Set<number>): boolean {
  if (!input.time.ok) {
    return input.flaggedNoTime.has(id);
  }

  return flaggedNow.has(id) || (input.flaggedNoTime.has(id) && !input.time.trackedEver.has(id));
}

/** What the dashboard read could see, so a notification missing from the candidates is known to be fixed. */
export interface NotificationScope {
  /** The project the dashboard was narrowed to (tickets), or undefined for all of them. */
  projectName: string | undefined;
  workItemsRead: boolean;
  /**
   * Ticket ids read now whose open/closed state Azure confirmed (their closed-ticket notification is fixed when it
   * is not a candidate). A ticket whose type's states could not be read is left out, so it is re-checked instead.
   */
  readTicketIds: Set<number>;
  /**
   * Pull requests read now (pr:<repositoryId>:<id>), with whether their comment threads could be counted
   * and their merge status is known. Only these can be judged from the read; others are looked up one by one.
   */
  readPullRequests: Map<string, { threadsRead: boolean; mergeKnown?: boolean }>;
  /** The latest run read per pipeline key, and whether it finished and succeeded. A pipeline with no such run read keeps its notification. */
  readPipelines: Map<string, { passed: boolean }>;
}

export interface SyncDependencies {
  /** Re-reads closed tickets outside the dashboard's window: their candidates now and the ids that could not be read, or null when Azure failed. */
  recheckClosedTickets: (ids: number[]) => Promise<{ candidates: NotificationCandidate[]; unchecked: Set<number> } | null>;
  /** Looks up pull requests that were not in the read: the keys of those no longer active (completed or abandoned). */
  recheckPullRequests: (pullRequests: Array<{ key: string; projectName: string; repositoryId: string; id: number }>) => Promise<Set<string>>;
}

/** Re-checks per dashboard load, at most, per kind; the least recently checked go first, so all get their turn. */
export const MAX_RECHECK = 20;

/**
 * A pull request's reasons that this read could not judge (threads not counted, merge status still being worked out)
 * stay as stored, with their words, instead of silently vanishing.
 */
function withUnknownKept(candidate: NotificationCandidate, row: { signals: string[]; reasons: string[] }, read: { threadsRead: boolean; mergeKnown?: boolean } | undefined): NotificationCandidate {
  // ("Ready to complete" is never carried: another reason now means it is not ready.)
  const unknown = [...(read && !read.threadsRead ? ["UNRESOLVED_THREADS"] : []), ...(read?.mergeKnown === false ? ["MERGE_CONFLICTS"] : [])];
  const kept = row.signals.flatMap((signal, index) => (unknown.includes(signal) && !candidate.signals.includes(signal) && row.reasons[index] !== undefined ? [{ signal, reason: row.reasons[index]! }] : []));

  return kept.length === 0 ? candidate : { ...candidate, signals: [...candidate.signals, ...kept.map((one) => one.signal)], reasons: [...candidate.reasons, ...kept.map((one) => one.reason)] };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const PR_KEY = /^pr:([^:]+):(\d+)$/;

/**
 * Stores what needs me now and removes what is fixed. Never removes a notification just because
 * it could not be checked: a section that failed, something outside the read, or Solidtime down keeps it.
 */
export async function syncNotifications(
  userId: string,
  credentialId: string,
  candidates: NotificationCandidate[],
  scope: NotificationScope,
  time: TimeCheck,
  dependencies: SyncDependencies
): Promise<void> {
  const stored = await prisma.notification.findMany({
    where: { userId, credentialId },
    select: { id: true, key: true, kind: true, projectName: true, title: true, reasons: true, target: true, signals: true, readSignals: true, status: true },
    // Least recently checked first, for the capped re-checks.
    orderBy: { updatedAt: "asc" },
  });
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const lower = (value: string | null) => (value ?? "").toLowerCase();
  const ticketsInScope = (projectName: string | null) => scope.projectName === undefined || lower(projectName) === lower(scope.projectName);

  const fixed: string[] = [];
  const timeRecheck: string[] = [];
  const closedRecheck: number[] = [];
  const pullRequestRecheck: Array<{ key: string; projectName: string; repositoryId: string; id: number }> = [];

  for (const row of stored) {
    if (byKey.has(row.key)) {
      continue;
    }

    switch (row.kind as NotificationKind) {
      case "pullRequest": {
        const read = scope.readPullRequests.get(row.key);
        const match = PR_KEY.exec(row.key);

        if (read) {
          // Read and nothing needs me any more; unless its comment threads could not be counted now (threads and "ready" depend on them),
          // or Azure is still working out whether it has merge conflicts.
          if (read.threadsRead && (read.mergeKnown !== false || !row.signals.includes("MERGE_CONFLICTS"))) fixed.push(row.id);
        } else if (match && row.projectName) {
          pullRequestRecheck.push({ key: row.key, projectName: row.projectName, repositoryId: match[1]!, id: Number(match[2]) });
        }
        break;
      }
      case "pipeline":
        // Fixed only when a newer run of the same pipeline and branch finished and succeeded.
        if (scope.readPipelines.get(row.key)?.passed === true) fixed.push(row.id);
        break;
      case "closedTicket": {
        const id = Number(CLOSED_KEY.exec(row.key)?.[1]);

        if (!scope.workItemsRead || !ticketsInScope(row.projectName) || !Number.isFinite(id)) break;

        if (scope.readTicketIds.has(id)) fixed.push(row.id);
        else closedRecheck.push(id);
        break;
      }
      case "timeUntracked":
        // Fixed only when Solidtime shows time naming the ticket that day (never because the ticket was not read).
        if (time.ok) timeRecheck.push(row.key);
        break;
      case "timeDay":
      case "timer":
        if (time.ok) {
          if (time.covers(row.key)) fixed.push(row.id);
          else timeRecheck.push(row.key);
        }
        break;
      // Approvals are synced when the list is read.
      case "approvals":
        break;
    }
  }

  const rowsByKey = new Map(stored.map((row) => [row.key, row]));
  const checked: string[] = [];
  const fix = (key: string) => {
    const row = rowsByKey.get(key);
    if (row) fixed.push(row.id);
  };

  const timeBatch = timeRecheck.slice(0, MAX_RECHECK);
  if (timeBatch.length > 0) {
    const done = await time.recheck(timeBatch);
    // Checked or not (Solidtime failed), they go to the back, so the others get their turn.
    checked.push(...timeBatch);
    done?.forEach(fix);
  }

  const pullRequestBatch = pullRequestRecheck.slice(0, MAX_RECHECK);
  if (pullRequestBatch.length > 0) {
    const done = await dependencies.recheckPullRequests(pullRequestBatch);
    checked.push(...pullRequestBatch.map((pr) => pr.key));
    done.forEach(fix);
  }

  const upserts = [...candidates];
  const closedBatch = closedRecheck.slice(0, MAX_RECHECK);

  if (closedBatch.length > 0) {
    const reread = await dependencies.recheckClosedTickets(closedBatch);
    // Re-read or not (Azure failed, or left some out), they go to the back of the queue.
    checked.push(...closedBatch.map(closedKey));

    if (reread) {
      const still = new Set(reread.candidates.map((candidate) => candidate.key));
      upserts.push(...reread.candidates);

      for (const id of closedBatch) {
        if (reread.unchecked.has(id)) continue;
        // Fixed: no gap or missing time left, or reopened.
        if (!still.has(closedKey(id))) fix(closedKey(id));
      }
    }
  }

  if (fixed.length > 0) {
    await prisma.notification.deleteMany({ where: { userId, id: { in: fixed } } });
  }

  // Checked (or tried) and still there: to the back of the queue for the next re-check.
  const touched = checked.map((key) => rowsByKey.get(key)?.id).filter((id): id is string => Boolean(id) && !fixed.includes(id!));
  if (touched.length > 0) {
    await prisma.notification.updateMany({ where: { userId, id: { in: touched } }, data: { updatedAt: new Date() } });
  }

  const fresh = upserts.filter((candidate) => !rowsByKey.has(candidate.key));

  if (fresh.length > 0) {
    // Two dashboard reads at once may both add the same one: the second is skipped.
    await prisma.notification.createMany({
      data: fresh.map((candidate) => ({
        userId,
        credentialId,
        key: candidate.key,
        kind: candidate.kind,
        projectName: candidate.projectName,
        title: candidate.title,
        reasons: candidate.reasons,
        target: candidate.target as unknown as Prisma.InputJsonValue,
        signals: candidate.signals,
        readSignals: [],
      })),
      skipDuplicates: true,
    });
  }

  for (const found of upserts) {
    const row = rowsByKey.get(found.key);

    if (!row) continue;

    const candidate = found.kind === "pullRequest" ? withUnknownKept(found, row, scope.readPullRequests.get(found.key)) : found;

    // Something new since it was read: back to unread. Abandoned stays abandoned.
    const reopened = row.status === "READ" && candidate.signals.some((signal) => !row.readSignals.includes(signal));
    const changed =
      reopened ||
      row.title !== candidate.title ||
      row.projectName !== candidate.projectName ||
      !sameList(row.reasons, candidate.reasons) ||
      !sameList(row.signals, candidate.signals) ||
      JSON.stringify(row.target) !== JSON.stringify(candidate.target);

    if (changed) {
      // updateMany: a row another read just removed as fixed is simply skipped.
      await prisma.notification.updateMany({
        where: { id: row.id, userId },
        data: {
          title: candidate.title,
          projectName: candidate.projectName,
          reasons: candidate.reasons,
          signals: candidate.signals,
          target: candidate.target as unknown as Prisma.InputJsonValue,
          ...(reopened ? { status: "UNREAD" as const } : {}),
        },
      });
    }
  }
}

/**
 * What is stored for closed tickets: those flagged "No time tracked" (the flag survives a Solidtime outage)
 * and their SOP gaps (kept until their rule is seen to pass).
 */
export async function storedClosedTickets(userId: string, credentialId: string): Promise<{ flaggedNoTime: Set<number>; previousGaps: Map<number, StoredGap[]> }> {
  const rows = await prisma.notification.findMany({ where: { userId, credentialId, kind: "closedTicket" }, select: { key: true, signals: true, reasons: true } });
  const flagged = new Set<number>();
  const previousGaps = new Map<number, StoredGap[]>();

  for (const row of rows) {
    const id = Number(CLOSED_KEY.exec(row.key)?.[1]);
    if (!Number.isFinite(id)) continue;
    if (row.signals.includes(NO_TIME_SIGNAL)) flagged.add(id);
    // Signals and reasons are stored side by side, gaps first.
    previousGaps.set(id, row.signals.flatMap((signal, index) => (signal.startsWith("SOP:") && row.reasons[index] !== undefined ? [{ signal, reason: row.reasons[index]! }] : [])));
  }

  return { flaggedNoTime: flagged, previousGaps };
}

/** Approvals live in Relay, so they are checked whenever the list is read. */
async function syncApprovals(userId: string, credentialId: string): Promise<void> {
  const pending = await prisma.proposedAction.findMany({ where: { userId, credentialId, status: "PENDING" }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const key = "approvals";

  if (pending.length === 0) {
    await prisma.notification.deleteMany({ where: { userId, credentialId, key } });
    return;
  }

  const candidate: NotificationCandidate = {
    key,
    kind: "approvals",
    projectName: null,
    title: `${pending.length} ${pending.length === 1 ? "change awaits" : "changes await"} your approval`,
    reasons: ["Nothing is written to Azure DevOps or Solidtime until you approve"],
    target: { type: "actions", projectName: null, id: 0 },
    signals: pending.map((action) => `ACTION:${action.id}`),
  };
  const row = await prisma.notification.findUnique({ where: { credentialId_key: { credentialId, key } }, select: { id: true, title: true, signals: true, readSignals: true, status: true } });

  if (!row) {
    await prisma.notification.createMany({
      data: [{ userId, credentialId, key, kind: candidate.kind, projectName: null, title: candidate.title, reasons: candidate.reasons, target: candidate.target as unknown as Prisma.InputJsonValue, signals: candidate.signals, readSignals: [] }],
      skipDuplicates: true,
    });
    return;
  }

  const reopened = row.status === "READ" && candidate.signals.some((signal) => !row.readSignals.includes(signal));

  if (reopened || row.title !== candidate.title || !sameList(row.signals, candidate.signals)) {
    await prisma.notification.updateMany({ where: { id: row.id, userId }, data: { title: candidate.title, signals: candidate.signals, ...(reopened ? { status: "UNREAD" as const } : {}) } });
  }
}

/** This organization's notifications, narrowed to one project (plus those tied to none) when given. Newest first. */
export async function listNotifications(userId: string, credentialId: string, projectName: string | undefined) {
  await assertOwnedCredential(userId, credentialId);
  await syncApprovals(userId, credentialId);

  return prisma.notification.findMany({
    where: {
      userId,
      credentialId,
      ...(projectName ? { OR: [{ projectName: null }, { projectName: { equals: projectName, mode: "insensitive" as const } }] } : {}),
    },
    select: notificationSelect,
    orderBy: [{ firstSeenAt: "desc" }, { key: "asc" }],
  });
}

/** Read, unread (restore) or abandoned: only the status changes; nothing is removed. */
export async function setNotificationStatus(userId: string, id: string, status: NotificationStatusValue) {
  const row = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true, signals: true } });
  // What it said when read or abandoned; a signal outside this brings a read one back.
  const result = row ? await prisma.notification.updateMany({ where: { id, userId }, data: { status, readSignals: status === "UNREAD" ? [] : row.signals } }) : { count: 0 };
  const updated = result.count > 0 ? await prisma.notification.findFirst({ where: { id, userId }, select: notificationSelect }) : null;

  if (!updated) {
    // Gone meanwhile means its cause was fixed.
    throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found (its cause may have just been fixed)");
  }

  return updated;
}

/** Every unread one (in this project, when given) becomes read. */
export async function markAllNotificationsRead(userId: string, credentialId: string, projectName: string | undefined): Promise<number> {
  await assertOwnedCredential(userId, credentialId);
  const rows = await prisma.notification.findMany({
    where: {
      userId,
      credentialId,
      status: "UNREAD",
      ...(projectName ? { OR: [{ projectName: null }, { projectName: { equals: projectName, mode: "insensitive" as const } }] } : {}),
    },
    select: { id: true, signals: true },
  });

  await prisma.$transaction(rows.map((row) => prisma.notification.updateMany({ where: { id: row.id, userId }, data: { status: "READ", readSignals: row.signals } })));
  return rows.length;
}
