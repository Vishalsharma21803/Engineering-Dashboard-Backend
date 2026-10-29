import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import type { ComplianceResult, ComplianceViolation, Recommendation, WorkItemSummary } from "../../types/azure.types.js";
import { getIdentity } from "../azure/identity.service.js";
import { listAssignedWorkItemRecords } from "../azure/work-items.service.js";
import { checkCompliance } from "../compliance/compliance.service.js";
import { buildRecommendations } from "../recommendation.service.js";
import { applyAiReviews } from "../sop/ai/sop-ai-review.js";
import { isHiddenState, resolveWorkItemTriage, type TriageMarkLike } from "./triage-resolve.js";
import { matchesWorkItem, workItemFacets, type FilterOption, type WorkItemFilters } from "./work-item-filters.js";

/**
 * My work rows (open tickets + their code-rule results) are expensive to
 * compute, so a page request reuses what the dashboard just computed for a
 * short time instead of re-running every SOP check per page click.
 */
const SNAPSHOT_TTL_MS = 60_000;
const MAX_SNAPSHOTS = 500;

export interface MyWorkSnapshot {
  items: WorkItemSummary[];
  compliance: Map<number, ComplianceResult>;
  /** Recommendation signal codes per ticket (they decide when triaged tickets resurface). */
  signals: Map<number, string[]>;
}

const snapshots = new Map<string, { expiresAt: number; snapshot: MyWorkSnapshot }>();
/** When each user's lists for a credential were last forgotten (userId|credentialId|): older reads are not cached. */
const forgottenAt = new Map<string, number>();

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
  input: { workItems: WorkItemSummary[]; compliance: ComplianceResult[]; recommendations: Recommendation[] },
  readStartedAt = Date.now()
): MyWorkSnapshot {
  const open = input.workItems.filter((item) => item.stateCategory !== "Completed" && item.stateCategory !== "Removed");
  const signals = new Map<number, string[]>();

  for (const recommendation of input.recommendations) {
    if (recommendation.target.type === "workItem") {
      signals.set(recommendation.target.id, [...(signals.get(recommendation.target.id) ?? []), ...recommendation.signals]);
    }
  }

  const snapshot: MyWorkSnapshot = { items: open, compliance: new Map(input.compliance.map((result) => [result.workItemId, result])), signals };

  if ((forgottenAt.get(`${userId}|${credentialId}|`) ?? 0) > readStartedAt) {
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

/** After an approved change: My work is rebuilt from Azure on the next read instead of up to a minute later. */
export function forgetMyWorkSnapshots(userId: string, credentialId: string): void {
  const prefix = `${userId}|${credentialId}|`;
  forgottenAt.set(prefix, Date.now());

  for (const key of [...snapshots.keys()]) {
    if (key.startsWith(prefix)) snapshots.delete(key);
  }
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

  return rememberMyWork(userId, client.credentialId, projectName, { workItems, compliance, recommendations }, now.getTime());
}

/** The user's saved AI reviews (clears, AI-only rules) applied to the cached code results. */
async function withAiReviews(userId: string, credentialId: string, snapshot: MyWorkSnapshot): Promise<Map<number, ComplianceResult>> {
  const revs = new Map(snapshot.items.map((item) => [item.id, item.rev]));
  const applied = await applyAiReviews(userId, credentialId, [...snapshot.compliance.values()], revs);
  return new Map(applied.map((result) => [result.workItemId, result]));
}

export interface MyWorkPage extends Page<{ workItem: WorkItemSummary; compliance: ComplianceResult | null }> {
  /** Tickets in view before filters (the hidden ones when showing hidden). */
  poolTotal: number;
  /** Snoozed or abandoned tickets; shown only with `hidden`. */
  hiddenCount: number;
  showingHidden: boolean;
  facets: { types: FilterOption[]; states: FilterOption[]; priorities: FilterOption[]; sop: FilterOption[] };
}

export async function getMyWorkPage(
  client: AzureClient,
  userId: string,
  input: { projectName: string | undefined; filters: WorkItemFilters; page: number; hidden: boolean; refresh: boolean }
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

  const hiddenCount = snapshot.items.filter(hidden).length;
  const showingHidden = input.hidden && hiddenCount > 0;
  const pool = snapshot.items.filter((item) => hidden(item) === showingHidden);
  const matching = pool.filter((item) => matchesWorkItem(item, input.filters, compliance, null));
  const page = paginate(matching, input.page);
  const facets = workItemFacets(pool, compliance, null);

  return {
    ...page,
    items: page.items.map((workItem) => ({ workItem, compliance: compliance.get(workItem.id) ?? null })),
    poolTotal: pool.length,
    hiddenCount,
    showingHidden,
    facets: { types: facets.types, states: facets.states, priorities: facets.priorities, sop: facets.sop },
  };
}

export interface TeamWorkPage extends Page<WorkItemSummary> {
  poolTotal: number;
  facets: { types: FilterOption[]; states: FilterOption[]; priorities: FilterOption[]; assignees: FilterOption[] };
}

/** Everyone's tickets in one project (Project overview), filtered and paged. */
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

  return {
    ...paginate(matching, input.page),
    poolTotal: pool.length,
    facets: { types: facets.types, states: facets.states, priorities: facets.priorities, assignees: facets.assignees },
  };
}
