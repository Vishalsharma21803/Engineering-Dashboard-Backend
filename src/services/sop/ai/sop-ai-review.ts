import { prisma } from "../../../lib/prisma.js";
import type { ComplianceResult, ComplianceViolation } from "../../../types/azure.types.js";
import type { AiRuleResult } from "./sop-ai-verifier.js";

function findingFor(result: AiRuleResult, phase: ComplianceViolation["phase"]): ComplianceViolation {
  return {
    ruleId: result.ruleId,
    ruleTitle: result.ruleTitle,
    checker: "ai",
    severity: result.severity,
    message: result.reason,
    evidence: result.quotes,
    suggestedAction: null,
    phase,
  };
}

/**
 * One ticket's code result with the user's AI review applied, when the review
 * judged this revision of the ticket: a cleared gap (or to-do or notice) moves
 * to `cleared`, and a failed AI-only rule becomes a gap (to-do while not due).
 * An outdated review is only reported, never applied.
 */
export function withAiReview(
  result: ComplianceResult,
  check: { status: NonNullable<ComplianceResult["aiReview"]>["status"]; results: unknown; ticketRev: number | null; finishedAt: Date | null },
  rev: number
): ComplianceResult {
  const outdated = check.ticketRev === null || check.ticketRev !== rev;
  const next: ComplianceResult = {
    ...result,
    aiReview: { status: check.status, checkedAt: check.finishedAt?.toISOString() ?? null, outdated },
  };
  const verdicts = Array.isArray(check.results) ? (check.results as AiRuleResult[]) : [];

  if (outdated || verdicts.length === 0) {
    return next;
  }

  const cleared = new Map(verdicts.filter((verdict) => verdict.review === "gap" && verdict.verdict === "pass").map((verdict) => [verdict.ruleId, verdict]));
  const keep = (finding: ComplianceViolation) => finding.checker !== "code" || !cleared.has(finding.ruleId);
  const removed = [...result.violations, ...result.todos, ...result.notices].filter((finding) => !keep(finding));

  next.violations = result.violations.filter(keep);
  next.todos = result.todos.filter(keep);
  next.notices = result.notices.filter(keep);
  next.cleared = [
    ...result.cleared,
    ...removed.map((finding) => {
      const verdict = cleared.get(finding.ruleId) as AiRuleResult;
      return { ruleId: finding.ruleId, ruleTitle: finding.ruleTitle, reason: verdict.reason, quotes: verdict.quotes };
    }),
  ];

  // AI-only rules that apply now (listed by the code result) and failed.
  for (const verdict of verdicts) {
    const rule = verdict.review === "ai-rule" && verdict.verdict === "fail" ? result.aiRules.find((candidate) => candidate.ruleId === verdict.ruleId) : undefined;

    if (!rule) {
      continue;
    }

    if (!rule.due) {
      next.todos = [...next.todos, findingFor(verdict, "now")];
    } else if (verdict.severity === "low") {
      next.notices = [...next.notices, findingFor(verdict, rule.phase)];
    } else {
      next.violations = [...next.violations, findingFor(verdict, rule.phase)];
    }
  }

  return next;
}

/**
 * The user's saved AI reviews applied to their code results (never for team
 * reports: reviews are private). Reads the database only; no AI is called.
 * `revs`: each ticket's current revision.
 */
export async function applyAiReviews(
  userId: string,
  credentialId: string,
  results: ComplianceResult[],
  revs: Map<number, number>
): Promise<ComplianceResult[]> {
  const ids = results.filter((result) => result.configured).map((result) => result.workItemId);

  if (ids.length === 0) {
    return results;
  }

  const checks = await prisma.sopAiCheck.findMany({
    where: { userId, credentialId, workItemId: { in: ids } },
    select: { workItemId: true, status: true, results: true, ticketRev: true, finishedAt: true },
  });
  const byId = new Map(checks.map((check) => [check.workItemId, check]));

  return results.map((result) => {
    const check = byId.get(result.workItemId);
    const rev = revs.get(result.workItemId);
    return check && result.configured && rev !== undefined ? withAiReview(result, check, rev) : result;
  });
}
