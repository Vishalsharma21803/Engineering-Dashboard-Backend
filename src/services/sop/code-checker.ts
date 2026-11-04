import type { SuggestedAction } from "../../types/azure.types.js";
import { WORK_ITEM_FIELDS } from "../azure/work-items.service.js";
import { toIdentityRef } from "../azure/mappers.js";
import type { BuiltinCheckName, StageCommentDetail } from "./builtin-checks.js";
import type { DossierNeed, StageEntry, TicketDossier } from "./dossier.js";
import { numberField, stageOf } from "./dossier.js";
import type { CodeRuleCard, ItemKind, SopStage } from "./rulebook.types.js";
import { SOP_STAGES } from "./rulebook.types.js";
import {
  MENTIONS,
  findApproachSection,
  findDodSection,
  isApproval,
  isListedPerson,
  mentionsAnyDate,
  mentionsPerson,
  mentionsPullRequest,
  mentionsWord,
} from "./sop-text.js";

export type CheckOutcome =
  | { status: "pass" }
  /** `notice`: this outcome is only a notice, whatever the rule's severity. */
  | { status: "fail"; message: string; evidence: string[]; action: SuggestedAction | null; notice?: boolean }
  /** Not yet decidable (e.g. the time window is still open). */
  | { status: "pending"; message: string }
  /** The check does not apply or its data is unavailable. */
  | { status: "skip"; reason: string };

interface CheckContext {
  dossier: TicketDossier;
  params: Record<string, unknown>;
  now: Date;
}

interface CheckDefinition {
  needs: DossierNeed[];
  run(context: CheckContext): CheckOutcome;
}

const HOUR_MS = 60 * 60 * 1000;
/** Only the start of a long comment is searched for a stage comment's details. */
const MAX_COMMENT_CHARS = 5_000;
const MAX_LISTED = 5;
const PASS: CheckOutcome = { status: "pass" };

/* ---------------------------------------------------------------- helpers */

function fail(message: string, evidence: string[] = [], action: SuggestedAction | null = null): CheckOutcome {
  return { status: "fail", message, evidence: evidence.slice(0, MAX_LISTED), action };
}

function skip(reason: string): CheckOutcome {
  return { status: "skip", reason };
}

function action(dossier: TicketDossier, kind: string, params: Record<string, unknown> = {}, requiresInput = true): SuggestedAction {
  return { kind, target: { projectId: dossier.workItem.projectName, workItemId: dossier.workItem.id }, params, requiresInput };
}

/** Calendar day (YYYY-MM-DD) in the team's time zone. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function isWeekendDay(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function stageIndex(stage: SopStage): number {
  return SOP_STAGES.indexOf(stage);
}

/** First time the ticket entered `stage` or any later stage; null if it never did. */
export function enteredAt(dossier: TicketDossier, stage: SopStage): Date | null {
  const target = stageIndex(stage);
  const entry = (dossier.stageHistory ?? []).find((item) => item.stage !== null && stageIndex(item.stage) >= target);

  if (entry) {
    return entry.at;
  }

  // History unavailable or truncated: the current stage still proves the ticket got there.
  if (dossier.stage !== null && stageIndex(dossier.stage) >= target) {
    const { stateChangeDate, changedDate, createdDate } = dossier.workItem;
    return new Date(stateChangeDate ?? changedDate ?? createdDate ?? 0);
  }

  return null;
}

/**
 * The latest move into `stage` (or a later one) from below it: after rework
 * (Testing → Active → Testing) this is the second entry. Without history, the
 * same as `enteredAt`.
 */
export function latestEntryFromBelow(dossier: TicketDossier, stage: SopStage): Date | null {
  const target = stageIndex(stage);
  let previous: SopStage | null = null;
  let acrossGap = false;
  let latest: Date | null = null;

  for (const item of dossier.stageHistory ?? []) {
    acrossGap ||= item.afterGap === true;

    // States the SOP does not map (On Hold…) are skipped: Testing → On Hold → Testing never left Testing.
    if (item.stage === null) {
      continue;
    }

    // Across revisions that were not read, where the ticket came from is unknown: not counted as a move from below.
    const fromBelow = !acrossGap && (previous === null || stageIndex(previous) < target);

    if (stageIndex(item.stage) >= target && fromBelow) {
      latest = item.at;
    }

    previous = item.stage;
    acrossGap = false;
  }

  return latest ?? enteredAt(dossier, stage);
}

/**
 * Closed (done or Removed) without ever being in a working stage (Active to
 * UAT), with no linked pull request and no Completed Work: a duplicate or
 * won't-fix closed from New. History that is unavailable or only partly read
 * proves nothing.
 */
export function neverWorked(dossier: TicketDossier): boolean {
  if (dossier.stageHistory === null || dossier.historyTruncated) {
    return false;
  }

  // A linked pull request or logged hours show work was done, even on a ticket closed straight from New.
  if (dossier.workItem.links.pullRequests.length > 0 || (dossier.workItem.completedWork ?? 0) > 0) {
    return false;
  }

  const closed = dossier.stage === "done" || dossier.workItem.stateCategory === "Removed";
  const worked = (stage: SopStage | null) => stage !== null && stageIndex(stage) >= stageIndex("active") && stageIndex(stage) <= stageIndex("uat");
  return closed && !dossier.stageHistory.some((entry) => worked(entry.stage));
}

/** The ticket moved to a stage after `stage` at some point (moving back later does not undo it). */
export function movedPast(dossier: TicketDossier, stage: SopStage): boolean {
  const target = stageIndex(stage);
  const later = (stage: SopStage | null) => stage !== null && stageIndex(stage) > target;
  return (dossier.stageHistory ?? []).some((entry) => later(entry.stage)) || later(dossier.stage);
}

/** The latest move into exactly `stage`; null if the ticket never got there. */
export function lastEnteredAt(dossier: TicketDossier, stage: SopStage): Date | null {
  const entry = (dossier.stageHistory ?? []).filter((item) => item.stage === stage).at(-1);

  if (entry) {
    return entry.at;
  }

  if (dossier.stage === stage) {
    const { stateChangeDate, changedDate, createdDate } = dossier.workItem;
    return new Date(stateChangeDate ?? changedDate ?? createdDate ?? 0);
  }

  return null;
}

function sameActor(a: { id: string | null; uniqueName?: string | null } | null, b: { id: string | null; uniqueName?: string | null } | null): boolean {
  if (!a || !b) {
    return false;
  }

  if (a.id && b.id) {
    return a.id === b.id;
  }

  return Boolean(a.uniqueName && b.uniqueName && a.uniqueName.toLowerCase() === b.uniqueName.toLowerCase());
}

/** Automatic transitions (PR completion, pipelines) are not made by a person who could comment. */
function isServiceIdentity(entry: StageEntry): boolean {
  const name = `${entry.by?.displayName ?? ""} ${entry.by?.uniqueName ?? ""}`;
  return entry.by === null || /build service|microsoft\.|azure devops|project collection|\bTFS\b/i.test(name);
}

function hasComment(dossier: TicketDossier, by: StageEntry["by"], from: Date, to: Date): boolean {
  return (dossier.comments ?? []).some((comment) => {
    const at = new Date(comment.createdDate);
    return at >= from && at <= to && sameActor(comment.createdBy, by);
  });
}

function commentsOnDay(dossier: TicketDossier, day: string, by: StageEntry["by"] | null) {
  return (dossier.comments ?? []).filter(
    (comment) => localDay(new Date(comment.createdDate), dossier.profile.timeZone) === day && (by === null || sameActor(comment.createdBy, by))
  );
}

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Does `text` mention the calendar date `day` (YYYY-MM-DD) in a common written form? */
export function mentionsDate(text: string, day: string): boolean {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const lower = text.toLowerCase();
  const monthNames = `(?:${FULL_MONTHS[month - 1]}|${MONTHS[month - 1]}\\.?)`;
  const dayNumber = `0?${date}(?:st|nd|rd|th)?`;
  const monthNumber = `0?${month}`;
  const yearPart = `(?:${year}|${String(year).slice(2)})`;
  const patterns = [
    `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
    `\\b${dayNumber}[\\s,-]*(?:of\\s+)?${monthNames}\\b`,
    `\\b${monthNames}[\\s,-]*${dayNumber}\\b`,
    `\\b0?${date}[/.-]${monthNumber}(?:[/.-]${yearPart})?\\b`,
    `\\b${monthNumber}[/.-]0?${date}(?:[/.-]${yearPart})?\\b`,
  ];

  return patterns.some((pattern) => new RegExp(pattern, "i").test(lower));
}

function dueDateDays(value: unknown, timeZone: string): string[] {
  if (typeof value !== "string") {
    return [];
  }

  const date = new Date(value);
  // Date-only fields are stored as midnight in the editor's zone; accept both readings.
  return [...new Set([localDay(date, timeZone), value.slice(0, 10)])];
}

function positive(value: number | null): boolean {
  return value !== null && value > 0;
}

function activePrs(dossier: TicketDossier) {
  return (dossier.pullRequests ?? []).filter((pr) => pr.status !== "abandoned");
}

/* ------------------------------------------------------- text-based checks */

/** Comments oldest first (the API returns newest first). */
function commentsInOrder(dossier: TicketDossier) {
  return [...(dossier.comments ?? [])].sort((a, b) => new Date(a.createdDate).getTime() - new Date(b.createdDate).getTime());
}

export interface FoundApproach {
  steps: number;
  /** When it was written: a comment's date; null for the description (it may have been edited any time). */
  at: Date | null;
  where: string;
}

/** The approach with the most steps that meets `minSteps`, else the best one found (or null). */
export function findApproach(dossier: TicketDossier, minSteps: number): FoundApproach | null {
  const candidates: FoundApproach[] = [];
  // In a bug's description a plain "Steps" list is usually how to reproduce it.
  const description = findApproachSection(dossier.description, { bareSteps: dossier.kind !== "bug" });

  if (description) {
    candidates.push({ steps: description.items, at: null, where: `Description: "${description.heading}"` });
  }

  for (const comment of commentsInOrder(dossier)) {
    const found = findApproachSection(comment.text);

    if (found) {
      candidates.push({ steps: found.items, at: new Date(comment.createdDate), where: `Comment by ${comment.createdBy.displayName}: "${found.heading}"` });
    }
  }

  return candidates.find((candidate) => candidate.steps >= minSteps) ?? candidates.sort((a, b) => b.steps - a.steps)[0] ?? null;
}

const DETAIL_LABELS: Record<StageCommentDetail, string> = {
  "eta-date": "an ETA date",
  "ac-dod": "that AC/DoD were reviewed",
  approver: "who approved the approach",
  branch: "the branch name",
  "target-branch": "the base/target branch",
  "pr-number": "the PR number",
  reviewer: "the reviewer",
  tests: "the test status",
  merge: "that it was merged",
  "build-number": "the build or deployment number",
  done: "that the work is done",
};

/** Whether `text` covers one required detail; null when the detail does not apply to this ticket (nothing linked). */
function coversDetail(dossier: TicketDossier, detail: StageCommentDetail, fullText: string): boolean | null {
  const text = fullText.slice(0, MAX_COMMENT_CHARS);
  const prIds = dossier.workItem.links.pullRequests.map((link) => link.pullRequestId);

  switch (detail) {
    case "eta-date":
      return MENTIONS.eta.test(text) || mentionsAnyDate(text);
    case "ac-dod":
      return MENTIONS.acDod.test(text);
    case "approver":
      return MENTIONS.approval.test(text) || dossier.profile.roles.tl.some((name) => mentionsPerson(text, { displayName: name }));
    case "branch": {
      if (dossier.branches.length === 0) return null;
      const id = String(dossier.workItem.id);
      return dossier.branches.some(
        (branch) => mentionsWord(text, branch.refName) || mentionsWord(text, branch.refName.split("/").at(-1) ?? "") || (/\bbranch\b/i.test(text) && text.includes(id))
      );
    }
    case "target-branch": {
      // Only asked for when something was branched or merged ("from develop", "merged into develop").
      if (dossier.branches.length === 0 && prIds.length === 0) return null;
      const targets = [dossier.profile.prTargetBranch, ...(dossier.pullRequests ?? []).map((pr) => pr.targetBranch)].filter((name): name is string => Boolean(name));
      return targets.length === 0 ? null : targets.some((name) => mentionsWord(text, name));
    }
    case "pr-number":
      return prIds.length === 0 ? null : prIds.some((id) => mentionsPullRequest(text, id));
    case "reviewer": {
      if (prIds.length === 0) return null;
      const reviewers = (dossier.pullRequests ?? []).flatMap((pr) => pr.reviewers.filter((reviewer) => !sameActor(reviewer, pr.createdBy)));
      return MENTIONS.reviewer.test(text) || reviewers.some((reviewer) => mentionsPerson(text, reviewer));
    }
    case "tests":
      return MENTIONS.tests.test(text);
    case "merge":
      return MENTIONS.merge.test(text);
    case "build-number":
      return MENTIONS.build.test(text);
    case "done":
      return MENTIONS.done.test(text);
  }
}

/** The assignee at `at`, from the assignment history (the current one when it never changed after). */
function assigneeAt(dossier: TicketDossier, at: Date) {
  const changes = (dossier.fieldChanges ?? []).filter((change) => change.field === WORK_ITEM_FIELDS.assignedTo);
  const before = changes.filter((change) => change.at <= at).at(-1);

  if (before) {
    return toIdentityRef(before.newValue);
  }

  const after = changes.find((change) => change.at > at);
  return after ? toIdentityRef(after.oldValue) : dossier.workItem.assignedTo;
}

/* ----------------------------------------------------------------- checks */

const PARENT_KINDS: Partial<Record<ItemKind, ItemKind[]>> = {
  task: ["story", "feature"],
  bug: ["story", "feature"],
  story: ["feature"],
  feature: ["epic"],
};

const FLAG_CANONICAL = /^\[(Blocked|On Hold|Paused|Discuss)\] \S/;
/** A flag-like word at the start of the title, or in brackets anywhere. */
const FLAG_LIKE = /^\s*[[(]?\s*(blocked|on[\s-]?hold|paused|discuss)\s*[\]):-]|[[(]\s*(blocked|on[\s-]?hold|paused|discuss)\s*[\])]/i;

const FIELD_LABELS: Record<string, string> = {
  priority: "Priority",
  "due-date": "Due Date",
  description: "Description",
  "acceptance-criteria": "Acceptance Criteria",
  category: "Category",
  "target-completion": "Target completion",
  area: "Area Path",
};

export const CODE_CHECKS: Record<BuiltinCheckName, CheckDefinition> = {
  "title-length": {
    needs: [],
    run: ({ dossier, params }) => {
      const title = dossier.workItem.title.trim();
      const min = params.min as number;
      const max = params.max as number;

      if (title.length < min || title.length > max) {
        return fail(`Title is ${title.length} characters; it should be ${min}-${max}.`, [title]);
      }

      return title.endsWith(".") ? fail("Title ends with a period.", [title]) : PASS;
    },
  },

  "field-present": {
    needs: [],
    run: ({ dossier, params }) => {
      const field = params.field as string;
      const minLength = (params.min_length as number | undefined) ?? 1;
      const label = FIELD_LABELS[field] ?? field;
      let value: unknown;

      switch (field) {
        case "priority":
          value = dossier.workItem.priority;
          break;
        case "due-date":
          value = dossier.workItem.dueDate;
          break;
        case "description":
          value = dossier.description.trim().length >= minLength ? dossier.description : null;
          break;
        case "acceptance-criteria":
          value = dossier.acceptanceCriteria.trim().length >= minLength ? dossier.acceptanceCriteria : null;
          break;
        case "category":
        case "target-completion": {
          const reference = field === "category" ? dossier.profile.fields.category : dossier.profile.fields.targetCompletion;

          if (!reference) {
            return skip(`The project has no ${label} field configured`);
          }

          value = dossier.fields[reference];
          break;
        }
        case "area":
          value = dossier.workItem.areaPath && dossier.workItem.areaPath.includes("\\") ? dossier.workItem.areaPath : null;
          break;
      }

      if (value !== null && value !== undefined && value !== "") {
        return PASS;
      }

      const updatable = field === "priority" || field === "due-date";
      return fail(`${label} is not set.`, [], updatable ? action(dossier, "WORK_ITEM_UPDATE_FIELDS") : null);
    },
  },

  "estimate-present": {
    needs: [],
    run: ({ dossier }) => {
      const { workItem } = dossier;

      if (dossier.kind === "story") {
        return positive(workItem.storyPoints) || positive(workItem.effort)
          ? PASS
          : fail("Story has no story points.", [], action(dossier, "WORK_ITEM_UPDATE_FIELDS"));
      }

      if (dossier.kind === "task" || dossier.kind === "bug") {
        return positive(workItem.originalEstimate)
          ? PASS
          : fail("No original estimate (hours).", [], action(dossier, "WORK_ITEM_UPDATE_FIELDS"));
      }

      return skip("Estimates apply to stories, tasks and bugs");
    },
  },

  "parent-link": {
    needs: ["relatedItems"],
    run: ({ dossier }) => {
      const allowed = dossier.kind ? PARENT_KINDS[dossier.kind] : undefined;

      if (!allowed) {
        return skip("No parent is required for this type");
      }

      const wanted = allowed.join(" or ");

      if (dossier.workItem.links.parentId === null) {
        return fail(`No parent ${wanted}.`);
      }

      if (dossier.relatedItems === null) {
        return skip("Could not read the parent");
      }

      const parent = dossier.relatedItems.find((item) => item.relation === "parent");

      if (!parent) {
        return skip("Could not read the parent");
      }

      return parent.kind && allowed.includes(parent.kind)
        ? PASS
        : fail(`Parent #${parent.id} is a ${parent.type}; it should be a ${wanted}.`);
    },
  },

  "tags-present": {
    needs: [],
    run: ({ dossier, params }) => {
      const tags = dossier.workItem.tags;

      if (tags.length === 0) {
        return fail("No tags.");
      }

      const vocabulary = dossier.profile.tagVocabulary.map((tag) => tag.toLowerCase());

      if (params.from_vocabulary && vocabulary.length > 0 && !tags.some((tag) => vocabulary.includes(tag.toLowerCase()))) {
        return fail(`None of the tags is from the project's list (${dossier.profile.tagVocabulary.join(", ")}).`, tags);
      }

      return PASS;
    },
  },

  "reference-links": {
    needs: [],
    run: ({ dossier }) => (dossier.hyperlinks.length > 0 ? PASS : fail("No reference link (hyperlink or URL in the description).")),
  },

  "time-fields-present": {
    needs: [],
    run: ({ dossier }) => {
      const { workItem } = dossier;
      const missing = [
        workItem.originalEstimate === null ? "Original Estimate" : null,
        workItem.remainingWork === null ? "Remaining Work" : null,
        workItem.completedWork === null ? "Completed Work" : null,
      ].filter((label): label is string => label !== null);

      return missing.length === 0 ? PASS : fail(`Missing: ${missing.join(", ")}.`, [], action(dossier, "WORK_ITEM_UPDATE_FIELDS"));
    },
  },

  "branch-linked": {
    needs: ["updates"],
    run: ({ dossier, params, now }) => {
      const active = enteredAt(dossier, "active");

      if (!active) {
        return skip("Work has not started");
      }

      const deadline = new Date(active.getTime() + (params.within_hours as number) * HOUR_MS);
      const linked = dossier.branches.map((branch) => branch.linkedAt).filter((date): date is Date => date !== null);

      if (dossier.branches.length > 0 && (linked.length === 0 || linked.some((date) => date <= deadline))) {
        return PASS;
      }

      if (dossier.branches.length > 0) {
        return fail(`Branch was linked after the ${params.within_hours}h window (deadline ${formatDate(deadline, dossier.profile.timeZone)}).`);
      }

      return now < deadline
        ? { status: "pending", message: `Link a branch by ${formatDate(deadline, dossier.profile.timeZone)}.` }
        : fail(`No branch linked within ${params.within_hours}h of starting work.`);
    },
  },

  "branch-name": {
    needs: [],
    run: ({ dossier }) => {
      const pattern = dossier.profile.branchPattern;

      if (dossier.branches.length === 0) {
        return skip("No branch linked");
      }

      if (!pattern) {
        return skip("The project has no branch pattern");
      }

      const regex = new RegExp(pattern.replaceAll("{id}", String(dossier.workItem.id)));
      const wrong = dossier.branches.filter((branch) => !regex.test(branch.refName) || !branch.refName.includes(String(dossier.workItem.id)));

      return wrong.length === 0
        ? PASS
        : fail(`Branch name does not follow the pattern ${pattern}.`, wrong.map((branch) => branch.refName));
    },
  },

  "transition-comment": {
    needs: ["updates", "comments"],
    run: ({ dossier, params, now }) => {
      if (dossier.stageHistory === null || dossier.comments === null) {
        return skip("History or comments unavailable");
      }

      const before = (params.minutes_before as number) * 60_000;
      const after = (params.hours_after as number) * HOUR_MS;
      const missing: string[] = [];
      let pending = false;

      for (const entry of dossier.stageHistory) {
        if (entry.initial || isServiceIdentity(entry)) {
          continue;
        }

        const windowEnd = new Date(entry.at.getTime() + after);

        if (hasComment(dossier, entry.by, new Date(entry.at.getTime() - before), windowEnd)) {
          continue;
        }

        if (now < windowEnd) {
          pending = true;
        } else {
          missing.push(`→ ${entry.value} on ${formatDate(entry.at, dossier.profile.timeZone)} by ${entry.by?.displayName ?? "unknown"}`);
        }
      }

      if (missing.length > 0) {
        return fail(`${missing.length} state change(s) without a comment from the person who made them.`, missing, action(dossier, "WORK_ITEM_COMMENT", { text: "" }));
      }

      return pending ? { status: "pending", message: "Add a comment explaining the latest state change." } : PASS;
    },
  },

  "pr-linked": {
    needs: [],
    run: ({ dossier }) =>
      dossier.workItem.links.pullRequests.length > 0 ? PASS : fail("No pull request linked.", [], action(dossier, "WORK_ITEM_LINK_PR")),
  },

  "pr-reviewer": {
    needs: ["pullRequests"],
    run: ({ dossier }) => {
      if (dossier.pullRequests === null) {
        return skip("Pull requests unavailable");
      }

      const open = dossier.pullRequests.filter((pr) => pr.status === "active");

      if (open.length === 0) {
        return skip("No active pull request");
      }

      const lonely = open.filter((pr) => !pr.reviewers.some((reviewer) => !sameActor(reviewer, pr.createdBy)));
      return lonely.length === 0 ? PASS : fail("Pull request has no reviewer besides its author.", lonely.map((pr) => `PR ${pr.pullRequestId}`));
    },
  },

  "pr-target-branch": {
    needs: ["pullRequests"],
    run: ({ dossier }) => {
      const target = dossier.profile.prTargetBranch;

      if (!target) {
        return skip("The project has no target branch configured");
      }

      if (dossier.pullRequests === null) {
        return skip("Pull requests unavailable");
      }

      const wrong = activePrs(dossier).filter((pr) => pr.targetBranch !== target);
      return wrong.length === 0
        ? PASS
        : fail(`Pull request targets the wrong branch; it should target ${target}.`, wrong.map((pr) => `PR ${pr.pullRequestId} → ${pr.targetBranch}`));
    },
  },

  "pr-approved-before-merge": {
    needs: ["pullRequests", "prThreads"],
    run: ({ dossier }) => {
      if (dossier.pullRequests === null) {
        return skip("Pull requests unavailable");
      }

      const merged = dossier.pullRequests.filter((pr) => pr.status === "completed");

      if (merged.length === 0) {
        return skip("No completed pull request");
      }

      // A pull request nobody was asked to review has no approval to wait for.
      const reviewed = merged.filter((pr) => pr.reviewers.some((reviewer) => !sameActor(reviewer, pr.createdBy)));

      if (reviewed.length === 0) {
        return skip("No reviewer on the merged pull request(s)");
      }

      const problems = reviewed.flatMap((pr) => [
        ...(pr.reviewers.some((reviewer) => reviewer.vote >= 5 && !sameActor(reviewer, pr.createdBy)) ? [] : [`PR ${pr.pullRequestId} merged without an approval`]),
        ...(pr.unresolvedThreads ? [`PR ${pr.pullRequestId} merged with ${pr.unresolvedThreads} open comment thread${pr.unresolvedThreads === 1 ? "" : "s"}`] : []),
      ]);

      return problems.length === 0 ? PASS : fail("Pull request merged without approval or with open comments.", problems);
    },
  },

  "daily-time-update": {
    needs: ["updates"],
    run: ({ dossier, params, now }) => {
      if (dossier.stageHistory === null || dossier.fieldChanges === null) {
        return skip("History unavailable");
      }

      const stages = params.stages as SopStage[];
      const timeZone = dossier.profile.timeZone;
      const today = localDay(now, timeZone);
      const logged = new Set(
        dossier.fieldChanges
          .filter((change) => change.field === WORK_ITEM_FIELDS.completedWork || change.field === WORK_ITEM_FIELDS.remainingWork)
          .map((change) => localDay(change.at, timeZone))
      );
      const missing = new Set<string>();

      dossier.stageHistory.forEach((entry, index) => {
        if (!entry.stage || !stages.includes(entry.stage)) {
          return;
        }

        const end = dossier.stageHistory?.[index + 1]?.at ?? now;
        const lastDay = localDay(end, timeZone);
        // The day work moved in is a partial day; checking starts the next day.
        for (let day = nextDay(localDay(entry.at, timeZone)); day <= lastDay && day < today; day = nextDay(day)) {
          if (!isWeekendDay(day) && !logged.has(day)) {
            missing.add(day);
          }
        }
      });

      if (missing.size === 0) {
        return PASS;
      }

      const days = [...missing].sort().reverse();
      return fail(`Time not updated on ${days.length} working day(s).`, days, action(dossier, "WORK_ITEM_UPDATE_FIELDS"));
    },
  },

  "estimate-change-comment": {
    needs: ["updates", "comments"],
    run: ({ dossier }) => {
      if (dossier.fieldChanges === null || dossier.comments === null) {
        return skip("History or comments unavailable");
      }

      const active = enteredAt(dossier, "active");

      if (!active) {
        return skip("Work has not started");
      }

      const changes = dossier.fieldChanges.filter((change) => {
        if (change.at < active || change.oldValue === null) {
          return false;
        }

        if (change.field === WORK_ITEM_FIELDS.originalEstimate || change.field === WORK_ITEM_FIELDS.storyPoints) {
          return change.oldValue !== change.newValue;
        }

        return change.field === WORK_ITEM_FIELDS.remainingWork && Number(change.newValue) > Number(change.oldValue);
      });
      const unexplained = changes.filter((change) => commentsOnDay(dossier, localDay(change.at, dossier.profile.timeZone), change.by).length === 0);

      return unexplained.length === 0
        ? PASS
        : fail(
            "Estimate changed without a comment the same day.",
            unexplained.map((change) => `${change.field.split(".").pop()} ${String(change.oldValue)} → ${String(change.newValue)} on ${formatDate(change.at, dossier.profile.timeZone)}`),
            action(dossier, "WORK_ITEM_COMMENT", { text: "" })
          );
    },
  },

  "due-date-change-comment": {
    needs: ["updates", "comments"],
    run: ({ dossier }) => {
      if (dossier.fieldChanges === null || dossier.comments === null) {
        return skip("History or comments unavailable");
      }

      const timeZone = dossier.profile.timeZone;
      const changes = dossier.fieldChanges.filter(
        (change) => change.field === WORK_ITEM_FIELDS.dueDate && change.oldValue !== null && change.newValue !== null
      );
      const unexplained = changes.filter((change) => {
        const oldDays = dueDateDays(change.oldValue, timeZone);
        const newDays = dueDateDays(change.newValue, timeZone);
        return !commentsOnDay(dossier, localDay(change.at, timeZone), change.by).some(
          (comment) => oldDays.some((day) => mentionsDate(comment.text, day)) && newDays.some((day) => mentionsDate(comment.text, day))
        );
      });

      return unexplained.length === 0
        ? PASS
        : fail(
            "Due date changed without a same-day comment giving the old and new date.",
            unexplained.map((change) => `${dueDateDays(change.oldValue, timeZone)[0]} → ${dueDateDays(change.newValue, timeZone)[0]}`),
            action(dossier, "WORK_ITEM_COMMENT", { text: "" })
          );
    },
  },

  "merged-before-stage": {
    needs: ["updates", "pullRequests"],
    run: ({ dossier, params }) => {
      const stage = params.stage as SopStage;
      // After rework, what counts is the latest move into the stage: a PR merged during rework is in time.
      const entered = latestEntryFromBelow(dossier, stage);

      if (!entered) {
        return skip(`Not in ${stage} yet`);
      }

      if (dossier.pullRequests === null) {
        return skip("Pull requests unavailable");
      }

      const late = activePrs(dossier).filter((pr) => pr.status !== "completed" || (pr.closedDate !== null && pr.closedDate > entered));
      return late.length === 0
        ? PASS
        : fail(
            `Moved to ${stage} before every pull request was merged.`,
            late.map((pr) => (pr.status === "completed" ? `PR ${pr.pullRequestId} merged after the move` : `PR ${pr.pullRequestId} is ${pr.status}`))
          );
    },
  },

  "linked-prs-completed": {
    needs: ["pullRequests"],
    run: ({ dossier }) => {
      if (dossier.pullRequests === null) {
        return skip("Pull requests unavailable");
      }

      const considered = activePrs(dossier);

      // Some tickets need no code change, so a missing pull request is only a notice.
      if (considered.length === 0) {
        return { ...fail("No pull request is linked.", [], action(dossier, "WORK_ITEM_LINK_PR")), notice: true };
      }

      const open = considered.filter((pr) => pr.status !== "completed");
      return open.length === 0 ? PASS : fail("A linked pull request is not merged.", open.map((pr) => `PR ${pr.pullRequestId} is ${pr.status}`));
    },
  },

  "time-logged-at-done": {
    needs: [],
    run: ({ dossier }) => {
      const completed = numberField(dossier, WORK_ITEM_FIELDS.completedWork);
      const remaining = numberField(dossier, WORK_ITEM_FIELDS.remainingWork) ?? 0;
      const problems = [
        positive(completed) ? null : "Completed Work is 0 or empty",
        remaining > 0 ? `Remaining Work is ${remaining}` : null,
      ].filter((problem): problem is string => problem !== null);

      return problems.length === 0
        ? PASS
        : fail(problems.join("; ") + ".", [], action(dossier, "WORK_ITEM_UPDATE_FIELDS", remaining > 0 && positive(completed) ? { remainingWork: 0 } : {}, !(remaining > 0 && positive(completed))));
    },
  },

  "linked-bugs-closed": {
    needs: ["relatedItems"],
    run: ({ dossier }) => {
      if (dossier.relatedItems === null) {
        return skip("Linked items unavailable");
      }

      const open = dossier.relatedItems.filter(
        (item) => item.kind === "bug" && item.relation !== "parent" && stageOf(dossier.profile, item.state) !== "done" && !["Closed", "Done", "Removed", "Resolved"].includes(item.state)
      );

      return open.length === 0 ? PASS : fail("A linked bug is still open.", open.map((item) => `#${item.id} (${item.state})`));
    },
  },

  "title-flag-format": {
    needs: [],
    run: ({ dossier }) => {
      const title = dossier.workItem.title.trim();

      if (FLAG_CANONICAL.test(title) || !FLAG_LIKE.test(title)) {
        return PASS;
      }

      return fail('Flags must be exactly "[Blocked]", "[On Hold]", "[Paused]" or "[Discuss]" at the start of the title.', [title]);
    },
  },

  "evidence-attached": {
    needs: ["updates"],
    run: ({ dossier, params }) => {
      const stage = params.before as SopStage;
      const entered = enteredAt(dossier, stage);

      if (!entered) {
        return skip(`Not in ${stage} yet`);
      }

      return dossier.attachments.some((attachment) => attachment.addedAt === null || attachment.addedAt <= entered)
        ? PASS
        : fail(`No attachment (evidence) before moving to ${stage}.`);
    },
  },

  "approach-present": {
    needs: ["comments"],
    run: ({ dossier, params }) => {
      const minSteps = params.min_steps as number;
      const found = findApproach(dossier, minSteps);

      if (found && found.steps >= minSteps) {
        return PASS;
      }

      return found
        ? fail(`The approach has ${found.steps} step${found.steps === 1 ? "" : "s"}; it needs at least ${minSteps}.`, [found.where], action(dossier, "WORK_ITEM_COMMENT", { text: "" }))
        : fail(
            `No technical approach found: a heading such as Approach, Pseudocode, Plan or Steps followed by at least ${minSteps} steps, in the description or a comment.`,
            [],
            action(dossier, "WORK_ITEM_COMMENT", { text: "" })
          );
    },
  },

  "tl-approval": {
    needs: ["comments", "updates"],
    run: ({ dossier }) => {
      const leads = dossier.profile.roles.tl;

      if (leads.length === 0) {
        return skip("The project has no team lead listed (SOP rules → Projects)");
      }

      if (dossier.comments === null) {
        return skip("Comments unavailable");
      }

      const approach = findApproach(dossier, 1);
      // The developer is whoever had the ticket when the lead commented (it may move to the lead later, e.g. for review).
      const byLead = commentsInOrder(dossier).filter((comment) => {
        const developer = assigneeAt(dossier, new Date(comment.createdDate));
        return isListedPerson(comment.createdBy, leads) && !(developer && sameActor(comment.createdBy, developer));
      });
      const approvals = byLead.filter((comment) => isApproval(comment.text));
      // An approval only counts after the approach (a description approach may be edited any time, so it has no date).
      const valid = approvals.filter((comment) => !approach?.at || new Date(comment.createdDate) >= approach.at);
      const quoted = (comments: typeof byLead) => comments.map((comment) => `${comment.createdBy.displayName}: ${comment.text.slice(0, 120)}`);

      if (valid.length > 0) {
        return PASS;
      }

      if (approvals.length > 0) {
        return fail("The team lead's approval was written before the approach.", quoted(approvals));
      }

      return fail(
        byLead.length > 0 ? "A team lead commented but did not approve the approach." : `No approval from a team lead (${leads.join(", ")}).`,
        quoted(byLead),
        action(dossier, "WORK_ITEM_COMMENT", { text: "" })
      );
    },
  },

  "dod-present": {
    needs: ["comments"],
    run: ({ dossier, params }) => {
      const minItems = params.min_items as number;
      const sources = [dossier.description, dossier.acceptanceCriteria, ...commentsInOrder(dossier).map((comment) => comment.text)];
      const found = sources.map(findDodSection).filter((section) => section !== null);

      if (found.some((section) => section.items >= minItems)) {
        return PASS;
      }

      return fail(
        found.length > 0
          ? `The Definition of Done has too few items; it needs at least ${minItems}.`
          : 'No Definition of Done (a "Definition of Done" or "DoD" section with items) in the description, acceptance criteria or comments.',
        found.map((section) => section.heading),
        action(dossier, "WORK_ITEM_COMMENT", { text: "" })
      );
    },
  },

  "stage-comment": {
    needs: ["updates", "comments", "pullRequests"],
    run: ({ dossier, params, now }) => {
      const stage = params.stage as SopStage;
      const requires = params.requires as StageCommentDetail[];

      if (dossier.comments === null) {
        return skip("Comments unavailable");
      }

      const entry = (dossier.stageHistory ?? []).filter((item) => item.stage === stage).at(-1);

      if (!entry) {
        return skip(`Never moved to ${stage}`);
      }

      const from = new Date(entry.at.getTime() - (params.minutes_before as number) * 60_000);
      const windowEnd = new Date(entry.at.getTime() + (params.hours_after as number) * HOUR_MS);
      // An automatic move (PR completion, pipeline) has no person to comment; anyone's comment counts then.
      const anyone = isServiceIdentity(entry);
      const candidates = dossier.comments.filter((comment) => {
        const at = new Date(comment.createdDate);
        return at >= from && at <= windowEnd && (anyone || sameActor(comment.createdBy, entry.by) || sameActor(comment.createdBy, dossier.workItem.assignedTo));
      });
      // Details that apply to this ticket (no branch linked: the branch is not required, and so on).
      const applicable = requires.filter((detail) => coversDetail(dossier, detail, "") !== null);
      const wanted = applicable.map((detail) => DETAIL_LABELS[detail]).join(", ");
      const best = candidates
        .map((comment) => ({ comment, missing: applicable.filter((detail) => !coversDetail(dossier, detail, comment.text)) }))
        .sort((a, b) => a.missing.length - b.missing.length)[0];
      const when = formatDate(entry.at, dossier.profile.timeZone);

      if (best && best.missing.length === 0) {
        return PASS;
      }

      if (now < windowEnd) {
        return { status: "pending", message: `Comment on the move to ${entry.value}${wanted ? ` with ${wanted}` : ""}.` };
      }

      if (best) {
        return fail(
          `The comment on the move to ${entry.value} (${when}) does not mention ${best.missing.map((detail) => DETAIL_LABELS[detail]).join(", ")}.`,
          [`${best.comment.createdBy.displayName}: ${best.comment.text.slice(0, 160)}`],
          action(dossier, "WORK_ITEM_COMMENT", { text: "" })
        );
      }

      return fail(
        `No comment when the ticket moved to ${entry.value} (${when}${entry.by ? ` by ${entry.by.displayName}` : ""}).`,
        wanted ? [`It should mention ${wanted}.`] : [],
        action(dossier, "WORK_ITEM_COMMENT", { text: "" })
      );
    },
  },

  "assigned-to-reviewer": {
    needs: ["updates", "pullRequests"],
    run: ({ dossier }) => {
      const history = dossier.stageHistory ?? [];
      const entered = history.filter((item) => item.stage === "review").at(-1);

      if (!entered) {
        return skip("Never in Review");
      }

      const left = history.find((item) => item.at > entered.at && item.stage !== "review");
      const assignee = left ? assigneeAt(dossier, left.at) : dossier.workItem.assignedTo;
      const reviewers = (dossier.pullRequests ?? []).flatMap((pr) => pr.reviewers.filter((reviewer) => !sameActor(reviewer, pr.createdBy)));
      const leads = dossier.profile.roles.tl;

      if (!assignee) {
        return fail("The ticket was unassigned while in Review.");
      }

      if (reviewers.some((reviewer) => sameActor(reviewer, assignee)) || isListedPerson(assignee, leads)) {
        return PASS;
      }

      // Nobody to compare with: it should at least have moved on from the developer.
      if (reviewers.length === 0 && leads.length === 0) {
        return sameActor(assignee, entered.by) ? fail(`In Review the ticket stayed with ${assignee.displayName}, who moved it there.`) : PASS;
      }

      return fail(
        `In Review the ticket was assigned to ${assignee.displayName}, not to a reviewer or team lead.`,
        [...new Set([...reviewers.map((reviewer) => reviewer.displayName), ...leads])].map((name) => `Could be: ${name}`)
      );
    },
  },
};

export function checkNeeds(card: CodeRuleCard): DossierNeed[] {
  return CODE_CHECKS[card.uses as BuiltinCheckName]?.needs ?? [];
}

export function runCodeCheck(card: CodeRuleCard, dossier: TicketDossier, now: Date): CheckOutcome {
  const check = CODE_CHECKS[card.uses as BuiltinCheckName];

  if (!check) {
    return skip(`Unknown check ${card.uses}`);
  }

  if (check.needs.includes("updates") && dossier.stageHistory === null) {
    return skip("History unavailable");
  }

  return check.run({ dossier, params: card.params, now });
}
