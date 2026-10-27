import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import type { BuildSummary, PullRequestSummary, Recommendation, RecommendationCategory } from "../../types/azure.types.js";
import { matchesPullRequest, pullRequestFacets, type PullRequestFilters } from "./pull-request-filters.js";
import {
  buildSignalIndex,
  isHiddenState,
  pipelineKey,
  pullRequestKey,
  recommendationKey,
  resolveTriage,
  type TriageMarkLike,
  type TriageState,
} from "./triage-resolve.js";
import type { FilterOption } from "./work-item-filters.js";

/**
 * The dashboard's lists (prioritized actions, pull requests, pipeline runs)
 * are paged on the server from what the dashboard just computed, so a page
 * click never re-reads every project from Azure.
 */
const SNAPSHOT_TTL_MS = 60_000;
const MAX_SNAPSHOTS = 500;

export interface DashboardLists {
  recommendations: Recommendation[];
  /** Null when the dashboard could not read this section (the list then reports an error, not "none"). */
  pullRequests: PullRequestSummary[] | null;
  builds: BuildSummary[] | null;
}

const snapshots = new Map<string, { expiresAt: number; lists: DashboardLists }>();
/** Rebuilds in progress, so several list requests share one instead of each re-reading Azure. */
const rebuilding = new Map<string, Promise<DashboardLists>>();

const keyOf = (userId: string, credentialId: string, projectName: string | undefined) => `${userId}|${credentialId}|${projectName ?? "*"}`;

/** Called by the dashboard with what it computed. */
export function rememberDashboardLists(userId: string, credentialId: string, projectName: string | undefined, lists: DashboardLists): void {
  if (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;

    if (oldest !== undefined) {
      snapshots.delete(oldest);
    }
  }

  const key = keyOf(userId, credentialId, projectName);
  snapshots.delete(key);
  snapshots.set(key, { expiresAt: Date.now() + SNAPSHOT_TTL_MS, lists });
}

/** Exposed for tests. */
export function clearDashboardLists(): void {
  snapshots.clear();
  rebuilding.clear();
}

async function loadLists(client: AzureClient, userId: string, project: { id: string; name: string } | undefined): Promise<DashboardLists> {
  const key = keyOf(userId, client.credentialId, project?.name);
  const cached = snapshots.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.lists;
  }

  const pending = rebuilding.get(key);

  if (pending) {
    return pending;
  }

  const rebuild = (async () => {
    // Imported lazily: the dashboard imports this module to remember its lists.
    const { getDashboard } = await import("../dashboard.service.js");
    const dashboard = await getDashboard(client, userId, project?.id);

    return (
      snapshots.get(key)?.lists ?? {
        recommendations: dashboard.recommendations,
        pullRequests: dashboard.sections.pullRequests.data,
        builds: dashboard.sections.pipelines.data,
      }
    );
  })();
  rebuilding.set(key, rebuild);

  try {
    return await rebuild;
  } finally {
    rebuilding.delete(key);
  }
}

function sectionOrError<T>(items: T[] | null, label: string): T[] {
  if (items === null) {
    throw new AppError(503, "SECTION_UNAVAILABLE", `Your ${label} could not be read from Azure DevOps right now.`);
  }

  return items;
}

async function triageOf(userId: string, credentialId: string, lists: DashboardLists) {
  const marks = await prisma.triageMark.findMany({
    where: { userId, credentialId },
    select: { itemKey: true, status: true, snoozedUntil: true, signals: true },
  });
  const marksByKey = new Map<string, TriageMarkLike>(marks.map((mark) => [mark.itemKey, mark]));
  const signals = buildSignalIndex(lists.recommendations, lists.builds ?? []);
  const now = Date.now();

  return (itemKey: string | null, projectName: string | null): TriageState =>
    resolveTriage(marksByKey, itemKey, projectName, itemKey ? (signals.get(itemKey) ?? []) : [], now);
}

interface HiddenAware {
  /** Items in view before filters (the hidden ones when showing hidden). */
  poolTotal: number;
  /** Snoozed or abandoned items; listed only with `hidden`. */
  hiddenCount: number;
  showingHidden: boolean;
}

function split<T>(items: T[], hidden: (item: T) => boolean, wantHidden: boolean) {
  const hiddenCount = items.filter(hidden).length;
  const showingHidden = wantHidden && hiddenCount > 0;
  return { pool: items.filter((item) => hidden(item) === showingHidden), hiddenCount, showingHidden };
}

/* ------------------------------------------------------------ recommendations */

export interface RecommendationPage extends Page<{ recommendation: Recommendation; state: TriageState; rank: number | null }>, HiddenAware {
  activeTotal: number;
  acknowledgedTotal: number;
  facets: { categories: FilterOption[] };
}

const CATEGORY_ORDER: RecommendationCategory[] = ["BLOCKER", "FAILED_PIPELINE", "REVIEW", "SOP", "TIME", "STALE"];

/** Highest priority first; acknowledged items after the active ones, unnumbered. */
export async function getRecommendationPage(
  client: AzureClient,
  userId: string,
  input: { project: { id: string; name: string } | undefined; category: string; hidden: boolean; page: number }
): Promise<RecommendationPage> {
  const lists = await loadLists(client, userId, input.project);
  const resolve = await triageOf(userId, client.credentialId, lists);
  const buildsById = new Map((lists.builds ?? []).map((build) => [build.id, build]));
  const entries = lists.recommendations.map((recommendation) => ({
    recommendation,
    state: resolve(recommendationKey(recommendation, buildsById), recommendation.target.projectName),
  }));
  const { pool, hiddenCount, showingHidden } = split(entries, (entry) => isHiddenState(entry.state), input.hidden);
  const categories = CATEGORY_ORDER.map((value) => ({ value, label: value, count: pool.filter((entry) => entry.recommendation.category === value).length })).filter(
    (option) => option.count > 0
  );
  const matching = input.category ? pool.filter((entry) => entry.recommendation.category === input.category) : pool;
  const active = matching.filter((entry) => entry.state === "active");
  const acknowledged = matching.filter((entry) => entry.state === "acknowledged");
  const ordered = showingHidden
    ? matching.map((entry) => ({ ...entry, rank: null }))
    : [...active.map((entry, index) => ({ ...entry, rank: index + 1 })), ...acknowledged.map((entry) => ({ ...entry, rank: null }))];

  return {
    ...paginate(ordered, input.page),
    poolTotal: pool.length,
    hiddenCount,
    showingHidden,
    activeTotal: showingHidden ? 0 : active.length,
    acknowledgedTotal: showingHidden ? 0 : acknowledged.length,
    facets: { categories },
  };
}

/* -------------------------------------------------------------- pull requests */

export interface PullRequestPage extends Page<PullRequestSummary> {
  poolTotal: number;
  facets: ReturnType<typeof pullRequestFacets>;
}

/** Any list of pull requests, filtered and paged (Project overview uses it without triage). */
export function pagePullRequests(pool: PullRequestSummary[], filters: PullRequestFilters, team: boolean, page: number): PullRequestPage {
  return {
    ...paginate(
      pool.filter((pr) => matchesPullRequest(pr, filters, team)),
      page
    ),
    poolTotal: pool.length,
    facets: pullRequestFacets(pool, team),
  };
}

export async function getDashboardPullRequestPage(
  client: AzureClient,
  userId: string,
  input: { project: { id: string; name: string } | undefined; filters: PullRequestFilters; hidden: boolean; page: number }
): Promise<PullRequestPage & HiddenAware> {
  const lists = await loadLists(client, userId, input.project);
  const resolve = await triageOf(userId, client.credentialId, lists);
  const all = sectionOrError(lists.pullRequests, "pull requests");
  const { pool, hiddenCount, showingHidden } = split(
    all,
    (pr) => isHiddenState(resolve(pullRequestKey(pr.repositoryId, pr.pullRequestId), pr.projectName)),
    input.hidden
  );

  // Filter options count every pull request, hidden ones included (as before paging moved here).
  return { ...pagePullRequests(pool, input.filters, false, input.page), facets: pullRequestFacets(all, false), hiddenCount, showingHidden };
}

/* -------------------------------------------------------------- pipeline runs */

/** Same wording as the badge on each run. */
export function buildLabel(build: Pick<BuildSummary, "status" | "result">): string {
  if (build.status !== "completed") {
    return build.status === "notStarted" ? "Queued" : build.status === "inProgress" ? "Running" : build.status;
  }

  return build.result ?? "completed";
}

export interface PipelineRunPage extends Page<BuildSummary>, HiddenAware {
  facets: { results: FilterOption[] };
}

export async function getDashboardPipelineRunPage(
  client: AzureClient,
  userId: string,
  input: { project: { id: string; name: string } | undefined; result: string; hidden: boolean; page: number }
): Promise<PipelineRunPage> {
  const lists = await loadLists(client, userId, input.project);
  const resolve = await triageOf(userId, client.credentialId, lists);
  const { pool, hiddenCount, showingHidden } = split(sectionOrError(lists.builds, "pipeline runs"), (build) => isHiddenState(resolve(pipelineKey(build), build.projectName)), input.hidden);
  const results = [...new Set(pool.map(buildLabel))].map((value) => ({ value, label: value, count: pool.filter((build) => buildLabel(build) === value).length }));
  const matching = input.result ? pool.filter((build) => buildLabel(build) === input.result) : pool;

  return { ...paginate(matching, input.page), poolTotal: pool.length, hiddenCount, showingHidden, facets: { results } };
}
