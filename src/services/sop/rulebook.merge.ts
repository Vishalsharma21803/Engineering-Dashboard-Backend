import { parseBuiltinParams } from "./rulebook.parser.js";
import type { ParsedRulebook, ProjectProfile, RuleCard, RulebookError } from "./rulebook.types.js";

export interface EffectiveRulebook {
  projects: ProjectProfile[];
  cards: RuleCard[];
  /** Personal entries that could not be applied (e.g. the default rule no longer exists). */
  issues: RulebookError[];
}

/**
 * Default rules + a user's personal file. Same id = the user's severity/params
 * replace the default's field by field; MY- cards are added. Facts (projects)
 * always come from the default.
 */
export function mergeRulebooks(defaults: ParsedRulebook, personal: ParsedRulebook | null): EffectiveRulebook {
  const issues: RulebookError[] = [];
  const cards = new Map<string, RuleCard>(defaults.cards.map((card) => [card.id, card]));

  for (const override of personal?.overrides ?? []) {
    const base = cards.get(override.id);

    if (!base) {
      issues.push({ line: override.line, message: `${override.id}: there is no default rule with this id` });
      continue;
    }

    let next: RuleCard = { ...base, origin: "personal" };

    if (override.severity !== undefined) {
      next = { ...next, severity: override.severity };
    }

    if (override.params !== undefined) {
      if (base.checker !== "code") {
        issues.push({ line: override.line, message: `${override.id}: only code rules have params` });
        continue;
      }

      const merged = parseBuiltinParams(base.uses, { ...base.params, ...override.params });

      if (!merged.ok) {
        issues.push({ line: override.line, message: `${override.id}: ${merged.message}` });
        continue;
      }

      next = { ...next, checker: "code", uses: base.uses, params: merged.params } as RuleCard;
    }

    cards.set(override.id, next);
  }

  for (const card of personal?.cards ?? []) {
    cards.set(card.id, card);
  }

  return { projects: defaults.projects, cards: [...cards.values()], issues };
}

export function findProjectProfile(projects: ProjectProfile[], projectName: string): ProjectProfile | null {
  const wanted = projectName.trim().toLowerCase();
  return projects.find((profile) => profile.project.toLowerCase() === wanted) ?? null;
}
