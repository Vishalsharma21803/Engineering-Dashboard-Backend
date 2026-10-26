import { describe, expect, it } from "vitest";

import type { WorkItemSummary } from "../../src/types/azure.types.js";
import { WORK_ITEM_FIELDS } from "../../src/services/azure/work-items.service.js";
import { localDay, mentionsDate, runCodeCheck } from "../../src/services/sop/code-checker.js";
import type { TicketDossier } from "../../src/services/sop/dossier.js";
import { parseRulebook } from "../../src/services/sop/rulebook.parser.js";
import type { CodeRuleCard, ProjectProfile, RuleCard } from "../../src/services/sop/rulebook.types.js";
import { evaluateDossier } from "../../src/services/sop/sop-evaluator.js";

// Wednesday 15 Oct 2025, 12:00 UTC
const NOW = new Date("2025-10-15T12:00:00Z");
const ME = { id: "me", displayName: "Me", uniqueName: "me@example.com" };
const OTHER = { id: "other", displayName: "Other", uniqueName: "other@example.com" };

const PROFILE = parseRulebook(
  `---
kind: project
project: Alpha
stages:
  ready: [New]
  active: [Active]
  review: [Review]
  testing: [Testing]
  done: [Closed]
pr_target_branch: develop
timezone: Asia/Kolkata
---
`,
  "default"
).projects[0] as ProjectProfile;

function workItem(overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id: 42,
    rev: 5,
    projectName: "Alpha",
    type: "Task",
    title: "Add export button",
    state: "Active",
    stateCategory: "InProgress",
    reason: null,
    priority: 2,
    assignedTo: ME,
    iterationPath: null,
    areaPath: "Alpha\\Web",
    tags: [],
    originalEstimate: 8,
    remainingWork: 4,
    completedWork: 4,
    storyPoints: null,
    effort: null,
    dueDate: null,
    blocked: false,
    createdDate: "2025-10-01T05:00:00Z",
    changedDate: "2025-10-14T05:00:00Z",
    stateChangeDate: "2025-10-06T05:00:00Z",
    closedDate: null,
    commentCount: 0,
    links: { pullRequests: [], commits: [], branches: [], builds: [], parentId: null, childIds: [] },
    webUrl: "https://dev.azure.com/org/Alpha/_workitems/edit/42",
    ...overrides,
  };
}

function dossier(overrides: Partial<TicketDossier> = {}): TicketDossier {
  const item = overrides.workItem ?? workItem();
  return {
    workItem: item,
    fields: {
      [WORK_ITEM_FIELDS.completedWork]: item.completedWork,
      [WORK_ITEM_FIELDS.remainingWork]: item.remainingWork,
    },
    profile: PROFILE,
    kind: "task",
    stage: "active",
    description: "",
    acceptanceCriteria: "",
    reproSteps: "",
    hyperlinks: [],
    attachments: [],
    branches: [],
    stageHistory: [
      { value: "New", stage: "ready", at: new Date("2025-10-01T05:00:00Z"), by: ME, initial: true },
      { value: "Active", stage: "active", at: new Date("2025-10-06T05:00:00Z"), by: ME, initial: false },
    ],
    fieldChanges: [],
    comments: [],
    pullRequests: [],
    relatedItems: [],
    ...overrides,
  };
}

function card(uses: string, params: Record<string, unknown> = {}, extra: Partial<CodeRuleCard> = {}): CodeRuleCard {
  const header = `---\nid: X-01\ntitle: Test rule\nchecker: code\nuses: ${uses}\nparams: ${JSON.stringify(params)}\napplies_to: all\nwhen: always\n---\n**Rule:** x\n`;
  const parsed = parseRulebook(header, "default");
  expect(parsed.errors).toEqual([]);
  return { ...(parsed.cards[0] as CodeRuleCard), ...extra };
}

function comment(text: string, createdDate: string, by = ME) {
  return { id: Math.random(), text, createdBy: by, createdDate, modifiedDate: null };
}

const run = (uses: string, d: TicketDossier, params: Record<string, unknown> = {}) => runCodeCheck(card(uses, params), d, NOW);

describe("simple field checks", () => {
  it("title-length rejects long titles and trailing periods", () => {
    expect(run("title-length", dossier()).status).toBe("pass");
    expect(run("title-length", dossier({ workItem: workItem({ title: "Fix it." }) }))).toMatchObject({ status: "fail", message: "Title ends with a period." });
    expect(run("title-length", dossier({ workItem: workItem({ title: "Fix" }) }))).toMatchObject({ status: "fail" });
  });

  it("title-flag-format accepts only the exact bracketed flags at the start", () => {
    const status = (title: string) => run("title-flag-format", dossier({ workItem: workItem({ title }) })).status;
    expect(status("[Blocked] Waiting for API keys")).toBe("pass");
    expect(status("[On Hold] Budget review")).toBe("pass");
    expect(status("Fix blocked - user cannot login")).toBe("pass");
    expect(status("BLOCKED: waiting for vendor")).toBe("fail");
    expect(status("(paused) migrate db")).toBe("fail");
    expect(status("Migrate db [on hold]")).toBe("fail");
    expect(status("[blocked] lower case")).toBe("fail");
  });

  it("estimate-present wants story points for stories and hours for tasks and bugs", () => {
    expect(run("estimate-present", dossier({ kind: "bug", workItem: workItem({ originalEstimate: null, storyPoints: 3 }) })).status).toBe("fail");
    expect(run("estimate-present", dossier({ kind: "story", workItem: workItem({ originalEstimate: null, storyPoints: 3 }) })).status).toBe("pass");
    expect(run("estimate-present", dossier({ kind: "epic" })).status).toBe("skip");
  });

  it("field-present reads configured fields and skips unconfigured ones", () => {
    expect(run("field-present", dossier(), { field: "category" })).toMatchObject({ status: "skip" });
    const withCategory = { ...PROFILE, fields: { category: "Microsoft.VSTS.Common.Activity", targetCompletion: null } };
    expect(run("field-present", dossier({ profile: withCategory }), { field: "category" })).toMatchObject({ status: "fail", message: "Category is not set." });
    expect(run("field-present", dossier({ profile: withCategory, fields: { "Microsoft.VSTS.Common.Activity": "Development" } }), { field: "category" }).status).toBe("pass");
    expect(run("field-present", dossier({ description: "short" }), { field: "description", min_length: 20 }).status).toBe("fail");
  });

  it("time-logged-at-done proposes zeroing remaining work only when completed work exists", () => {
    const outcome = run("time-logged-at-done", dossier());
    expect(outcome).toMatchObject({ status: "fail", action: { kind: "WORK_ITEM_UPDATE_FIELDS", params: { remainingWork: 0 }, requiresInput: false } });
    const nothingLogged = dossier({ fields: { [WORK_ITEM_FIELDS.remainingWork]: 0 } });
    expect(run("time-logged-at-done", nothingLogged)).toMatchObject({ status: "fail", message: "Completed Work is 0 or empty.", action: { requiresInput: true } });
  });
});

describe("history-based checks", () => {
  it("transition-comment needs a comment by the mover within the window", () => {
    const moved = dossier();
    expect(run("transition-comment", moved)).toMatchObject({ status: "fail", evidence: [expect.stringContaining("→ Active")] });

    // A comment 30 minutes before by the same person counts; by someone else it does not.
    expect(run("transition-comment", dossier({ comments: [comment("Starting", "2025-10-06T04:30:00Z")] })).status).toBe("pass");
    expect(run("transition-comment", dossier({ comments: [comment("Starting", "2025-10-06T04:30:00Z", OTHER)] })).status).toBe("fail");

    // A transition 2 hours ago is still within its 24h window.
    const recent = dossier({
      stageHistory: [{ value: "Review", stage: "review", at: new Date("2025-10-15T10:00:00Z"), by: ME, initial: false }],
    });
    expect(run("transition-comment", recent).status).toBe("pending");

    // Automatic transitions are ignored.
    const automatic = dossier({
      stageHistory: [{ value: "Closed", stage: "done", at: new Date("2025-10-06T05:00:00Z"), by: { id: "svc", displayName: "Alpha Build Service (org)", uniqueName: "build" }, initial: false }],
    });
    expect(run("transition-comment", automatic).status).toBe("pass");
  });

  it("daily-time-update lists missed working days in the team's time zone", () => {
    const logged = (at: string) => ({ field: WORK_ITEM_FIELDS.completedWork, at: new Date(at), by: ME, oldValue: 1, newValue: 2 });
    // Active since Mon 6 Oct. Working days to check: 7, 8, 9, 10, 13, 14 (not the 6th, not today the 15th).
    const outcome = run(
      "daily-time-update",
      dossier({
        fieldChanges: [
          logged("2025-10-07T06:00:00Z"),
          logged("2025-10-08T06:00:00Z"),
          logged("2025-10-09T06:00:00Z"),
          // 23:00 IST on the 10th is 17:30 UTC on the 10th.
          logged("2025-10-10T17:30:00Z"),
          // 01:00 IST on the 14th is still the 13th in UTC; it counts for the 14th in Kolkata.
          logged("2025-10-13T19:30:00Z"),
        ],
      }),
      { stages: ["active"] }
    );
    expect(outcome).toMatchObject({ status: "fail", message: "Time not updated on 1 working day(s).", evidence: ["2025-10-13"] });
  });

  it("estimate-change-comment flags unexplained changes after work started", () => {
    const change = { field: WORK_ITEM_FIELDS.originalEstimate, at: new Date("2025-10-08T06:00:00Z"), by: ME, oldValue: 8, newValue: 12 };
    const before = { ...change, at: new Date("2025-10-02T06:00:00Z") };
    const down = { field: WORK_ITEM_FIELDS.remainingWork, at: new Date("2025-10-09T06:00:00Z"), by: ME, oldValue: 6, newValue: 4 };

    expect(run("estimate-change-comment", dossier({ fieldChanges: [change, before, down] }))).toMatchObject({ status: "fail", evidence: [expect.stringContaining("OriginalEstimate 8 → 12")] });
    expect(run("estimate-change-comment", dossier({ fieldChanges: [change], comments: [comment("Scope grew: export to CSV too", "2025-10-08T11:00:00Z")] })).status).toBe("pass");
  });

  it("due-date-change-comment needs both dates in a same-day comment", () => {
    const change = { field: WORK_ITEM_FIELDS.dueDate, at: new Date("2025-10-08T06:00:00Z"), by: ME, oldValue: "2025-10-09T18:30:00Z", newValue: "2025-10-13T18:30:00Z" };
    const withComment = (text: string) => run("due-date-change-comment", dossier({ fieldChanges: [change], comments: [comment(text, "2025-10-08T07:00:00Z")] })).status;

    // Stored as midnight IST: the 10th and the 14th in Kolkata.
    expect(withComment("Moved due date from 10 Oct to 14 Oct because the API is late")).toBe("pass");
    expect(withComment("Due date 10/10/2025 -> 14/10/2025, waiting on vendor")).toBe("pass");
    expect(withComment("Moved the due date, vendor is late")).toBe("fail");
    expect(run("due-date-change-comment", dossier({ fieldChanges: [{ ...change, oldValue: null }] })).status).toBe("pass");
  });

  it("mentionsDate understands common formats", () => {
    expect(mentionsDate("new date is October 14th", "2025-10-14")).toBe(true);
    expect(mentionsDate("new date 2025-10-14", "2025-10-14")).toBe(true);
    expect(mentionsDate("new date 14.10.25", "2025-10-14")).toBe(true);
    expect(mentionsDate("new date 14 Nov", "2025-10-14")).toBe(false);
    expect(localDay(new Date("2025-10-13T19:30:00Z"), "Asia/Kolkata")).toBe("2025-10-14");
  });
});

describe("links and pull requests", () => {
  const pr = (overrides: Record<string, unknown> = {}) => ({
    pullRequestId: 7,
    title: "Add export",
    status: "active",
    createdBy: ME,
    closedDate: null,
    targetBranch: "develop",
    reviewers: [{ id: "other", displayName: "Other", vote: 0 }],
    unresolvedThreads: null,
    ...overrides,
  });

  it("branch-linked uses the link time against the window", () => {
    expect(run("branch-linked", dossier(), { within_hours: 24 })).toMatchObject({ status: "fail", message: "No branch linked within 24h of starting work." });
    expect(run("branch-linked", dossier({ branches: [{ refName: "feature/42-export", linkedAt: new Date("2025-10-06T09:00:00Z") }] })).status).toBe("pass");
    expect(run("branch-linked", dossier({ branches: [{ refName: "feature/42-export", linkedAt: new Date("2025-10-09T09:00:00Z") }] })).status).toBe("fail");
    const justStarted = dossier({ stageHistory: [{ value: "Active", stage: "active", at: new Date("2025-10-15T08:00:00Z"), by: ME, initial: false }] });
    expect(run("branch-linked", justStarted).status).toBe("pending");
  });

  it("branch-name checks the pattern with the ticket id", () => {
    const named = (refName: string) => run("branch-name", dossier({ branches: [{ refName, linkedAt: null }] })).status;
    expect(named("feature/42-export-button")).toBe("pass");
    expect(named("feature/AB-42-export")).toBe("pass");
    expect(named("feature/43-export")).toBe("fail");
    expect(named("export-button")).toBe("fail");
    expect(run("branch-name", dossier()).status).toBe("skip");
  });

  it("pr-reviewer, pr-target-branch and pr-approved-before-merge", () => {
    expect(run("pr-reviewer", dossier({ pullRequests: [pr()] })).status).toBe("pass");
    expect(run("pr-reviewer", dossier({ pullRequests: [pr({ reviewers: [{ id: "me", displayName: "Me", vote: 10 }] })] })).status).toBe("fail");
    expect(run("pr-target-branch", dossier({ pullRequests: [pr({ targetBranch: "main" })] }))).toMatchObject({ status: "fail", evidence: ["PR !7 → main"] });
    expect(run("pr-target-branch", dossier({ pullRequests: [pr({ targetBranch: "main", status: "abandoned" })] })).status).toBe("pass");

    const merged = pr({ status: "completed", closedDate: new Date("2025-10-10T05:00:00Z"), unresolvedThreads: 0 });
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [merged] })).status).toBe("fail");
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [{ ...merged, reviewers: [{ id: "other", displayName: "Other", vote: 10 }] }] })).status).toBe("pass");
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [{ ...merged, unresolvedThreads: 2, reviewers: [{ id: "other", displayName: "Other", vote: 10 }] }] })).status).toBe("fail");
  });

  it("merged-before-stage compares merge time with the stage entry", () => {
    const history = [
      { value: "Active", stage: "active" as const, at: new Date("2025-10-06T05:00:00Z"), by: ME, initial: false },
      { value: "Testing", stage: "testing" as const, at: new Date("2025-10-10T05:00:00Z"), by: ME, initial: false },
    ];
    const at = (closedDate: string) =>
      run("merged-before-stage", dossier({ stage: "testing", stageHistory: history, pullRequests: [pr({ status: "completed", closedDate: new Date(closedDate) })] }), { stage: "testing" }).status;

    expect(at("2025-10-09T05:00:00Z")).toBe("pass");
    expect(at("2025-10-11T05:00:00Z")).toBe("fail");
    expect(run("merged-before-stage", dossier(), { stage: "testing" }).status).toBe("skip");
  });

  it("parent-link and linked-bugs-closed use related items", () => {
    const withParent = (type: string, kind: "story" | "epic") =>
      run("parent-link", dossier({ workItem: workItem({ links: { ...workItem().links, parentId: 9 } }), relatedItems: [{ id: 9, relation: "parent", type, state: "Active", kind }] })).status;

    expect(withParent("User Story", "story")).toBe("pass");
    expect(withParent("Epic", "epic")).toBe("fail");
    expect(run("parent-link", dossier()).status).toBe("fail");

    const bugs = (state: string) => run("linked-bugs-closed", dossier({ relatedItems: [{ id: 11, relation: "related", type: "Bug", state, kind: "bug" }] })).status;
    expect(bugs("Closed")).toBe("pass");
    expect(bugs("Active")).toBe("fail");
  });
});

describe("evaluateDossier", () => {
  const rulebook = parseRulebook(
    `---
id: A-01
title: Estimate exists
checker: code
uses: estimate-present
applies_to: [task]
when: before-active
severity: fail
---
**Rule:** x
---
id: A-02
title: Merged before testing
checker: code
uses: merged-before-stage
applies_to: [task]
when: at-testing
---
**Rule:** x
---
id: A-03
title: Evidence before UAT
checker: code
uses: evidence-attached
applies_to: [task]
when: at-uat
---
**Rule:** x
---
id: A-04
title: Stories only
checker: code
uses: pr-linked
applies_to: [story]
when: always
---
**Rule:** x
`,
    "default"
  );
  const effective = { projects: [PROFILE], cards: rulebook.cards as RuleCard[], issues: [], defaultVersion: 3, personalVersion: 1 };

  it("only runs rules for this kind once their stage is reached, and explains missing stages", () => {
    const result = evaluateDossier(dossier({ workItem: workItem({ originalEstimate: null }) }), effective, NOW);

    expect(result.violations).toEqual([expect.objectContaining({ ruleId: "A-01", severity: "high" })]);
    // A-02: not in testing yet, so not listed. A-04: stories only.
    expect(result.passedRules).toEqual([]);
    expect(result.skippedRules).toEqual([{ ruleId: "A-03", ruleTitle: "Evidence before UAT", reason: "Alpha has no uat stage" }]);
    expect(result.rulebook).toEqual({ defaultVersion: 3, personalVersion: 1 });
  });
});
