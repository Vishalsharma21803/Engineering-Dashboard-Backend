import { describe, expect, it } from "vitest";

import type { WorkItemSummary } from "../../src/types/azure.types.js";
import { WORK_ITEM_FIELDS } from "../../src/services/azure/work-items.service.js";
import { localDay, mentionsDate, runCodeCheck } from "../../src/services/sop/code-checker.js";
import type { TicketDossier } from "../../src/services/sop/dossier.js";
import { profileFromSettings, projectSettingsSchema } from "../../src/services/sop/project-settings.js";
import { parseRulebook } from "../../src/services/sop/rulebook.parser.js";
import type { CodeRuleCard, ProjectProfile, RuleCard } from "../../src/services/sop/rulebook.types.js";
import { evaluateDossier } from "../../src/services/sop/sop-evaluator.js";

// Wednesday 15 Oct 2025, 12:00 UTC
const NOW = new Date("2025-10-15T12:00:00Z");
const ME = { id: "me", displayName: "Me", uniqueName: "me@example.com" };
const OTHER = { id: "other", displayName: "Other", uniqueName: "other@example.com" };

const PROFILE: ProjectProfile = profileFromSettings(
  "Alpha",
  projectSettingsSchema.parse({
    stages: { ready: ["New"], active: ["Active"], review: ["Review"], testing: ["Testing"], done: ["Closed"] },
    prTargetBranch: "develop",
    timeZone: "Asia/Kolkata",
  })
);

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

  it("time-fields-present asks for the time fields only, not the due date", () => {
    const withDueDate = { ...PROFILE, fields: { ...PROFILE.fields, targetCompletion: WORK_ITEM_FIELDS.dueDate } };
    expect(run("time-fields-present", dossier({ profile: withDueDate })).status).toBe("pass");
    expect(run("time-fields-present", dossier({ workItem: workItem({ completedWork: null }) }))).toMatchObject({ status: "fail", message: "Missing: Completed Work." });
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
    expect(run("pr-target-branch", dossier({ pullRequests: [pr({ targetBranch: "main" })] }))).toMatchObject({ status: "fail", evidence: ["PR 7 → main"] });
    expect(run("pr-target-branch", dossier({ pullRequests: [pr({ targetBranch: "main", status: "abandoned" })] })).status).toBe("pass");

    const merged = pr({ status: "completed", closedDate: new Date("2025-10-10T05:00:00Z"), unresolvedThreads: 0 });
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [merged] })).status).toBe("fail");
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [{ ...merged, reviewers: [{ id: "other", displayName: "Other", vote: 10 }] }] })).status).toBe("pass");
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [{ ...merged, unresolvedThreads: 2, reviewers: [{ id: "other", displayName: "Other", vote: 10 }] }] })).status).toBe("fail");
    // Nobody was asked to review (or only the author): nothing to wait for, so it is not a gap.
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [{ ...merged, reviewers: [] }] }))).toMatchObject({ status: "skip" });
    expect(run("pr-approved-before-merge", dossier({ pullRequests: [{ ...merged, reviewers: [{ id: "me", displayName: "Me", vote: 0 }] }] })).status).toBe("skip");
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
  const effective = { projects: [PROFILE], cards: rulebook.cards as RuleCard[], issues: [], switchedOff: [], defaultVersion: 3, personalVersion: 1 };

  it("checks estimate rules at Estimation (a to-do there, a gap once moved on), or before work starts without an Estimation stage", () => {
    const estimate = parseRulebook(
      "---\nid: E-01\ntitle: Estimate exists\nchecker: code\nuses: estimate-present\napplies_to: [task]\nwhen: at-estimation\n---\n**Rule:** x\n",
      "default"
    ).cards as RuleCard[];
    const rules = { ...effective, cards: estimate };
    const noEstimate = workItem({ originalEstimate: null });
    const newTicket = { workItem: noEstimate, stage: "ready" as const, stageHistory: [] };

    // PROFILE has no Estimation stage: a New ticket has it as a to-do, an Active one as a gap.
    expect(evaluateDossier(dossier(newTicket), rules, NOW)).toMatchObject({ violations: [], todos: [expect.objectContaining({ ruleId: "E-01", phase: "now" })] });
    expect(evaluateDossier(dossier({ workItem: noEstimate }), rules, NOW).violations).toEqual([expect.objectContaining({ ruleId: "E-01", phase: "earlier" })]);

    const withEstimation = { ...PROFILE, stages: { ...PROFILE.stages, estimation: ["Estimations"] } };
    const inEstimation = [{ value: "Estimations", stage: "estimation" as const, at: new Date("2025-10-05T05:00:00Z"), by: ME, initial: false }];
    const estimating = dossier({ ...newTicket, profile: withEstimation, stage: "estimation", stageHistory: inEstimation });
    expect(evaluateDossier(estimating, rules, NOW)).toMatchObject({ violations: [], todos: [expect.objectContaining({ ruleId: "E-01" })] });
    // A New ticket in a project with Estimations shows nothing yet.
    expect(evaluateDossier(dossier({ ...newTicket, profile: withEstimation }), rules, NOW)).toMatchObject({ violations: [], todos: [] });
    const started = dossier({ workItem: noEstimate, profile: withEstimation, stageHistory: [...inEstimation, { value: "Active", stage: "active", at: new Date("2025-10-06T05:00:00Z"), by: ME, initial: false }] });
    expect(evaluateDossier(started, rules, NOW).violations).toEqual([expect.objectContaining({ ruleId: "E-01", phase: "earlier" })]);
  });

  it("makes a stage's rule a to-do while in that stage and a gap once the ticket moves past it, even if it moves back", () => {
    const review = parseRulebook(
      "---\nid: R-01\ntitle: PR linked\nchecker: code\nuses: pr-linked\napplies_to: [task]\nwhen: at-review\n---\n**Rule:** x\n",
      "default"
    ).cards as RuleCard[];
    const rules = { ...effective, cards: review };
    const at = (day: number) => new Date(`2025-10-${String(day).padStart(2, "0")}T05:00:00Z`);
    const moves = [
      { value: "Active", stage: "active" as const, at: at(6), by: ME, initial: false },
      { value: "Review", stage: "review" as const, at: at(8), by: ME, initial: false },
    ];

    expect(evaluateDossier(dossier(), rules, NOW)).toMatchObject({ violations: [], todos: [] });
    expect(evaluateDossier(dossier({ stage: "review", stageHistory: moves }), rules, NOW)).toMatchObject({ violations: [], todos: [expect.objectContaining({ ruleId: "R-01" })] });
    const testing = [...moves, { value: "Testing", stage: "testing" as const, at: at(9), by: ME, initial: false }];
    expect(evaluateDossier(dossier({ stage: "testing", stageHistory: testing }), rules, NOW).violations).toEqual([expect.objectContaining({ ruleId: "R-01", phase: "earlier" })]);
    const backToActive = [...testing, { value: "Active", stage: "active" as const, at: at(10), by: ME, initial: false }];
    expect(evaluateDossier(dossier({ stageHistory: backToActive }), rules, NOW).violations).toHaveLength(1);
  });

  it("gives Done items 24 hours, and waits while a closed ticket is reopened", () => {
    const done = parseRulebook(
      "---\nid: D-02\ntitle: Time logged\nchecker: code\nuses: time-logged-at-done\napplies_to: [task]\nwhen: at-done\n---\n**Rule:** x\n",
      "default"
    ).cards as RuleCard[];
    const rules = { ...effective, cards: done };
    const closedAt = (at: string) => ({
      workItem: workItem({ state: "Closed", stateCategory: "Completed", remainingWork: 2 }),
      stage: "done" as const,
      stageHistory: [{ value: "Closed", stage: "done" as const, at: new Date(at), by: ME, initial: false }],
    });

    expect(evaluateDossier(dossier(closedAt("2025-10-15T02:00:00Z")), rules, NOW)).toMatchObject({ violations: [], todos: [expect.objectContaining({ ruleId: "D-02" })] });
    expect(evaluateDossier(dossier(closedAt("2025-10-14T02:00:00Z")), rules, NOW).violations).toEqual([expect.objectContaining({ ruleId: "D-02", phase: "now" })]);
    const reopened = { ...closedAt("2025-10-14T02:00:00Z"), stage: "active" as const };
    expect(evaluateDossier(dossier(reopened), rules, NOW)).toMatchObject({ violations: [], todos: [] });
  });

  it("shows nothing for a ticket in a state the project does not map, and applies Always rules at once", () => {
    const rules = { ...effective, cards: parseRulebook("---\nid: F-01\ntitle: Flags\nchecker: code\nuses: title-flag-format\napplies_to: all\nwhen: always\n---\n**Rule:** x\n---\nid: T-01\ntitle: Tags\nchecker: code\nuses: tags-present\napplies_to: all\nwhen: before-active\n---\n**Rule:** x\n", "default").cards as RuleCard[] };
    const flagged = workItem({ title: "BLOCKED: waiting", state: "Proposed" });
    const result = evaluateDossier(dossier({ workItem: flagged, stage: null, stageHistory: [] }), rules, NOW);
    expect(result.violations).toEqual([expect.objectContaining({ ruleId: "F-01", phase: "now" })]);
    expect(result.todos).toEqual([]);
  });

  it("only runs rules for this kind once their stage is reached, and explains missing stages", () => {
    const result = evaluateDossier(dossier({ workItem: workItem({ originalEstimate: null }) }), effective, NOW);

    expect(result.violations).toEqual([expect.objectContaining({ ruleId: "A-01", severity: "high" })]);
    // A-02: not in testing yet, so not listed. A-04: stories only.
    expect(result.passedRules).toEqual([]);
    expect(result.skippedRules).toEqual([{ ruleId: "A-03", ruleTitle: "Evidence before UAT", reason: "Alpha has no uat stage" }]);
    expect(result.rulebook).toEqual({ defaultVersion: 3, personalVersion: 1 });
  });

  it("lists a check whose own window is still open as a to-do, whatever its level", () => {
    const rules = parseRulebook(
      "---\nid: N-02\ntitle: Branch linked\nchecker: code\nuses: branch-linked\nparams: { within_hours: 24 }\napplies_to: [task]\nwhen: while-active\nseverity: notice\n---\n**Rule:** x\n",
      "default"
    ).cards as RuleCard[];
    const justStarted = dossier({ stageHistory: [{ value: "Active", stage: "active", at: new Date("2025-10-15T06:00:00Z"), by: ME, initial: false }] });
    const result = evaluateDossier(justStarted, { ...effective, cards: rules }, NOW);

    expect(result.todos).toEqual([expect.objectContaining({ ruleId: "N-02", severity: "low", message: expect.stringContaining("Link a branch by") })]);
    expect(result.notices).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("lists notice rules as notices, never as gaps", () => {
    const rules = parseRulebook(
      "---\nid: N-01\ntitle: Tags are set\nchecker: code\nuses: tags-present\napplies_to: [task]\nwhen: before-active\nseverity: notice\n---\n**Rule:** x\n",
      "default"
    ).cards as RuleCard[];
    const result = evaluateDossier(dossier(), { ...effective, cards: rules }, NOW);

    expect(result.violations).toEqual([]);
    expect(result.notices).toEqual([expect.objectContaining({ ruleId: "N-01", severity: "low" })]);
  });

  it("treats a closed ticket without any pull request as a notice, but an unmerged one as a gap", () => {
    const rules = parseRulebook(
      "---\nid: D-01\ntitle: PRs merged\nchecker: code\nuses: linked-prs-completed\napplies_to: [task]\nwhen: at-done\n---\n**Rule:** x\n",
      "default"
    ).cards as RuleCard[];
    const closed = {
      workItem: workItem({ state: "Closed", stateCategory: "Completed" }),
      stage: "done" as const,
      stageHistory: [{ value: "Closed", stage: "done" as const, at: new Date("2025-10-10T05:00:00Z"), by: ME, initial: false }],
    };
    const openPr = { pullRequestId: 7, title: "x", status: "active", createdBy: ME, closedDate: null, targetBranch: "develop", reviewers: [], unresolvedThreads: null };

    const noPr = evaluateDossier(dossier(closed), { ...effective, cards: rules }, NOW);
    expect(noPr.violations).toEqual([]);
    expect(noPr.notices).toEqual([expect.objectContaining({ ruleId: "D-01", message: "No pull request is linked." })]);

    const unmerged = evaluateDossier(dossier({ ...closed, pullRequests: [openPr] as TicketDossier["pullRequests"] }), { ...effective, cards: rules }, NOW);
    expect(unmerged.notices).toEqual([]);
    expect(unmerged.violations).toEqual([expect.objectContaining({ ruleId: "D-01", severity: "medium" })]);
  });
});

describe("WI-002 text checks", () => {
  const LEAD = { id: "lead", displayName: "Ravi Kumar", uniqueName: "ravi@example.com" };
  const withLead = { ...PROFILE, roles: { tl: ["Ravi Kumar"], qa: [], po: [] } };

  it("approach-present finds the approach in the description or a comment, in any wording", () => {
    expect(run("approach-present", dossier({ description: "PSEUDO CODE:\n1. a b\n2. c d\n3. e f" }), { min_steps: 3 }).status).toBe("pass");
    expect(run("approach-present", dossier({ comments: [comment("plan - \n- add table\n- issue jwt\n- refresh", "2025-10-05T05:00:00Z")] }), { min_steps: 3 }).status).toBe("pass");
    expect(run("approach-present", dossier({ description: "Approach: will do it using JWT." }), { min_steps: 3 })).toMatchObject({ status: "fail", message: "The approach has 1 step; it needs at least 3." });
    expect(run("approach-present", dossier(), { min_steps: 3 })).toMatchObject({ status: "fail", message: expect.stringContaining("No technical approach found") });
    // A bug's "Steps:" in its description are how to reproduce it.
    expect(run("approach-present", dossier({ kind: "bug", description: "Steps:\n1. open the app\n2. click save\n3. see the error" }), { min_steps: 3 }).status).toBe("fail");
  });

  it("tl-approval needs a listed lead's approval after the approach, not the developer's", () => {
    const approach = comment("Approach:\n1. a b\n2. c d\n3. e f", "2025-10-05T05:00:00Z");
    const approve = (text: string, at: string, by = LEAD) => comment(text, at, by);

    expect(run("tl-approval", dossier({ comments: [approach] })).status).toBe("skip");
    expect(run("tl-approval", dossier({ profile: withLead, comments: [approach, approve("LGTM, go ahead", "2025-10-05T07:00:00Z")] })).status).toBe("pass");
    expect(run("tl-approval", dossier({ profile: withLead, comments: [approve("Approved", "2025-10-04T07:00:00Z"), approach] }))).toMatchObject({
      status: "fail",
      message: "The team lead's approval was written before the approach.",
    });
    expect(run("tl-approval", dossier({ profile: withLead, comments: [approach, approve("Can you add more detail?", "2025-10-05T07:00:00Z")] }))).toMatchObject({
      status: "fail",
      message: "A team lead commented but did not approve the approach.",
    });
    // The lead approving their own ticket does not count.
    const ownTicket = dossier({ profile: withLead, workItem: workItem({ assignedTo: LEAD }), comments: [approach, approve("approved", "2025-10-05T07:00:00Z")] });
    expect(run("tl-approval", ownTicket).status).toBe("fail");
    // Moving the ticket to the lead later (e.g. for review) does not undo their earlier approval.
    const reassigned = dossier({
      profile: withLead,
      workItem: workItem({ assignedTo: LEAD }),
      comments: [approach, approve("approved", "2025-10-05T07:00:00Z")],
      fieldChanges: [{ field: WORK_ITEM_FIELDS.assignedTo, at: new Date("2025-10-09T05:00:00Z"), by: ME, oldValue: ME, newValue: LEAD }],
    });
    expect(run("tl-approval", reassigned).status).toBe("pass");
    // An approach in the description has no date, so any later approval counts.
    expect(run("tl-approval", dossier({ profile: withLead, description: "Plan:\n- a b\n- c d\n- e f", comments: [approve("looks good", "2025-10-01T07:00:00Z")] })).status).toBe("pass");
  });

  it("dod-present looks in the description, acceptance criteria and comments", () => {
    expect(run("dod-present", dossier({ acceptanceCriteria: "1. Export works\n\nDefinition of Done:\n- merged\n- deployed" }), { min_items: 1 }).status).toBe("pass");
    expect(run("dod-present", dossier({ comments: [comment("DoD: merged, tests green", "2025-10-05T05:00:00Z")] }), { min_items: 2 }).status).toBe("pass");
    expect(run("dod-present", dossier({ description: "AC/DoD reviewed" }), { min_items: 1 })).toMatchObject({ status: "fail", message: expect.stringContaining("No Definition of Done") });
  });

  describe("stage-comment", () => {
    const active = { value: "Active", stage: "active" as const, at: new Date("2025-10-06T05:00:00Z"), by: ME, initial: false };
    const starting = (text: string, at = "2025-10-06T06:00:00Z", by = ME) => comment(text, at, by);
    const params = { stage: "active", requires: ["eta-date", "ac-dod", "approver", "branch", "target-branch"] };

    it("passes when one comment by the mover covers every detail, in any wording", () => {
      const branch = [{ refName: "feature/42-export", linkedAt: null }];
      const text = "Starting work; branch feature/42-export from DEVELOP; ac/dod reviewed; approach approved by Ravi; eta 28 Oct";
      expect(run("stage-comment", dossier({ branches: branch, comments: [starting(text)] }), params).status).toBe("pass");
    });

    it("does not ask for the branch or the base branch when no branch is linked", () => {
      const text = "Starting work; AC/DoD reviewed; approach approved by Ravi; ETA 28 Oct";
      expect(run("stage-comment", dossier({ comments: [starting(text)] }), params).status).toBe("pass");
    });

    it("does not ask for the branch when none is linked, and names what is missing", () => {
      const outcome = run("stage-comment", dossier({ comments: [starting("Starting work from develop, ETA Friday")] }), params);
      expect(outcome).toMatchObject({ status: "fail", message: expect.stringContaining("does not mention that AC/DoD were reviewed, who approved the approach") });
      expect(outcome.status === "fail" && outcome.message).not.toContain("branch name");
    });

    it("is a to-do while its window is open and a gap without any comment after it", () => {
      const fresh = { ...active, at: new Date("2025-10-15T06:00:00Z") };
      expect(run("stage-comment", dossier({ stageHistory: [fresh] }), params)).toMatchObject({ status: "pending", message: expect.stringContaining("Comment on the move to Active with an ETA date") });
      expect(run("stage-comment", dossier({ stageHistory: [active] }), params)).toMatchObject({ status: "fail", message: expect.stringContaining("No comment when the ticket moved to Active") });
      // Someone else's comment does not count.
      expect(run("stage-comment", dossier({ stageHistory: [active], comments: [starting("ETA Friday, AC reviewed, approved by Ravi, develop", undefined, OTHER)] }), params).status).toBe("fail");
    });

    it("accepts anyone's comment after an automatic move, and checks PR number, tests and reviewer for review", () => {
      const pr = { pullRequestId: 551, title: "x", status: "active", createdBy: ME, closedDate: null, targetBranch: "develop", reviewers: [{ id: "lead", displayName: "Ravi Kumar", vote: 0 }], unresolvedThreads: null };
      const review = { value: "Review", stage: "review" as const, at: new Date("2025-10-08T05:00:00Z"), by: { id: null, displayName: "Project Collection Build Service", uniqueName: null }, initial: false };
      const ticket = (text: string) =>
        dossier({
          workItem: workItem({ links: { pullRequests: [{ projectId: "p", repositoryId: "r", pullRequestId: 551 }], commits: [], branches: [], builds: [], parentId: null, childIds: [] } as WorkItemSummary["links"] }),
          stageHistory: [active, review],
          pullRequests: [pr] as TicketDossier["pullRequests"],
          comments: [comment(text, "2025-10-08T06:00:00Z", OTHER)],
        });
      const reviewParams = { stage: "review", requires: ["pr-number", "tests", "reviewer"] };
      expect(run("stage-comment", ticket("PR !551 up, unit tests green, ravi please review"), reviewParams).status).toBe("pass");
      expect(run("stage-comment", ticket("PR 551 up"), reviewParams)).toMatchObject({ status: "fail", message: expect.stringContaining("the test status, the reviewer") });
    });
  });

  it("assigned-to-reviewer wants a PR reviewer or a lead while in Review", () => {
    const review = [{ value: "Review", stage: "review" as const, at: new Date("2025-10-08T05:00:00Z"), by: ME, initial: false }];
    const pr = { pullRequestId: 7, title: "x", status: "active", createdBy: ME, closedDate: null, targetBranch: "develop", reviewers: [{ id: "lead", displayName: "Ravi Kumar", vote: 0 }], unresolvedThreads: null };
    const inReview = (assignedTo: typeof ME | null, extra: Partial<TicketDossier> = {}) =>
      dossier({ workItem: workItem({ state: "Review", assignedTo }), stage: "review", stageHistory: review, pullRequests: [pr] as TicketDossier["pullRequests"], ...extra });

    expect(run("assigned-to-reviewer", inReview(LEAD)).status).toBe("pass");
    expect(run("assigned-to-reviewer", inReview(ME))).toMatchObject({ status: "fail", evidence: ["Could be: Ravi Kumar"] });
    expect(run("assigned-to-reviewer", inReview(null)).status).toBe("fail");
    // Without reviewers or leads it only has to move on from the developer.
    expect(run("assigned-to-reviewer", inReview(OTHER, { pullRequests: [] })).status).toBe("pass");
    // After Review, the assignee at the time counts (from the assignment history).
    const moved = dossier({
      workItem: workItem({ assignedTo: ME }),
      stage: "testing",
      stageHistory: [...review, { value: "Testing", stage: "testing", at: new Date("2025-10-09T05:00:00Z"), by: LEAD, initial: false }],
      pullRequests: [pr] as TicketDossier["pullRequests"],
      fieldChanges: [
        { field: WORK_ITEM_FIELDS.assignedTo, at: new Date("2025-10-08T05:05:00Z"), by: ME, oldValue: ME, newValue: LEAD },
        { field: WORK_ITEM_FIELDS.assignedTo, at: new Date("2025-10-09T05:05:00Z"), by: LEAD, oldValue: LEAD, newValue: ME },
      ],
    });
    expect(run("assigned-to-reviewer", moved).status).toBe("pass");
  });
});
