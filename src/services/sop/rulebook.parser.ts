import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

import { BUILTIN_CHECKS, isBuiltinCheck } from "./builtin-checks.js";
import {
  ITEM_KINDS,
  RULE_WHEN,
  SEVERITIES,
  SOP_STAGES,
  type AiRuleCard,
  type CodeRuleCard,
  type ItemKind,
  type ParsedRulebook,
  type ProjectProfile,
  type RuleOverride,
  type RulebookError,
  type SopStage,
} from "./rulebook.types.js";

/**
 * Rulebook format (Markdown "rule cards"):
 *
 *   ---
 *   <YAML header>
 *   ---
 *   <plain-English body with **Rule:**, **Passes when:**, ... sections>
 *
 * A line that is exactly `---` always starts or ends a header, so bodies
 * must not contain one. Project facts are blocks with `kind: project`.
 */

export const MAX_CONTENT_LENGTH = 200_000;
export const MAX_PERSONAL_RULES = 20;
const SEPARATOR = "---";
const CUSTOM_PREFIX = "MY-";
const ID_PATTERN = /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/;

export const DEFAULT_WORK_ITEM_TYPES: Record<ItemKind, string[]> = {
  story: ["User Story", "Product Backlog Item", "Requirement"],
  task: ["Task"],
  bug: ["Bug"],
  feature: ["Feature"],
  epic: ["Epic"],
  impediment: ["Issue", "Impediment"],
};

export const DEFAULT_BRANCH_PATTERN = "^(feature|bugfix|hotfix)/[A-Za-z]*-?{id}-[a-z0-9]+(-[a-z0-9]+)*$";

const SECTION_LABELS = {
  rule: "rule",
  "passes when": "passesWhen",
  "fails when": "failsWhen",
  "pass example": "passExample",
  "fail example": "failExample",
  "suggested fix": "suggestedFix",
} as const;

type SectionKey = (typeof SECTION_LABELS)[keyof typeof SECTION_LABELS];

interface RawBlock {
  headerLine: number;
  header: string;
  body: string;
  bodyLine: number;
}

/** Splits the document into header/body blocks, reporting structural problems by line. */
function splitBlocks(content: string, errors: RulebookError[]): RawBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: RawBlock[] = [];
  let index = 0;

  // Anything before the first separator is a free-text preamble (ignored).
  while (index < lines.length && lines[index]?.trim() !== SEPARATOR) {
    index += 1;
  }

  while (index < lines.length) {
    const headerLine = index + 1;
    index += 1;
    const header: string[] = [];

    while (index < lines.length && lines[index]?.trim() !== SEPARATOR) {
      header.push(lines[index] ?? "");
      index += 1;
    }

    if (index >= lines.length) {
      errors.push({ line: headerLine, message: "Header opened with --- is never closed with another ---" });
      break;
    }

    index += 1;
    const bodyLine = index + 1;
    const body: string[] = [];

    while (index < lines.length && lines[index]?.trim() !== SEPARATOR) {
      body.push(lines[index] ?? "");
      index += 1;
    }

    blocks.push({ headerLine, header: header.join("\n"), body: body.join("\n").trim(), bodyLine });
  }

  return blocks;
}

function parseSections(body: string): Partial<Record<SectionKey, string>> {
  const sections: Partial<Record<SectionKey, string>> = {};
  const pattern = /^\s*\*\*([A-Za-z ]+):\*\*\s*/gm;
  const matches = [...body.matchAll(pattern)];

  matches.forEach((match, position) => {
    const label = match[1]?.trim().toLowerCase() as keyof typeof SECTION_LABELS;
    const key = SECTION_LABELS[label];

    if (!key) {
      return;
    }

    const start = (match.index ?? 0) + match[0].length;
    const end = matches[position + 1]?.index ?? body.length;
    sections[key] = body.slice(start, end).trim();
  });

  return sections;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const stringList = z.union([z.string().min(1), z.array(z.string().min(1))]).transform((value) => (Array.isArray(value) ? value : [value]));

const projectSchema = z
  .object({
    kind: z.literal("project"),
    project: z.string().trim().min(1),
    stage_source: z.enum(["state", "board_column"]).default("state"),
    stages: z.partialRecord(z.enum(SOP_STAGES), stringList).default({}),
    roles: z
      .object({ tl: z.array(z.string()).default([]), qa: z.array(z.string()).default([]), po: z.array(z.string()).default([]) })
      .strict()
      .default({ tl: [], qa: [], po: [] }),
    fields: z
      .object({ category: z.string().nullable().default(null), target_completion: z.string().nullable().default(null) })
      .strict()
      .default({ category: null, target_completion: null }),
    categories: z.record(z.string(), z.string()).default({}),
    work_item_types: z.partialRecord(z.enum(ITEM_KINDS), stringList).default({}),
    tag_vocabulary: z.array(z.string()).default([]),
    branch_pattern: z.string().nullable().default(DEFAULT_BRANCH_PATTERN),
    pr_target_branch: z.string().nullable().default("develop"),
    timezone: z
      .string()
      .refine(isTimeZone, "timezone must be an IANA name such as UTC or Asia/Kolkata")
      .default("UTC"),
  })
  .strict();

const appliesToSchema = z
  .union([z.literal("all"), z.array(z.enum(ITEM_KINDS)).min(1)])
  .transform((value) => (value === "all" ? [...ITEM_KINDS] : value));

const cardHeaderSchema = z
  .object({
    id: z.string().regex(ID_PATTERN, "id must look like ABC-01 (letters, a dash, then letters/numbers)"),
    title: z.string().trim().min(3).max(120),
    checker: z.enum(["code", "ai"]),
    uses: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    applies_to: appliesToSchema,
    when: z.enum(RULE_WHEN),
    severity: z.enum(SEVERITIES).default("warn"),
  })
  .strict();

const overrideSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    severity: z.enum(SEVERITIES).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

export function parseBuiltinParams(uses: string, params: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  if (!isBuiltinCheck(uses)) {
    return { ok: false, message: `uses: "${uses}" is not a built-in check (${Object.keys(BUILTIN_CHECKS).join(", ")})` };
  }

  const result = BUILTIN_CHECKS[uses].params.safeParse(params ?? {});
  return result.success
    ? { ok: true, params: result.data as Record<string, unknown> }
    : { ok: false, message: `params for ${uses}: ${zodMessage(result.error)}` };
}

function toProject(raw: z.infer<typeof projectSchema>, line: number): ProjectProfile {
  const stages = Object.fromEntries(SOP_STAGES.map((stage) => [stage, raw.stages[stage] ?? []])) as Record<SopStage, string[]>;
  const workItemTypes = Object.fromEntries(
    ITEM_KINDS.map((kind) => [kind, raw.work_item_types[kind] ?? DEFAULT_WORK_ITEM_TYPES[kind]])
  ) as Record<ItemKind, string[]>;

  return {
    project: raw.project,
    stageSource: raw.stage_source,
    stages,
    roles: raw.roles,
    fields: { category: raw.fields.category, targetCompletion: raw.fields.target_completion },
    categories: raw.categories,
    workItemTypes,
    tagVocabulary: raw.tag_vocabulary,
    branchPattern: raw.branch_pattern,
    prTargetBranch: raw.pr_target_branch,
    timeZone: raw.timezone,
    line,
  };
}

/** Parses and validates a rulebook. `personal` files may only override or add MY- AI rules. */
export function parseRulebook(content: string, scope: "default" | "personal"): ParsedRulebook {
  const result: ParsedRulebook = { projects: [], cards: [], overrides: [], errors: [] };

  if (content.length > MAX_CONTENT_LENGTH) {
    result.errors.push({ line: 1, message: `Rulebook is too long (max ${MAX_CONTENT_LENGTH} characters)` });
    return result;
  }

  const seen = new Map<string, number>();

  for (const block of splitBlocks(content, result.errors)) {
    let header: unknown;

    try {
      header = parseYaml(block.header) ?? {};
    } catch (error) {
      const line = error instanceof YAMLParseError && error.linePos ? block.headerLine + error.linePos[0].line : block.headerLine;
      result.errors.push({ line, message: `Invalid YAML: ${error instanceof Error ? error.message.split("\n")[0] : "parse error"}` });
      continue;
    }

    if (typeof header !== "object" || header === null || Array.isArray(header)) {
      result.errors.push({ line: block.headerLine, message: "Header must be a set of key: value lines" });
      continue;
    }

    const record = header as Record<string, unknown>;

    if (record.kind === "project") {
      if (scope === "personal") {
        result.errors.push({ line: block.headerLine, message: "Project facts can only be set in the default rulebook" });
        continue;
      }

      const parsed = projectSchema.safeParse(record);

      if (!parsed.success) {
        result.errors.push({ line: block.headerLine, message: `Project block: ${zodMessage(parsed.error)}` });
        continue;
      }

      if (parsed.data.branch_pattern) {
        try {
          new RegExp(parsed.data.branch_pattern.replace("{id}", "1"));
        } catch {
          result.errors.push({ line: block.headerLine, message: "branch_pattern is not a valid regular expression" });
          continue;
        }
      }

      const key = `project:${parsed.data.project.toLowerCase()}`;

      if (seen.has(key)) {
        result.errors.push({ line: block.headerLine, message: `Project "${parsed.data.project}" is defined twice (first on line ${seen.get(key)})` });
        continue;
      }

      seen.set(key, block.headerLine);
      result.projects.push(toProject(parsed.data, block.headerLine));
      continue;
    }

    const id = typeof record.id === "string" ? record.id : null;

    if (!id) {
      result.errors.push({ line: block.headerLine, message: "Every block needs either `kind: project` or an `id`" });
      continue;
    }

    if (seen.has(id)) {
      result.errors.push({ line: block.headerLine, message: `Rule ${id} is defined twice (first on line ${seen.get(id)})` });
      continue;
    }

    seen.set(id, block.headerLine);
    const isCustom = id.startsWith(CUSTOM_PREFIX);

    if (scope === "default" && isCustom) {
      result.errors.push({ line: block.headerLine, message: `${id}: the ${CUSTOM_PREFIX} prefix is reserved for personal rules` });
      continue;
    }

    if (scope === "personal" && !isCustom) {
      const parsed = overrideSchema.safeParse(record);

      if (!parsed.success) {
        result.errors.push({
          line: block.headerLine,
          message: `${id}: in your rules you can only change severity and params of a default rule (new rules must start with ${CUSTOM_PREFIX}). ${zodMessage(parsed.error)}`,
        });
        continue;
      }

      const override: RuleOverride = { id: parsed.data.id, line: block.headerLine };
      if (parsed.data.severity !== undefined) override.severity = parsed.data.severity;
      if (parsed.data.params !== undefined) override.params = parsed.data.params;
      result.overrides.push(override);
      continue;
    }

    const parsed = cardHeaderSchema.safeParse(record);

    if (!parsed.success) {
      result.errors.push({ line: block.headerLine, message: `${id}: ${zodMessage(parsed.error)}` });
      continue;
    }

    const headerData = parsed.data;
    const sections = parseSections(block.body);

    if (!sections.rule) {
      result.errors.push({ line: block.bodyLine, message: `${id}: the body needs a **Rule:** section` });
      continue;
    }

    const base = {
      id: headerData.id,
      title: headerData.title,
      appliesTo: headerData.applies_to,
      when: headerData.when,
      severity: headerData.severity,
      rule: sections.rule,
      line: block.headerLine,
      origin: scope,
    } as const;

    if (headerData.checker === "code") {
      if (scope === "personal") {
        result.errors.push({ line: block.headerLine, message: `${id}: personal rules must use checker: ai (code checks are built in)` });
        continue;
      }

      if (!headerData.uses) {
        result.errors.push({ line: block.headerLine, message: `${id}: code rules need uses: <built-in check>` });
        continue;
      }

      const params = parseBuiltinParams(headerData.uses, headerData.params);

      if (!params.ok) {
        result.errors.push({ line: block.headerLine, message: `${id}: ${params.message}` });
        continue;
      }

      const card: CodeRuleCard = { ...base, checker: "code", uses: headerData.uses, params: params.params };
      result.cards.push(card);
      continue;
    }

    if (headerData.uses || headerData.params) {
      result.errors.push({ line: block.headerLine, message: `${id}: uses/params only apply to checker: code` });
      continue;
    }

    if (!sections.passesWhen || !sections.failsWhen) {
      result.errors.push({ line: block.bodyLine, message: `${id}: AI rules need **Passes when:** and **Fails when:** sections` });
      continue;
    }

    const card: AiRuleCard = {
      ...base,
      checker: "ai",
      passesWhen: sections.passesWhen,
      failsWhen: sections.failsWhen,
      passExample: sections.passExample ?? null,
      failExample: sections.failExample ?? null,
      suggestedFix: sections.suggestedFix ?? null,
    };
    result.cards.push(card);
  }

  if (scope === "personal" && result.cards.length > MAX_PERSONAL_RULES) {
    result.errors.push({ line: 1, message: `At most ${MAX_PERSONAL_RULES} personal rules are allowed (found ${result.cards.length})` });
  }

  // Report in reading order, whatever stage found the problem.
  result.errors.sort((a, b) => a.line - b.line);
  return result;
}
