import { describe, expect, it } from "vitest";

import { buildRecommendations } from "../../src/services/recommendation.service.js";
import type {
  BuildSummary,
  PullRequestSummary,
  WorkItemSummary,
} from "../../src/types/azure.types.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const baseWorkItem: WorkItemSummary = {
  id: 1,
  rev: 1,
  projectName: "Alpha",
  type: "Task",
  title: "Item",
  state: "Active",
  stateCategory: "InProgress",
  reason: null,
  priority: 2,
  assignedTo: null,
  iterationPath: null,
  areaPath: null,
  tags: [],
  originalEstimate: 1,
  remainingWork: 1,
  completedWork: 1,
  storyPoints: null,
  effort: null,
  dueDate: null,
  blocked: false,
  createdDate: null,
  changedDate: daysAgo(0),
  stateChangeDate: null,
  closedDate: null,
  commentCount: 0,
  links: { pullRequests: [], commits: [], branches: [], builds: [], parentId: null, childIds: [] },
  webUrl: "u",
};

const basePr: PullRequestSummary = {
  projectId: "p",
  projectName: "Alpha",
  repositoryId: "r",
  repositoryName: "repo",
  pullRequestId: 7,
  title: "PR",
  status: "active",
  isDraft: false,
  mergeStatus: "succeeded",
  createdBy: { id: "me", displayName: "Me", uniqueName: null },
  creationDate: daysAgo(3),
  closedDate: null,
  sourceBranch: "f",
  targetBranch: "main",
  reviewers: [],
  approvals: 0,
  rejections: 0,
  unresolvedThreads: 0,
  myRole: "author",
  myVote: null,
  webUrl: "u",
};

const failedBuild: BuildSummary = {
  id: 9,
  buildNumber: "9",
  definitionId: 3,
  definitionName: "ci",
  projectName: "Alpha",
  status: "completed",
  result: "failed",
  sourceBranch: "refs/heads/main",
  sourceVersion: null,
  reason: null,
  requestedFor: null,
  queueTime: daysAgo(1),
  startTime: null,
  finishTime: null,
  webUrl: null,
};

describe("buildRecommendations", () => {
  it("ignores items without any signal", () => {
    expect(
      buildRecommendations({ workItems: [baseWorkItem], compliance: [], pullRequests: [basePr], builds: [], now: NOW })
    ).toEqual([]);
  });

  it("prioritizes failed pipelines, blockers and requested changes by score", () => {
    const recommendations = buildRecommendations({
      now: NOW,
      workItems: [
        { ...baseWorkItem, id: 1, blocked: true, priority: 1 },
        { ...baseWorkItem, id: 2, changedDate: daysAgo(10) },
      ],
      compliance: [],
      pullRequests: [
        {
          ...basePr,
          reviewers: [{ id: "o", displayName: "Other", vote: -10, voteLabel: "rejected", isRequired: true, hasDeclined: false }],
        },
        { ...basePr, pullRequestId: 8, myRole: "reviewer", myVote: 0, createdBy: { id: "o", displayName: "O", uniqueName: null } },
      ],
      builds: [failedBuild, { ...failedBuild, id: 10, result: "succeeded" }],
    });

    expect(recommendations.map((item) => [item.id, item.category])).toEqual([
      ["wi:1", "BLOCKER"],
      ["build:9", "FAILED_PIPELINE"],
      ["pr:r:7", "REVIEW"],
      ["pr:r:8", "REVIEW"],
      ["wi:2", "STALE"],
    ]);
    expect(recommendations[1]?.suggestedAction).toMatchObject({
      kind: "PIPELINE_QUEUE_RUN",
      target: { projectId: "Alpha", definitionId: 3 },
      params: { sourceBranch: "refs/heads/main" },
    });
  });

  it("adds SOP violations with the most actionable suggestion", () => {
    const [recommendation] = buildRecommendations({
      now: NOW,
      workItems: [baseWorkItem],
      compliance: [
        {
          workItemId: 1,
          projectName: "Alpha",
          title: "Item",
          type: "Task",
          state: "Active",
          stateCategory: "InProgress",
          configured: true,
          rulebook: { defaultVersion: 0, personalVersion: 0 },
          passedRules: [],
          pendingRules: [],
          skippedRules: [],
          aiRules: [],
          violations: [
            { ruleId: "ALW-01", ruleTitle: "Comment on every state change", checker: "code", severity: "medium", message: "No comment", evidence: [], suggestedAction: { kind: "WORK_ITEM_COMMENT", target: {}, params: {}, requiresInput: true } },
            { ruleId: "DONE-07", ruleTitle: "Time logged at Done", checker: "code", severity: "high", message: "Remaining work", evidence: [], suggestedAction: { kind: "WORK_ITEM_UPDATE_FIELDS", target: {}, params: { remainingWork: 0 }, requiresInput: false } },
          ],
        },
      ],
      pullRequests: [],
      builds: [],
    });

    expect(recommendation).toMatchObject({ category: "SOP", score: 20 + 10 + 20 });
    expect(recommendation?.suggestedAction?.kind).toBe("WORK_ITEM_UPDATE_FIELDS");
    expect(recommendation?.signals).toEqual(["SOP:ALW-01", "SOP:DONE-07"]);
  });

  it("emits stable signal codes that do not change as display text ages", () => {
    const build = (now: Date) =>
      buildRecommendations({
        now,
        workItems: [
          { ...baseWorkItem, id: 1, blocked: true, dueDate: daysAgo(1), changedDate: daysAgo(10) },
          { ...baseWorkItem, id: 2, dueDate: new Date(NOW.getTime() + DAY).toISOString() },
        ],
        compliance: [],
        pullRequests: [
          { ...basePr, mergeStatus: "conflicts", unresolvedThreads: 2 },
          { ...basePr, pullRequestId: 8, myRole: "reviewer", myVote: 0, createdBy: { id: "o", displayName: "O", uniqueName: null } },
        ],
        builds: [failedBuild],
      });

    const signals = (now: Date) => Object.fromEntries(build(now).map((item) => [item.id, item.signals]));
    const today = signals(NOW);

    expect(today).toEqual({
      "wi:1": ["BLOCKED", "OVERDUE", "STALE"],
      "wi:2": ["DUE_SOON"],
      "pr:r:7": ["MERGE_CONFLICTS", "UNRESOLVED_THREADS"],
      "pr:r:8": ["REVIEW_REQUESTED"],
      "build:9": ["FAILED:9"],
    });
    // Reasons such as "Review requested 3 day(s) ago" change daily; signals do not.
    expect(signals(new Date(NOW.getTime() + 2 * DAY))["pr:r:8"]).toEqual(today["pr:r:8"]);
    expect(signals(new Date(NOW.getTime() + 2 * DAY))["wi:1"]).toEqual(today["wi:1"]);
  });
});
