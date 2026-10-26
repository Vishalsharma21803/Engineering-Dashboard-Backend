import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import type { ComplianceResult } from "../../types/azure.types.js";
import { belongsToProject } from "../azure/work-item-detail.service.js";
import { getWorkItem, toWorkItemSummaries } from "../azure/work-items.service.js";
import { mergeRulebooks } from "./rulebook.merge.js";
import { parseRulebook } from "./rulebook.parser.js";
import {
  getDefaultRulebook,
  getEffectiveRulebook,
  validateDefaultContent,
} from "./rulebook.service.js";
import type { RulebookError } from "./rulebook.types.js";
import { evaluateTicket, type RulebookForChecks } from "./sop-evaluator.js";
import { getProjectProfiles } from "./sop-projects.service.js";

export interface SopTestInput {
  projectId: string;
  workItemId: number;
  /** Unsaved rules from the editor; omitted = the saved rules. */
  draft?: { scope: "default" | "personal"; content: string } | undefined;
}

export interface SopTestResult {
  result: ComplianceResult | null;
  /** Problems in the draft; when present nothing was checked. */
  errors: Array<{ field: string; message: string }>;
}

/** Marks the rulebook version that is the unsaved draft in a test result. */
export const DRAFT_VERSION = -1;

function toFieldErrors(problems: RulebookError[]) {
  return problems.map((problem) => ({ field: `line ${problem.line}`, message: problem.message }));
}

async function draftRulebook(
  userId: string,
  draft: NonNullable<SopTestInput["draft"]>
): Promise<RulebookForChecks | RulebookError[]> {
  if (draft.scope === "default") {
    // A default draft is tested as the team sees it: without anyone's personal rules.
    const parsed = parseRulebook(draft.content, "default");
    const { profiles } = await getProjectProfiles(null);
    return parsed.errors.length
      ? parsed.errors
      : { ...mergeRulebooks(parsed, null), projects: profiles, switchedOff: [], defaultVersion: DRAFT_VERSION, personalVersion: 0 };
  }

  const defaults = await getDefaultRulebook();
  const personal = parseRulebook(draft.content, "personal");
  const merged = mergeRulebooks(validateDefaultContent(defaults.content), personal);
  const problems = [...personal.errors, ...merged.issues];
  const { profiles, switchedOff } = await getProjectProfiles(userId);

  return problems.length
    ? problems
    : { ...merged, projects: profiles, switchedOff, defaultVersion: defaults.version, personalVersion: DRAFT_VERSION };
}

/** Runs the code rules on one real ticket, read-only, without saving anything. */
export async function testRulesOnTicket(client: AzureClient, userId: string, input: SopTestInput): Promise<SopTestResult> {
  let rulebook: RulebookForChecks;

  if (input.draft) {
    const draft = await draftRulebook(userId, input.draft);

    if (Array.isArray(draft)) {
      return { result: null, errors: toFieldErrors(draft) };
    }

    rulebook = draft;
  } else {
    rulebook = await getEffectiveRulebook(userId);
  }

  const raw = await getWorkItem(client, input.workItemId);
  const [summary] = await toWorkItemSummaries(client, [raw]);

  if (!summary || !belongsToProject(input.projectId, summary.projectName)) {
    throw new AzureApiError("AZURE_NOT_FOUND", 404);
  }

  return { result: await evaluateTicket(client, rulebook, summary, raw, new Date()), errors: [] };
}
