import { hoursBetween, workingDaysBetween } from "../../lib/working-days.js";
import type {
  AzureIdentity,
  ComplianceResult,
  ComplianceRuleId,
  ComplianceViolation,
  LinkedPullRequest,
  StateCategory,
  SuggestedAction,
  SupportedWorkFields,
  WorkFieldChange,
  WorkItemComment,
  WorkItemSummary,
} from "../../types/azure.types.js";
import type { ComplianceConfig } from "./compliance.config.js";

export type RuleData = "comments" | "history" | "linkedPullRequests" | "supportedFields";

export interface RuleContext {
  workItem: WorkItemSummary;
  me: AzureIdentity;
  now: Date;
  config: ComplianceConfig;
  /** null means the data could not be loaded; dependent rules are skipped. */
  comments: WorkItemComment[] | null;
  history: WorkFieldChange[] | null;
  linkedPullRequests: LinkedPullRequest[] | null;
  supportedFields: SupportedWorkFields | null;
}

interface Rule {
  id: ComplianceRuleId;
  needs: RuleData[];
  appliesTo(workItem: WorkItemSummary, config: ComplianceConfig): boolean;
  evaluate(context: RuleContext): ComplianceViolation | null;
}

const ACTIVE_OR_LATER: StateCategory[] = ["InProgress", "Resolved", "Completed"];

function target(workItem: WorkItemSummary) {
  return { projectId: workItem.projectName, workItemId: workItem.id };
}

function suggest(
  workItem: WorkItemSummary,
  kind: string,
  params: Record<string, unknown>,
  requiresInput: boolean
): SuggestedAction {
  return { kind, target: target(workItem), params, requiresInput };
}

function inProgressSince(workItem: WorkItemSummary): Date | null {
  const value = workItem.stateChangeDate ?? workItem.changedDate;
  return value ? new Date(value) : null;
}

function inProgressLongerThan(context: RuleContext, workingDays: number): boolean {
  const since = inProgressSince(context.workItem);
  return since !== null && workingDaysBetween(since, context.now) > workingDays;
}

function positive(value: number | null): boolean {
  return value !== null && value > 0;
}

function considered(prs: LinkedPullRequest[]): LinkedPullRequest[] {
  return prs.filter((pr) => pr.status !== "abandoned" && pr.status !== "unavailable");
}

export const rules: Rule[] = [
  {
    id: "MISSING_APPROACH",
    needs: ["comments"],
    appliesTo: (workItem) => ACTIVE_OR_LATER.includes(workItem.stateCategory),
    evaluate: ({ workItem, comments, config }) => {
      const prefix = config.approachCommentPrefix.toLowerCase();
      const documented = (comments ?? []).some((comment) =>
        comment.text.trim().toLowerCase().startsWith(prefix)
      );

      return documented
        ? null
        : {
            ruleId: "MISSING_APPROACH",
            severity: "medium",
            message: `No approach comment (a comment starting with "${config.approachCommentPrefix}") on this ticket`,
            suggestedAction: suggest(workItem, "WORK_ITEM_COMMENT", { text: "Approach: " }, true),
          };
    },
  },
  {
    id: "MISSING_COMMENT",
    needs: ["comments"],
    appliesTo: (workItem) => workItem.stateCategory === "InProgress",
    evaluate: (context) => {
      const { workItem, comments, me, now, config } = context;

      if (!inProgressLongerThan(context, config.commentStaleWorkingDays)) {
        return null;
      }

      const latestMine = (comments ?? []).find((comment) => comment.createdBy.id === me.id);
      const days = latestMine
        ? workingDaysBetween(new Date(latestMine.createdDate), now)
        : null;

      if (days !== null && days <= config.commentStaleWorkingDays) {
        return null;
      }

      return {
        ruleId: "MISSING_COMMENT",
        severity: "medium",
        message:
          days === null
            ? "You have not commented on this in-progress ticket"
            : `No progress comment from you in ${days} working days`,
        suggestedAction: suggest(workItem, "WORK_ITEM_COMMENT", { text: "" }, true),
      };
    },
  },
  {
    id: "MISSING_ESTIMATE",
    needs: ["supportedFields"],
    appliesTo: (workItem) => ACTIVE_OR_LATER.includes(workItem.stateCategory),
    evaluate: ({ workItem, supportedFields }) => {
      if (!supportedFields) {
        return null;
      }

      const candidates: Array<[boolean, number | null]> = [
        [supportedFields.originalEstimate, workItem.originalEstimate],
        [supportedFields.storyPoints, workItem.storyPoints],
        [supportedFields.effort, workItem.effort],
      ];
      const supported = candidates.filter(([isSupported]) => isSupported);

      if (supported.length === 0 || supported.some(([, value]) => positive(value))) {
        return null;
      }

      return {
        ruleId: "MISSING_ESTIMATE",
        severity: "high",
        message: "Ticket is in progress or done without an estimate",
        suggestedAction: suggest(workItem, "WORK_ITEM_UPDATE_FIELDS", {}, true),
      };
    },
  },
  {
    id: "MISSING_WORK_LOG",
    needs: ["supportedFields", "history"],
    appliesTo: (workItem) => workItem.stateCategory === "InProgress",
    evaluate: (context) => {
      const { workItem, supportedFields, history, now, config } = context;

      if (
        !supportedFields ||
        (!supportedFields.completedWork && !supportedFields.remainingWork) ||
        !inProgressLongerThan(context, config.workLogStaleWorkingDays)
      ) {
        return null;
      }

      if (supportedFields.completedWork && !positive(workItem.completedWork)) {
        return {
          ruleId: "MISSING_WORK_LOG",
          severity: "medium",
          message: "No completed work logged on this in-progress ticket",
          suggestedAction: suggest(workItem, "WORK_ITEM_UPDATE_FIELDS", {}, true),
        };
      }

      const lastLog = (history ?? []).find(
        (change) => change.field === "RemainingWork" || change.field === "CompletedWork"
      );
      const reference = lastLog ? new Date(lastLog.revisedDate) : inProgressSince(workItem);

      if (!reference) {
        return null;
      }

      const days = workingDaysBetween(reference, now);

      return days > config.workLogStaleWorkingDays
        ? {
            ruleId: "MISSING_WORK_LOG",
            severity: "medium",
            message: `Work log (remaining/completed work) not updated in ${days} working days`,
            suggestedAction: suggest(workItem, "WORK_ITEM_UPDATE_FIELDS", {}, true),
          }
        : null;
    },
  },
  {
    id: "MISSING_PR_LINK",
    needs: [],
    appliesTo: (workItem, config) =>
      config.codeWorkItemTypes.includes(workItem.type) &&
      (workItem.stateCategory === "Resolved" || workItem.stateCategory === "Completed"),
    evaluate: ({ workItem }) =>
      workItem.links.pullRequests.length > 0
        ? null
        : {
            ruleId: "MISSING_PR_LINK",
            severity: "high",
            message: "Resolved or closed without a linked pull request",
            suggestedAction: suggest(workItem, "WORK_ITEM_LINK_PR", {}, true),
          },
  },
  {
    id: "NOT_CLOSED_AFTER_MERGE",
    needs: ["linkedPullRequests"],
    appliesTo: (workItem) =>
      ["Proposed", "InProgress", "Resolved"].includes(workItem.stateCategory) &&
      workItem.links.pullRequests.length > 0,
    evaluate: ({ workItem, linkedPullRequests, now, config }) => {
      const prs = considered(linkedPullRequests ?? []);

      if (prs.length === 0 || prs.some((pr) => pr.status !== "completed")) {
        return null;
      }

      const lastMerged = prs
        .map((pr) => pr.closedDate)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1);

      if (!lastMerged || hoursBetween(new Date(lastMerged), now) <= config.closeAfterMergeHours) {
        return null;
      }

      return {
        ruleId: "NOT_CLOSED_AFTER_MERGE",
        severity: "high",
        message: `All linked pull requests merged more than ${config.closeAfterMergeHours}h ago but the ticket is still open`,
        suggestedAction: suggest(workItem, "WORK_ITEM_CLOSE_AFTER_MERGE", {}, false),
      };
    },
  },
  {
    id: "CLOSED_WITH_OPEN_PR",
    needs: ["linkedPullRequests"],
    appliesTo: (workItem) =>
      workItem.stateCategory === "Completed" && workItem.links.pullRequests.length > 0,
    evaluate: ({ linkedPullRequests }) =>
      (linkedPullRequests ?? []).some((pr) => pr.status === "active")
        ? {
            ruleId: "CLOSED_WITH_OPEN_PR",
            severity: "medium",
            message: "Ticket is closed but a linked pull request is still active",
            suggestedAction: null,
          }
        : null,
  },
  {
    id: "REMAINING_NOT_ZERO_ON_CLOSE",
    needs: [],
    appliesTo: (workItem) => workItem.stateCategory === "Completed",
    evaluate: ({ workItem }) =>
      positive(workItem.remainingWork)
        ? {
            ruleId: "REMAINING_NOT_ZERO_ON_CLOSE",
            severity: "low",
            message: `Ticket is closed with ${workItem.remainingWork}h remaining work`,
            suggestedAction: suggest(workItem, "WORK_ITEM_UPDATE_FIELDS", { remainingWork: 0 }, false),
          }
        : null,
  },
];

/** Which extra data the applicable rules need, so callers fetch only that. */
export function requiredData(workItem: WorkItemSummary, config: ComplianceConfig): Set<RuleData> {
  const needs = new Set<RuleData>();

  for (const rule of rules) {
    if (rule.appliesTo(workItem, config)) {
      rule.needs.forEach((need) => needs.add(need));
    }
  }

  return needs;
}

export function evaluateCompliance(context: RuleContext): ComplianceResult {
  const violations: ComplianceViolation[] = [];
  const skippedRules: ComplianceRuleId[] = [];

  for (const rule of rules) {
    if (!rule.appliesTo(context.workItem, context.config)) {
      continue;
    }

    if (rule.needs.some((need) => context[need] === null)) {
      skippedRules.push(rule.id);
      continue;
    }

    const violation = rule.evaluate(context);

    if (violation) {
      violations.push(violation);
    }
  }

  const { workItem } = context;

  return {
    workItemId: workItem.id,
    projectName: workItem.projectName,
    title: workItem.title,
    type: workItem.type,
    state: workItem.state,
    stateCategory: workItem.stateCategory,
    violations,
    skippedRules,
  };
}
