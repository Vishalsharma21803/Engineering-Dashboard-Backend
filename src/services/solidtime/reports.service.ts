import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, isValidTimeZone, startOfZonedDay, zonedDay } from "../../lib/zoned-time.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import { aggregateByDescription, entrySeconds, getMe, listEntries, listMembers } from "./read.service.js";
import { candidateTicketIds, shareSeconds, ticketIdsOf } from "./ticket-ids.js";
import { SAME_TIME_HOURS, getTicketTimes } from "./ticket-time.service.js";
import { lookUpTickets, type TicketInfo } from "./tickets.service.js";
import { fallbackTo } from "../../lib/log-fallback.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

const roundHours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;

export async function zoneOf(client: SolidtimeClient): Promise<string> {
  const zone = (await getMe(client)).timezone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/* --------------------------------------------------------- estimate accuracy */

/**
 * A ticket is within its estimate when its total tracked time is at most its
 * Original Estimate (a minute's leeway): finishing early is fully compliant.
 */
export interface AccuracyRow {
  key: string;
  label: string;
  tickets: number;
  trackedHours: number;
  estimateHours: number;
  /** Tickets within their estimate. */
  withinEstimate: number;
  /** withinEstimate ÷ tickets (1 = every ticket within its estimate). */
  compliance: number;
  overEstimate: number;
}

export interface AccuracyTicket {
  ticketId: number;
  title: string;
  type: string;
  projectName: string;
  /** Hours on it inside the chosen period. */
  periodHours: number;
  /** Total tracked on it over all time (the team's when visible, else mine). */
  trackedHours: number;
  estimateHours: number;
  withinEstimate: boolean;
  /** How far the total went past the estimate (0 when within). */
  overByHours: number;
}

export interface AccuracyReport {
  from: string;
  to: string;
  team: boolean;
  /** All tickets compared together. */
  totals: { tickets: number; trackedHours: number; estimateHours: number; withinEstimate: number; compliance: number | null; overEstimate: number };
  /** Each ticket, furthest over its estimate first. */
  byTicket: Page<AccuracyTicket>;
  byPerson: Page<AccuracyRow>;
  byType: Page<AccuracyRow>;
  ticketsWithoutEstimate: number;
}

const within = (tracked: number, estimate: number) => tracked <= estimate + SAME_TIME_HOURS;

function accuracyRows(groups: Map<string, { label: string; items: Array<{ tracked: number; estimate: number }> }>): AccuracyRow[] {
  return [...groups.entries()]
    .map(([key, group]) => {
      const tracked = group.items.reduce((sum, item) => sum + item.tracked, 0);
      const estimate = group.items.reduce((sum, item) => sum + item.estimate, 0);
      const withinEstimate = group.items.filter((item) => within(item.tracked, item.estimate)).length;
      return {
        key,
        label: group.label,
        tickets: group.items.length,
        trackedHours: Math.round(tracked * 100) / 100,
        estimateHours: Math.round(estimate * 100) / 100,
        withinEstimate,
        compliance: Math.round((withinEstimate / group.items.length) * 100) / 100,
        overEstimate: group.items.length - withinEstimate,
      };
    })
    // Lowest compliance first: the groups worth a look.
    .sort((a, b) => a.compliance - b.compliance || a.label.localeCompare(b.label));
}

/**
 * Estimate compliance for the tickets with time in [from, to]: each ticket's
 * total tracked time (all time) against its Original Estimate, by person
 * (team roles) or for me, and by ticket type.
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
  const names = team ? new Map((await listMembers(client, connection.organizationId).catch(fallbackTo("Reading Solidtime member names failed", []))).map((member) => [member.user_id, member.name])) : new Map<string, string>();

  const { tickets, checked } = await lookUpTickets(azure, (aggregate.grouped_data ?? []).flatMap((group) => candidateTicketIds(group.key)));

  if (!checked) {
    // Without the tickets there are no estimates: an empty report would look like nothing to compare.
    throw new AppError(502, "AZURE_UNAVAILABLE", "Azure DevOps could not be read, so estimates cannot be compared. Try again.");
  }

  // seconds per ticket, and per (ticket, person); a description naming two tickets is split between them
  const perTicket = new Map<number, number>();
  const perTicketPerson = new Map<number, Map<string, number>>();
  const isTicket = (id: number) => tickets.has(id);

  for (const group of aggregate.grouped_data ?? []) {
    const ids = ticketIdsOf(group.key, isTicket);

    for (const id of ids) {
      perTicket.set(id, (perTicket.get(id) ?? 0) + group.seconds / ids.length);
      const people = perTicketPerson.get(id) ?? new Map<string, number>();

      for (const person of group.grouped_data ?? [{ key: "me", seconds: group.seconds }]) {
        const key = person.key ?? "unknown";
        people.set(key, (people.get(key) ?? 0) + person.seconds / ids.length);
      }

      perTicketPerson.set(id, people);
    }
  }
  const estimated = [...perTicket.keys()].filter((id) => tickets.get(id)?.originalEstimate);
  const totals = await getTicketTimes(client, connection, estimated, {});
  const byPerson = new Map<string, { label: string; items: Array<{ tracked: number; estimate: number }> }>();
  const byType = new Map<string, { label: string; items: Array<{ tracked: number; estimate: number }> }>();
  const withoutEstimate = [...perTicket.keys()].filter((id) => tickets.has(id) && !tickets.get(id)!.originalEstimate).length;
  const compared: AccuracyTicket[] = [];

  for (const id of estimated) {
    const ticket: TicketInfo = tickets.get(id)!;
    const estimate = ticket.originalEstimate!;
    const time = totals.get(id)!;
    const tracked = (team ? (time.teamSeconds ?? time.mySeconds) : time.mySeconds) / 3600;
    const ok = within(tracked, estimate);

    compared.push({
      ticketId: id,
      title: ticket.title,
      type: ticket.type,
      projectName: ticket.projectName,
      periodHours: Math.round(((perTicket.get(id) ?? 0) / 3600) * 100) / 100,
      trackedHours: Math.round(tracked * 100) / 100,
      estimateHours: estimate,
      withinEstimate: ok,
      overByHours: ok ? 0 : Math.round((tracked - estimate) * 100) / 100,
    });
    const typeGroup = byType.get(ticket.type) ?? { label: ticket.type, items: [] };
    typeGroup.items.push({ tracked, estimate });
    byType.set(ticket.type, typeGroup);

    // A ticket counts for whoever tracked most of its time in the period (one person per ticket).
    const [owner] = [...(perTicketPerson.get(id) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    const ownerKey = owner?.[0] ?? "me";
    const personGroup = byPerson.get(ownerKey) ?? { label: team ? (names.get(ownerKey) ?? "Someone") : "You", items: [] };
    personGroup.items.push({ tracked, estimate });
    byPerson.set(ownerKey, personGroup);
  }

  const trackedTotal = compared.reduce((sum, item) => sum + item.trackedHours, 0);
  const estimateTotal = compared.reduce((sum, item) => sum + item.estimateHours, 0);
  const withinTotal = compared.filter((item) => item.withinEstimate).length;

  return {
    from: input.from,
    to: input.to,
    team,
    totals: {
      tickets: compared.length,
      trackedHours: Math.round(trackedTotal * 100) / 100,
      estimateHours: Math.round(estimateTotal * 100) / 100,
      withinEstimate: withinTotal,
      compliance: compared.length > 0 ? Math.round((withinTotal / compared.length) * 100) / 100 : null,
      overEstimate: compared.length - withinTotal,
    },
    byTicket: paginate(
      compared.sort((a, b) => b.overByHours - a.overByHours || a.ticketId - b.ticketId),
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

const hoursCell = (value: number | null) => (value === null ? "" : roundHours(value * 3600));

/**
 * Time per person, day and ticket between two days (everyone with a team role,
 * otherwise mine), each row with its ticket's estimate figures: total tracked
 * (all time), Original Estimate, Azure's Completed and Remaining Work, and
 * whether the total stayed within the estimate.
 */
export async function timeCsv(client: SolidtimeClient, connection: Connection, azure: AzureClient | null, input: { from: string; to: string }, now = new Date()): Promise<string> {
  const timeZone = await zoneOf(client);
  const range = { start: startOfZonedDay(input.from, timeZone), end: startOfZonedDay(addDays(input.to, 1), timeZone) };
  const team = connection.canViewTeam;
  const { entries } = await listEntries(client, connection.organizationId, team ? range : { ...range, memberId: connection.memberId });
  const names = team ? new Map((await listMembers(client, connection.organizationId).catch(fallbackTo("Reading Solidtime member names failed", []))).map((member) => [member.user_id, member.name])) : new Map<string, string>();
  const { tickets, checked } = await lookUpTickets(azure, entries.flatMap((entry) => candidateTicketIds(entry.description)));
  const totals = await getTicketTimes(client, connection, [...tickets.keys()], { now });
  const rows = new Map<string, { person: string; day: string; ticketId: number | null; title: string; seconds: number }>();

  for (const entry of entries) {
    const person = team ? (names.get(entry.user_id) ?? "Someone") : "Me";
    const day = zonedDay(new Date(entry.start), timeZone);
    // Ids that could not be checked against Azure are kept as written.
    const ids = candidateTicketIds(entry.description).filter((id) => tickets.has(id) || !checked);
    const ticketId = ids[0] ?? null;
    const key = `${person}|${day}|${ticketId ?? entry.description ?? ""}`;
    const row = rows.get(key) ?? { person, day, ticketId, title: (ticketId !== null ? tickets.get(ticketId)?.title : undefined) ?? entry.description ?? "", seconds: 0 };
    row.seconds += entrySeconds(entry, now);
    rows.set(key, row);
  }

  const header = [
    "Person",
    "Day",
    "Ticket",
    "Title",
    "Type",
    "State",
    "Azure project",
    "Hours",
    "Total tracked (h)",
    "Original estimate (h)",
    "Completed Work (h)",
    "Remaining Work (h)",
    "Within estimate",
    "Over by (h)",
  ];
  const lines = [...rows.values()]
    .sort((a, b) => a.person.localeCompare(b.person) || a.day.localeCompare(b.day) || (a.ticketId ?? 0) - (b.ticketId ?? 0) || a.title.localeCompare(b.title))
    .map((row) => {
      const ticket = row.ticketId !== null ? tickets.get(row.ticketId) : undefined;
      const time = row.ticketId !== null ? totals.get(row.ticketId) : undefined;
      const tracked = time ? (time.teamSeconds ?? time.mySeconds) / 3600 : null;
      const estimate = ticket?.originalEstimate ?? null;
      const ok = tracked !== null && estimate !== null ? within(tracked, estimate) : null;
      return [
        row.person,
        row.day,
        row.ticketId ?? "",
        row.title,
        ticket?.type ?? "",
        ticket?.state ?? "",
        ticket?.projectName ?? "",
        roundHours(row.seconds),
        hoursCell(tracked),
        hoursCell(estimate),
        hoursCell(ticket?.completedWork ?? null),
        hoursCell(ticket?.remainingWork ?? null),
        ok === null ? "" : ok ? "Yes" : "No",
        ok === null ? "" : ok ? 0 : roundHours((tracked! - estimate!) * 3600),
      ]
        .map(csvCell)
        .join(",");
    });

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
    // The asked-for ids are tickets; a description naming two tickets is split between them.
    for (const [id, seconds] of shareSeconds(group.key, group.seconds, (candidate) => (wanted.has(candidate) ? true : null))) {
      if (wanted.has(id)) hours.set(id, (hours.get(id) ?? 0) + seconds / 3600);
    }
  }

  return { hours: new Map([...hours].map(([id, value]) => [id, Math.round(value * 100) / 100])), team };
}
