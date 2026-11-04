import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import type { ComplianceResult, ComplianceViolation, Recommendation, RecommendationCategory, SuggestedAction, WorkItemSummary } from "../../types/azure.types.js";
import { getIdentity } from "../azure/identity.service.js";
import { listAssignedWorkItemRecords } from "../azure/work-items.service.js";
import { checkCompliance } from "../compliance/compliance.service.js";
import { buildRecommendations } from "../recommendation.service.js";
import { applyAiReviews } from "../sop/ai/sop-ai-review.js";
import { isHiddenState, resolveWorkItemTriage, type TriageMarkLike } from "./triage-resolve.js";
import { matchesWorkItem, workItemFacets, type FilterOption, type WorkItemFilters } from "./work-item-filters.js";
import { groupWorkItems, resolveGroups, type WorkItemGroup } from "./grouping.js";
import { currentSprints, inCurrentSprint, type CurrentSprint } from "./sprints.js";

/**
 * My work rows (open tickets + their code-rule results) are expensive to
 * compute, so a page request reuses what the dashboard just computed for a
 * short time instead of re-running every SOP check per page click.
 */
const SNAPSHOT_TTL_MS = 60_000;
const MAX_SNAPSHOTS = 500;

export interface MyWorkSnapshot {
  /** Open tickets. */
  items: WorkItemSummary[];
  /** Tickets closed in the last days (shown with "Include recently closed"). */
  closed: WorkItemSummary[];
  /** Tickets read for this list, including parents read for group headings (reused while the snapshot lives). */
  known: Map<number, WorkItemSummary>;
  /** Each project's current sprint, read on the first page request. */
  sprints?: Map<string, CurrentSprint | null>;
  compliance: Map<number, ComplianceResult>;
  /** Recommendation signal codes per ticket (they decide when triaged tickets resurface). */
  signals: Map<number, string[]>;
  /** What needs doing on a ticket (blocked, SOP gaps, idle…), shown on its row in My work. */
  attention: Map<number, Attention>;
}

const snapshots = new Map<string, { expiresAt: number; snapshot: MyWorkSnapshot }>();
/** When each user's lists for a credential were last forgotten (userId|credentialId|): older reads are not cached. */
const forgottenAt = new Map<string, number>();

/** The latest "forget" covering this user's lists for this organization ("" = everyone, "user|" = all their organizations). */
function forgottenSince(userId: string, credentialId: string): number {
  return Math.max(forgottenAt.get("") ?? 0, forgottenAt.get(`${userId}|`) ?? 0, forgottenAt.get(`${userId}|${credentialId}|`) ?? 0);
}

function snapshotKey(userId: string, credentialId: string, projectName: string | undefined): string {
  return `${userId}|${credentialId}|${projectName ?? "*"}`;
}

/**
 * Called by the dashboard with what it computed. `readStartedAt`: when its
 * Azure reads began; a result read before an approved change is not cached.
 */
export function rememberMyWork(
  userId: string,
  credentialId: string,
  projectName: string | undefined,
  input: { workItems: WorkItemSummary[]; compliance: ComplianceResult[]; recommendations: Recommendation[]; sprints?: Map<string, CurrentSprint | null> | undefined },
  readStartedAt = Date.now()
): MyWorkSnapshot {
  const isOpen = (item: WorkItemSummary) => item.stateCategory !== "Completed" && item.stateCategory !== "Removed";
  const open = input.workItems.filter(isOpen);
  const closed = input.workItems.filter((item) => !isOpen(item));
  const signals = new Map<number, string[]>();

  const attention = new Map<number, Attention>();

  for (const recommendation of input.recommendations) {
    if (recommendation.target.type === "workItem") {
      signals.set(recommendation.target.id, [...(signals.get(recommendation.target.id) ?? []), ...recommendation.signals]);
      // A ticket can have several (its SOP/blocked one and time reminders): keep every reason, and the
      // first (highest-scoring) one's category and fix, so a time reminder never hides a fix.
      const earlier = attention.get(recommendation.target.id);
      const reasons = recommendation.reasons.filter((reason) => !/^Priority \d$/.test(reason));
      attention.set(recommendation.target.id, {
        category: earlier?.category ?? recommendation.category,
        reasons: [...(earlier?.reasons ?? []), ...reasons.filter((reason) => !earlier?.reasons.includes(reason))],
        suggestedAction: earlier?.suggestedAction ?? recommendation.suggestedAction,
      });
    }
  }

  const snapshot: MyWorkSnapshot = { attention, items: open, closed, known: new Map(input.workItems.map((item) => [item.id, item])), ...(input.sprints ? { sprints: input.sprints } : {}), compliance: new Map(input.compliance.map((result) => [result.workItemId, result])), signals };

  if (forgottenSince(userId, credentialId) > readStartedAt) {
    return snapshot;
  }

  // Oldest entries go first once the cap is reached (Map keeps insertion order).
  if (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;

    if (oldest !== undefined) {
      snapshots.delete(oldest);
    }
  }

  const key = snapshotKey(userId, credentialId, projectName);
  snapshots.delete(key);
  snapshots.set(key, { expiresAt: Date.now() + SNAPSHOT_TTL_MS, snapshot });
  return snapshot;
}

/** Whether a cached My work list holds an older revision of this ticket than Azure has now. */
export function myWorkIsBehind(userId: string, credentialId: string, workItemId: number, rev: number): boolean {
  const prefix = `${userId}|${credentialId}|`;

  return [...snapshots.entries()].some(
    ([key, entry]) => key.startsWith(prefix) && [...entry.snapshot.items, ...entry.snapshot.closed].some((item) => item.id === workItemId && item.rev < rev)
  );
}

/**
 * Rebuild from Azure on the next read instead of up to a minute later: after an
 * approved change (one organization), a change to the user's own rules (no
 * credential), or to the shared rules and project set-ups (nobody named: everyone).
 */
export function forgetMyWorkSnapshots(userId?: string, credentialId?: string): void {
  const prefix = userId === undefined ? "" : credentialId === undefined ? `${userId}|` : `${userId}|${credentialId}|`;
  forgottenAt.set(prefix, Date.now());

  for (const key of [...snapshots.keys()]) {
    if (key.startsWith(prefix)) snapshots.delete(key);
  }
}

/** Exposed for tests. */
export function getMyWorkSnapshotForTests(userId: string, credentialId: string, projectName?: string): MyWorkSnapshot | undefined {
  return snapshots.get(snapshotKey(userId, credentialId, projectName))?.snapshot;
}

/** Exposed for tests. */
export function clearMyWorkSnapshots(): void {
  snapshots.clear();
  forgottenAt.clear();
}

async function loadSnapshot(client: AzureClient, userId: string, projectName: string | undefined, refresh: boolean): Promise<MyWorkSnapshot> {
  const key = snapshotKey(userId, client.credentialId, projectName);
  const cached = snapshots.get(key);

  if (cached && cached.expiresAt > Date.now() && !refresh) {
    return cached.snapshot;
  }

  const now = new Date();
  const records = await listAssignedWorkItemRecords(client, { projectName, scope: "compliance" });
  const compliance = await checkCompliance(client, userId, records, now);
  const workItems = records.map((record) => record.summary);
  // Ticket signals depend only on the ticket and its SOP results (with the user's AI reviews; the snapshot keeps code results).
  const reviewed = await applyAiReviews(userId, client.credentialId, compliance, new Map(workItems.map((item) => [item.id, item.rev])));
  const recommendations = buildRecommendations({ workItems, compliance: reviewed, pullRequests: [], builds: [], now });
  const sprints = await currentSprints(client, workItems.map((item) => item.projectName));

  return rememberMyWork(userId, client.credentialId, projectName, { workItems, compliance, recommendations, sprints }, now.getTime());
}

/** The user's saved AI reviews (clears, AI-only rules) applied to the cached code results. */
async function withAiReviews(userId: string, credentialId: string, snapshot: MyWorkSnapshot): Promise<Map<number, ComplianceResult>> {
  const revs = new Map([...snapshot.items, ...snapshot.closed].map((item) => [item.id, item.rev]));
  const applied = await applyAiReviews(userId, credentialId, [...snapshot.compliance.values()], revs);
  return new Map(applied.map((result) => [result.workItemId, result]));
}

/** Why a ticket needs me, and the change that fixes it (proposed for approval, never applied directly). */
export interface Attention {
  category: RecommendationCategory;
  reasons: string[];
  suggestedAction: SuggestedAction | null;
}

export interface MyWorkRow {
  workItem: WorkItemSummary;
  compliance: ComplianceResult | null;
  attention: Attention | null;
}

/** Where a ticket sits in My work: what I am doing, what is next, what waits for others, what is finished. */
export type WorkSection = "inProgress" | "todo" | "resolved" | "done";
const SECTION_ORDER: WorkSection[] = ["inProgress", "todo", "resolved", "done"];

export function sectionOf(item: WorkItemSummary): WorkSection {
  switch (item.stateCategory) {
    case "InProgress":
      return "inProgress";
    case "Resolved":
      return "resolved";
    case "Completed":
    case "Removed":
      return "done";
    default:
      return "todo";
  }
}

const finished = (item: WorkItemSummary) => item.stateCategory === "Resolved" || item.stateCategory === "Completed";

/** My tickets under a story: how many are finished (resolved or closed) and the hours left on the rest. */
export interface StoryProgress {
  done: number;
  total: number;
  remainingHours: number;
}

/** One group of My work: a story with my tickets under it (or one ticket under no story), in its status section. */
export interface MyWorkGroup extends WorkItemGroup<MyWorkRow> {
  /** Null when the list is grouped by story only. */
  section: WorkSection | null;
  /** My tickets under the heading, across every section; null without a heading. */
  progress: StoryProgress | null;
}

/** The picture at the top of My work, before filters: the sprint and where my tickets stand. */
export interface MyWorkOverview {
  /** The current sprint when my tickets are in one sprint; null with several or none. */
  sprint: { name: string; startDate: string | null; finishDate: string | null } | null;
  counts: Record<WorkSection, number>;
  /** Remaining Work left on my open tickets. */
  remainingHours: number;
}

/** One page of groups (10 per page), ordered by status section and then by my latest change. */
export interface MyWorkPage extends Page<MyWorkGroup> {
  groupBy: "status" | "story";
  /** Matching tickets per section (done counted even while it is folded). */
  sections: Array<{ key: WorkSection; count: number }>;
  overview: MyWorkOverview;
  /** My tickets matching the filters (the groups hold them). */
  ticketCount: number;
  /** Open tickets in view before filters (the hidden ones when showing hidden). */
  poolTotal: number;
  /** Snoozed or abandoned tickets; shown only with `hidden`. */
  hiddenCount: number;
  showingHidden: boolean;
  /** "current": only tickets in their project's current sprint (the default when any are). */
  sprint: { mode: "current" | "all"; inSprint: number; names: string[] };
  /** Finished tickets (closed in the last days): listed only when included. */
  closed: { included: boolean; count: number };
  /** Tickets that need something from me (in view before filters); `only` when the list shows just those. */
  attention: { only: boolean; count: number };
  facets: { types: FilterOption[]; states: FilterOption[]; priorities: FilterOption[]; sop: FilterOption[] };
}

export async function getMyWorkPage(
  client: AzureClient,
  userId: string,
  input: {
    projectName: string | undefined;
    filters: WorkItemFilters;
    page: number;
    hidden: boolean;
    refresh: boolean;
    sprint?: "current" | "all" | undefined;
    closed?: boolean | undefined;
    attention?: boolean | undefined;
    groupBy?: "status" | "story" | undefined;
  }
): Promise<MyWorkPage> {
  const snapshot = await loadSnapshot(client, userId, input.projectName, input.refresh);
  const [marks, compliance] = await Promise.all([
    prisma.triageMark.findMany({
      where: { userId, credentialId: client.credentialId },
      select: { itemKey: true, status: true, snoozedUntil: true, signals: true },
    }),
    withAiReviews(userId, client.credentialId, snapshot),
  ]);
  const marksByKey = new Map<string, TriageMarkLike>(marks.map((mark) => [mark.itemKey, mark]));
  const now = Date.now();
  const hidden = (item: WorkItemSummary) =>
    isHiddenState(resolveWorkItemTriage(marksByKey, item.id, item.projectName, snapshot.signals.get(item.id) ?? [], now));
  const isOpen = (item: WorkItemSummary) => sectionOf(item) !== "done";

  const includeClosed = input.closed === true;
  const groupBy = input.groupBy ?? "status";
  // Finished tickets always count (the overview and the folded "Done" section); they are listed only when asked.
  const candidates = [...snapshot.items, ...snapshot.closed];
  const hiddenCount = candidates.filter((item) => (includeClosed || isOpen(item)) && hidden(item)).length;
  const showingHidden = input.hidden && hiddenCount > 0;
  const visible = candidates.filter((item) => hidden(item) === showingHidden);

  snapshot.sprints ??= await currentSprints(client, candidates.map((item) => item.projectName));
  const sprints = snapshot.sprints;
  const inSprint = visible.filter((item) => inCurrentSprint(item, sprints));
  const hasSprints = [...sprints.values()].some((sprint) => sprint !== null);
  // Current sprint by default when some project has sprints and something open of mine is in one.
  const mode = hasSprints ? (input.sprint ?? (inSprint.some(isOpen) ? "current" : "all")) : "all";
  const pool = mode === "current" ? inSprint : visible;
  const openPool = pool.filter(isOpen);
  const needsMe = (item: WorkItemSummary) => snapshot.attention.has(item.id);
  const attentionOnly = input.attention === true;
  const matching = pool.filter((item) => (!attentionOnly || needsMe(item)) && matchesWorkItem(item, input.filters, compliance, null));
  const listed = includeClosed ? matching : matching.filter(isOpen);
  const sectionCount = (items: WorkItemSummary[], section: WorkSection) => items.filter((item) => sectionOf(item) === section).length;

  // Status sections in a fixed order (stories inside each), or story groups only.
  const units: Array<{ section: WorkSection | null; draft: ReturnType<typeof groupWorkItems>[number] }> =
    groupBy === "status"
      ? SECTION_ORDER.flatMap((section) => groupWorkItems(listed.filter((item) => sectionOf(item) === section)).map((draft) => ({ section, draft })))
      : groupWorkItems(listed).map((draft) => ({ section: null, draft }));
  const page = paginate(units, input.page);
  // Filter options cover what can be listed: closed tickets too while "Done recently" is open.
  const facets = workItemFacets(includeClosed ? pool : openPool, compliance, null);
  const toRow = (workItem: WorkItemSummary): MyWorkRow => ({ workItem, compliance: compliance.get(workItem.id) ?? null, attention: snapshot.attention.get(workItem.id) ?? null });
  const groups = await resolveGroups(client, page.items.map((unit) => unit.draft), snapshot.known, toRow);
  // Progress counts all my tickets under the story (every section, finished ones included), not only this page's.
  const progressOf = (headingId: number): StoryProgress => {
    const mine = pool.filter((item) => item.links.parentId === headingId && item.stateCategory !== "Removed");
    return {
      done: mine.filter(finished).length,
      total: mine.length,
      remainingHours: Math.round(mine.filter((item) => !finished(item)).reduce((sum, item) => sum + (item.remainingWork ?? 0), 0) * 100) / 100,
    };
  };
  // The sprint header always describes the tickets on my list (never the snoozed/abandoned view), and a removed ticket is not finished work.
  const overviewPool = (mode === "current" ? candidates.filter((item) => inCurrentSprint(item, sprints)) : candidates).filter(
    (item) => !hidden(item) && item.stateCategory !== "Removed"
  );
  const overviewOpen = overviewPool.filter(isOpen);
  const activeSprints = [...new Set(overviewOpen.map((item) => item.projectName))]
    .map((name) => sprints.get(name))
    .filter((sprint): sprint is CurrentSprint => sprint !== null && sprint !== undefined);
  const distinctSprints = [...new Map(activeSprints.map((sprint) => [`${sprint.name}|${sprint.finishDate}`, sprint])).values()];
  const names = [...new Set([...sprints.values()].filter((sprint): sprint is CurrentSprint => sprint !== null).map((sprint) => sprint.name))];

  return {
    ...page,
    items: groups.map((group, index) => ({ ...group, section: page.items[index]!.section, progress: group.heading ? progressOf(group.heading.id) : null })),
    groupBy,
    sections: SECTION_ORDER.map((key) => ({ key, count: sectionCount(matching, key) })),
    overview: {
      sprint: mode === "current" && distinctSprints.length === 1 ? { name: distinctSprints[0]!.name, startDate: distinctSprints[0]!.startDate, finishDate: distinctSprints[0]!.finishDate } : null,
      counts: { inProgress: sectionCount(overviewPool, "inProgress"), todo: sectionCount(overviewPool, "todo"), resolved: sectionCount(overviewPool, "resolved"), done: sectionCount(overviewPool, "done") },
      remainingHours: Math.round(overviewOpen.filter((item) => !finished(item)).reduce((sum, item) => sum + (item.remainingWork ?? 0), 0) * 100) / 100,
    },
    ticketCount: listed.length,
    poolTotal: openPool.length,
    hiddenCount,
    showingHidden,
    sprint: { mode, inSprint: hasSprints ? inSprint.filter(isOpen).length : 0, names },
    closed: { included: includeClosed, count: sectionCount(matching, "done") },
    attention: { only: attentionOnly, count: openPool.filter(needsMe).length },
    facets: { types: facets.types, states: facets.states, priorities: facets.priorities, sop: facets.sop },
  };
}

/** One page of groups of everyone's tickets in a project (10 groups per page). */
export interface TeamWorkPage extends Page<WorkItemGroup<WorkItemSummary>> {
  ticketCount: number;
  poolTotal: number;
  facets: { types: FilterOption[]; states: FilterOption[]; priorities: FilterOption[]; assignees: FilterOption[] };
}

/** Everyone's tickets in one project (Project overview), grouped by story, filtered and paged. */
export async function getTeamWorkPage(
  client: AzureClient,
  input: { projectName: string; scope: "open" | "all"; filters: WorkItemFilters; page: number }
): Promise<TeamWorkPage> {
  const [records, identity] = await Promise.all([
    listAssignedWorkItemRecords(client, { projectName: input.projectName, scope: input.scope, assignee: "any" }),
    getIdentity(client),
  ]);
  const pool = records.map((record) => record.summary);
  const matching = pool.filter((item) => matchesWorkItem(item, input.filters, new Map(), identity.id));
  const facets = workItemFacets(pool, new Map(), identity.id);
  const page = paginate(groupWorkItems(matching), input.page);

  return {
    ...page,
    items: await resolveGroups(client, page.items, new Map(pool.map((item) => [item.id, item])), (item) => item),
    ticketCount: matching.length,
    poolTotal: pool.length,
    facets: { types: facets.types, states: facets.states, priorities: facets.priorities, assignees: facets.assignees },
  };
}
