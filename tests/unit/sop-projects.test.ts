import { describe, expect, it } from "vitest";

import { moveProjectsOutOfRulebook, suggestStage } from "../../src/services/sop/sop-projects.service.js";

const CARD = (id: string, when: string) => `---
id: ${id}
title: Some rule
checker: code
uses: estimate-present
applies_to: [task]
when: ${when}
---
**Rule:** x
`;

describe("moveProjectsOutOfRulebook", () => {
  it("imports valid blocks, keeps unreadable ones in the text, and never drops rules or the preamble", () => {
    const content = [
      "# Intro text",
      "",
      "---\nkind: project\nproject: Good\nstages:\n  ready: [New, Estimations]\n  active: [Active]\n---\nNotes about Good.\n",
      "---\nkind: project\nproject: Broken\nbogus: 1\n---\n",
      "---\nkind: project\nproject: good\nstages:\n  active: [Doing]\n---\n",
      CARD("STR-05", "before-active"),
      CARD("STR-08", "before-active"),
    ].join("\n");

    const moved = moveProjectsOutOfRulebook(content);

    expect(moved.imports).toEqual([
      { projectName: "Good", settings: expect.objectContaining({ stages: { ready: ["New"], estimation: ["Estimations"], active: ["Active"] } }) },
    ]);
    // The unknown-key block and the duplicate name are kept so nothing disappears silently.
    expect(moved.kept).toEqual(["Broken", "good"]);
    expect(moved.content).toContain("# Intro text");
    expect(moved.content).not.toContain("Notes about Good.");
    expect(moved.content).toContain("project: Broken");
    expect(moved.content).toContain("id: STR-08\ntitle: Some rule\nchecker: code\nuses: estimate-present\napplies_to: [task]\nwhen: before-active");
    expect(moved.content).toContain("id: STR-05\ntitle: Some rule\nchecker: code\nuses: estimate-present\napplies_to: [task]\nwhen: at-estimation");
  });

  it("tidies old blocks: a state in two stages keeps its first, empty names are dropped", () => {
    const moved = moveProjectsOutOfRulebook("---\nkind: project\nproject: X\nstages:\n  ready: [New]\n  active: [New, Active]\nroles:\n  tl: ['']\n---\n");
    expect(moved.imports[0]?.settings).toMatchObject({ stages: { ready: ["New"], active: ["Active"] }, roles: { tl: [] } });
  });

  it("re-times quoted when values too", () => {
    expect(moveProjectsOutOfRulebook(CARD("STR-14", '"before-active"')).content).toContain("when: at-estimation");
    expect(moveProjectsOutOfRulebook(CARD("STR-04", "'before-active'")).content).toContain("when: at-estimation");
  });
});

describe("suggestStage", () => {
  it("maps Azure states by name first, then by category", () => {
    expect(suggestStage("Estimations", "Proposed")).toBe("estimation");
    expect(suggestStage("Code Review", "InProgress")).toBe("review");
    expect(suggestStage("Testing", "InProgress")).toBe("testing");
    expect(suggestStage("UAT", "Resolved")).toBe("uat");
    expect(suggestStage("New", "Proposed")).toBe("ready");
    expect(suggestStage("Closed", "Completed")).toBe("done");
    expect(suggestStage("Removed", "Removed")).toBeNull();
  });
});
