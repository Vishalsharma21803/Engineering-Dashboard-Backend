import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import type { ComplianceResult, IdentityRef } from "../../types/azure.types.js";
import { checkCompliance } from "../compliance/compliance.service.js";
import { listAssignedWorkItemRecords } from "../azure/work-items.service.js";
import { findProjectProfile } from "./rulebook.merge.js";
import { getEffectiveRulebook } from "./rulebook.service.js";

const MAX_LISTED_ITEMS = 200;

export interface SopReport {
  projectName: string;
  /** False when the project is not set up for SOP checks. */
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
  /** Severity per rule id from the default rules ("fail" = high); notice rules are left out of the report. */
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
      if (!severities.has(rule.ruleId)) {
        continue;
      }

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

/** A built report is reused for page changes for this long; "Rebuild" bypasses it. */
const REPORT_TTL_MS = 10 * 60_000;
const MAX_CACHED_REPORTS = 200;
const reports = new Map<string, { expiresAt: number; report: SopReport }>();

/** Exposed for tests. */
export function clearSopReportCache(): void {
  reports.clear();
}

export type PagedSopReport = Omit<SopReport, "items"> & { items: Page<SopReport["items"][number]> };

/** The report with its tickets-with-gaps list paged (10 per page); the totals cover every ticket. */
export async function getPagedSopReport(
  client: AzureClient,
  userId: string,
  projectName: string,
  input: { page: number; refresh: boolean }
): Promise<PagedSopReport> {
  // Team reports use the default rules only, so one built report serves everyone with this connection.
  const key = `${client.credentialId}|${projectName.toLowerCase()}`;
  const cached = reports.get(key);
  let report = cached && cached.expiresAt > Date.now() && !input.refresh ? cached.report : null;

  if (!report) {
    report = await getSopReport(client, userId, projectName);

    if (reports.size >= MAX_CACHED_REPORTS) {
      const oldest = reports.keys().next().value;

      if (oldest !== undefined) {
        reports.delete(oldest);
      }
    }

    reports.delete(key);
    reports.set(key, { expiresAt: Date.now() + REPORT_TTL_MS, report });
  }

  return { ...report, items: paginate(report.items, input.page) };
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
    severities: new Map(
      rulebook.cards
        .filter((card) => card.severity === "fail" || card.severity === "warn")
        .map((card) => [card.id, card.severity === "fail" ? ("high" as const) : ("medium" as const)])
    ),
    now,
  };

  if (!context.configured) {
    return summarizeReport([], { ...context, assignees: new Map() });
  }

  const records = await listAssignedWorkItemRecords(client, { projectName, scope: "compliance", assignee: "any" });
  const results = await checkCompliance(client, userId, records, now, { forTeamReports: true });

  return summarizeReport(results, { ...context, assignees: new Map(records.map((record) => [record.summary.id, record.summary.assignedTo])) });
}
