import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, pageWindow, type Page } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import type { ComplianceResult, IdentityRef } from "../../types/azure.types.js";
import { listAssignedWorkItemRecords } from "../azure/work-items.service.js";
import { checkCompliance } from "../compliance/compliance.service.js";
import { findProjectProfile } from "./rulebook.merge.js";
import { getEffectiveRulebook } from "./rulebook.service.js";
import { linkedSolidtimeFor } from "../solidtime/connection.service.js";
import { trackedHoursByTicket } from "../solidtime/reports.service.js";
import { logFallback } from "../../lib/log-fallback.js";

/* ------------------------------------------------------------------ shapes */

export interface ReportRule {
  ruleId: string;
  ruleTitle: string;
  severity: "high" | "medium";
}

/** One checked ticket as saved with a run. */
export interface ReportTicket {
  workItemId: number;
  title: string;
  type: string;
  state: string;
  assignee: IdentityRef | null;
  violations: Array<{ ruleId: string; ruleTitle: string; severity: "high" | "medium" | "low"; message: string }>;
  /** Gap rules this ticket passed. */
  passed: string[];
  /** Solidtime hours on the ticket when the run was made (see the run's timeScope). */
  trackedHours?: number | null;
}

export interface ReportRoles {
  tl: string[];
  qa: string[];
  po: string[];
}

export const REPORT_ROLES = ["tl", "qa", "po", "developer"] as const;
export type ReportRole = (typeof REPORT_ROLES)[number];

const ROLE_LABELS: Record<ReportRole, string> = { tl: "Team lead", qa: "QA", po: "Product owner", developer: "Developer" };

export interface ReportFilters {
  /** Person key (Azure id or unique name), or "unassigned". */
  person: string;
  role: ReportRole | "";
  rule: string;
  type: string;
  state: string;
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

export interface ReportRunSummary {
  id: string;
  projectName: string;
  defaultVersion: number;
  itemsChecked: number;
  itemsWithGaps: number;
  createdAt: string;
  /**
   * Whose Solidtime hours are included: "team", "mine", "unavailable" (a connection is linked but
   * Solidtime could not be read when the run was made; hours unknown), or null (no connection linked).
   */
  timeScope: "team" | "mine" | "unavailable" | null;
  /** More tickets existed than a run checks: only the most recently changed were checked. */
  truncated: boolean;
}

export interface ReportRunView {
  run: ReportRunSummary;
  /** Solidtime hours on the matching tickets (null when the run has no time). */
  trackedHours: number | null;
  /** All numbers below are for the tickets matching the filters. */
  itemsChecked: number;
  itemsWithGaps: number;
  /** Share of matching tickets with no gaps (0-1); null when none match. */
  compliantShare: number | null;
  byRule: Page<ReportRule & { failing: number; checked: number }>;
  byPerson: Page<{ personKey: string; assignee: IdentityRef | null; roles: ReportRole[]; items: number; itemsWithGaps: number; gaps: number; trackedHours: number | null }>;
  items: Page<ReportTicket>;
  facets: { people: FacetOption[]; roles: FacetOption[]; rules: FacetOption[]; types: FacetOption[]; states: FacetOption[] };
}

/* --------------------------------------------------------------- summaries */

function personKey(assignee: IdentityRef | null): string {
  return assignee?.id ?? assignee?.uniqueName ?? "unassigned";
}

/** Roles from the project set-up, matched by display name or sign-in name; anyone not listed is a developer. */
function rolesOf(assignee: IdentityRef | null, roles: ReportRoles): ReportRole[] {
  if (!assignee) {
    return ["developer"];
  }

  const names = [assignee.displayName, assignee.uniqueName].filter((name): name is string => Boolean(name)).map((name) => name.trim().toLowerCase());
  const listed = (["tl", "qa", "po"] as const).filter((role) => roles[role].some((entry) => names.includes(entry.trim().toLowerCase())));

  return listed.length > 0 ? listed : ["developer"];
}

function matches(ticket: ReportTicket, filters: ReportFilters, roles: ReportRoles): boolean {
  if (filters.person && personKey(ticket.assignee) !== filters.person) return false;
  if (filters.role && !rolesOf(ticket.assignee, roles).includes(filters.role)) return false;
  if (filters.rule && !ticket.violations.some((violation) => violation.ruleId === filters.rule)) return false;
  if (filters.type && ticket.type !== filters.type) return false;
  if (filters.state && ticket.state !== filters.state) return false;
  return true;
}

function countOptions(values: Array<{ value: string; label: string }>): FacetOption[] {
  const counts = new Map<string, FacetOption>();

  for (const { value, label } of values) {
    const entry = counts.get(value) ?? { value, label, count: 0 };
    entry.count += 1;
    counts.set(value, entry);
  }

  return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function facetsOf(tickets: ReportTicket[], rules: ReportRule[], roles: ReportRoles): ReportRunView["facets"] {
  const titles = new Map(rules.map((rule) => [rule.ruleId, rule.ruleTitle]));

  return {
    people: countOptions(tickets.map((ticket) => ({ value: personKey(ticket.assignee), label: ticket.assignee?.displayName ?? "Unassigned" }))),
    roles: REPORT_ROLES.map((role) => ({
      value: role,
      label: ROLE_LABELS[role],
      count: tickets.filter((ticket) => rolesOf(ticket.assignee, roles).includes(role)).length,
    })).filter((option) => option.count > 0),
    // Rules: how many tickets fail each one.
    rules: countOptions(
      tickets.flatMap((ticket) =>
        ticket.violations.map((violation) => ({ value: violation.ruleId, label: `${violation.ruleId} ${titles.get(violation.ruleId) ?? violation.ruleTitle}` }))
      )
    ).sort((a, b) => a.value.localeCompare(b.value)),
    types: countOptions(tickets.map((ticket) => ({ value: ticket.type, label: ticket.type }))),
    states: countOptions(tickets.map((ticket) => ({ value: ticket.state, label: ticket.state }))),
  };
}

function summarizeTickets(
  tickets: ReportTicket[],
  rules: ReportRule[],
  roles: ReportRoles,
  pages: { page: number; rulePage: number; personPage: number }
): Omit<ReportRunView, "run" | "facets" | "trackedHours"> {
  const withGaps = tickets.filter((ticket) => ticket.violations.length > 0);
  const byRule = rules
    .map((rule) => {
      const failing = tickets.filter((ticket) => ticket.violations.some((violation) => violation.ruleId === rule.ruleId)).length;
      return { ...rule, failing, checked: failing + tickets.filter((ticket) => ticket.passed.includes(rule.ruleId)).length };
    })
    .filter((rule) => rule.checked > 0)
    .sort((a, b) => b.failing - a.failing || a.ruleId.localeCompare(b.ruleId));
  const people = new Map<string, ReportRunView["byPerson"]["items"][number]>();

  for (const ticket of tickets) {
    const key = personKey(ticket.assignee);
    const person = people.get(key) ?? { personKey: key, assignee: ticket.assignee, roles: rolesOf(ticket.assignee, roles), items: 0, itemsWithGaps: 0, gaps: 0, trackedHours: null };
    person.items += 1;
    // Hours on the person's assigned tickets (whoever tracked them).
    if (typeof ticket.trackedHours === "number") {
      person.trackedHours = Math.round(((person.trackedHours ?? 0) + ticket.trackedHours) * 100) / 100;
    }
    person.gaps += ticket.violations.length;
    person.itemsWithGaps += ticket.violations.length > 0 ? 1 : 0;
    people.set(key, person);
  }

  return {
    itemsChecked: tickets.length,
    itemsWithGaps: withGaps.length,
    compliantShare: tickets.length ? (tickets.length - withGaps.length) / tickets.length : null,
    byRule: paginate(byRule, pages.rulePage),
    byPerson: paginate(
      [...people.values()].sort((a, b) => b.gaps - a.gaps || b.items - a.items),
      pages.personPage
    ),
    items: paginate(withGaps, pages.page),
  };
}

/** A code-rule result reduced to what a saved run keeps (gap rules only; notices are never counted). */
function toReportTicket(result: ComplianceResult, assignee: IdentityRef | null, gapRules: Set<string>): ReportTicket {
  return {
    workItemId: result.workItemId,
    title: result.title,
    type: result.type,
    state: result.state,
    assignee,
    violations: result.violations
      .filter((violation) => gapRules.has(violation.ruleId))
      .map((violation) => ({ ruleId: violation.ruleId, ruleTitle: violation.ruleTitle, severity: violation.severity, message: violation.message })),
    passed: result.passedRules.filter((rule) => gapRules.has(rule.ruleId)).map((rule) => rule.ruleId),
  };
}

/* -------------------------------------------------------------------- runs */

type RunRow = { id: string; projectName: string; defaultVersion: number; itemsChecked: number; itemsWithGaps: number; createdAt: Date; timeScope: string | null; truncated: boolean };

const runSummary = (row: RunRow): ReportRunSummary => ({
  id: row.id,
  projectName: row.projectName,
  defaultVersion: row.defaultVersion,
  itemsChecked: row.itemsChecked,
  itemsWithGaps: row.itemsWithGaps,
  createdAt: row.createdAt.toISOString(),
  timeScope: row.timeScope === "team" || row.timeScope === "mine" || row.timeScope === "unavailable" ? row.timeScope : null,
  truncated: row.truncated,
});

const RUN_SUMMARY_FIELDS = { id: true, projectName: true, defaultVersion: true, itemsChecked: true, itemsWithGaps: true, createdAt: true, timeScope: true, truncated: true } as const;

/**
 * Checks every open and recently closed ticket in the project with the
 * default rules only (never anyone's personal rules) and code rules only
 * (AI results are private), then saves the result as a run for this user.
 */
export async function runSopReport(client: AzureClient, userId: string, projectName: string, now = new Date()): Promise<ReportRunSummary> {
  const rulebook = await getEffectiveRulebook(userId, { forTeamReports: true });
  const profile = findProjectProfile(rulebook.projects, projectName);

  if (!profile) {
    throw new AppError(409, "SOP_PROJECT_NOT_SET_UP", `${projectName} is not set up for SOP checks yet (SOP rules → Projects).`);
  }

  const rules: ReportRule[] = rulebook.cards
    .filter((card) => card.checker === "code" && (card.severity === "fail" || card.severity === "warn"))
    .map((card) => ({ ruleId: card.id, ruleTitle: card.title, severity: card.severity === "fail" ? "high" : "medium" }));
  const gapRules = new Set(rules.map((rule) => rule.ruleId));
  // Capped like every SOP-checked list (the run must finish in time); a cut is saved with the run and shown.
  const { items: records, truncated } = await listAssignedWorkItemRecords(client, { projectName: profile.project, scope: "compliance", assignee: "any" });
  const results = await checkCompliance(client, userId, records, now, { forTeamReports: true });
  const assignees = new Map(records.map((record) => [record.summary.id, record.summary.assignedTo]));
  const tickets = results.filter((result) => result.configured).map((result) => toReportTicket(result, assignees.get(result.workItemId) ?? null, gapRules));
  const time = await reportTime(userId, client.credentialId, tickets.map((ticket) => ticket.workItemId), now);

  for (const ticket of tickets) {
    ticket.trackedHours = time && "hours" in time ? (time.hours.get(ticket.workItemId) ?? 0) : null;
  }

  const row = await prisma.sopReportRun.create({
    data: {
      userId,
      credentialId: client.credentialId,
      projectName,
      defaultVersion: rulebook.defaultVersion,
      itemsChecked: tickets.length,
      itemsWithGaps: tickets.filter((ticket) => ticket.violations.length > 0).length,
      rules: rules as object[],
      roles: profile.roles as object,
      tickets: tickets as object[],
      timeScope: time ? ("unavailable" in time ? "unavailable" : time.team ? "team" : "mine") : null,
      truncated,
      createdAt: now,
    },
    select: RUN_SUMMARY_FIELDS,
  });

  return runSummary(row);
}

/** This user's saved runs for one project, newest first, 10 per page. */
export async function listSopReportRuns(
  userId: string,
  credentialId: string,
  projectName: string,
  page: number
): Promise<Page<ReportRunSummary> & { latestId: string | null }> {
  const where = { userId, credentialId, projectName };
  const window = pageWindow(await prisma.sopReportRun.count({ where }), page);
  const [rows, latest] = await Promise.all([
    prisma.sopReportRun.findMany({ where, orderBy: { createdAt: "desc" }, skip: window.skip, take: window.take, select: RUN_SUMMARY_FIELDS }),
    prisma.sopReportRun.findFirst({ where, orderBy: { createdAt: "desc" }, select: { id: true } }),
  ]);

  return {
    items: rows.map(runSummary),
    page: window.page,
    pageSize: window.pageSize,
    total: window.total,
    totalPages: window.totalPages,
    // The newest run, shown by default whichever page of the list is open.
    latestId: latest?.id ?? null,
  };
}

async function ownRun(userId: string, credentialId: string, projectName: string, runId: string) {
  const row = await prisma.sopReportRun.findFirst({ where: { id: runId, userId, credentialId, projectName } });

  if (!row) {
    throw new AppError(404, "SOP_REPORT_NOT_FOUND", "Report not found");
  }

  return row;
}

/** One saved run, filtered and paged on the server. */
export async function getSopReportRun(
  userId: string,
  credentialId: string,
  projectName: string,
  runId: string,
  input: { filters: ReportFilters; page: number; rulePage: number; personPage: number }
): Promise<ReportRunView> {
  const row = await ownRun(userId, credentialId, projectName, runId);
  const tickets = row.tickets as unknown as ReportTicket[];
  const rules = row.rules as unknown as ReportRule[];
  const roles = row.roles as unknown as ReportRoles;
  const matching = tickets.filter((ticket) => matches(ticket, input.filters, roles));

  // Hours were read (an "unavailable" run's hours are unknown, not 0).
  const hasTime = row.timeScope === "team" || row.timeScope === "mine";

  return {
    run: runSummary(row),
    trackedHours: hasTime ? Math.round(matching.reduce((sum, ticket) => sum + (ticket.trackedHours ?? 0), 0) * 100) / 100 : null,
    ...summarizeTickets(matching, rules, roles, input),
    facets: facetsOf(tickets, rules, roles),
  };
}

/**
 * Solidtime hours per ticket for a report, from the user's Solidtime connection
 * linked to this Azure organization. Null (no time column) when none is linked;
 * `{ unavailable: true }` when Solidtime could not be read, so the run says so
 * instead of showing no time. The report itself never fails because of it.
 */
async function reportTime(
  userId: string,
  azureCredentialId: string,
  ticketIds: number[],
  now: Date
): Promise<Awaited<ReturnType<typeof trackedHoursByTicket>> | { unavailable: true } | null> {
  try {
    const linked = await linkedSolidtimeFor(userId, azureCredentialId, { background: true });
    return linked ? await trackedHoursByTicket(linked.client, linked.connection, ticketIds, now) : null;
  } catch (error) {
    logFallback("Reading Solidtime hours for the SOP report failed", error);
    return { unavailable: true };
  }
}

export async function deleteSopReportRun(userId: string, credentialId: string, projectName: string, runId: string): Promise<void> {
  const row = await ownRun(userId, credentialId, projectName, runId);
  await prisma.sopReportRun.delete({ where: { id: row.id } });
}
