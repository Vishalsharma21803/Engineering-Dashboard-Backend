import type { AzureClient } from "../../lib/azure/client.js";
import { paginate, type Page } from "../../lib/pagination.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, isValidTimeZone, startOfZonedDay, zonedDay } from "../../lib/zoned-time.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { entrySeconds, getMe, listEntries, listProjects } from "./read.service.js";
import { candidateTicketIds, ticketIdsOf } from "./ticket-ids.js";
import { lookUpTickets } from "./tickets.service.js";
import { fallbackTo } from "../../lib/log-fallback.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

export interface TimesheetEntry {
  id: string;
  start: string;
  end: string | null;
  seconds: number;
  running: boolean;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  tags: string[];
  billable: boolean;
  /** Azure tickets named in the description (only real tickets when Azure is linked). */
  tickets: Array<{ id: number; title: string; projectName: string }>;
}

export interface Timesheet {
  from: string;
  to: string;
  timeZone: string;
  totalSeconds: number;
  days: Array<{ day: string; seconds: number }>;
  byTicket: Page<{ ticketId: number; title: string; seconds: number }>;
  unlinkedSeconds: number;
  entries: Page<TimesheetEntry>;
  /**
   * My running timer if it is in this period, as counted above (its seconds up to now), so the page can keep the
   * totals moving without asking again. Its tickets share its time like any entry's; none means "not linked".
   */
  running: { id: string; start: string; day: string; seconds: number; ticketIds: number[] } | null;
  /** Ticket ids could be checked against Azure. */
  ticketsChecked: boolean;
  /** More entries than Relay reads at once; totals cover only those read. */
  truncated: boolean;
}

async function timeZoneOf(client: SolidtimeClient): Promise<string> {
  const zone = (await getMe(client)).timezone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/** My own entries in [from, to] (local days in my Solidtime time zone), annotated with Azure tickets. */
async function myEntries(client: SolidtimeClient, connection: Connection, azure: AzureClient | null, from: string, to: string, now: Date) {
  const timeZone = await timeZoneOf(client);
  const [{ entries, truncated }, projects] = await Promise.all([
    listEntries(client, connection.organizationId, { memberId: connection.memberId, start: startOfZonedDay(from, timeZone), end: startOfZonedDay(addDays(to, 1), timeZone) }),
    listProjects(client, connection.organizationId, "all").catch(fallbackTo("Reading Solidtime projects for the timesheet failed", [])),
  ]);
  const lookup = await lookUpTickets(azure, entries.flatMap((entry) => candidateTicketIds(entry.description)));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  const rows = entries.map((entry): TimesheetEntry => ({
    id: entry.id,
    start: entry.start,
    end: entry.end,
    seconds: entrySeconds(entry, now),
    running: entry.end === null,
    description: entry.description,
    projectId: entry.project_id,
    projectName: entry.project_id ? (projectNames.get(entry.project_id) ?? null) : null,
    taskId: entry.task_id,
    tags: entry.tags ?? [],
    billable: entry.billable,
    // Unchecked (Azure unreadable or not linked): "#123" and 4+ digit numbers count (see ticketIdsOf).
    tickets: ticketIdsOf(entry.description, (id) => (lookup.checked ? lookup.tickets.has(id) : null)).map((id) => {
      const ticket = lookup.tickets.get(id);
      return { id, title: ticket?.title ?? "", projectName: ticket?.projectName ?? "" };
    }),
  }));

  return { rows, timeZone, truncated, checked: lookup.checked };
}

function runningOf(rows: TimesheetEntry[], timeZone: string): Timesheet["running"] {
  // Solidtime runs one timer per person.
  const row = rows.find((candidate) => candidate.running);
  return row ? { id: row.id, start: row.start, day: zonedDay(new Date(row.start), timeZone), seconds: row.seconds, ticketIds: row.tickets.map((ticket) => ticket.id) } : null;
}

export async function getTimesheet(
  client: SolidtimeClient,
  connection: Connection,
  azure: AzureClient | null,
  input: { from: string; to: string; day?: string | undefined; page: number; ticketPage: number; now?: Date }
): Promise<Timesheet> {
  const now = input.now ?? new Date();
  const { rows, timeZone, truncated, checked } = await myEntries(client, connection, azure, input.from, input.to, now);
  const days = new Map<string, number>();
  const tickets = new Map<number, { ticketId: number; title: string; seconds: number }>();
  let unlinkedSeconds = 0;

  for (let day = input.from; day <= input.to; day = addDays(day, 1)) {
    days.set(day, 0);
  }

  for (const row of rows) {
    const day = zonedDay(new Date(row.start), timeZone);
    days.set(day, (days.get(day) ?? 0) + row.seconds);

    if (row.tickets.length === 0) {
      unlinkedSeconds += row.seconds;
    }

    // An entry naming two tickets is split between them.
    for (const ticket of row.tickets) {
      const entry = tickets.get(ticket.id) ?? { ticketId: ticket.id, title: ticket.title, seconds: 0 };
      entry.seconds += row.seconds / row.tickets.length;
      tickets.set(ticket.id, entry);
    }
  }

  return {
    from: input.from,
    to: input.to,
    timeZone,
    totalSeconds: rows.reduce((total, row) => total + row.seconds, 0),
    days: [...days.entries()].filter(([day]) => day >= input.from && day <= input.to).map(([day, seconds]) => ({ day, seconds })),
    byTicket: paginate([...tickets.values()].map((ticket) => ({ ...ticket, seconds: Math.round(ticket.seconds) })).sort((a, b) => b.seconds - a.seconds), input.ticketPage),
    unlinkedSeconds,
    running: runningOf(rows, timeZone),
    // The list can be one day of the period; totals above always cover all of it.
    entries: paginate(input.day ? rows.filter((row) => zonedDay(new Date(row.start), timeZone) === input.day) : rows, input.page),
    ticketsChecked: checked,
    truncated,
  };
}

/** My entries in [from, to] whose description names no (real) Azure ticket, newest first. */
export async function getUnlinkedEntries(
  client: SolidtimeClient,
  connection: Connection,
  azure: AzureClient | null,
  input: { from: string; to: string; page: number; now?: Date }
): Promise<Page<TimesheetEntry> & { ticketsChecked: boolean }> {
  const { rows, checked } = await myEntries(client, connection, azure, input.from, input.to, input.now ?? new Date());
  return { ...paginate(rows.filter((row) => row.tickets.length === 0), input.page), ticketsChecked: checked };
}
