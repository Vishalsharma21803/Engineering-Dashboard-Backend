import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, isValidTimeZone, zonedDay, zonedDayRange } from "../../lib/zoned-time.js";
import { getIdentity } from "../azure/identity.service.js";
import { WORK_ITEM_FIELDS, getWorkItemComments, getWorkItemUpdates, listTouchedWorkItemIds, updateDate } from "../azure/work-items.service.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { entrySeconds, getMe, listEntries, listProjects } from "./read.service.js";
import { candidateTicketIds, ticketDescription } from "./ticket-ids.js";
import { lookUpTickets } from "./tickets.service.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

/** Drafts can be made for today and the 14 days before it. */
export const DRAFT_MAX_DAYS_BACK = 14;
/** At most this many tickets are read (and a day can be approved in one batch of 50). */
const MAX_TICKETS = 50;

export interface DraftActivity {
  at: string;
  what: string;
}

export interface DraftRow {
  ticketId: number;
  title: string;
  projectName: string;
  /** What I did on the ticket that day, from Azure. */
  activity: DraftActivity[];
  /** Sum of my increases to Completed Work that day (hours). */
  completedWorkAdded: number;
  /** Decreases to Completed Work that day (corrections; not counted). */
  completedWorkRemoved: number;
  /** Time already in Solidtime for this ticket that day (hours). */
  alreadyTrackedHours: number;
  /** Suggested new time (hours): Completed Work added minus already tracked; null = only activity, enter it yourself. */
  hours: number | null;
  /** Suggested placement (UTC); null when no slot fits or no hours are known. */
  start: string | null;
  end: string | null;
  description: string;
  /** The Solidtime project for the ticket's Azure project (mapping, or the same name). */
  solidtimeProjectId: string | null;
  note: string | null;
}

export interface DayDraft {
  day: string;
  timeZone: string;
  rows: DraftRow[];
  /** More tickets were touched than Cockpit reads at once. */
  truncated: boolean;
}

const roundQuarter = (hours: number) => Math.round(hours * 4) / 4;
const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

interface Interval {
  start: number;
  end: number;
}

/**
 * Places an entry of `ms` ending at `preferredEnd`, moving it earlier past any
 * busy interval; if it no longer fits in the day, the first free gap from the
 * start of the day is used. Null when the day has no room.
 */
export function placeEntry(busy: Interval[], ms: number, preferredEnd: number, day: Interval): Interval | null {
  const overlaps = (slot: Interval) => busy.find((other) => slot.start < other.end && other.start < slot.end);
  let end = Math.min(preferredEnd, day.end);

  for (let guard = 0; guard < 200; guard += 1) {
    const slot = { start: end - ms, end };

    if (slot.start < day.start) break;

    const clash = overlaps(slot);
    if (!clash) return slot;
    end = clash.start;
  }

  // From the start of the day, the first gap that is long enough.
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  let cursor = day.start;

  for (const other of sorted) {
    if (other.start - cursor >= ms) return { start: cursor, end: cursor + ms };
    cursor = Math.max(cursor, other.end);
  }

  return day.end - cursor >= ms ? { start: cursor, end: cursor + ms } : null;
}

function solidtimeProjectFor(projectName: string, connection: Connection, projects: Array<{ id: string; name: string }>): string | null {
  const mapped = connection.projectMap[projectName.toLowerCase()];

  if (mapped && projects.some((project) => project.id === mapped)) {
    return mapped;
  }

  return projects.find((project) => project.name.trim().toLowerCase() === projectName.trim().toLowerCase())?.id ?? null;
}

/**
 * A suggested timesheet for one day, built from what I did in Azure DevOps:
 * hours from my increases to Completed Work (minus what Solidtime already has
 * for the ticket that day), activity (state changes, comments, other edits)
 * listed for tickets without hours. Read-only: nothing is written.
 */
export async function draftDayFromAzure(client: SolidtimeClient, connection: Connection, azure: AzureClient | null, day: string, now = new Date()): Promise<DayDraft> {
  if (!azure) {
    throw new AppError(409, "AZURE_NOT_LINKED", "Link this Solidtime connection to an Azure DevOps organization first");
  }

  const zone = (await getMe(client)).timezone;
  const timeZone = zone && isValidTimeZone(zone) ? zone : "UTC";
  const today = zonedDay(now, timeZone);

  if (day > today || day < addDays(today, -DRAFT_MAX_DAYS_BACK)) {
    throw new AppError(422, "DRAFT_DAY_OUT_OF_RANGE", `Choose today or one of the ${DRAFT_MAX_DAYS_BACK} days before it`);
  }

  const range = zonedDayRange(day, timeZone);
  const window: Interval = { start: range.start.getTime(), end: Math.min(range.end.getTime(), now.getTime()) };
  const [identity, touched, existing, projects] = await Promise.all([
    getIdentity(azure),
    // Azure compares days in its own zone; one day earlier is safe, revisions are checked exactly below.
    listTouchedWorkItemIds(azure, addDays(day, -1)),
    listEntries(client, connection.organizationId, { memberId: connection.memberId, start: range.start, end: range.end }),
    listProjects(client, connection.organizationId).catch(() => []),
  ]);
  const ids = touched.slice(0, MAX_TICKETS);
  const lookup = await lookUpTickets(azure, ids);
  const inDay = (iso: string) => {
    const time = Date.parse(iso);
    return time >= range.start.getTime() && time < range.end.getTime();
  };
  const email = identity.email?.toLowerCase() ?? null;
  const isMe = (identityRef: { id?: string | null; uniqueName?: string | null } | undefined) =>
    Boolean(identityRef && ((identityRef.id && identityRef.id === identity.id) || (email !== null && identityRef.uniqueName?.toLowerCase() === email)));

  const limit = createLimiter(4);
  const perTicket = await mapWithLimit(ids, limit, async (id) => {
    const ticket = lookup.tickets.get(id);

    if (!ticket) {
      return null;
    }

    const [updates, comments] = await Promise.all([
      getWorkItemUpdates(azure, ticket.projectName, id),
      getWorkItemComments(azure, ticket.projectName, id).catch(() => []),
    ]);
    const activity: DraftActivity[] = [];
    let added = 0;
    let removed = 0;
    let lastIncreaseAt: number | null = null;

    for (const update of updates) {
      const at = updateDate(update);

      if (!at || !inDay(at) || !isMe(update.revisedBy)) continue;

      const fields = update.fields ?? {};
      const state = fields[WORK_ITEM_FIELDS.state];
      const completed = fields[WORK_ITEM_FIELDS.completedWork];

      if (state && state.newValue !== undefined) {
        activity.push({ at, what: `State ${String(state.oldValue ?? "—")} → ${String(state.newValue)}` });
      }

      if (completed) {
        const delta = (asNumber(completed.newValue) ?? 0) - (asNumber(completed.oldValue) ?? 0);

        if (delta > 0) {
          added += delta;
          lastIncreaseAt = Date.parse(at);
        } else if (delta < 0) {
          removed += -delta;
        }

        activity.push({ at, what: `Completed Work ${asNumber(completed.oldValue) ?? 0} → ${asNumber(completed.newValue) ?? 0}` });
      }

      const other = Object.keys(fields).filter(
        (field) => ![WORK_ITEM_FIELDS.state, WORK_ITEM_FIELDS.completedWork, WORK_ITEM_FIELDS.changedDate, "System.ChangedBy", "System.Rev", "System.AuthorizedDate", "System.RevisedDate", "System.AuthorizedAs", "System.PersonId", "System.Watermark", "System.StateChangeDate", "Microsoft.VSTS.Common.StateChangeDate"].includes(field)
      );

      if (!state && !completed && other.length > 0) {
        activity.push({ at, what: `Edited ${other.map((field) => field.split(".").pop()).join(", ")}` });
      }
    }

    for (const comment of comments) {
      if (inDay(comment.createdDate) && isMe(comment.createdBy)) {
        activity.push({ at: comment.createdDate, what: "Commented" });
      }
    }

    if (activity.length === 0) {
      return null;
    }

    activity.sort((a, b) => a.at.localeCompare(b.at));
    return { ticket, activity, added, removed, lastIncreaseAt };
  });

  // Time Solidtime already has on each ticket that day (whatever the description wording).
  const tracked = new Map<number, number>();

  for (const entry of existing.entries) {
    for (const ticketId of candidateTicketIds(entry.description)) {
      tracked.set(ticketId, (tracked.get(ticketId) ?? 0) + entrySeconds(entry, now) / 3600);
    }
  }

  const busy: Interval[] = existing.entries.map((entry) => ({ start: Date.parse(entry.start), end: entry.end ? Date.parse(entry.end) : now.getTime() }));
  const found = perTicket.filter((item): item is NonNullable<typeof item> => item !== null);
  // Place the ones with known hours, earliest change first, so later work stays later.
  found.sort((a, b) => (a.lastIncreaseAt ?? Number.MAX_SAFE_INTEGER) - (b.lastIncreaseAt ?? Number.MAX_SAFE_INTEGER));

  const rows: DraftRow[] = found.map(({ ticket, activity, added, removed, lastIncreaseAt }) => {
    const already = roundQuarter(tracked.get(ticket.id) ?? 0);
    const missing = roundQuarter(added - already);
    const hours = added > 0 ? Math.max(0, missing) : null;
    let start: string | null = null;
    let end: string | null = null;
    let note: string | null = removed > 0 ? `Completed Work was also lowered by ${removed} h that day (not counted).` : null;

    if (hours !== null && hours > 0) {
      const slot = placeEntry(busy, hours * 3_600_000, lastIncreaseAt ?? window.end, window);

      if (slot) {
        busy.push(slot);
        start = new Date(slot.start).toISOString();
        end = new Date(slot.end).toISOString();
      } else {
        note = "No free time left in the day for this; set the times yourself.";
      }
    } else if (hours === 0) {
      note = "Already tracked in Solidtime.";
    }

    return {
      ticketId: ticket.id,
      title: ticket.title,
      projectName: ticket.projectName,
      activity,
      completedWorkAdded: roundQuarter(added),
      completedWorkRemoved: roundQuarter(removed),
      alreadyTrackedHours: already,
      hours,
      start,
      end,
      description: ticketDescription(ticket.id, ticket.title),
      solidtimeProjectId: solidtimeProjectFor(ticket.projectName, connection, projects),
      note,
    };
  });

  return { day, timeZone, rows: rows.sort((a, b) => a.ticketId - b.ticketId), truncated: touched.length > ids.length };
}
