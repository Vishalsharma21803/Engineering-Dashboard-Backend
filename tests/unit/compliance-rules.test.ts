import { describe, expect, it } from "vitest";

import { complianceConfig } from "../../src/services/compliance/compliance.config.js";
import { evaluateCompliance, requiredData, type RuleContext } from "../../src/services/compliance/rules.js";
import type {
  ComplianceRuleId,
  SupportedWorkFields,
  WorkItemSummary,
} from "../../src/types/azure.types.js";

const NOW = new Date("2026-10-23T12:00:00Z"); // Friday
const ME = { id: "me", displayName: "Me", email: null };
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const TASK_FIELDS: SupportedWorkFields = {
  originalEstimate: true,
  remainingWork: true,
  completedWork: true,
  storyPoints: false,
  effort: false,
  priority: true,
};

function workItem(overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
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
    originalEstimate: 8,
    remainingWork: 4,
    completedWork: 4,
    storyPoints: null,
    effort: null,
    dueDate: null,
    blocked: false,
    createdDate: daysAgo(20),
    changedDate: daysAgo(1),
    stateChangeDate: daysAgo(10),
    closedDate: null,
    commentCount: 1,
    links: { pullRequests: [], commits: [], branches: [], builds: [], parentId: null, childIds: [] },
    webUrl: "https://example.test",
    ...overrides,
  };
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    workItem: workItem(),
    me: ME,
    now: NOW,
    config: complianceConfig,
    comments: [
      {
        id: 1,
        text: "Approach: do it",
        createdBy: { id: "me", displayName: "Me", uniqueName: null },
        createdDate: daysAgo(1),
        modifiedDate: null,
      },
    ],
    history: [
      { revisedDate: daysAgo(1), revisedBy: null, field: "RemainingWork", oldValue: 6, newValue: 4 },
    ],
    linkedPullRequests: [],
    supportedFields: TASK_FIELDS,
    ...overrides,
  };
}

function ruleIds(ctx: RuleContext): ComplianceRuleId[] {
  return evaluateCompliance(ctx).violations.map((violation) => violation.ruleId);
}

const PR_LINK = { projectId: "p", repositoryId: "r", pullRequestId: 1 };

describe("compliance rules", () => {
  it("passes a well-maintained in-progress task", () => {
    expect(ruleIds(context())).toEqual([]);
  });

  it("flags missing approach, comment, estimate and work log", () => {
    const ids = ruleIds(
      context({
        workItem: workItem({ originalEstimate: null, completedWork: 0 }),
        comments: [],
        history: [],
      })
    );

    expect(ids).toEqual(["MISSING_APPROACH", "MISSING_COMMENT", "MISSING_ESTIMATE", "MISSING_WORK_LOG"]);
  });

  it("does not demand comments or work logs from items that just started", () => {
    const ids = ruleIds(
      context({
        workItem: workItem({ completedWork: 0, stateChangeDate: NOW.toISOString() }),
        comments: [
          { id: 1, text: "Approach: x", createdBy: { id: "someone", displayName: "S", uniqueName: null }, createdDate: daysAgo(9), modifiedDate: null },
        ],
      })
    );

    expect(ids).toEqual([]);
  });

  it("flags a stale work log even when completed work exists", () => {
    const ids = ruleIds(
      context({
        history: [{ revisedDate: daysAgo(9), revisedBy: null, field: "CompletedWork", oldValue: 0, newValue: 4 }],
      })
    );

    expect(ids).toEqual(["MISSING_WORK_LOG"]);
  });

  it("skips estimate and work-log rules for types without those fields (e.g. Basic Issue)", () => {
    const none: SupportedWorkFields = {
      originalEstimate: false,
      remainingWork: false,
      completedWork: false,
      storyPoints: false,
      effort: false,
      priority: true,
    };

    expect(
      ruleIds(context({ workItem: workItem({ type: "Issue", originalEstimate: null, completedWork: null }), supportedFields: none }))
    ).toEqual([]);
  });

  it("accepts story points or effort as the estimate", () => {
    const storyFields = { ...TASK_FIELDS, originalEstimate: false, storyPoints: true };
    expect(
      ruleIds(context({ workItem: workItem({ type: "User Story", originalEstimate: null, storyPoints: 3 }), supportedFields: storyFields }))
    ).not.toContain("MISSING_ESTIMATE");
  });

  it("flags resolved/closed code work without a PR link", () => {
    expect(
      ruleIds(context({ workItem: workItem({ state: "Resolved", stateCategory: "Resolved" }) }))
    ).toContain("MISSING_PR_LINK");
  });

  it("flags tickets left open after every linked PR merged", () => {
    const result = evaluateCompliance(
      context({
        workItem: workItem({ state: "Resolved", stateCategory: "Resolved", links: { ...workItem().links, pullRequests: [PR_LINK] } }),
        linkedPullRequests: [
          { ...PR_LINK, repositoryName: "r", title: "t", status: "completed", closedDate: daysAgo(3), webUrl: null },
          { ...PR_LINK, pullRequestId: 2, repositoryName: "r", title: "t", status: "abandoned", closedDate: null, webUrl: null },
        ],
      })
    );

    const violation = result.violations.find((candidate) => candidate.ruleId === "NOT_CLOSED_AFTER_MERGE");
    expect(violation?.suggestedAction).toMatchObject({ kind: "WORK_ITEM_CLOSE_AFTER_MERGE", requiresInput: false });
  });

  it("does not flag tickets whose PR merged within the grace period or is still active", () => {
    const links = { ...workItem().links, pullRequests: [PR_LINK] };

    expect(
      ruleIds(context({
        workItem: workItem({ links }),
        linkedPullRequests: [{ ...PR_LINK, repositoryName: "r", title: "t", status: "completed", closedDate: daysAgo(0.5), webUrl: null }],
      }))
    ).not.toContain("NOT_CLOSED_AFTER_MERGE");

    expect(
      ruleIds(context({
        workItem: workItem({ links }),
        linkedPullRequests: [{ ...PR_LINK, repositoryName: "r", title: "t", status: "active", closedDate: null, webUrl: null }],
      }))
    ).not.toContain("NOT_CLOSED_AFTER_MERGE");
  });

  it("flags closed tickets with an active PR or remaining work", () => {
    const ids = ruleIds(
      context({
        workItem: workItem({
          state: "Closed",
          stateCategory: "Completed",
          remainingWork: 2,
          links: { ...workItem().links, pullRequests: [PR_LINK] },
        }),
        linkedPullRequests: [{ ...PR_LINK, repositoryName: "r", title: "t", status: "active", closedDate: null, webUrl: null }],
      })
    );

    expect(ids).toEqual(["CLOSED_WITH_OPEN_PR", "REMAINING_NOT_ZERO_ON_CLOSE"]);
  });

  it("reports rules as skipped when their data could not be loaded", () => {
    const result = evaluateCompliance(context({ comments: null, history: null }));
    expect(result.skippedRules).toEqual(["MISSING_APPROACH", "MISSING_COMMENT", "MISSING_WORK_LOG"]);
    expect(result.violations).toEqual([]);
  });

  it("asks only for data that applicable rules need", () => {
    expect([...requiredData(workItem({ stateCategory: "Proposed" }), complianceConfig)]).toEqual([]);
    expect(requiredData(workItem(), complianceConfig)).toEqual(
      new Set(["comments", "supportedFields", "history"])
    );
  });
});
