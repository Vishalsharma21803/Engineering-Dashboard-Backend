import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawList,
  RawPolicyEvaluation,
  RawPullRequest,
  RawReviewer,
  RawThread,
} from "../../lib/azure/azure-api.types.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type {
  AzureIdentity,
  PolicyEvaluation,
  PullRequestDetail,
  PullRequestReviewer,
  PullRequestSummary,
  PullRequestThread,
  ReadCompleteness,
} from "../../types/azure.types.js";
import { asString, requireIdentityRef, stripRefPrefix } from "./mappers.js";
import { toSection } from "./section.js";
import { logFallback } from "../../lib/log-fallback.js";
import { WORK_ITEM_FIELDS, getWorkItemsByIds, workItemType } from "./work-items.service.js";

/** Pull requests listed at most (each costs a threads read). */
const MAX_PULL_REQUESTS = 100;
/** Each search reads pages of this size, up to MAX_PER_SEARCH pull requests. */
const SEARCH_PAGE_SIZE = 100;
const MAX_PER_SEARCH = 300;
const POLICY_API_VERSION = "7.1-preview.1";
const UNRESOLVED_THREAD_STATUSES = new Set(["active", "pending"]);

/** "all" = mine (authored or reviewing); "everyone" = every active PR in the projects. */
export type PullRequestRole = "author" | "reviewer" | "all" | "everyone";

function voteLabel(vote: number): PullRequestReviewer["voteLabel"] {
  if (vote >= 10) return "approved";
  if (vote >= 5) return "approvedWithSuggestions";
  if (vote <= -10) return "rejected";
  if (vote <= -5) return "waitingForAuthor";
  return "noVote";
}

function toReviewer(raw: RawReviewer): PullRequestReviewer {
  const vote = raw.vote ?? 0;

  return {
    id: raw.id ?? "",
    displayName: raw.displayName ?? raw.uniqueName ?? "Unknown",
    vote,
    voteLabel: voteLabel(vote),
    isRequired: raw.isRequired ?? false,
    hasDeclined: raw.hasDeclined ?? false,
  };
}

function isUserThread(thread: RawThread): boolean {
  // System threads (votes, pushes) have no status.
  return (
    !thread.isDeleted &&
    thread.status !== undefined &&
    thread.status !== "unknown" &&
    (thread.comments ?? []).some((comment) => comment.commentType !== "system")
  );
}

export function countUnresolvedThreads(threads: RawThread[]): number {
  return threads.filter(
    (thread) =>
      isUserThread(thread) && UNRESOLVED_THREAD_STATUSES.has(thread.status ?? "")
  ).length;
}

export function toPullRequestSummary(
  raw: RawPullRequest,
  identity: AzureIdentity,
  unresolvedThreads: number | null
): PullRequestSummary {
  const reviewers = (raw.reviewers ?? []).map(toReviewer);
  const me = reviewers.find((reviewer) => reviewer.id === identity.id);
  const isAuthor = raw.createdBy?.id === identity.id;

  return {
    projectId: raw.repository.project.id,
    projectName: raw.repository.project.name,
    repositoryId: raw.repository.id,
    repositoryName: raw.repository.name,
    pullRequestId: raw.pullRequestId,
    title: raw.title,
    status: raw.status,
    isDraft: raw.isDraft ?? false,
    mergeStatus: raw.mergeStatus ?? null,
    createdBy: requireIdentityRef(raw.createdBy),
    creationDate: raw.creationDate,
    closedDate: raw.closedDate ?? null,
    sourceBranch: stripRefPrefix(raw.sourceRefName) ?? raw.sourceRefName,
    targetBranch: stripRefPrefix(raw.targetRefName) ?? raw.targetRefName,
    reviewers,
    approvals: reviewers.filter((reviewer) => reviewer.vote >= 5).length,
    rejections: reviewers.filter((reviewer) => reviewer.vote <= -5).length,
    unresolvedThreads,
    myRole: isAuthor ? "author" : me ? "reviewer" : "other",
    myVote: me ? me.vote : null,
    webUrl: `${raw.repository.webUrl ?? ""}/pullrequest/${raw.pullRequestId}`,
  };
}

export async function getThreads(
  client: AzureClient,
  projectId: string,
  repositoryId: string,
  pullRequestId: number
): Promise<RawThread[]> {
  const data = await client.get<RawList<RawThread>>([
    projectId,
    "_apis",
    "git",
    "repositories",
    repositoryId,
    "pullRequests",
    String(pullRequestId),
    "threads",
  ]);

  return data.value ?? [];
}

/** Active pull requests matching the criteria, page by page up to MAX_PER_SEARCH; `truncated` when more may exist. */
async function searchPullRequests(
  client: AzureClient,
  projectId: string,
  criteria: Record<string, string>
): Promise<{ pullRequests: RawPullRequest[]; truncated: boolean }> {
  const pullRequests: RawPullRequest[] = [];

  const readPage = async (top: number, skip: number) =>
    (
      await client.get<RawList<RawPullRequest>>(
        [projectId, "_apis", "git", "pullrequests"],
        {
          query: {
            "searchCriteria.status": "active",
            ...criteria,
            $top: top,
            $skip: skip,
          },
        }
      )
    ).value ?? [];

  for (let skip = 0; skip < MAX_PER_SEARCH; skip += SEARCH_PAGE_SIZE) {
    const page = await readPage(SEARCH_PAGE_SIZE, skip);
    pullRequests.push(...page);

    if (page.length < SEARCH_PAGE_SIZE) {
      return { pullRequests, truncated: false };
    }
  }

  // Every page was full: one more pull request tells a cut from exactly MAX_PER_SEARCH.
  try {
    return { pullRequests, truncated: (await readPage(1, MAX_PER_SEARCH)).length > 0 };
  } catch (error) {
    if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
      throw error;
    }

    // The pages already read stand; whether more exist is unknown, so the list says it may be cut.
    logFallback(`Checking for more than ${MAX_PER_SEARCH} pull requests in ${projectId} failed; the list is shown as cut`, error);
    return { pullRequests, truncated: true };
  }
}

/** A list read across projects, as the user is told about it: the cap hit, and the projects that could not be read. */
export function readCompleteness(what: string, read: { truncated: boolean; cap: number; failedProjects: string[] }, cutText: string): ReadCompleteness {
  const failedProjects = [...read.failedProjects].sort();
  const notes = [
    ...(failedProjects.length > 0 ? [`${what} from ${failedProjects.join(", ")} could not be read from Azure DevOps.`] : []),
    ...(read.truncated ? [cutText] : []),
  ];

  return { truncated: read.truncated, cap: read.cap, failedProjects, note: notes.length > 0 ? notes.join(" ") : null };
}

/**
 * My pull requests (or, for "everyone", every active one) across the projects, newest first, at most
 * MAX_PULL_REQUESTS. A project that cannot be read is reported in `completeness` while the others are
 * listed; only when none can be read does the whole list fail.
 */
export async function listMyPullRequests(
  client: AzureClient,
  identity: AzureIdentity,
  projects: Array<{ id: string; name: string }>,
  role: PullRequestRole = "all"
): Promise<{ pullRequests: PullRequestSummary[]; completeness: ReadCompleteness }> {
  const projectLimit = createLimiter(4);
  const threadLimit = createLimiter(4);
  const failures: Array<{ name: string; error: unknown }> = [];
  let searchCut = false;

  const perProject = await mapWithLimit(projects, projectLimit, async (project) => {
    try {
      const searches = await Promise.all(
        role === "everyone"
          ? [searchPullRequests(client, project.id, {})]
          : [
              ...(role === "reviewer" ? [] : [searchPullRequests(client, project.id, { "searchCriteria.creatorId": identity.id })]),
              ...(role === "author" ? [] : [searchPullRequests(client, project.id, { "searchCriteria.reviewerId": identity.id })]),
            ]
      );
      searchCut ||= searches.some((search) => search.truncated);
      return searches.flatMap((search) => search.pullRequests);
    } catch (error) {
      if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
        throw error;
      }

      logFallback(`Reading the pull requests of ${project.name} failed`, error);
      failures.push({ name: project.name, error });
      return [];
    }
  });

  if (failures.length > 0 && failures.length === projects.length) {
    throw failures[0]!.error;
  }

  const unique = new Map<string, RawPullRequest>();

  for (const pr of perProject.flat()) {
    unique.set(`${pr.repository.id}:${pr.pullRequestId}`, pr);
  }

  const sorted = [...unique.values()].sort((a, b) => b.creationDate.localeCompare(a.creationDate));
  const pullRequests = sorted.slice(0, MAX_PULL_REQUESTS);
  const completeness = readCompleteness(
    "Pull requests",
    { truncated: searchCut || sorted.length > MAX_PULL_REQUESTS, cap: MAX_PULL_REQUESTS, failedProjects: failures.map((failure) => failure.name) },
    `Showing the ${MAX_PULL_REQUESTS} newest pull requests; older ones are not listed.`
  );

  const summaries = await mapWithLimit(pullRequests, threadLimit, async (pr) => {
    let unresolved: number | null = null;

    try {
      unresolved = countUnresolvedThreads(
        await getThreads(client, pr.repository.project.id, pr.repository.id, pr.pullRequestId)
      );
    } catch (error) {
      logFallback(`Counting unresolved threads on PR ${pr.pullRequestId} failed`, error);
      unresolved = null;
    }

    return toPullRequestSummary(pr, identity, unresolved);
  });

  return { pullRequests: summaries, completeness };
}

function toThread(raw: RawThread): PullRequestThread {
  return {
    id: raw.id,
    status: raw.status ?? "unknown",
    filePath: raw.threadContext?.filePath ?? null,
    isResolved: !UNRESOLVED_THREAD_STATUSES.has(raw.status ?? ""),
    comments: (raw.comments ?? [])
      .filter((comment) => !comment.isDeleted && comment.commentType !== "system")
      .map((comment) => ({
        id: comment.id,
        author: requireIdentityRef(comment.author),
        // PR comments are Markdown, not HTML; React renders them as text.
        content: comment.content ?? "",
        publishedDate: comment.publishedDate ?? null,
      })),
  };
}

export async function getPullRequest(
  client: AzureClient,
  projectId: string,
  repositoryId: string,
  pullRequestId: number
): Promise<RawPullRequest> {
  return client.get<RawPullRequest>([
    projectId,
    "_apis",
    "git",
    "repositories",
    repositoryId,
    "pullrequests",
    String(pullRequestId),
  ]);
}

/** One pull request as it is now (its status, votes and threads are read fresh; metadata stays cached). */
export async function getPullRequestDetail(
  cachedClient: AzureClient,
  identity: AzureIdentity,
  projectId: string,
  repositoryId: string,
  pullRequestId: number
): Promise<PullRequestDetail> {
  const client = cachedClient.withFreshData();
  const raw = await getPullRequest(client, projectId, repositoryId, pullRequestId);
  const projectGuid = raw.repository.project.id;

  const [threads, policies, linkedWorkItemIds] = await Promise.all([
    toSection(async () => {
      const rawThreads = await getThreads(client, projectGuid, repositoryId, pullRequestId);
      return rawThreads.filter(isUserThread).map(toThread);
    }),
    toSection(async () => {
      const data = await client.get<RawList<RawPolicyEvaluation>>(
        [projectGuid, "_apis", "policy", "evaluations"],
        {
          apiVersion: POLICY_API_VERSION,
          query: {
            artifactId: `vstfs:///CodeReview/CodeReviewId/${projectGuid}/${pullRequestId}`,
          },
        }
      );

      return (data.value ?? [])
        .filter((evaluation) => evaluation.configuration?.isEnabled !== false)
        .map(
          (evaluation): PolicyEvaluation => ({
            name: evaluation.configuration?.type?.displayName ?? "Policy",
            status: evaluation.status ?? "unknown",
            isBlocking: evaluation.configuration?.isBlocking ?? false,
          })
        );
    }),
    toSection(async () => {
      const data = await client.get<RawList<{ id: string | number }>>([
        projectGuid,
        "_apis",
        "git",
        "repositories",
        repositoryId,
        "pullRequests",
        String(pullRequestId),
        "workitems",
      ]);

      return (data.value ?? []).map((item) => Number(item.id));
    }),
  ]);

  const unresolved =
    threads.status === "ok" && threads.data
      ? threads.data.filter((thread) => !thread.isResolved).length
      : null;
  const linkedIds = linkedWorkItemIds.data;
  const linkedWorkItems = linkedIds === null ? undefined : linkedIds.length === 0 ? [] : await readLinkedWorkItems(client, linkedIds);

  return {
    ...toPullRequestSummary(raw, identity, unresolved),
    description: raw.description ?? "",
    threads,
    policies,
    linkedWorkItemIds,
    ...(linkedWorkItems ? { linkedWorkItems } : {}),
  };
}

/** The linked tickets' titles; undefined when they could not be read (the page then shows their numbers). Tickets Azure leaves out are missing. */
async function readLinkedWorkItems(client: AzureClient, ids: number[]): Promise<PullRequestDetail["linkedWorkItems"]> {
  try {
    return (await getWorkItemsByIds(client, ids)).map((item) => ({
      id: item.id,
      title: asString(item.fields[WORK_ITEM_FIELDS.title]) ?? "(untitled)",
      state: asString(item.fields[WORK_ITEM_FIELDS.state]) ?? "",
      type: workItemType(item),
    }));
  } catch (error) {
    if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
      throw error;
    }

    logFallback("Reading the titles of a pull request's linked work items failed", error);
    return undefined;
  }
}
