/**
 * Wording-tolerant text matching for the SOP checks. People write the same
 * thing many ways ("Approach", "pseudo code", "PLAN", "Steps"; "1.", "1)",
 * "-", "•"), so every pattern here ignores case and accepts the usual
 * synonyms and list styles. What code cannot recognise, the AI review on
 * the ticket page can still clear.
 */

/** Optional markdown or emphasis around a heading word. */
const HEADING_START = String.raw`^(?:#{1,6}\s*)?(?:[*_]{1,2}\s*)?(?:(?:my|our|the|proposed|suggested)\s+)?`;
/** After the heading word: optional "(...)", closing emphasis, then ":" / "-" / end of line. */
const HEADING_END = String.raw`\s*(?:\([^)\n]{0,40}\)\s*)?(?:[*_]{1,2}\s*)?(?:[:：\-–—=]|$)`;

const APPROACH_WORDS = [
  String.raw`technical\s+(?:approach|plan|design|solution)`,
  String.raw`implementation\s+(?:approach|plan|steps|details)`,
  String.raw`dev(?:elopment)?\s+(?:approach|plan|steps)`,
  String.raw`(?:action|work|execution)\s+plan`,
  String.raw`approach`,
  String.raw`ps(?:eu|ue)do[\s\-_]*code`,
  String.raw`plan(?:\s+of\s+action)?`,
  String.raw`steps`,
  String.raw`solution(?:\s+steps)?`,
  String.raw`(?:fix|changes?)\s+plan`,
  String.raw`how\s+(?:to\s+|i\s+will\s+|we\s+will\s+)?(?:implement|fix|solve)(?:\s+it)?`,
];

/** "Approach:", "## Pseudo code", "**Plan** -", "Steps", "Technical approach (pseudocode):" ... */
const APPROACH_HEADING = new RegExp(`${HEADING_START}(?:${APPROACH_WORDS.join("|")})${HEADING_END}`, "i");
/** Bug reproduction steps are not an approach. */
const NOT_APPROACH = /\b(?:steps\s+to\s+reproduce|repro(?:duction)?\s+steps|reproduc)/i;

const DOD_HEADING = new RegExp(String.raw`${HEADING_START}(?:definition\s+of\s+done|d\.?o\.?d\.?)${HEADING_END}`, "i");
/** Acceptance criteria that say they are the definition of done ("AC = DoD", "These AC are our definition of done"). */
const AC_IS_DOD =
  /\b(?:acceptance\s+criteria|ac)\b[^\n.]{0,30}?(?:\s(?:are|is|as)\s|\s*=\s*)[^\n.]{0,15}?\b(?:definition\s+of\s+done|dod)\b|\b(?:definition\s+of\s+done|dod)\b\s*(?:=|\sis\s|\sare\s|\s(?:is\s)?(?:the\s)?same\s+as\s)\s*(?:the\s+|our\s+)?(?:acceptance\s+criteria|ac)\b/i;

/** A list item line: "- x", "* x", "• x", "1. x", "1) x", "(1) x", "a) x", "Step 1: x". */
const LIST_ITEM = /^\s*(?:[-*•▪◦·‣]\s*|\(?\d{1,2}(?:\)\s*|[.:]\s+)|\(?[a-z](?:\)\s*|\.\s+)|step\s*\d{1,2}[\s:.)\-–]*)\S/i;
/** A short line ending with a colon starts a new section ("Acceptance criteria:", "Notes:"). */
const SECTION_LINE = /^\s*(?:#{1,6}\s*)?[^\n:]{1,40}:\s*$/;

/** Bounds on user text, so a huge description or comment can never stall the server. */
const MAX_TEXT_CHARS = 20_000;
const MAX_LINE_CHARS = 400;
const MAX_SECTION_LINES = 60;

/** Trimmed, length-capped lines of user text. */
function textLines(text: string): string[] {
  return text
    .slice(0, MAX_TEXT_CHARS)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().slice(0, MAX_LINE_CHARS));
}

export function isListItem(line: string): boolean {
  return LIST_ITEM.test(line);
}

/**
 * Numbered items written on one line: "Plan: 1) add table 2) issue JWT 3) refresh".
 * Only a run counting up from 1 is accepted, so "2.5 hours" or "ETA 28 Oct" never count.
 */
export function inlineSteps(text: string): number {
  const numbers = [...text.matchAll(/(?:^|[\s:;,(])\(?(\d{1,2})[.)](?=\s*\S)/g)].map((match) => Number(match[1]));
  let expected = 1;

  for (const number of numbers) {
    if (number === expected) {
      expected += 1;
    }
  }

  return expected - 1;
}

/** Lines of a section that starts right after `start`, up to the next section line. */
function sectionLines(lines: string[], start: number): string[] {
  const section: string[] = [];

  for (const line of lines.slice(start + 1, start + 1 + MAX_SECTION_LINES)) {
    if (APPROACH_HEADING.test(line) || DOD_HEADING.test(line) || (!isListItem(line) && SECTION_LINE.test(line))) {
      break;
    }

    section.push(line);
  }

  return section;
}

/** How many items a section has: list items, else one per non-trivial line, plus numbered steps on the heading line. */
function countItems(headingRest: string, section: string[]): number {
  const listed = section.filter(isListItem).length;
  const plain = section.filter((line) => line.trim().split(/\s+/).length >= 2).length;
  return Math.max(inlineSteps(headingRest), 0) + (listed > 0 ? listed : plain);
}

export interface FoundSection {
  /** Items under the heading. */
  items: number;
  /** The heading line, for evidence. */
  heading: string;
}

/** `commaItems`: "DoD: code merged, tests green" counts as two items (an approach needs real steps). */
function findSection(text: string, heading: RegExp, skip: ((line: string, section: string[]) => boolean) | null, commaItems: boolean): FoundSection | null {
  const lines = textLines(text);
  let best: FoundSection | null = null;

  for (const [index, line] of lines.entries()) {
    const match = heading.exec(line);

    if (!match) {
      continue;
    }

    const section = sectionLines(lines, index);

    if (skip?.(line, section)) {
      continue;
    }

    const rest = line.slice(match[0].length);
    const commas = commaItems ? rest.split(/[,;]/).filter((part) => part.trim().length >= 3).length : 0;
    const sameLine = rest.trim().length >= 3 ? Math.max(1, inlineSteps(rest), commas) : 0;
    const items = Math.max(sameLine, countItems(rest, section));

    if (!best || items > best.items) {
      best = { items, heading: line.trim().slice(0, 120) };
    }
  }

  return best;
}

/** Steps that describe a bug's reproduction ("expected result", "actual behaviour", "crash"), not how to do the work. */
const REPRO_CONTENT = /\b(?:reproduc\w*|expected\s+(?:result|behaviou?r|outcome)|actual\s+(?:result|behaviou?r|outcome)|observed|crash(?:es|ed)?)\b/i;
const BARE_STEPS = /^(?:#{1,6}\s*)?(?:[*_]{1,2}\s*)?steps\b/i;

/**
 * A technical approach heading (any of the usual names, any case) and its step count.
 * `bareSteps: false` ignores a plain "Steps" heading (in a bug's description it usually lists how to reproduce it).
 */
export function findApproachSection(text: string, options: { bareSteps?: boolean } = {}): FoundSection | null {
  const bareSteps = options.bareSteps ?? true;
  return findSection(
    text,
    APPROACH_HEADING,
    (line, section) => NOT_APPROACH.test(line) || (!bareSteps && BARE_STEPS.test(line)) || REPRO_CONTENT.test(section.join("\n")),
    false
  );
}

/** A "Definition of Done" / "DoD" section and its item count; text saying the AC are the DoD counts as one item. */
export function findDodSection(text: string): FoundSection | null {
  const section = findSection(text, DOD_HEADING, null, true);

  if (section && section.items > 0) {
    return section;
  }

  const said = AC_IS_DOD.exec(text.slice(0, MAX_TEXT_CHARS));
  return said ? { items: 1, heading: said[0] } : section;
}

const APPROVAL =
  /\b(?:approved?|approving|lgtm|looks?\s+(?:good|fine|ok(?:ay)?|great)|go\s+ahead|good\s+to\s+go|sounds\s+good|ok(?:ay)?\s+to\s+(?:proceed|go|start)|(?:please\s+)?proceed|you\s+(?:can|may)\s+(?:start|begin)|green\s+light|signed\s+off|sign[\s-]?off)\b|👍|✅|✔️/i;
const NEGATED =
  /\b(?:not|never|no)\s+(?:yet\s+)?(?:been\s+)?(?:approved?|good|ok(?:ay)?|go(?:ing)?\s+ahead|proceed)|\b(?:don['’]?t|do\s+not|doesn['’]?t|cannot|can['’]?t|won['’]?t|shouldn['’]?t|isn['’]?t|wait\s+(?:before|to))\s+(?:yet\s+)?(?:be\s+)?(?:approve|approved|proceed|go\s+ahead|start|lgtm)|\bnot\s+(?:yet\s+)?approv|\bon\s+hold\b|\bhold\s+off\b/i;
/** Approval words that only promise or ask for one ("will approve later", "sign-off pending", "approve after changes"). */
const CONDITIONAL =
  /\b(?:will|would|shall|going\s+to|need(?:s|ed)?|pending|awaiting|waiting|after|once|if|unless|until|later|only)\b/i;

/**
 * A clear approval: an approval word in a statement (not a question), with no
 * condition or promise in that sentence, and nothing in the comment saying not
 * to go ahead ("Wait, do not start."). Unusual wording is left to the AI review.
 */
export function isApproval(text: string): boolean {
  const sentences = text.slice(0, MAX_TEXT_CHARS).split(/(?<=[.!?\n])/);

  if (sentences.some((sentence) => NEGATED.test(sentence))) {
    return false;
  }

  return sentences.some((sentence) => APPROVAL.test(sentence) && !CONDITIONAL.test(sentence) && !sentence.trim().endsWith("?"));
}

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DATE_PATTERNS = [
  String.raw`\b\d{4}-\d{1,2}-\d{1,2}\b`,
  String.raw`\b\d{1,2}(?:st|nd|rd|th)?[\s,\-]*(?:of\s+)?${MONTH}\b`,
  String.raw`\b${MONTH}[\s,\-]*\d{1,2}(?:st|nd|rd|th)?\b`,
  // 28/10, 28-10-2025, 28.10.2025 (two-part dotted numbers are versions, not dates).
  String.raw`\b\d{1,2}[/\-]\d{1,2}(?:[/\-]\d{2,4})?\b`,
  String.raw`\b\d{1,2}\.\d{1,2}\.\d{2,4}\b`,
  String.raw`\b(?:today|tomorrow|tonight|eod|end\s+of\s+(?:the\s+)?(?:day|week)|this\s+week|next\s+week|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?)\b`,
];
const ANY_DATE = new RegExp(DATE_PATTERNS.join("|"), "i");

export function mentionsAnyDate(text: string): boolean {
  return ANY_DATE.test(text.slice(0, MAX_TEXT_CHARS));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `word` appears as a whole word (or path segment), ignoring case. */
export function mentionsWord(text: string, word: string): boolean {
  const trimmed = word.trim();
  return trimmed.length > 0 && new RegExp(`(?:^|[^\\w])${escapeRegex(trimmed)}(?:$|[^\\w])`, "i").test(text);
}

/** A person's full name, first name (3+ letters), account name or @mention appears in the text. */
export function mentionsPerson(text: string, person: { displayName: string; uniqueName?: string | null }): boolean {
  const names = [person.displayName, person.displayName.split(/\s+/)[0] ?? "", person.uniqueName?.split("@")[0] ?? ""];
  return names.some((name) => name.length >= 3 && name !== "Unknown" && mentionsWord(text, name));
}

/** A name from a role list (display name or e-mail) matches this identity. */
export function isListedPerson(person: { displayName: string; uniqueName?: string | null } | null, names: string[]): boolean {
  if (!person) {
    return false;
  }

  const own = [person.displayName, person.uniqueName ?? ""].map((value) => value.trim().toLowerCase()).filter(Boolean);
  return names.some((name) => own.includes(name.trim().toLowerCase()));
}

export const MENTIONS = {
  eta: /\b(?:e\.?t\.?a|deadline|(?:target(?:ing)?|due)\s+(?:date|by|on)|(?:expected|deliver(?:y|ed)?|complete|done|finish(?:ed)?)\s+(?:by|on))\b/i,
  acDod: /\b(?:ac|a\.c\.|acceptance\s+criteria|dod|d\.o\.d|definition\s+of\s+done)\b/i,
  approval: /\bapprov(?:ed|al|er|es)\b|\bsigned\s+off\b|\blgtm\b/i,
  tests: /\b(?:unit[\s-]?tests?|tests?|tested|testing|specs?|green|pass(?:ed|es|ing)?|ci)\b|✅/i,
  merge: /\bmerg(?:e|ed|es|ing)\b|\bcompleted\s+(?:the\s+)?(?:pr|pull\s+request)\b/i,
  // "build #2026.51", "deployment 412", "release v1.4.2"; a bare "#551" is usually the PR, so it does not count.
  build: /\b(?:build|deploy(?:ment|ed)?|release|run|pipeline|version)\b[\s:#\-]{0,3}(?:(?:no\.?|number|num|id)[\s:#\-]{0,3})?v?\d[\w.\-]*|\b\d{4}\.\d+(?:\.\d+)*\b|\bv\d+(?:\.\d+)+\b/i,
  done: /\b(?:done|complete[ds]?|finished|closing|closed|resolved|delivered|shipped|dod\s+(?:met|verified|confirmed|checked))\b|✅/i,
  reviewer: /\b(?:reviewers?|review(?:ed)?\s+by|assigned\s+to)\b|@\w/i,
};

/** A pull request id written as #551, !551, PR 551, PR-551, pull request 551 or 551 on its own. */
export function mentionsPullRequest(text: string, id: number): boolean {
  return new RegExp(`(?:^|[^\\w])(?:#|!|pr\\s*[-#!:]?\\s*|pull\\s+request\\s*[-#!:]?\\s*)?${id}(?:$|[^\\w])`, "i").test(text);
}
