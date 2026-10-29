import { describe, expect, it } from "vitest";

import { RULE_LEVEL_UPDATES, applyRuleLevels } from "../../src/services/sop/rule-levels.js";
import { parseRulebook } from "../../src/services/sop/rulebook.parser.js";
import { STARTER_RULEBOOK } from "../../src/services/sop/starter-rulebook.js";

type Update = (typeof RULE_LEVEL_UPDATES)[number];
const [first, second, third, fourth] = RULE_LEVEL_UPDATES as [Update, Update, Update, Update];

const rule = (id: string, extra = "", body = "**Rule:** x") =>
  `---\nid: ${id}\ntitle: ${id} title\nchecker: code\nuses: tags-present\napplies_to: all\nwhen: before-active\n${extra}---\n${body}\n`;

describe("applyRuleLevels", () => {
  it("makes the agreed rules notices, keeping their wording and anything switched off", () => {
    const content = `# Intro\n\n${rule("STR-11", "severity: warn\n", "**Rule:** Our own wording.")}\n${rule("STR-10", "")}\n${rule("STR-12", 'severity: "fail"\n')}\n${rule("STR-13", "severity: off\n")}\n${rule("PR-01", "severity: warn\n")}`;
    const { content: next, changed } = applyRuleLevels(content, first);
    const cards = new Map(parseRulebook(next, "default").cards.map((card) => [card.id, card]));

    expect(changed).toBe(true);
    expect(next.startsWith("# Intro\n")).toBe(true);
    expect(cards.get("STR-11")).toMatchObject({ severity: "notice", rule: "Our own wording." });
    // No severity line (default warn) gets one.
    expect(cards.get("STR-10")?.severity).toBe("notice");
    expect(cards.get("STR-12")?.severity).toBe("notice");
    expect(cards.get("STR-13")?.severity).toBe("off");
    expect(cards.get("PR-01")?.severity).toBe("warn");
  });

  it("removes DEV-01, DONE-09 and ALW-01 and turns STR-06 and STR-07 into filled-in checks", () => {
    const content = [
      rule("DEV-01", "severity: warn\n"),
      rule("STR-06", "severity: fail\n").replace("checker: code\nuses: tags-present", "checker: ai"),
      rule("STR-07").replace("checker: code\nuses: tags-present", "checker: ai"),
      rule("ALW-01"),
      rule("DONE-09"),
      rule("FLG-01"),
    ].join("\n");
    const parsed = parseRulebook(applyRuleLevels(content, first).content, "default");

    expect(parsed.errors).toEqual([]);
    expect(parsed.cards.map((card) => card.id)).toEqual(["STR-06", "STR-07", "FLG-01"]);
    // The level the SOP owner chose is kept.
    expect(parsed.cards[0]).toMatchObject({ checker: "code", uses: "field-present", params: { field: "description" }, severity: "fail" });
    expect(parsed.cards[1]).toMatchObject({ checker: "code", uses: "field-present", params: { field: "acceptance-criteria" }, severity: "warn" });
  });

  it("leaves a rulebook that already has the levels (like the starter) unchanged", () => {
    for (const update of RULE_LEVEL_UPDATES) {
      expect(applyRuleLevels(STARTER_RULEBOOK, update)).toEqual({ content: STARTER_RULEBOOK, changed: false });
    }
    const once = applyRuleLevels(rule("STR-11") + rule("DEV-01"), first).content;
    expect(applyRuleLevels(once, first).changed).toBe(false);
  });

  it("then makes PR-01 and STR-09 notices, removes ALW-02 and rewords PR-05 and ACT-06 (STR-14 is left for the next update)", () => {
    const ai = (id: string) => rule(id, "", "**Rule:** Old.\n\n**Passes when:** a.\n\n**Fails when:** b.").replace("checker: code\nuses: tags-present", "checker: ai");
    const content = [rule("PR-01", "severity: warn\n"), ai("STR-09"), rule("ALW-02"), rule("STR-14", "", "**Rule:** Old."), ai("PR-05"), ai("ACT-06")].join("\n");
    const parsed = parseRulebook(applyRuleLevels(content, third).content, "default");
    const cards = new Map(parsed.cards.map((card) => [card.id, card]));

    expect(parsed.errors).toEqual([]);
    expect([...cards.keys()]).toEqual(["PR-01", "STR-09", "STR-14", "PR-05", "ACT-06"]);
    expect(cards.get("PR-01")?.severity).toBe("notice");
    expect(cards.get("STR-09")?.severity).toBe("notice");
    // The starter no longer has STR-14, so this update leaves it; the fourth removes it.
    expect(cards.get("STR-14")?.rule).toBe("Old.");
    expect(cards.get("PR-05")?.rule).toContain("no linked pull request");
    expect(cards.get("ACT-06")?.rule).toContain("no linked branch");
  });

  it("then removes STR-01 and PR-07 and rewords MRG-01", () => {
    const content = [rule("STR-01"), rule("PR-07"), rule("MRG-01", "", "**Rule:** Old wording."), rule("PR-01")].join("\n");
    const parsed = parseRulebook(applyRuleLevels(content, second).content, "default");

    expect(parsed.errors).toEqual([]);
    expect(parsed.cards.map((card) => card.id)).toEqual(["MRG-01", "PR-01"]);
    expect(parsed.cards[0]).toMatchObject({ uses: "pr-approved-before-merge", rule: expect.stringContaining("without any reviewer is not counted") });
  });

  it("then makes the AI rules code checks, removes STR-14 and adds the new WI-002 rules once", () => {
    const ai = (id: string, severity = "") => rule(id, severity, "**Rule:** Old.\n\n**Passes when:** a.\n\n**Fails when:** b.").replace("checker: code\nuses: tags-present", "checker: ai");
    const content = [ai("STR-08", "severity: fail\n"), ai("STR-09", "severity: off\n"), rule("STR-14"), ai("ACT-06"), ai("PR-05"), ai("TST-02"), ai("STR-15"), rule("TRN-01", "severity: warn\n")].join("\n");
    const updated = applyRuleLevels(content, fourth);
    const parsed = parseRulebook(updated.content, "default");
    const cards = new Map(parsed.cards.map((card) => [card.id, card]));

    expect(parsed.errors).toEqual([]);
    expect(cards.has("STR-14")).toBe(false);
    expect(cards.get("STR-08")).toMatchObject({ checker: "code", uses: "approach-present", severity: "fail" });
    // Switched off stays off.
    expect(cards.get("STR-09")).toMatchObject({ checker: "code", uses: "tl-approval", severity: "off" });
    expect(["ACT-06", "PR-05", "TST-02"].map((id) => cards.get(id))).toEqual([
      expect.objectContaining({ uses: "stage-comment", params: expect.objectContaining({ stage: "active" }) }),
      expect.objectContaining({ uses: "stage-comment", params: expect.objectContaining({ stage: "review" }) }),
      expect.objectContaining({ uses: "stage-comment", params: expect.objectContaining({ stage: "testing" }) }),
    ]);
    expect(cards.get("STR-15")).toMatchObject({ uses: "dod-present" });
    // Added at the end, except a rule the owner already has (kept as it was).
    expect(["STR-16", "TIME-01", "REV-01", "DONE-10"].map((id) => cards.get(id)?.severity)).toEqual(["notice", "notice", "notice", "notice"]);
    expect(cards.get("TRN-01")).toMatchObject({ uses: "tags-present", severity: "warn" });
    // A level set back to warn, and the owner's own applies_to / when, are kept too.
    const owned = applyRuleLevels(ai("STR-09", "severity: warn\n").replace("applies_to: all", "applies_to: [task]").replace("when: before-active", "when: always"), fourth).content;
    expect(parseRulebook(owned, "default").cards.find((card) => card.id === "STR-09")).toMatchObject({ uses: "tl-approval", severity: "warn", appliesTo: ["task"], when: "always" });
    expect(applyRuleLevels(updated.content, fourth).changed).toBe(false);
  });
});
