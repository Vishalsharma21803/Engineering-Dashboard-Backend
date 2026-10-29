import { describe, expect, it } from "vitest";

import { findApproachSection, findDodSection, inlineSteps, isApproval, isListItem, mentionsAnyDate, mentionsPullRequest } from "../../src/services/sop/sop-text.js";

const steps = (text: string) => findApproachSection(text)?.items ?? null;

describe("approach headings", () => {
  it.each([
    "Approach:\n1. Add table\n2. Issue JWT\n3. Refresh endpoint",
    "APPROACH\n- add table\n- issue JWT\n- refresh endpoint",
    "approach -\n* add table\n* issue JWT\n* refresh endpoint",
    "Pseudocode:\n1) add table\n2) issue JWT\n3) refresh endpoint",
    "pseudo code\n• add table\n• issue JWT\n• refresh endpoint",
    "Pseudo-Code:\na) add table\nb) issue JWT\nc) refresh endpoint",
    "psuedo code:\n1. add table\n2. issue JWT\n3. refresh endpoint",
    "## Plan\n1. add table\n2. issue JWT\n3. refresh endpoint",
    "**Technical approach**\nStep 1: add table\nStep 2: issue JWT\nStep 3: refresh endpoint",
    "Implementation plan:\n(1) add table\n(2) issue JWT\n(3) refresh endpoint",
    "Steps:\nAdd token table\nIssue JWT on login\nAdd refresh endpoint",
    "Plan: 1) add token table 2) issue JWT on login 3) add refresh endpoint",
    "My approach (pseudocode):\n- add table\n- issue JWT\n- refresh endpoint",
  ])("finds three steps in: %s", (text) => {
    expect(steps(text)).toBeGreaterThanOrEqual(3);
  });

  it("does not take repro steps, prose or other sections for an approach", () => {
    expect(steps("Steps to reproduce:\n1. open\n2. click\n3. crash")).toBeNull();
    expect(steps("We plan to fix this soon. 1. a")).toBeNull();
    expect(steps("Approach: will do it using JWT.")).toBe(1);
    expect(steps("Approach:\n- add table\n\nAcceptance criteria:\n- a\n- b\n- c")).toBe(1);
    // A bug's reproduction under a plain heading, and "e.g." lines, are not steps.
    expect(steps("Steps:\n1. open app\n2. click save\n3. it crashes\nExpected result: saved")).toBeNull();
    expect(findApproachSection("Steps:\n1. open\n2. click\n3. see error", { bareSteps: false })).toBeNull();
    expect(["e.g. something", "2.5 hours", "1. one", "a) two", "• three"].map(isListItem)).toEqual([false, false, true, true, true]);
  });

  it("counts inline numbering only when it counts up from 1", () => {
    expect(inlineSteps("1) a 2) b 3) c")).toBe(3);
    expect(inlineSteps("ETA 28 Oct, about 2.5 hours")).toBe(0);
    expect(inlineSteps("3) c 4) d")).toBe(0);
  });
});

describe("definition of done", () => {
  it.each([
    "Definition of Done:\n- merged\n- tests green",
    "DoD: code merged, tests green",
    "dod -\n1. merged",
    "**Definition of done**\n* deployed to dev",
    "These acceptance criteria are our definition of done.",
    "DoD = AC",
  ])("finds a DoD in: %s", (text) => {
    expect(findDodSection(text)?.items).toBeGreaterThanOrEqual(1);
  });

  it("does not take a passing mention for a DoD section", () => {
    expect(findDodSection("AC/DoD reviewed; ETA Friday")).toBeNull();
    expect(findDodSection("DoD reviewed and approach approved")).toBeNull();
  });
});

describe("approvals", () => {
  it.each(["Approved", "approved, go ahead", "LGTM", "Looks good to me", "Good to go 👍", "OK to proceed", "Sounds good, please proceed."])("accepts %s", (text) => {
    expect(isApproval(text)).toBe(true);
  });

  it.each([
    "Not approved yet",
    "Can you add more detail?",
    "Is this approved?",
    "Don't proceed until the API is ready",
    "Will check later",
    "On hold, looks good otherwise but wait",
    "Will approve later",
    "Sign off pending",
    "needs sign-off",
    "Approve after changes",
    "Wait, do not start. Approved for estimation only",
  ])(
    "rejects %s",
    (text) => {
      expect(isApproval(text)).toBe(false);
    }
  );
});

describe("dates and pull requests", () => {
  it("recognises common date and ETA forms", () => {
    for (const text of ["ETA 28 Oct", "by 2025-10-28", "Oct 28th", "28/10", "end of day tomorrow", "Friday"]) {
      expect(mentionsAnyDate(text)).toBe(true);
    }
    expect(mentionsAnyDate("no date here")).toBe(false);
    expect(mentionsAnyDate("version 1.2 released")).toBe(false);
    expect(mentionsAnyDate("on 28.10.2025")).toBe(true);
  });

  it("finds a PR id however it is written, but not inside other numbers", () => {
    for (const text of ["PR #551", "!551 opened", "pr-551", "Pull request 551", "raised 551"]) {
      expect(mentionsPullRequest(text, 551)).toBe(true);
    }
    expect(mentionsPullRequest("build 15510", 551)).toBe(false);
  });
});

describe("long or hostile text", () => {
  it("stays fast on huge descriptions and long runs of spaces", () => {
    const started = Date.now();
    findApproachSection("* Plan:\n".repeat(10_000));
    findApproachSection(`Plan${" ".repeat(50_000)}`);
    findDodSection(`DoD${" ".repeat(50_000)}`);
    mentionsAnyDate(`build${" ".repeat(50_000)}`);
    isApproval(`approved ${"x ".repeat(50_000)}?`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
