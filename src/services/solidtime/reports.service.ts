import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, isValidTimeZone, startOfZonedDay, zonedDay } from "../../lib/zoned-time.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import { aggregateByDescription, entrySeconds, getMe, listEntries, listMembers } from "./read.service.js";
import { candidateTicketIds } from "./ticket-ids.js";
import { lookUpTickets, type TicketInfo } from "./tickets.service.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

const roundHours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;

export async function zoneOf(client: SolidtimeClient): Promise<string> {
  const zone = (await getMe(client)).timezone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/* --------------------------------------------------------- estimate accuracy */

export interface AccuracyRow {
  key: string;
  label: string;
  tickets: number;
  trackedHours: number;
  estimateHours: number;
  /** Tracked ÷ estimate over these tickets (1 = on estimate); null without estimates. */
  ratio: number | null;
  overEstimate: number;
}

export interface AccuracyTicket {
  ticketId: number;
  title: string;
  type: string;
  projectName: string;
  trackedHours: number;
  estimateHours: number;
  /** Tracked ÷ estimate (1 = on estimate). */
  ratio: number;
}

export interface AccuracyReport {
  from: string;
  to: string;
  team: boolean;
  /** All tickets compared together. */
  totals: { tickets: number; trackedHours: number; estimateHours: number; ratio: number | null; overEstimate: number };
  /** Each ticket, furthest over its estimate first. */
  byTicket: Page<AccuracyTicket>;
  byPerson: Page<AccuracyRow>;
  byType: Page<AccuracyRow>;
  ticketsWithoutEstimate: number;
}

function accuracyRows(groups: Map<string, { label: string; items: Array<{ tracked: number; estimate: number }> }>): AccuracyRow[] {
  return [...groups.entries()]
    .map(([key, group]) => {
      const tracked = group.items.reduce((sum, item) => sum + item.tracked, 0);
      const estimate = group.items.reduce((sum, item) => sum + item.estimate, 0);
      return {
        key,
        label: group.label,
        tickets: group.items.length,
        trackedHours: Math.round(tracked * 100) / 100,
        estimateHours: Math.round(estimate * 100) / 100,
        ratio: estimate > 0 ? Math.round((tracked / estimate) * 100) / 100 : null,
        overEstimate: group.items.filter((item) => item.tracked > item.estimate).length,
      };
    })
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || a.label.localeCompare(b.label));
}

/**
 * How tracked time compares with Azure's original estimate, for tickets with
 * time in [from, to]: by person (team roles) or for me, and by ticket type.
 */
export async function estimateAccuracy(
  client: SolidtimeClient,
  connection: Connection,
  azure: AzureClient | null,
  input: { from: string; to: string; personPage: number; typePage: number; ticketPage?: number }
): Promise<AccuracyReport> {
  if (!azure) {
    throw new AppError(409, "AZURE_NOT_LINKED", "Link this Solidtime connection to an Azure DevOps organization first");
  }

  const timeZone = await zoneOf(client);
  const range = { start: startOfZonedDay(input.from, timeZone), end: startOfZonedDay(addDays(input.to, 1), timeZone) };
  let team = connection.canViewTeam;
  let aggregate;

  try {
    aggregate = await aggregateByDescription(client, connection.organizationId, team ? range : { ...range, memberId: connection.memberId }, team);
  } catch (error) {
    // The role was lowered in Solidtime since it was stored: show my own time.
    if (!team || !(error instanceof SolidtimeApiError) || error.solidtimeReason !== "SOLIDTIME_FORBIDDEN") throw error;
    team = false;
    aggregate = await aggregateByDescription(client, connection.organizationId, { ...range, memberId: connection.memberId }, false);
  }
  const names = team ? new Map((await listMembers(client, connection.organizationId).catch(() => [])).map((member) => [member.user_id, member.name])) : new Map<string, string>();

  // seconds per ticket, and per (ticket, person)
  const perTicket = new Map<number, number>();
  const perTicketPerson = new Map<number, Map<string, number>>();

  for (const group of aggregate.grouped_data ?? []) {
    for (const id of candidateTicketIds(group.key)) {
      perTicket.set(id, (perTicket.get(id) ?? 0) + group.seconds);
      const people = perTicketPerson.get(id) ?? new Map<string, number>();

      for (const person of group.grouped_data ?? [{ key: "me", seconds: group.seconds }]) {
        const key = person.key ?? "unknown";
        people.set(key, (people.get(key) ?? 0) + person.seconds);
      }

      perTicketPerson.set(id, people);
    }
  }

  const { tickets } = await lookUpTickets(azure, [...perTicket.keys()]);
  const byPerson = new Map<string, { label: string; items: Array<{ tracked: number; estimate: number }> }>();
  const byType = new Map<string, { label: string; items: Array<{ tracked: number; estimate: number }> }>();
  let withoutEstimate = 0;
  const compared: AccuracyTicket[] = [];

  for (const [id, seconds] of perTicket) {
    const ticket: TicketInfo | undefined = tickets.get(id);
    if (!ticket) continue;

    if (!ticket.originalEstimate) {
      withoutEstimate += 1;
      continue;
    }

    const tracked = seconds / 3600;
    compared.push({
      ticketId: id,
      title: ticket.title,
      type: ticket.type,
      projectName: ticket.projectName,
      trackedHours: Math.round(tracked * 100) / 100,
      estimateHours: ticket.originalEstimate,
      ratio: Math.round((tracked / ticket.originalEstimate) * 100) / 100,
    });
    const typeGroup = byType.get(ticket.type) ?? { label: ticket.type, items: [] };
    typeGroup.items.push({ tracked, estimate: ticket.originalEstimate });
    byType.set(ticket.type, typeGroup);

    // A ticket counts for whoever tracked most of its time (one person per ticket keeps the ratios honest).
    const [owner] = [...(perTicketPerson.get(id) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const ownerKey = owner?.[0] ?? "me";
    const personGroup = byPerson.get(ownerKey) ?? { label: team ? (names.get(ownerKey) ?? "Someone") : "You", items: [] };
    personGroup.items.push({ tracked, estimate: ticket.originalEstimate });
    byPerson.set(ownerKey, personGroup);
  }

  const trackedTotal = compared.reduce((sum, item) => sum + item.trackedHours, 0);
  const estimateTotal = compared.reduce((sum, item) => sum + item.estimateHours, 0);

  return {
    from: input.from,
    to: input.to,
    team,
    totals: {
      tickets: compared.length,
      trackedHours: Math.round(trackedTotal * 100) / 100,
      estimateHours: Math.round(estimateTotal * 100) / 100,
      ratio: estimateTotal > 0 ? Math.round((trackedTotal / estimateTotal) * 100) / 100 : null,
      overEstimate: compared.filter((item) => item.trackedHours > item.estimateHours).length,
    },
    byTicket: paginate(
      compared.sort((a, b) => b.ratio - a.ratio || a.ticketId - b.ticketId),
      input.ticketPage ?? 1
    ),
    byPerson: paginate(accuracyRows(byPerson), input.personPage),
    byType: paginate(accuracyRows(byType), input.typePage),
    ticketsWithoutEstimate: withoutEstimate,
  };
}

/* ------------------------------------------------------------- weekly CSV */

function csvCell(value: string | number): string {
  const text = String(value);
  // Quote everything; neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Time per person, ticket and day for the 7 days from `weekStart` (everyone with a team role, otherwise mine). */
export async function weeklyCsv(client: SolidtimeClient, connection: Connection, azure: AzureClient | null, weekStart: string, now = new Date()): Promise<string> {
  const timeZone = await zoneOf(client);
  const range = { start: startOfZonedDay(weekStart, timeZone), end: startOfZonedDay(addDays(weekStart, 7), timeZone) };
  const team = connection.canViewTeam;
  const { entries } = await listEntries(client, connection.organizationId, team ? range : { ...range, memberId: connection.memberId });
  const names = team ? new Map((await listMembers(client, connection.organizationId).catch(() => [])).map((member) => [member.user_id, member.name])) : new Map<string, string>();
  const { tickets, checked } = await lookUpTickets(azure, entries.flatMap((entry) => candidateTicketIds(entry.description)));
  const rows = new Map<string, { person: string; day: string; ticket: string; title: string; project: string; seconds: number }>();

  for (const entry of entries) {
    const person = team ? (names.get(entry.user_id) ?? "Someone") : "Me";
    const day = zonedDay(new Date(entry.start), timeZone);
    // Ids that could not be checked against Azure are kept as written.
    const ids = candidateTicketIds(entry.description).filter((id) => tickets.has(id) || !checked);
    const ticket = ids[0] !== undefined ? tickets.get(ids[0]) : undefined;
    const key = `${person}|${day}|${ids[0] ?? entry.description ?? ""}`;
    const row = rows.get(key) ?? {
      person,
      day,
      ticket: ids[0] !== undefined ? String(ids[0]) : "",
      title: ticket?.title ?? entry.description ?? "",
      project: ticket?.projectName ?? "",
      seconds: 0,
    };
    row.seconds += entrySeconds(entry, now);
    rows.set(key, row);
  }

  const header = ["Person", "Day", "Ticket", "Title", "Azure project", "Hours"];
  const lines = [...rows.values()]
    .sort((a, b) => a.person.localeCompare(b.person) || a.day.localeCompare(b.day) || a.ticket.localeCompare(b.ticket))
    .map((row) => [row.person, row.day, row.ticket, row.title, row.project, roundHours(row.seconds)].map(csvCell).join(","));

  return [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

/* ------------------------------------------------ team time for SOP reports */

/** Hours tracked per ticket over the last year (team when allowed, else mine), for the Team SOP report. */
export async function trackedHoursByTicket(client: SolidtimeClient, connection: Connection, ticketIds: number[], now = new Date()): Promise<{ hours: Map<number, number>; team: boolean }> {
  const team = connection.canViewTeam;
  const range = { start: new Date(now.getTime() - 365 * 86_400_000), end: now };
  const aggregate = await aggregateByDescription(client, connection.organizationId, team ? range : { ...range, memberId: connection.memberId }, false);
  const wanted = new Set(ticketIds);
  const hours = new Map<number, number>();

  for (const group of aggregate.grouped_data ?? []) {
    for (const id of candidateTicketIds(group.key)) {
      if (wanted.has(id)) hours.set(id, (hours.get(id) ?? 0) + group.seconds / 3600);
    }
  }

  return { hours: new Map([...hours].map(([id, value]) => [id, Math.round(value * 100) / 100])), team };
}
