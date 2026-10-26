import type { AzureClient } from "../../lib/azure/client.js";
import type { RawWorkItem } from "../../lib/azure/azure-api.types.js";
import type { ComplianceResult, WorkItemSummary } from "../../types/azure.types.js";
import { checkNeeds, enteredAt, runCodeCheck } from "./code-checker.js";
import { buildDossier, kindOf, type DossierNeed, type TicketDossier } from "./dossier.js";
import { findProjectProfile, type EffectiveRulebook } from "./rulebook.merge.js";
import { findingSeverity, type ProjectProfile, type RuleCard, type RuleWhen, type SopStage } from "./rulebook.types.js";

export interface RulebookForChecks extends EffectiveRulebook {
  defaultVersion: number;
  personalVersion: number;
  /** Set-up projects the user switched SOP checks off for (shown as such, not "not set up"). */
  switchedOff: string[];
}

/** When a rule starts to apply. "before-active" rules must be done before work starts, so they are checked once it has. */
const STAGE_OF_WHEN: Partial<Record<RuleWhen, SopStage>> = {
  "at-estimation": "estimation",
  "before-active": "active",
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
  let stage = STAGE_OF_WHEN[card.when];

  if (!stage) {
    return { applies: true };
  }

  // Projects without an Estimations state estimate when work starts.
  if (stage === "estimation" && dossier.profile.stages.estimation.length === 0) {
    stage = "active";
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

function baseResult(
  workItem: WorkItemSummary,
  rulebook: RulebookForChecks,
  sopProject: ComplianceResult["sopProject"]
): ComplianceResult {
  const configured = sopProject === "checked";
  return {
    workItemId: workItem.id,
    projectName: workItem.projectName,
    title: workItem.title,
    type: workItem.type,
    state: workItem.state,
    stateCategory: workItem.stateCategory,
    configured,
    sopProject,
    rulebook: { defaultVersion: rulebook.defaultVersion, personalVersion: rulebook.personalVersion },
    violations: [],
    notices: [],
    passedRules: [],
    pendingRules: [],
    skippedRules: [],
    aiRules: [],
  };
}

/** Runs the code rules on an already-built dossier. AI rules are only listed. */
export function evaluateDossier(dossier: TicketDossier, rulebook: RulebookForChecks, now: Date): ComplianceResult {
  const result = baseResult(dossier.workItem, rulebook, "checked");

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
        // A notice that is not even due yet is noise; it shows only if it is still missing once due.
        if (card.severity !== "notice") {
          result.pendingRules.push({ ...ref, message: outcome.message });
        }
        break;
      case "skip":
        result.skippedRules.push({ ...ref, reason: outcome.reason });
        break;
      case "fail": {
        // Notice rules, and outcomes a check marks as notice-only, are shown but never count as gaps.
        const notice = card.severity === "notice" || outcome.notice === true;
        (notice ? result.notices : result.violations).push({
          ...ref,
          checker: "code",
          severity: findingSeverity(notice ? "notice" : card.severity),
          message: outcome.message,
          evidence: outcome.evidence,
          suggestedAction: outcome.action,
        });
        break;
      }
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
    const off = rulebook.switchedOff.some((name) => name.toLowerCase() === workItem.projectName.toLowerCase());
    return baseResult(workItem, rulebook, off ? "switched-off" : "not-set-up");
  }

  const cards = candidateCards(rulebook, profile, workItem.type);

  const dossier = await buildDossier(client, workItem, raw, profile, needsFor(cards));
  return evaluateDossier(dossier, rulebook, now);
}
