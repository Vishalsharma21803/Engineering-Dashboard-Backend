import { z } from "zod";

import { AppError } from "../../lib/app-error.js";
import { blockSpans } from "./rulebook.parser.js";
import { ITEM_KINDS, RULE_WHEN, SEVERITIES } from "./rulebook.types.js";
import { STARTER_RULEBOOK } from "./starter-rulebook.js";

/**
 * Edits made from the rules list (level, settings, reset, add, remove),
 * applied to a rulebook's text block by block. Other blocks, wording and
 * comments stay exactly as they were, and the result is saved like a
 * Markdown edit (validated, a new version), so history keeps working.
 */

const id = z.string().trim().regex(/^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/, "Rule ids look like ABC-01");
const text = (max: number) => z.string().trim().min(1).max(max);

const newCardSchema = z
  .object({
    id: id.optional(),
    title: z.string().trim().min(3).max(120),
    checker: z.enum(["code", "ai"]),
    uses: z.string().trim().min(1).max(60).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    appliesTo: z.array(z.enum(ITEM_KINDS)).min(1),
    when: z.enum(RULE_WHEN),
    severity: z.enum(SEVERITIES),
    rule: text(2_000),
    passesWhen: text(2_000).optional(),
    failsWhen: text(2_000).optional(),
  })
  .strict();

export const ruleEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), id, severity: z.enum(SEVERITIES).optional(), params: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ op: z.literal("reset"), id }).strict(),
  z.object({ op: z.literal("remove"), id }).strict(),
  z.object({ op: z.literal("add"), card: newCardSchema }).strict(),
]);

export const ruleEditsSchema = z
  .object({
    /** The version the edits were made on; a newer saved version is a conflict. */
    baseVersion: z.number().int().min(0),
    edits: z.array(ruleEditSchema).min(1).max(50),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type RuleEdit = z.infer<typeof ruleEditSchema>;
type NewCard = z.infer<typeof newCardSchema>;

const CUSTOM_PREFIX = "MY-";
/** Header keys in the order they are written. */
const HEADER_ORDER = ["id", "title", "checker", "uses", "params", "applies_to", "when", "severity"];

/** A YAML scalar: JSON is valid YAML, so anything that needs quoting is written as a JSON string. */
function scalar(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9][\w\s().,/'-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value) && !/\s$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function headerLines(header: Record<string, unknown>): string[] {
  const keys = [...HEADER_ORDER.filter((key) => key in header), ...Object.keys(header).filter((key) => !HEADER_ORDER.includes(key))];
  return keys.filter((key) => header[key] !== undefined).map((key) => `${key}: ${typeof header[key] === "object" ? JSON.stringify(header[key]) : scalar(header[key])}`);
}

/** A line that is exactly --- would end the block, so it never goes into a body. */
function bodyText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "---" ? "- - -" : line))
    .join("\n")
    .trim();
}

function cardBlock(card: NewCard & { id: string }): string[] {
  const header: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    checker: card.checker,
    ...(card.checker === "code" ? { uses: card.uses, ...(card.params && Object.keys(card.params).length ? { params: card.params } : {}) } : {}),
    applies_to: card.appliesTo.length === ITEM_KINDS.length ? "all" : card.appliesTo,
    when: card.when,
    severity: card.severity,
  };
  const body = [`**Rule:** ${bodyText(card.rule)}`];

  if (card.checker === "ai") {
    body.push("", `**Passes when:** ${bodyText(card.passesWhen ?? "")}`, "", `**Fails when:** ${bodyText(card.failsWhen ?? "")}`);
  }

  return ["---", ...headerLines(header), "---", ...body, ""];
}

interface Block {
  id: string | null;
  header: Record<string, unknown> | null;
  /** All lines, from the opening --- to just before the next block. */
  lines: string[];
}

function readBlocks(content: string): { preamble: string[]; blocks: Block[] } {
  const { lines, spans } = blockSpans(content);
  return {
    preamble: lines.slice(0, spans[0]?.start ?? lines.length),
    blocks: spans.map((span) => ({
      id: typeof span.header?.id === "string" ? span.header.id : null,
      header: span.header,
      lines: lines.slice(span.start, span.end),
    })),
  };
}

/** The block with its header replaced (the body and anything after it kept). */
function withHeader(block: Block, header: Record<string, unknown>): Block {
  const closing = block.lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return { ...block, header, lines: ["---", ...headerLines(header), ...block.lines.slice(closing)] };
}

function withoutNulls(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== null));
}

function starterBlock(ruleId: string): Block | null {
  return readBlocks(STARTER_RULEBOOK).blocks.find((block) => block.id === ruleId) ?? null;
}

function nextCustomId(blocks: Block[]): string {
  const used = new Set(blocks.map((block) => block.id));

  for (let number = 1; ; number += 1) {
    const candidate = `${CUSTOM_PREFIX}${String(number).padStart(2, "0")}`;

    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function notFound(ruleId: string): AppError {
  return new AppError(422, "RULE_NOT_FOUND", `There is no rule ${ruleId} to change`);
}

/**
 * Applies edits to a rulebook's text. `personal`: "set" on a default rule
 * writes an override block (id + severity/params), "reset" removes it, "add"
 * creates MY- rules. `default` (SOP owners): edits the rule's own header;
 * "reset" brings back the built-in starter's version of the rule.
 */
export function applyRuleEdits(content: string, scope: "default" | "personal", edits: RuleEdit[]): string {
  const { preamble, blocks } = readBlocks(content);
  let current = blocks;

  for (const edit of edits) {
    if (edit.op === "add") {
      const ruleId = edit.card.id ?? (scope === "personal" ? nextCustomId(current) : null);

      if (!ruleId) {
        throw new AppError(422, "RULE_ID_REQUIRED", "A new default rule needs an id");
      }

      if (scope === "personal" && !ruleId.startsWith(CUSTOM_PREFIX)) {
        throw new AppError(422, "RULE_ID_INVALID", `Your own rules start with ${CUSTOM_PREFIX}`);
      }

      if (current.some((block) => block.id === ruleId)) {
        throw new AppError(422, "RULE_ID_TAKEN", `A rule ${ruleId} already exists`);
      }

      current = [...current, { id: ruleId, header: null, lines: cardBlock({ ...edit.card, id: ruleId }) }];
      continue;
    }

    const index = current.findIndex((block) => block.id === edit.id);
    const block = index === -1 ? null : current[index]!;

    switch (edit.op) {
      case "set": {
        if (block?.header) {
          const header = { ...block.header };
          if (edit.severity !== undefined) header.severity = edit.severity;
          // Params given are merged into the existing ones (unchanged keys stay; null clears an optional one).
          if (edit.params !== undefined) header.params = withoutNulls({ ...((header.params as Record<string, unknown> | undefined) ?? {}), ...edit.params });
          current = current.with(index, withHeader(block, header));
        } else if (scope === "personal" && !edit.id.startsWith(CUSTOM_PREFIX)) {
          // First change to a default rule: a new override block.
          const header: Record<string, unknown> = { id: edit.id, ...(edit.severity !== undefined ? { severity: edit.severity } : {}), ...(edit.params !== undefined ? { params: withoutNulls(edit.params) } : {}) };
          current = [...current, { id: edit.id, header, lines: ["---", ...headerLines(header), "---", ""] }];
        } else {
          throw notFound(edit.id);
        }
        break;
      }
      case "reset": {
        if (scope === "personal") {
          if (!block) throw notFound(edit.id);
          // A personal override goes away; a MY- rule has no default to go back to.
          if (edit.id.startsWith(CUSTOM_PREFIX)) throw new AppError(422, "RULE_NOT_RESETTABLE", `${edit.id} is your own rule; remove it instead`);
          current = current.filter((_, position) => position !== index);
        } else {
          const starter = starterBlock(edit.id);
          if (!starter) throw new AppError(422, "RULE_NOT_RESETTABLE", `${edit.id} is not a built-in rule, so it has no default to go back to`);
          current = block ? current.with(index, starter) : [...current, starter];
        }
        break;
      }
      case "remove": {
        if (scope === "personal" && !edit.id.startsWith(CUSTOM_PREFIX)) {
          throw new AppError(422, "RULE_NOT_REMOVABLE", `${edit.id} is a default rule; set it to Off instead`);
        }
        if (!block) throw notFound(edit.id);
        current = current.filter((_, position) => position !== index);
        break;
      }
    }
  }

  const lines = [...preamble];

  for (const block of current) {
    // Each block runs up to the next ---; keep one blank line between blocks.
    if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
    lines.push(...block.lines);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
