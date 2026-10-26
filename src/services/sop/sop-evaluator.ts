import type { AzureClient } from "../../lib/azure/client.js";
import type { RawWorkItem } from "../../lib/azure/azure-api.types.js";
import type { ComplianceResult, WorkItemSummary } from "../../types/azure.types.js";
import { checkNeeds, enteredAt, runCodeCheck } from "./code-checker.js";
import { buildDossier, kindOf, type DossierNeed, type TicketDossier } from "./dossier.js";
import { findProjectProfile, type EffectiveRulebook } from "./rulebook.merge.js";
import type { ProjectProfile, RuleCard, RuleWhen, SopStage } from "./rulebook.types.js";

export interface RulebookForChecks extends EffectiveRulebook {
  defaultVersion: number;
  personalVersion: number;
}

const STAGE_OF_WHEN: Partial<Record<RuleWhen, SopStage>> = {
  "at-review": "review",
  "at-testing": "testing",
  "at-qa": "qa",
  "at-uat": "uat",
  "at-done": "done",
  "while-active": "active",
};

type Applicability = { applies: true } | { applies: false; reason: string | null };

/** Cards that could apply to this kind of ticket in this project (stage not yet considered). */
function candidateCards(rulebook: RulebookForChecks, profile: ProjectProfile, type: string): RuleCard[] {
  const kind = kindOf(profile, type);
  return kind === null ? [] : rulebook.cards.filter((card) => card.severity !== "off" && card.appliesTo.includes(kind));
}

/**
 * Whether a card applies now. A null reason means "not relevant yet" and the
 * rule is not listed; a reason is shown as a skipped rule.
 */
export function cardApplies(card: RuleCard, dossier: TicketDossier): Applicability {
  const stage = STAGE_OF_WHEN[card.when];

  if (!stage) {
    return { applies: true };
  }

  if (dossier.profile.stages[stage].length === 0) {
    return { applies: false, reason: `${dossier.profile.project} has no ${stage} stage` };
  }

  return enteredAt(dossier, stage) ? { applies: true } : { applies: false, reason: null };
}

function needsFor(cards: RuleCard[]): Set<DossierNeed> {
  const needs = new Set<DossierNeed>();

  for (const card of cards) {
    if (STAGE_OF_WHEN[card.when]) {
      needs.add("updates");
    }

    if (card.checker === "code") {
      checkNeeds(card).forEach((need) => needs.add(need));
    }
  }

  return needs;
}

function baseResult(workItem: WorkItemSummary, rulebook: RulebookForChecks, configured: boolean): ComplianceResult {
  return {
    workItemId: workItem.id,
    projectName: workItem.projectName,
    title: workItem.title,
    type: workItem.type,
    state: workItem.state,
    stateCategory: workItem.stateCategory,
    configured,
    rulebook: { defaultVersion: rulebook.defaultVersion, personalVersion: rulebook.personalVersion },
    violations: [],
    passedRules: [],
    pendingRules: [],
    skippedRules: [],
    aiRules: [],
  };
}

/** Runs the code rules on an already-built dossier. AI rules are only listed. */
export function evaluateDossier(dossier: TicketDossier, rulebook: RulebookForChecks, now: Date): ComplianceResult {
  const result = baseResult(dossier.workItem, rulebook, true);

  for (const card of candidateCards(rulebook, dossier.profile, dossier.workItem.type)) {
    const ref = { ruleId: card.id, ruleTitle: card.title };
    const applicability = cardApplies(card, dossier);

    if (!applicability.applies) {
      if (applicability.reason) {
        result.skippedRules.push({ ...ref, reason: applicability.reason });
      }
      continue;
    }

    if (card.checker === "ai") {
      result.aiRules.push(ref);
      continue;
    }

    const outcome = runCodeCheck(card, dossier, now);

    switch (outcome.status) {
      case "pass":
        result.passedRules.push(ref);
        break;
      case "pending":
        result.pendingRules.push({ ...ref, message: outcome.message });
        break;
      case "skip":
        result.skippedRules.push({ ...ref, reason: outcome.reason });
        break;
      case "fail":
        result.violations.push({
          ...ref,
          checker: "code",
          severity: card.severity === "fail" ? "high" : "medium",
          message: outcome.message,
          evidence: outcome.evidence,
          suggestedAction: outcome.action,
        });
        break;
    }
  }

  return result;
}

export async function evaluateTicket(
  client: AzureClient,
  rulebook: RulebookForChecks,
  workItem: WorkItemSummary,
  raw: RawWorkItem,
  now: Date
): Promise<ComplianceResult> {
  const profile = findProjectProfile(rulebook.projects, workItem.projectName);

  if (!profile) {
    return baseResult(workItem, rulebook, false);
  }

  const cards = candidateCards(rulebook, profile, workItem.type);

  const dossier = await buildDossier(client, workItem, raw, profile, needsFor(cards));
  return evaluateDossier(dossier, rulebook, now);
}
