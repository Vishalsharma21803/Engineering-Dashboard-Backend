import { describe, expect, it } from "vitest";

import { mergeRulebooks, findProjectProfile } from "../../src/services/sop/rulebook.merge.js";
import { MAX_PERSONAL_RULES, parseRulebook } from "../../src/services/sop/rulebook.parser.js";
import { STARTER_RULEBOOK } from "../../src/services/sop/starter-rulebook.js";

const AI_CARD = `---
id: STR-08
title: Approach before starting
checker: ai
applies_to: [task, bug]
when: before-active
severity: fail
---
**Rule:** There is a plan.

**Passes when:** 3-10 steps exist.

**Fails when:** No plan.

**Suggested fix:** Draft steps.
`;

const CODE_CARD = `---
id: DEV-01
title: Daily time update
checker: code
uses: daily-time-update
params: { stages: [active] }
applies_to: [task]
when: while-active
---
**Rule:** Update time daily.
`;

describe("starter rulebook", () => {
  it("parses without errors into projects and rule cards", () => {
    const parsed = parseRulebook(STARTER_RULEBOOK, "default");
    expect(parsed.errors).toEqual([]);
    expect(parsed.projects.map((project) => project.project)).toEqual(["automations", "DevOps"]);
    expect(parsed.cards.length).toBeGreaterThan(30);
    expect(new Set(parsed.cards.map((card) => card.id)).size).toBe(parsed.cards.length);
  });

  it("maps the automations stages and the Activity field as Category", () => {
    const profile = findProjectProfile(parseRulebook(STARTER_RULEBOOK, "default").projects, "AUTOMATIONS");
    expect(profile?.stages).toMatchObject({ ready: ["New", "Estimations"], review: ["Review"], testing: ["Testing"], qa: [], uat: [], done: ["Closed"] });
    expect(profile?.fields).toEqual({ category: "Microsoft.VSTS.Common.Activity", targetCompletion: "Microsoft.VSTS.Scheduling.DueDate" });
    expect(profile?.workItemTypes.impediment).toEqual(["Issue", "Impediment"]);
  });
});

describe("parseRulebook", () => {
  it("parses AI and code cards, applying defaults", () => {
    const parsed = parseRulebook(AI_CARD + CODE_CARD, "default");
    expect(parsed.errors).toEqual([]);

    const [ai, code] = parsed.cards;
    expect(ai).toMatchObject({ id: "STR-08", checker: "ai", severity: "fail", appliesTo: ["task", "bug"], rule: "There is a plan.", passesWhen: "3-10 steps exist.", failsWhen: "No plan.", suggestedFix: "Draft steps.", passExample: null });
    expect(code).toMatchObject({ id: "DEV-01", checker: "code", uses: "daily-time-update", params: { stages: ["active"] }, severity: "warn" });
  });

  it("expands applies_to: all", () => {
    const parsed = parseRulebook(CODE_CARD.replace("applies_to: [task]", "applies_to: all"), "default");
    expect(parsed.cards[0]?.appliesTo).toEqual(["story", "task", "bug", "feature", "epic", "impediment"]);
  });

  it("reports problems with line numbers instead of guessing", () => {
    const content = [
      "intro text",
      "---",
      "id: BAD-01",
      "title: Unknown check",
      "checker: code",
      "uses: does-not-exist",
      "applies_to: all",
      "when: always",
      "---",
      "**Rule:** x",
      "---",
      "id: BAD-02",
      "title: Bad params",
      "checker: code",
      "uses: branch-linked",
      "params: { within_hours: -1 }",
      "applies_to: all",
      "when: always",
      "---",
      "**Rule:** x",
      "---",
      "id: BAD-03",
      "title: Missing sections",
      "checker: ai",
      "applies_to: all",
      "when: always",
      "---",
      "**Rule:** x",
      "---",
      "id: [unclosed",
      "---",
      "**Rule:** x",
      "---",
      "id: BAD-05",
      "title: never closed",
    ].join("\n");

    const parsed = parseRulebook(content, "default");
    expect(parsed.cards).toEqual([]);
    expect(parsed.errors.map((error) => error.line)).toEqual([2, 11, 28, 30, 33]);
    expect(parsed.errors[0]?.message).toContain('"does-not-exist" is not a built-in check');
    expect(parsed.errors[1]?.message).toContain("params for branch-linked");
    expect(parsed.errors[2]?.message).toContain("Passes when");
    expect(parsed.errors[3]?.message).toContain("Invalid YAML");
    expect(parsed.errors[4]?.message).toContain("never closed");
  });

  it("rejects unknown keys, duplicates, wrong when values and missing Rule sections", () => {
    const parsed = parseRulebook(
      CODE_CARD + CODE_CARD + AI_CARD.replace("when: before-active", "when: sometimes").replace("STR-08", "STR-09") +
        `---\nid: X-01\ntitle: No rule text\nchecker: code\nuses: pr-linked\napplies_to: all\nwhen: always\ncolour: red\n---\n**Rule:** x\n` +
        `---\nid: X-02\ntitle: No rule text\nchecker: code\nuses: pr-linked\napplies_to: all\nwhen: always\n---\nno sections\n`,
      "default"
    );

    const messages = parsed.errors.map((error) => error.message);
    expect(messages).toEqual([
      expect.stringContaining("DEV-01 is defined twice"),
      expect.stringContaining("STR-09: when"),
      expect.stringContaining("X-01"),
      expect.stringContaining("X-02: the body needs a **Rule:** section"),
    ]);
  });

  it("reserves MY- for personal rules and keeps facts in the default", () => {
    const personalCard = AI_CARD.replace("STR-08", "MY-01");

    expect(parseRulebook(personalCard, "default").errors[0]?.message).toContain("reserved for personal rules");
    expect(parseRulebook("---\nkind: project\nproject: x\n---\n", "personal").errors[0]?.message).toContain("default rulebook");
    expect(parseRulebook(CODE_CARD.replace("DEV-01", "MY-02"), "personal").errors[0]?.message).toContain("must use checker: ai");
    expect(parseRulebook(personalCard, "personal").cards[0]).toMatchObject({ id: "MY-01", origin: "personal" });
  });

  it("only lets personal files change severity and params of default rules", () => {
    const ok = parseRulebook("---\nid: DEV-01\nseverity: off\n---\n", "personal");
    expect(ok.errors).toEqual([]);
    expect(ok.overrides).toEqual([{ id: "DEV-01", severity: "off", line: 1 }]);

    const tooMuch = parseRulebook("---\nid: DEV-01\ntitle: renamed\n---\n", "personal");
    expect(tooMuch.errors[0]?.message).toContain("you can only change severity and params");
  });

  it("caps personal rules", () => {
    const many = Array.from({ length: MAX_PERSONAL_RULES + 1 }, (_, index) => AI_CARD.replace("STR-08", `MY-${index}`)).join("\n");
    expect(parseRulebook(many, "personal").errors[0]?.message).toContain(`At most ${MAX_PERSONAL_RULES}`);
  });

  it("validates branch patterns", () => {
    const parsed = parseRulebook("---\nkind: project\nproject: x\nbranch_pattern: \"([\"\n---\n", "default");
    expect(parsed.errors[0]?.message).toContain("branch_pattern");
  });
});

describe("mergeRulebooks", () => {
  const defaults = parseRulebook(AI_CARD + CODE_CARD, "default");

  it("applies personal severity/params field by field and adds MY- rules", () => {
    const personal = parseRulebook(
      "---\nid: DEV-01\nparams: { stages: [active, testing] }\n---\n---\nid: STR-08\nseverity: off\n---\n" + AI_CARD.replace("STR-08", "MY-01"),
      "personal"
    );
    const merged = mergeRulebooks(defaults, personal);

    expect(merged.issues).toEqual([]);
    expect(merged.cards.find((card) => card.id === "DEV-01")).toMatchObject({ severity: "warn", params: { stages: ["active", "testing"] }, origin: "personal" });
    expect(merged.cards.find((card) => card.id === "STR-08")).toMatchObject({ severity: "off", rule: "There is a plan." });
    expect(merged.cards.map((card) => card.id)).toEqual(["STR-08", "DEV-01", "MY-01"]);
  });

  it("reports overrides that cannot be applied", () => {
    const personal = parseRulebook(
      "---\nid: GONE-01\nseverity: off\n---\n---\nid: STR-08\nparams: { a: 1 }\n---\n---\nid: DEV-01\nparams: { stages: [nowhere] }\n---\n",
      "personal"
    );
    const merged = mergeRulebooks(defaults, personal);

    expect(merged.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("no default rule"),
      expect.stringContaining("only code rules have params"),
      expect.stringContaining("params for daily-time-update"),
    ]);
    expect(merged.cards.find((card) => card.id === "DEV-01")).toMatchObject({ params: { stages: ["active"] } });
  });

  it("ignores the personal file for team reports", () => {
    expect(mergeRulebooks(defaults, null).cards.every((card) => card.origin === "default")).toBe(true);
  });
});
