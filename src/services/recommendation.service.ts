import { workingDaysBetween } from "../lib/working-days.js";
import type {
  BuildSummary,
  ComplianceResult,
  PullRequestSummary,
  Recommendation,
  RecommendationCategory,
  Severity,
  SuggestedAction,
  WorkItemSummary,
} from "../types/azure.types.js";

const PRIORITY_WEIGHT: Record<number, number> = { 1: 30, 2: 20, 3: 10, 4: 5 };
const DEFAULT_PRIORITY_WEIGHT = 10;
const SEVERITY_WEIGHT: Record<Severity, number> = { high: 20, medium: 10, low: 5 };
const STALE_WORKING_DAYS = 3;
const DUE_SOON_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecommendationInput {
  workItems: WorkItemSummary[];
  compliance: ComplianceResult[];
  pullRequests: PullRequestSummary[];
  builds: BuildSummary[];
  now: Date;
}

function workItemRecommendation(
  workItem: WorkItemSummary,
  compliance: ComplianceResult | undefined,
  now: Date
): Recommendation | null {
  let score = PRIORITY_WEIGHT[workItem.priority ?? 0] ?? DEFAULT_PRIORITY_WEIGHT;
  const reasons: string[] = [];
  const signals: string[] = [];
  let category: RecommendationCategory | null = null;
  let signal = false;

  if (workItem.priority !== null) {
    reasons.push(`Priority ${workItem.priority}`);
  }

  const open = workItem.stateCategory !== "Completed" && workItem.stateCategory !== "Removed";

  if (open && workItem.blocked) {
    score += 40;
    reasons.push("Marked as blocked");
    signals.push("BLOCKED");
    category = "BLOCKER";
    signal = true;
  }

  if (open && workItem.dueDate) {
    // Azure stores a due date as the midnight that starts the due day: the whole day is still in time.
    const msUntilDue = new Date(workItem.dueDate).getTime() - now.getTime();

    if (msUntilDue <= -DAY_MS) {
      score += 30;
      reasons.push("Overdue");
      signals.push("OVERDUE");
      signal = true;
    } else if (msUntilDue <= 0) {
      score += 20;
      reasons.push("Due today");
      signals.push("DUE_SOON");
      signal = true;
    } else if (msUntilDue <= DUE_SOON_DAYS * DAY_MS) {
      score += 20;
      reasons.push("Due within 2 days");
      signals.push("DUE_SOON");
      signal = true;
    }
  }

  const violations = compliance?.violations ?? [];

  for (const violation of violations) {
    score += SEVERITY_WEIGHT[violation.severity];
    reasons.push(violation.message);
    signals.push(`SOP:${violation.ruleId}`);
    category ??= "SOP";
    signal = true;
  }

  if (workItem.stateCategory === "InProgress" && workItem.changedDate) {
    const idleDays = workingDaysBetween(new Date(workItem.changedDate), now);

    if (idleDays > STALE_WORKING_DAYS) {
      score += 10;
      reasons.push(`No updates in ${idleDays} working days`);
      signals.push("STALE");
      category ??= "STALE";
      signal = true;
    }
  }

  if (!signal) {
    return null;
  }

  const suggestions = violations
    .map((violation) => violation.suggestedAction)
    .filter((action): action is SuggestedAction => action !== null);
  const suggestedAction =
    suggestions.find((action) => !action.requiresInput) ?? suggestions[0] ?? null;

  return {
    id: `wi:${workItem.id}`,
    score,
    category: category ?? "SOP",
    title: `#${workItem.id} ${workItem.title}`,
    reasons,
    signals,
    target: {
      type: "workItem",
      projectName: workItem.projectName,
      id: workItem.id,
      webUrl: workItem.webUrl,
    },
    suggestedAction,
  };
}

function pullRequestRecommendation(pr: PullRequestSummary, now: Date): Recommendation | null {
  if (pr.status !== "active") {
    return null;
  }

  let score = 10;
  const reasons: string[] = [];
  const signals: string[] = [];

  if (pr.myRole === "author") {
    const changesRequested = pr.reviewers.filter((reviewer) => reviewer.vote <= -5);

    if (changesRequested.length > 0) {
      score += 35;
      reasons.push(
        `Changes requested by ${changesRequested.map((reviewer) => reviewer.displayName).join(", ")}`
      );
      signals.push("CHANGES_REQUESTED");
    }

    if (pr.mergeStatus === "conflicts") {
      score += 30;
      reasons.push("Merge conflicts");
      signals.push("MERGE_CONFLICTS");
    }

    if (pr.unresolvedThreads !== null && pr.unresolvedThreads > 0) {
      score += Math.min(25, pr.unresolvedThreads * 5);
      reasons.push(`${pr.unresolvedThreads} unresolved comment thread(s)`);
      signals.push("UNRESOLVED_THREADS");
    }

    const requiredApproved = pr.reviewers
      .filter((reviewer) => reviewer.isRequired)
      .every((reviewer) => reviewer.vote >= 5);

    if (
      reasons.length === 0 &&
      !pr.isDraft &&
      pr.approvals > 0 &&
      requiredApproved &&
      pr.unresolvedThreads === 0
    ) {
      score += 15;
      reasons.push("Approved and ready to complete");
      signals.push("READY_TO_COMPLETE");
    }
  } else if (pr.myRole === "reviewer" && pr.myVote === 0 && !pr.isDraft) {
    const ageDays = Math.floor((now.getTime() - new Date(pr.creationDate).getTime()) / DAY_MS);
    score += 25 + Math.min(20, Math.max(0, ageDays) * 2);
    reasons.push(ageDays > 0 ? `Review requested ${ageDays} day(s) ago` : "Review requested");
    signals.push("REVIEW_REQUESTED");
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    id: `pr:${pr.repositoryId}:${pr.pullRequestId}`,
    score,
    category: "REVIEW",
    title: `PR ${pr.pullRequestId} ${pr.title}`,
    reasons,
    signals,
    target: {
      type: "pullRequest",
      projectName: pr.projectName,
      id: pr.pullRequestId,
      repositoryId: pr.repositoryId,
      webUrl: pr.webUrl,
    },
    suggestedAction: null,
  };
}

function buildRecommendation(build: BuildSummary): Recommendation | null {
  if (build.status !== "completed" || build.result !== "failed" || !build.projectName) {
    return null;
  }

  const branch = build.sourceBranch?.replace(/^refs\/heads\//, "") ?? "unknown branch";

  return {
    id: `build:${build.id}`,
    score: 50,
    category: "FAILED_PIPELINE",
    title: `${build.definitionName} #${build.buildNumber} failed`,
    reasons: [`Latest run on ${branch} failed`],
    // Per run: a snoozed pipeline resurfaces when a newer run fails.
    signals: [`FAILED:${build.id}`],
    target: {
      type: "build",
      projectName: build.projectName,
      id: build.id,
      webUrl: build.webUrl,
    },
    suggestedAction: {
      kind: "PIPELINE_QUEUE_RUN",
      target: { projectId: build.projectName, definitionId: build.definitionId },
      params: build.sourceBranch ? { sourceBranch: build.sourceBranch } : {},
      requiresInput: false,
    },
  };
}

export function buildRecommendations(input: RecommendationInput): Recommendation[] {
  const complianceById = new Map(input.compliance.map((result) => [result.workItemId, result]));

  const recommendations = [
    ...input.workItems.map((workItem) =>
      workItemRecommendation(workItem, complianceById.get(workItem.id), input.now)
    ),
    ...input.pullRequests.map((pr) => pullRequestRecommendation(pr, input.now)),
    ...input.builds.map(buildRecommendation),
  ].filter((recommendation): recommendation is Recommendation => recommendation !== null);

  return recommendations.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
