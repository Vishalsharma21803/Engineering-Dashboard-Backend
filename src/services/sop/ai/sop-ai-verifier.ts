import { findingSeverity, type AiRuleCard, type ProjectProfile } from "../rulebook.types.js";
import type { FixTarget, Verdict, VerdictOutput } from "./sop-ai-prompt.js";

export interface AiRuleResult {
  ruleId: string;
  ruleTitle: string;
  /** "fail" rules are high, "warn" rules medium, "notice" rules low (same as code rules). */
  severity: "high" | "medium" | "low";
  verdict: Verdict;
  reason: string;
  /** What to do, for the developer to read; never posted. */
  advice: string | null;
  quotes: string[];
  /** Final content to post as-is (after review); may contain [[fill in: ...]] gaps to complete. */
  fix: { target: FixTarget; text: string } | null;
  /** What the verifier changed, if anything (shown so people can trust the result). */
  note: string | null;
}

const MAX_REASON = 600;

/**
 * Text that tells the developer what to do instead of being the content
 * itself ("Add a comment with the steps", "You should…"). Posting it would put
 * an instruction on the ticket, so such a fix is dropped (the advice stays).
 */
const INSTRUCTION_START =
  /^(please\s+)?(add|write|draft|rewrite|include|create|provide|list|describe|explain|mention|consider|ensure|make sure|clarify|specify|document|state|you should|you need to|the (title|description|comment|ticket|acceptance criteria) should)\b(?!\s*:)/i;

function looksLikeInstruction(text: string, ruleId: string): boolean {
  return INSTRUCTION_START.test(text.trim()) || new RegExp(`\\b${ruleId.replace(/[-]/g, "\\-")}\\b`, "i").test(text) || /\b(this|the) (sop|rule)\b/i.test(text);
}

const MAX_FIX: Partial<Record<FixTarget, number>> = { title: 255, category: 100, tags: 400 };
const MAX_FIX_DEFAULT = 8_000;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Keeps a fix only when it can be applied safely. */
function checkFix(fix: VerdictOutput["results"][number]["fix"], profile: ProjectProfile, ruleId: string): { fix: AiRuleResult["fix"]; note: string | null } {
  const text = fix.text.trim();

  if (fix.target === "none" || !text) {
    return { fix: null, note: null };
  }

  if (fix.target !== "category" && fix.target !== "tags" && looksLikeInstruction(text, ruleId)) {
    return { fix: null, note: "The model wrote advice instead of ready-to-post text, so no draft is offered; see the suggestion." };
  }

  if (text.length > (MAX_FIX[fix.target] ?? MAX_FIX_DEFAULT)) {
    return { fix: null, note: "The suggested fix was too long and was dropped." };
  }

  if (fix.target === "category") {
    const match = Object.keys(profile.categories).find((name) => name.toLowerCase() === text.toLowerCase());
    return match
      ? { fix: { target: "category", text: match }, note: null }
      : { fix: null, note: `The suggested category "${text}" is not in the project's list and was dropped.` };
  }

  if (fix.target === "title" && text.includes("\n")) {
    return { fix: null, note: "The suggested title has line breaks and was dropped." };
  }

  return { fix: { target: fix.target, text }, note: null };
}

/**
 * Trust nothing the model says without checking it against the ticket:
 * every requested rule answered once, quotes really in the ticket, fixes
 * applicable. Unverifiable verdicts become "unsure".
 */
export function verifyVerdicts(output: VerdictOutput, cards: AiRuleCard[], ticketText: string, profile: ProjectProfile): AiRuleResult[] {
  const haystack = normalize(ticketText);

  return cards.map((card) => {
    const base = { ruleId: card.id, ruleTitle: card.title, severity: findingSeverity(card.severity) };
    const answers = output.results.filter((result) => result.ruleId.trim().toUpperCase() === card.id.toUpperCase());
    const answer = answers[0];

    if (!answer) {
      return { ...base, verdict: "unsure", reason: "The model gave no answer for this rule.", advice: null, quotes: [], fix: null, note: null };
    }

    const notes: string[] = answers.length > 1 ? ["The model answered this rule more than once; the first answer is shown."] : [];
    const quotes = answer.quotes.map((quote) => quote.trim()).filter(Boolean);
    const verified = quotes.filter((quote) => haystack.includes(normalize(quote.replace(/^["'“]|["'”]$/g, ""))));
    let verdict = answer.verdict;

    if (quotes.length > verified.length) {
      notes.push(`${quotes.length - verified.length} quote(s) could not be found in the ticket and were removed.`);
    }

    if (verdict !== "unsure" && quotes.length > 0 && verified.length === 0) {
      verdict = "unsure";
      notes.push("None of the quoted text is in the ticket, so the verdict was changed to unsure.");
    }

    const fix = verdict === "fail" ? checkFix(answer.fix, profile, card.id) : { fix: null, note: null };

    if (fix.note) {
      notes.push(fix.note);
    }

    return {
      ...base,
      verdict,
      reason: answer.reason.trim().slice(0, MAX_REASON) || "No reason given.",
      advice: verdict === "fail" ? answer.advice.trim().slice(0, MAX_REASON) || null : null,
      quotes: verified,
      fix: fix.fix,
      note: notes.length ? notes.join(" ") : null,
    };
  });
}
