import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawList,
  RawPolicyEvaluation,
  RawPullRequest,
  RawReviewer,
  RawThread,
} from "../../lib/azure/azure-api.types.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type {
  AzureIdentity,
  PolicyEvaluation,
  PullRequestDetail,
  PullRequestReviewer,
  PullRequestSummary,
  PullRequestThread,
} from "../../types/azure.types.js";
import { requireIdentityRef, stripRefPrefix } from "./mappers.js";
import { toSection } from "./section.js";

const MAX_PULL_REQUESTS = 50;
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

async function getThreads(
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

async function searchPullRequests(
  client: AzureClient,
  projectId: string,
  criteria: Record<string, string>
): Promise<RawPullRequest[]> {
  const data = await client.get<RawList<RawPullRequest>>(
    [projectId, "_apis", "git", "pullrequests"],
    {
      query: {
        "searchCriteria.status": "active",
        ...criteria,
        $top: MAX_PULL_REQUESTS,
      },
    }
  );

  return data.value ?? [];
}

export async function listMyPullRequests(
  client: AzureClient,
  identity: AzureIdentity,
  projectIds: string[],
  role: PullRequestRole = "all"
): Promise<PullRequestSummary[]> {
  const projectLimit = createLimiter(4);
  const threadLimit = createLimiter(4);

  const perProject = await mapWithLimit(projectIds, projectLimit, async (projectId) => {
    if (role === "everyone") {
      return searchPullRequests(client, projectId, {});
    }

    const [authored, reviewing] = await Promise.all([
      role === "reviewer"
        ? Promise.resolve([])
        : searchPullRequests(client, projectId, {
            "searchCriteria.creatorId": identity.id,
          }),
      role === "author"
        ? Promise.resolve([])
        : searchPullRequests(client, projectId, {
            "searchCriteria.reviewerId": identity.id,
          }),
    ]);

    return [...authored, ...reviewing];
  });

  const unique = new Map<string, RawPullRequest>();

  for (const pr of perProject.flat()) {
    unique.set(`${pr.repository.id}:${pr.pullRequestId}`, pr);
  }

  const pullRequests = [...unique.values()]
    .sort((a, b) => b.creationDate.localeCompare(a.creationDate))
    .slice(0, MAX_PULL_REQUESTS);

  return mapWithLimit(pullRequests, threadLimit, async (pr) => {
    let unresolved: number | null = null;

    try {
      unresolved = countUnresolvedThreads(
        await getThreads(client, pr.repository.project.id, pr.repository.id, pr.pullRequestId)
      );
    } catch {
      unresolved = null;
    }

    return toPullRequestSummary(pr, identity, unresolved);
  });
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

export async function getPullRequestDetail(
  client: AzureClient,
  identity: AzureIdentity,
  projectId: string,
  repositoryId: string,
  pullRequestId: number
): Promise<PullRequestDetail> {
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

  return {
    ...toPullRequestSummary(raw, identity, unresolved),
    description: raw.description ?? "",
    threads,
    policies,
    linkedWorkItemIds,
  };
}
