import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import type { ComplianceResult, ComplianceViolation, Recommendation, WorkItemSummary } from "../../types/azure.types.js";
import { getIdentity } from "../azure/identity.service.js";
import { listAssignedWorkItemRecords } from "../azure/work-items.service.js";
import { checkCompliance } from "../compliance/compliance.service.js";
import { buildRecommendations } from "../recommendation.service.js";
import type { AiRuleResult } from "../sop/ai/sop-ai-verifier.js";
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

function snapshotKey(userId: string, credentialId: string, projectName: string | undefined): string {
  return `${userId}|${credentialId}|${projectName ?? "*"}`;
}

/** Called by the dashboard with what it computed. */
export function rememberMyWork(
  userId: string,
  credentialId: string,
  projectName: string | undefined,
  input: { workItems: WorkItemSummary[]; compliance: ComplianceResult[]; recommendations: Recommendation[] }
): void {
  const open = input.workItems.filter((item) => item.stateCategory !== "Completed" && item.stateCategory !== "Removed");
  const signals = new Map<number, string[]>();

  for (const recommendation of input.recommendations) {
    if (recommendation.target.type === "workItem") {
      signals.set(recommendation.target.id, [...(signals.get(recommendation.target.id) ?? []), ...recommendation.signals]);
    }
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
  snapshots.set(key, {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    snapshot: { items: open, compliance: new Map(input.compliance.map((result) => [result.workItemId, result])), signals },
  });
}

/** Exposed for tests. */
export function clearMyWorkSnapshots(): void {
  snapshots.clear();
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
  // Ticket signals depend only on the ticket and its SOP results.
  const recommendations = buildRecommendations({ workItems, compliance, pullRequests: [], builds: [], now });

  rememberMyWork(userId, client.credentialId, projectName, { workItems, compliance, recommendations });
  return snapshots.get(key)?.snapshot ?? { items: [], compliance: new Map(), signals: new Map() };
}

/** The user's own AI "fail" verdicts become violations (notice rules: notices), like on the dashboard. */
async function withAiViolations(userId: string, credentialId: string, compliance: Map<number, ComplianceResult>, ids: number[]) {
  const checks = await prisma.sopAiCheck.findMany({
    where: { userId, credentialId, workItemId: { in: ids } },
    select: { workItemId: true, results: true },
  });
  const merged = new Map(compliance);

  for (const check of checks) {
    const base = merged.get(check.workItemId);
    const results = Array.isArray(check.results) ? (check.results as unknown as AiRuleResult[]) : [];
    const found: ComplianceViolation[] = results
      .filter((result) => result.verdict === "fail")
      .map((result) => ({
        ruleId: result.ruleId,
        ruleTitle: result.ruleTitle,
        checker: "ai",
        severity: result.severity,
        message: result.reason,
        evidence: result.quotes,
        suggestedAction: null,
      }));

    if (base && found.length > 0) {
      merged.set(check.workItemId, {
        ...base,
        violations: [...base.violations, ...found.filter((finding) => finding.severity !== "low")],
        notices: [...base.notices, ...found.filter((finding) => finding.severity === "low")],
      });
    }
  }

  return merged;
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
    withAiViolations(userId, client.credentialId, snapshot.compliance, snapshot.items.map((item) => item.id)),
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
