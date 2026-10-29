import { RULE_LEVEL_UPDATES } from "../../src/services/sop/rule-levels.js";
import { prisma } from "../../src/lib/prisma.js";

/** The fake "Alpha" project's SOP set-up (Beta stays not set up). */
export const ALPHA_SETTINGS = {
  stages: { ready: ["New"], active: ["Active"], review: ["Resolved"], done: ["Closed"] },
};

/** A small default rulebook used with the Alpha set-up. */
export const ALPHA_RULEBOOK = `---
id: T-01
title: Estimate exists
checker: code
uses: estimate-present
applies_to: [task, bug]
when: before-active
severity: fail
---
**Rule:** Tasks and bugs have an original estimate.

---
id: T-02
title: Pull request linked at review
checker: code
uses: pr-linked
applies_to: [task, bug]
when: at-review
---
**Rule:** A pull request is linked.

---
id: T-03
title: Priority is set
checker: code
uses: field-present
params: { field: priority }
applies_to: all
when: before-active
---
**Rule:** Priority is set.

---
id: T-04
title: Evidence before UAT
checker: code
uses: evidence-attached
applies_to: [task]
when: at-uat
---
**Rule:** Evidence is attached.

---
id: T-05
title: Approach is described
checker: ai
applies_to: [task]
when: always
---
**Rule:** The ticket explains the approach.

**Passes when:** A comment or the description lists the steps.

**Fails when:** There is no plan.

---
id: T-06
title: Old rule switched off
checker: code
uses: title-length
applies_to: all
when: always
severity: off
---
**Rule:** Not checked.
`;

/**
 * Saves the rulebook as version 1 and sets Alpha up (projects already live on the Projects screen).
 * The one-time rule updates count as done: the test rulebook is exactly what the test wants checked.
 */
export async function useAlphaRulebook(content = ALPHA_RULEBOOK, settings: object = ALPHA_SETTINGS) {
  await prisma.appSetting.createMany({
    data: [{ key: "sop.projectsMovedFromRulebook", value: { test: true } }, ...RULE_LEVEL_UPDATES.map((update) => ({ key: update.key, value: { test: true } }))],
  });
  await prisma.rulebook.create({ data: { version: 1, content, note: "test" } });
  await prisma.sopProject.create({ data: { nameKey: "alpha", projectName: "Alpha", settings } });
}
