/** SOP stages a project's states or board columns map onto (WI-002 terminology). */
export const SOP_STAGES = ["ready", "estimation", "active", "review", "testing", "qa", "uat", "done"] as const;
export type SopStage = (typeof SOP_STAGES)[number];

/** Logical work item kinds; each project maps them to its Azure type names. */
export const ITEM_KINDS = ["story", "task", "bug", "feature", "epic", "impediment"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** When a rule is evaluated, relative to the ticket's stage history. */
export const RULE_WHEN = [
  /** Checked once the ticket reaches Estimations (projects without that stage: once work starts). */
  "at-estimation",
  /** Must be true before work starts: checked once the ticket reaches Active, never on new tickets. */
  "before-active",
  "at-review",
  "at-testing",
  "at-qa",
  "at-uat",
  "at-done",
  "while-active",
  "always",
] as const;
export type RuleWhen = (typeof RULE_WHEN)[number];

/** "fail" and "warn" are SOP gaps; a "notice" is shown on the ticket but never counted as a gap. */
export const SEVERITIES = ["fail", "warn", "notice", "off"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** How a rule's problem is shown: "fail" high, "warn" medium, "notice" low. */
export function findingSeverity(severity: Severity): "high" | "medium" | "low" {
  return severity === "fail" ? "high" : severity === "notice" ? "low" : "medium";
}

export interface ProjectProfile {
  project: string;
  stageSource: "state" | "board_column";
  stages: Record<SopStage, string[]>;
  roles: { tl: string[]; qa: string[]; po: string[] };
  fields: { category: string | null; targetCompletion: string | null };
  categories: Record<string, string>;
  workItemTypes: Record<ItemKind, string[]>;
  tagVocabulary: string[];
  branchPattern: string | null;
  prTargetBranch: string | null;
  /** Decides what "the same day" and "every working day" mean for this team. */
  timeZone: string;
  /** First line of the block, for error messages. */
  line: number;
}

interface CardBase {
  id: string;
  title: string;
  appliesTo: ItemKind[];
  when: RuleWhen;
  severity: Severity;
  /** Plain-language explanation shown to people (and to the AI for AI rules). */
  rule: string;
  line: number;
  origin: "default" | "personal";
}

export interface CodeRuleCard extends CardBase {
  checker: "code";
  uses: string;
  params: Record<string, unknown>;
}

export interface AiRuleCard extends CardBase {
  checker: "ai";
  passesWhen: string;
  failsWhen: string;
  passExample: string | null;
  failExample: string | null;
  suggestedFix: string | null;
}

export type RuleCard = CodeRuleCard | AiRuleCard;

/** A personal-file entry that tweaks a default card. */
export interface RuleOverride {
  id: string;
  severity?: Severity;
  params?: Record<string, unknown>;
  line: number;
}

export interface RulebookError {
  line: number;
  message: string;
}

export interface ParsedRulebook {
  projects: ProjectProfile[];
  cards: RuleCard[];
  overrides: RuleOverride[];
  errors: RulebookError[];
}
