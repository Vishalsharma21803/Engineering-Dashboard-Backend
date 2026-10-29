import type { AzureClient } from "../../lib/azure/client.js";
import type { RawWorkItem } from "../../lib/azure/azure-api.types.js";
import type { ComplianceResult, ComplianceViolation, SuggestedAction, WorkItemSummary } from "../../types/azure.types.js";
import { checkNeeds, enteredAt, lastEnteredAt, movedPast, runCodeCheck } from "./code-checker.js";
import { buildDossier, kindOf, type DossierNeed, type TicketDossier } from "./dossier.js";
import { findProjectProfile, type EffectiveRulebook } from "./rulebook.merge.js";
import { findingSeverity, type ProjectProfile, type RuleCard, type RuleWhen, type Severity, type SopStage } from "./rulebook.types.js";

export interface RulebookForChecks extends EffectiveRulebook {
  defaultVersion: number;
  personalVersion: number;
  /** Set-up projects the user switched SOP checks off for (shown as such, not "not set up"). */
  switchedOff: string[];
}

/** The stage each timing belongs to. "before-active" items are needed before work starts. */
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

/** Done items are to-dos for this long after the ticket is closed, then gaps. */
export const DONE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Where a rule stands for this ticket now:
 * - hidden: its stage has not come yet (not listed);
 * - skip: the project has no such stage (listed with the reason);
 * - todo: the ticket is in the rule's stage, so a missing item is still to do;
 * - due: the ticket moved past the rule's stage ("earlier"), or the rule is due in this stage ("now").
 *
 * | when            | to-do                              | gap                         |
 * | before-active   | New / Estimations                  | from Active onward          |
 * | at-estimation   | in Estimations                     | once it moves past          |
 * | while-active    | in Active                          | once it moves past Active   |
 * | at-review, ...  | in that stage                      | once it moves past          |
 * | at-done         | first 24 h in Done                 | after that, while in Done   |
 * | always          | -                                  | immediately                 |
 */
export type RuleWindow =
  | { state: "hidden" }
  | { state: "skip"; reason: string }
  | { state: "todo" }
  | { state: "due"; phase: "now" | "earlier" };

export function ruleWindow(card: RuleCard, dossier: TicketDossier, now: Date): RuleWindow {
  if (card.when === "always") {
    return { state: "due", phase: "now" };
  }

  // Projects without an Estimations state estimate before work starts.
  const when: RuleWhen = card.when === "at-estimation" && dossier.profile.stages.estimation.length === 0 ? "before-active" : card.when;
  const stage = STAGE_OF_WHEN[when] as SopStage;

  if (dossier.profile.stages[stage].length === 0) {
    return { state: "skip", reason: `${dossier.profile.project} has no ${stage} stage` };
  }

  if (when === "before-active") {
    if (enteredAt(dossier, "active")) {
      return { state: "due", phase: "earlier" };
    }

    // A ticket in a state the project does not map (no SOP stage) is not checked yet.
    return dossier.stage === null ? { state: "hidden" } : { state: "todo" };
  }

  if (when === "at-done") {
    // A reopened ticket is not done: its Done items wait until it is closed again.
    const closedAt = dossier.stage === "done" ? lastEnteredAt(dossier, "done") : null;

    if (!closedAt) {
      return { state: "hidden" };
    }

    return now.getTime() - closedAt.getTime() < DONE_GRACE_MS ? { state: "todo" } : { state: "due", phase: "now" };
  }

  if (!enteredAt(dossier, stage)) {
    return { state: "hidden" };
  }

  return movedPast(dossier, stage) ? { state: "due", phase: "earlier" } : { state: "todo" };
}

/** Cards that could apply to this kind of ticket in this project (stage not yet considered). */
function candidateCards(rulebook: RulebookForChecks, profile: ProjectProfile, type: string): RuleCard[] {
  const kind = kindOf(profile, type);
  return kind === null ? [] : rulebook.cards.filter((card) => card.severity !== "off" && card.appliesTo.includes(kind));
}

function needsFor(cards: RuleCard[]): Set<DossierNeed> {
  const needs = new Set<DossierNeed>();

  for (const card of cards) {
    if (card.when !== "always") {
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
    todos: [],
    passedRules: [],
    skippedRules: [],
    aiRules: [],
    cleared: [],
    aiReview: null,
  };
}

function finding(
  card: RuleCard,
  severity: Severity,
  phase: ComplianceViolation["phase"],
  message: string,
  evidence: string[] = [],
  suggestedAction: SuggestedAction | null = null
): ComplianceViolation {
  return { ruleId: card.id, ruleTitle: card.title, checker: "code", severity: findingSeverity(severity), message, evidence, suggestedAction, phase };
}

/**
 * Runs the code rules on an already-built dossier. A rule missing in the
 * ticket's current stage is a to-do; once the ticket moves past that stage
 * it is a gap (notice rules: a notice). AI-only rules are only listed.
 */
export function evaluateDossier(dossier: TicketDossier, rulebook: RulebookForChecks, now: Date): ComplianceResult {
  const result = baseResult(dossier.workItem, rulebook, "checked");

  for (const card of candidateCards(rulebook, dossier.profile, dossier.workItem.type)) {
    const ref = { ruleId: card.id, ruleTitle: card.title };
    const window = ruleWindow(card, dossier, now);

    if (window.state === "hidden") {
      continue;
    }

    if (window.state === "skip") {
      result.skippedRules.push({ ...ref, reason: window.reason });
      continue;
    }

    if (card.checker === "ai") {
      result.aiRules.push({ ...ref, due: window.state === "due", phase: window.state === "due" ? window.phase : "now" });
      continue;
    }

    const outcome = runCodeCheck(card, dossier, now);

    switch (outcome.status) {
      case "pass":
        result.passedRules.push(ref);
        break;
      case "skip":
        result.skippedRules.push({ ...ref, reason: outcome.reason });
        break;
      case "pending":
        // The check's own time window is still open (e.g. a comment within 24 h of a move).
        result.todos.push(finding(card, card.severity, "now", outcome.message));
        break;
      case "fail": {
        // Notice rules, and outcomes a check marks as notice-only, are shown but never count as gaps.
        const notice = card.severity === "notice" || outcome.notice === true;
        const severity = notice ? "notice" : card.severity;

        if (window.state === "todo") {
          result.todos.push(finding(card, severity, "now", outcome.message, outcome.evidence, outcome.action));
        } else {
          (notice ? result.notices : result.violations).push(finding(card, severity, window.phase, outcome.message, outcome.evidence, outcome.action));
        }
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
