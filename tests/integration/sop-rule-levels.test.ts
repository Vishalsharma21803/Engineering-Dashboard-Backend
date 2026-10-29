import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { azurePath, installFakeAzure, resetDatabase, runSopReport, setupUser, type Agent } from "../support/harness.js";
import { ALPHA_RULEBOOK, useAlphaRulebook } from "../support/test-rulebook.js";

let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  installFakeAzure();
  ({ agent, credentialId } = await setupUser());
});

describe("updating the saved rulebook to the agreed rule levels", () => {
  it("saves one new version with a note", async () => {
    await prisma.appSetting.create({ data: { key: "sop.projectsMovedFromRulebook", value: { test: true } } });
    const old = `---
id: STR-11
title: Tags are set
checker: code
uses: tags-present
applies_to: all
when: before-active
severity: warn
---
**Rule:** Tags.

---
id: ALW-01
title: Every state change has a comment
checker: code
uses: transition-comment
applies_to: all
when: always
---
**Rule:** Comment.
`;
    await prisma.rulebook.create({ data: { version: 1, content: old, note: "old" } });

    // Each update that changes something saves one version: the first (levels) and the fourth (new WI-002 rules).
    const rulebook = (await agent.get("/api/sop/rulebook").expect(200)).body.rulebook;
    expect(rulebook).toMatchObject({ version: 3, note: expect.stringContaining("TRN-01 comment on every state change") });
    expect((await prisma.rulebook.findUnique({ where: { version: 2 } }))?.note).toContain("Rule levels updated");
    expect(rulebook.content).toContain("severity: notice");
    expect(rulebook.content).not.toContain("ALW-01");
    expect(rulebook.content).toContain("id: TRN-01");

    // Runs once; the old version stays restorable.
    await agent.get("/api/sop/rulebook").expect(200);
    expect(await prisma.rulebook.count()).toBe(3);
    expect((await prisma.rulebook.findUnique({ where: { version: 1 } }))?.content).toBe(old);
  });
});

describe("notices", () => {
  it("are shown on the ticket but never counted as gaps or in the team report", async () => {
    const estimateAsNotice = ALPHA_RULEBOOK.replace("when: before-active\nseverity: fail", "when: before-active\nseverity: notice");
    expect(estimateAsNotice).not.toBe(ALPHA_RULEBOOK);
    await useAlphaRulebook(estimateAsNotice);

    const items = (await agent.get(azurePath(credentialId, "/compliance")).expect(200)).body.items as Array<{
      violations: Array<{ ruleId: string }>;
      notices: Array<{ ruleId: string; severity: string }>;
    }>;
    expect(items.some((item) => item.notices.some((notice) => notice.ruleId === "T-01" && notice.severity === "low"))).toBe(true);
    expect(items.some((item) => item.violations.some((violation) => violation.ruleId === "T-01"))).toBe(false);

    const report = await runSopReport(agent, credentialId, "Alpha");
    expect(report.byRule.items.map((rule: { ruleId: string }) => rule.ruleId)).not.toContain("T-01");

    const myWork = (await agent.get(azurePath(credentialId, "/my-work?sop=T-01")).expect(200)).body.myWork;
    expect(myWork.total).toBe(0);
  });
});
