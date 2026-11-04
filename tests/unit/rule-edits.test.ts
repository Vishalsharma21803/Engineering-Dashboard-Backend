import { describe, expect, it } from "vitest";

import type { ComplianceResult } from "../../src/types/azure.types.js";
import { withAiReview } from "../../src/services/sop/ai/sop-ai-review.js";
import { applyRuleEdits } from "../../src/services/sop/rulebook.edits.js";
import { parseRulebook } from "../../src/services/sop/rulebook.parser.js";

const RULES = `# Our rules

Some notes.


---
id: A-01
title: Tags
checker: code
uses: tags-present
applies_to: all
when: before-active # set by the owner
---
**Rule:** Tags.

\`\`\`
keep


these blank lines
\`\`\`

---
id: A-02
title: Priority
checker: code
uses: field-present
params: { field: priority }
applies_to: all
when: before-active
---
**Rule:** Priority.
`;

describe("applyRuleEdits", () => {
  it("changes only the edited rule, keeping every other block and the preamble as they were", () => {
    const next = applyRuleEdits(RULES, "default", [{ op: "set", id: "A-02", severity: "notice" }]);
    expect(next.startsWith("# Our rules\n\nSome notes.\n\n\n---\nid: A-01")).toBe(true);
    expect(next).toContain("when: before-active # set by the owner");
    expect(next).toContain("keep\n\n\nthese blank lines");
    expect(parseRulebook(next, "default").cards.find((card) => card.id === "A-02")).toMatchObject({ severity: "notice", params: { field: "priority" } });
  });

  it("writes personal overrides and MY- rules that parse, and quotes awkward titles", () => {
    const next = applyRuleEdits("", "personal", [
      { op: "set", id: "A-01", severity: "off" },
      { op: "add", card: { title: "Yes: bugs #1", checker: "code", uses: "tags-present", appliesTo: ["bug"], when: "always", severity: "warn", rule: "x\n---\ny" } },
    ]);
    const parsed = parseRulebook(next, "personal");
    expect(parsed.errors).toEqual([]);
    expect(parsed.overrides).toEqual([expect.objectContaining({ id: "A-01", severity: "off" })]);
    expect(parsed.cards[0]).toMatchObject({ id: "MY-01", title: "Yes: bugs #1", rule: "x\n- - -\ny" });
  });

  it("lets null clear an optional setting", () => {
    const withLength = applyRuleEdits(RULES, "default", [{ op: "set", id: "A-02", params: { min_length: 10 } }]);
    expect(parseRulebook(withLength, "default").cards[1]).toMatchObject({ params: { field: "priority", min_length: 10 } });
    const cleared = applyRuleEdits(withLength, "default", [{ op: "set", id: "A-02", params: { min_length: null } }]);
    expect(parseRulebook(cleared, "default").cards[1]?.checker === "code" && parseRulebook(cleared, "default").cards[1]).toMatchObject({ params: { field: "priority" } });
  });
});

describe("withAiReview", () => {
  const gap = (ruleId: string, phase: "now" | "earlier" = "earlier") => ({ ruleId, ruleTitle: ruleId, checker: "code" as const, severity: "medium" as const, message: "x", evidence: [], suggestedAction: null, phase });
  const result = {
    workItemId: 1,
    configured: true,
    violations: [gap("STR-08")],
    todos: [gap("ACT-06", "now")],
    notices: [],
    cleared: [],
    aiRules: [
      { ruleId: "MY-01", ruleTitle: "Mine", due: false, phase: "now" as const },
      { ruleId: "MY-02", ruleTitle: "Mine too", due: true, phase: "earlier" as const },
    ],
    aiReview: null,
  } as unknown as ComplianceResult;
  const verdict = (ruleId: string, review: string | undefined, value: string) => ({ ruleId, ruleTitle: ruleId, severity: "medium", review, verdict: value, reason: "because", quotes: ["q"], advice: null, fix: null, note: null });
  const check = (results: unknown[], ticketRev: number | null = 5) => ({ status: "DONE" as const, results, ticketRev, finishedAt: new Date("2025-10-15T00:00:00Z") });

  it("clears gaps and to-dos the AI showed are met, and adds failed AI-only rules as to-dos or gaps", () => {
    const next = withAiReview(result, check([verdict("STR-08", "gap", "pass"), verdict("ACT-06", "gap", "pass"), verdict("MY-01", "ai-rule", "fail"), verdict("MY-02", "ai-rule", "fail")]), 5);
    expect(next.cleared.map((rule) => rule.ruleId)).toEqual(["STR-08", "ACT-06"]);
    expect(next.todos.map((todo) => [todo.ruleId, todo.checker])).toEqual([["MY-01", "ai"]]);
    expect(next.violations.map((violation) => [violation.ruleId, violation.phase])).toEqual([["MY-02", "earlier"]]);
    expect(next.aiReview).toEqual({ status: "DONE", checkedAt: "2025-10-15T00:00:00.000Z", outdated: false });
  });

  it("lists only AI-only rules the review explicitly passed: unsure, missing or outdated prove nothing", () => {
    expect(withAiReview(result, check([verdict("MY-01", "ai-rule", "pass"), verdict("MY-02", "ai-rule", "unsure")]), 5).aiPassed?.map((rule) => rule.ruleId)).toEqual(["MY-01"]);
    expect(withAiReview(result, check([]), 5).aiPassed).toBeUndefined();
    expect(withAiReview(result, check([verdict("MY-01", "ai-rule", "pass")], 4), 5).aiPassed).toBeUndefined();
  });

  it("applies nothing from an outdated review, results saved before reviews existed, or quality and draft verdicts", () => {
    const outdated = withAiReview(result, check([verdict("STR-08", "gap", "pass")], 4), 5);
    expect(outdated).toMatchObject({ violations: result.violations, cleared: [], aiReview: { outdated: true } });

    const legacy = withAiReview(result, check([verdict("STR-08", undefined, "pass"), verdict("MY-02", undefined, "fail")]), 5);
    expect(legacy).toMatchObject({ violations: result.violations, todos: result.todos, cleared: [] });

    const advice = withAiReview(result, check([verdict("STR-08", "quality", "fail"), verdict("ACT-06", "draft", "pass")]), 5);
    expect(advice).toMatchObject({ violations: result.violations, todos: result.todos, cleared: [] });
  });
});
