import type { AzureClient } from "../../lib/azure/client.js";
import type { ComplianceResult, IdentityRef } from "../../types/azure.types.js";
import { checkCompliance } from "../compliance/compliance.service.js";
import { listAssignedWorkItemRecords } from "../azure/work-items.service.js";
import { findProjectProfile } from "./rulebook.merge.js";
import { getEffectiveRulebook } from "./rulebook.service.js";

const MAX_LISTED_ITEMS = 200;

export interface SopReport {
  projectName: string;
  /** False when the default rulebook has no facts for this project. */
  configured: boolean;
  defaultVersion: number;
  generatedAt: string;
  itemsChecked: number;
  itemsWithGaps: number;
  /** Share of checked tickets with no gaps (0-1); null when nothing was checked. */
  compliantShare: number | null;
  byRule: Array<{ ruleId: string; ruleTitle: string; severity: "high" | "medium"; failing: number; checked: number }>;
  byPerson: Array<{ assignee: IdentityRef | null; items: number; itemsWithGaps: number; gaps: number }>;
  items: Array<{
    workItemId: number;
    title: string;
    type: string;
    state: string;
    assignee: IdentityRef | null;
    violations: Array<{ ruleId: string; ruleTitle: string; severity: "high" | "medium" | "low"; message: string }>;
  }>;
}

function personKey(assignee: IdentityRef | null): string {
  return assignee?.id ?? assignee?.uniqueName ?? "unassigned";
}

export interface ReportContext {
  projectName: string;
  configured: boolean;
  defaultVersion: number;
  /** Severity per rule id from the default rules ("fail" = high). */
  severities: Map<string, "high" | "medium">;
  assignees: Map<number, IdentityRef | null>;
  now: Date;
}

export function summarizeReport(results: ComplianceResult[], context: ReportContext): SopReport {
  const { assignees, severities } = context;
  const checked = results.filter((result) => result.configured);
  const withGaps = checked.filter((result) => result.violations.length > 0);
  const rules = new Map<string, SopReport["byRule"][number]>();
  const people = new Map<string, SopReport["byPerson"][number]>();

  for (const result of checked) {
    for (const rule of result.passedRules) {
      const entry = rules.get(rule.ruleId) ?? { ...rule, severity: severities.get(rule.ruleId) ?? "medium", failing: 0, checked: 0 };
      entry.checked += 1;
      rules.set(rule.ruleId, entry);
    }

    for (const violation of result.violations) {
      const entry = rules.get(violation.ruleId) ?? {
        ruleId: violation.ruleId,
        ruleTitle: violation.ruleTitle,
        severity: severities.get(violation.ruleId) ?? "medium",
        failing: 0,
        checked: 0,
      };
      entry.checked += 1;
      entry.failing += 1;
      rules.set(violation.ruleId, entry);
    }

    const assignee = assignees.get(result.workItemId) ?? null;
    const person = people.get(personKey(assignee)) ?? { assignee, items: 0, itemsWithGaps: 0, gaps: 0 };
    person.items += 1;
    person.gaps += result.violations.length;
    person.itemsWithGaps += result.violations.length > 0 ? 1 : 0;
    people.set(personKey(assignee), person);
  }

  return {
    projectName: context.projectName,
    configured: context.configured,
    defaultVersion: context.defaultVersion,
    generatedAt: context.now.toISOString(),
    itemsChecked: checked.length,
    itemsWithGaps: withGaps.length,
    compliantShare: checked.length ? (checked.length - withGaps.length) / checked.length : null,
    byRule: [...rules.values()].sort((a, b) => b.failing - a.failing || a.ruleId.localeCompare(b.ruleId)),
    byPerson: [...people.values()].sort((a, b) => b.gaps - a.gaps || b.items - a.items),
    items: withGaps.slice(0, MAX_LISTED_ITEMS).map((result) => ({
      workItemId: result.workItemId,
      title: result.title,
      type: result.type,
      state: result.state,
      assignee: assignees.get(result.workItemId) ?? null,
      violations: result.violations.map((violation) => ({
        ruleId: violation.ruleId,
        ruleTitle: violation.ruleTitle,
        severity: violation.severity,
        message: violation.message,
      })),
    })),
  };
}

/**
 * The whole team's SOP picture for one project: open tickets and those
 * closed recently, judged by the default rules only (never anyone's
 * personal rules) and by code rules only (AI results are private).
 */
export async function getSopReport(client: AzureClient, userId: string, projectName: string, now = new Date()): Promise<SopReport> {
  const rulebook = await getEffectiveRulebook(userId, { forTeamReports: true });
  const context = {
    projectName,
    configured: findProjectProfile(rulebook.projects, projectName) !== null,
    defaultVersion: rulebook.defaultVersion,
    severities: new Map(rulebook.cards.map((card) => [card.id, card.severity === "fail" ? ("high" as const) : ("medium" as const)])),
    now,
  };

  if (!context.configured) {
    return summarizeReport([], { ...context, assignees: new Map() });
  }

  const records = await listAssignedWorkItemRecords(client, { projectName, scope: "compliance", assignee: "any" });
  const results = await checkCompliance(client, userId, records, now, { forTeamReports: true });

  return summarizeReport(results, { ...context, assignees: new Map(records.map((record) => [record.summary.id, record.summary.assignedTo])) });
}
