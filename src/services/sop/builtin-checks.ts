import { z } from "zod";

import { SOP_STAGES } from "./rulebook.types.js";

/**
 * The fixed, code-based checks a rule card can reference with `uses:`.
 * Each declares the parameters it accepts; anything else is rejected when
 * a rulebook is saved. Evaluation lives in code-checker.ts.
 */
const hours = z.number().positive().max(24 * 30);
const stage = z.enum(SOP_STAGES);

/** What a stage comment may be required to mention. */
export const STAGE_COMMENT_DETAILS = [
  "eta-date",
  "ac-dod",
  "approver",
  "branch",
  "target-branch",
  "pr-number",
  "reviewer",
  "tests",
  "merge",
  "build-number",
  "done",
] as const;
export type StageCommentDetail = (typeof STAGE_COMMENT_DETAILS)[number];

export const BUILTIN_CHECKS = {
  "title-length": {
    description: "Title length is within limits and does not end with a period.",
    params: z.object({ min: z.number().int().min(1).default(5), max: z.number().int().max(255).default(80) }).strict(),
  },
  "field-present": {
    description: "A field has a value (priority, due-date, description, acceptance-criteria, category, target-completion, area).",
    params: z
      .object({
        field: z.enum(["priority", "due-date", "description", "acceptance-criteria", "category", "target-completion", "area"]),
        min_length: z.number().int().min(1).optional(),
      })
      .strict(),
  },
  "estimate-present": {
    description: "Stories have story points; tasks and bugs have an original estimate (hours).",
    params: z.object({}).strict(),
  },
  "parent-link": {
    description: "Task/Bug has a Story or Feature parent; Story has a Feature parent; Feature has an Epic parent.",
    params: z.object({}).strict(),
  },
  "tags-present": {
    description: "At least one tag; optionally at least one from the project's tag vocabulary.",
    params: z.object({ from_vocabulary: z.boolean().default(false) }).strict(),
  },
  "reference-links": {
    description: "At least one hyperlink relation or a URL in the description.",
    params: z.object({}).strict(),
  },
  "time-fields-present": {
    description: "Original estimate, remaining and completed work are filled in.",
    params: z.object({}).strict(),
  },
  "branch-linked": {
    description: "A git branch is linked to the ticket within a number of hours after it becomes Active.",
    params: z.object({ within_hours: hours.default(24) }).strict(),
  },
  "branch-name": {
    description: "Linked branch names match the project's branch pattern and contain the ticket number.",
    params: z.object({}).strict(),
  },
  "transition-comment": {
    description: "Every state change has a comment by the person who made it, within a time window.",
    params: z
      .object({
        hours_after: hours.default(24),
        minutes_before: z.number().int().min(0).max(24 * 60).default(60),
      })
      .strict(),
  },
  "pr-linked": {
    description: "At least one pull request is linked to the ticket.",
    params: z.object({}).strict(),
  },
  "pr-reviewer": {
    description: "Every linked active pull request has at least one reviewer other than the author.",
    params: z.object({}).strict(),
  },
  "pr-target-branch": {
    description: "Linked pull requests target the project's configured branch.",
    params: z.object({}).strict(),
  },
  "pr-approved-before-merge": {
    description: "Completed pull requests that had a reviewer were approved and had no open comment threads. Pull requests without a reviewer are not checked.",
    params: z.object({}).strict(),
  },
  "daily-time-update": {
    description: "Completed or remaining work is updated on every working day the ticket spends in the given stages.",
    params: z.object({ stages: z.array(stage).min(1).default(["active", "testing"]) }).strict(),
  },
  "estimate-change-comment": {
    description: "When the estimate changes or remaining work goes up after Active, a comment the same day explains it.",
    params: z.object({}).strict(),
  },
  "due-date-change-comment": {
    description: "When the due date changes, a comment the same day mentions both the old and the new date.",
    params: z.object({}).strict(),
  },
  "merged-before-stage": {
    description: "The ticket only enters the given stage once all linked pull requests are completed.",
    params: z.object({ stage: stage.default("testing") }).strict(),
  },
  "linked-prs-completed": {
    description: "All linked pull requests are completed. No pull request at all is only a notice.",
    params: z.object({}).strict(),
  },
  "time-logged-at-done": {
    description: "At Done, completed work is above 0 and remaining work is 0.",
    params: z.object({}).strict(),
  },
  "linked-bugs-closed": {
    description: "All related bugs are closed.",
    params: z.object({}).strict(),
  },
  "title-flag-format": {
    description: "Block/pause flags use exactly [Blocked], [On Hold], [Paused] or [Discuss] at the start of the title.",
    params: z.object({}).strict(),
  },
  "evidence-attached": {
    description: "At least one attachment is added before the given stage.",
    params: z.object({ before: stage.default("uat") }).strict(),
  },
  "approach-present": {
    description:
      "A technical approach with enough steps is in the description or a comment. Its heading may be Approach, Technical approach, Pseudocode, Pseudo code, Plan, Implementation plan, Steps or Solution, in any case; steps may be numbered, bulleted or one per line.",
    params: z.object({ min_steps: z.number().int().min(1).max(20).default(3) }).strict(),
  },
  "tl-approval": {
    description:
      "A team lead listed in the project set-up (not the ticket's developer) approves in a comment written after the approach (approved, LGTM, looks good, go ahead, good to go...; \"not approved yet\" and questions do not count).",
    params: z.object({}).strict(),
  },
  "dod-present": {
    description: "The description, acceptance criteria or a comment has a Definition of Done (or DoD) section with items, or says the acceptance criteria are the DoD.",
    params: z.object({ min_items: z.number().int().min(1).max(20).default(1) }).strict(),
  },
  "stage-comment": {
    description:
      "Around the latest move into a stage, the person who moved it (or the assignee) comments with the listed details. Branch, PR number and reviewer are only required when one is linked.",
    params: z
      .object({
        stage,
        requires: z.array(z.enum(STAGE_COMMENT_DETAILS)).max(STAGE_COMMENT_DETAILS.length).default([]),
        hours_after: hours.default(24),
        minutes_before: z.number().int().min(0).max(24 * 60).default(60),
      })
      .strict(),
  },
  "assigned-to-reviewer": {
    description: "While in Review the ticket is assigned to a reviewer of its pull request or a team lead (without either, to someone other than the person who moved it to Review).",
    params: z.object({}).strict(),
  },
} as const;

/** Which checks the AI review may clear (the code looks for wording) or only draft a fix for (the gap is a plain fact). */
export const AI_REVIEW: Partial<Record<BuiltinCheckName, "judge" | "draft">> = {
  "approach-present": "judge",
  "tl-approval": "judge",
  "dod-present": "judge",
  "stage-comment": "judge",
  "field-present": "draft",
  "tags-present": "draft",
  "transition-comment": "draft",
  "estimate-change-comment": "draft",
  "due-date-change-comment": "draft",
};

export type BuiltinCheckName = keyof typeof BUILTIN_CHECKS;

export function isBuiltinCheck(name: string): name is BuiltinCheckName {
  return Object.hasOwn(BUILTIN_CHECKS, name);
}
