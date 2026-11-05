import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, isValidTimeZone, zonedDay, zonedDayRange } from "../../lib/zoned-time.js";
import { getIdentity } from "../azure/identity.service.js";
import { WORK_ITEM_FIELDS, listWorkItemIdsChangedByMeSince, readWorkItemComments, readWorkItemUpdates, updateDate } from "../azure/work-items.service.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import type { SolidtimeProject, SolidtimeTimeEntry } from "../../lib/solidtime/types.js";
import { getMe, listEntries, listProjects, overlapsRange, secondsWithin } from "./read.service.js";
import { candidateTicketIds, shareSeconds, ticketDescription } from "./ticket-ids.js";
import { finishedState, lookUpTickets } from "./tickets.service.js";
import { logFallback } from "../../lib/log-fallback.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

/** Drafts can be made for today and the 14 days before it. */
export const DRAFT_MAX_DAYS_BACK = 14;
/** At most this many tickets I changed since the day are read for my changes that day. */
const MAX_SCAN = 200;
/** At most this many rows (tickets with my activity that day): a day can be approved in one batch of 50. */
const MAX_TICKETS = 50;
/** How far back my own Solidtime entries are read to learn which project a ticket goes to. */
const PROJECT_HISTORY_DAYS = 60;
/** At most this many earlier tickets are looked up in Azure for their project. */
const MAX_HISTORY_TICKETS = 200;

export interface DraftActivity {
  at: string;
  what: string;
}

export type HoursSource = "completed-work" | "remaining-work" | "activity";

/** Where a row's Solidtime project came from. */
export type ProjectSource = "mapping" | "ticket" | "azure-project" | "name";

export interface DraftRow {
  ticketId: number;
  title: string;
  projectName: string;
  type: string;
  state: string;
  originalEstimate: number | null;
  completedWork: number | null;
  remainingWork: number | null;
  /** What I did on the ticket that day, from Azure. */
  activity: DraftActivity[];
  /** Sum of my increases to Completed Work that day (hours). */
  completedWorkAdded: number;
  /** Decreases to Completed Work that day (corrections; not counted). */
  completedWorkRemoved: number;
  /** Sum of my decreases to Remaining Work that day (hours). */
  remainingWorkLowered: number;
  /** Time already in Solidtime for this ticket that day (hours). */
  alreadyTrackedHours: number;
  /** Suggested new time (hours), from the evidence in `hoursSource`, minus what Solidtime already has for the ticket that day. */
  hours: number | null;
  /**
   * The evidence behind `hours`, strongest first: my Completed Work increases,
   * else my Remaining Work decreases, else the time before my changes on the
   * ticket (see `activityHours`). Null when there is no evidence.
   */
  hoursSource: HoursSource | null;
  /** The evidence in words, e.g. "Remaining Work 6 → 4 h", so the hours can be checked. */
  hoursBasis: string | null;
  /** Where an entry for this row would preferably end (UTC): where its evidence ends (my last such change). */
  anchor: string;
  /** Suggested placement (UTC); null when no slot fits or no hours are known. */
  start: string | null;
  end: string | null;
  description: string;
  /** The Solidtime project for the ticket (see `chooseProject`). */
  solidtimeProjectId: string | null;
  projectSource: ProjectSource | null;
  /** Names of the Solidtime projects that all match the Azure project's name, when no project could be chosen because of that. */
  projectMatches: string[];
  note: string | null;
}

export interface DayDraft {
  day: string;
  timeZone: string;
  /** My daily target on this connection (hours). */
  targetHours: number;
  /** Everything I already have in Solidtime that day, with or without a ticket (hours). */
  trackedHours: number;
  /** My existing Solidtime entries that day (UTC), so new ones can avoid them. */
  busy: Array<{ start: string; end: string }>;
  rows: DraftRow[];
  /** Some work may be missing: see truncatedReason. */
  truncated: boolean;
  /**
   * "scan": I changed more tickets since that day than Relay reads, so the oldest-changed were not checked;
   * "rows": more tickets had my activity that day than one draft holds (50); null: nothing was cut.
   */
  truncatedReason: "scan" | "rows" | null;
  /** Reads that failed or were cut; the draft is still made, but may be incomplete. */
  warnings: string[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The longest gap before a change that still counts as work on it; longer gaps (lunch, a meeting, the night) count this much. */
export const MAX_GAP_HOURS = 2;
/** Any ticket I changed gets at least this much (a lone small edit). */
export const MIN_ACTIVITY_HOURS = 0.25;
/** Remaining Work lowered counts as at most this much work in a day (lowering it from 40 h to 0 on closing is not 40 h of work). */
export const MAX_REMAINING_WORK_HOURS = 12;
const roundQuarter = (hours: number) => Math.round(hours * 4) / 4;
const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

interface Interval {
  start: number;
  end: number;
}

/**
 * Hours per ticket from my day's timeline: the time between one of my changes
 * (on any ticket) and the next is credited to the ticket of that next change,
 * as the work that led to it. The first change of the day is measured from the
 * start of my first Solidtime entry that day, when there is one before it. A
 * gap counts at most MAX_GAP_HOURS, time already in Solidtime entries is left
 * out, and every ticket gets at least MIN_ACTIVITY_HOURS. Same input, same hours.
 */
export function activityHours(events: Array<{ ticketId: number; at: number }>, busy: Interval[]): Map<number, number> {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const hours = new Map<number, number>();
  // Overlapping busy time (an entry and a running timer) counts once.
  const merged: Interval[] = [];
  for (const interval of [...busy].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }

  // `busy` is that day's entries: the first one starts my working day.
  const dayStart = merged[0]?.start;

  sorted.forEach((event, index) => {
    const previous = index > 0 ? sorted[index - 1]!.at : dayStart !== undefined && dayStart < event.at ? dayStart : event.at;
    const from = Math.max(previous, event.at - MAX_GAP_HOURS * HOUR);
    const covered = merged.reduce((sum, other) => sum + Math.max(0, Math.min(event.at, other.end) - Math.max(from, other.start)), 0);
    const worked = Math.max(0, event.at - from - covered) / HOUR;
    hours.set(event.ticketId, (hours.get(event.ticketId) ?? 0) + worked);
  });

  for (const [ticketId, value] of hours) hours.set(ticketId, Math.max(MIN_ACTIVITY_HOURS, value));
  return hours;
}

/**
 * The hours a ticket's evidence supports, strongest evidence first: my
 * Completed Work increases, else my Remaining Work decreases, else my
 * timeline (`activityHours`), capped by the Remaining Work the ticket had
 * that day (`remainingThatDay`).
 */
export function hoursEvidence(
  item: { remainingThatDay: number | null; activity: DraftActivity[]; added: number; lowered: number },
  timelineHours: number,
  clock: (at: string) => string
): { hours: number; source: HoursSource; basis: string } {
  if (item.added > 0) {
    return { hours: item.added, source: "completed-work", basis: `Completed Work raised by ${roundQuarter(item.added)} h` };
  }

  if (item.lowered > 0) {
    const limited = item.lowered > MAX_REMAINING_WORK_HOURS;
    return {
      hours: Math.min(item.lowered, MAX_REMAINING_WORK_HOURS),
      source: "remaining-work",
      basis: `Remaining Work lowered by ${roundQuarter(item.lowered)} h${limited ? `, counted as ${MAX_REMAINING_WORK_HOURS} h at most` : ""}`,
    };
  }

  // Remaining Work is what was left to do at most (when it is set).
  const left = item.remainingThatDay;
  const capped = left !== null && left > 0 && timelineHours > left;
  const hours = Math.max(MIN_ACTIVITY_HOURS, roundQuarter(capped ? left : timelineHours));
  const first = item.activity[0]?.at;
  const last = item.activity.at(-1)?.at;
  const changes = `${item.activity.length} change${item.activity.length === 1 ? "" : "s"}`;
  const span = first && last ? (first === last ? ` at ${clock(first)}` : ` between ${clock(first)} and ${clock(last)}`) : "";
  return { hours, source: "activity", basis: `${changes}${span}${capped ? `, capped at its ${left} h Remaining Work` : ""}` };
}

/**
 * Places an entry of `ms` ending at `preferredEnd`, moving it earlier past any
 * busy interval; if it no longer fits in the day, the first free gap from the
 * start of the day is used. Null when the day has no room.
 */
export function placeEntry(taken: Interval[], ms: number, preferredEnd: number, window: Interval): Interval | null {
  // Whole minutes (busy time widened, the rest narrowed): entries are edited as HH:MM, so a slot never ends up seconds into another.
  const busy = taken.map((other) => ({ start: Math.floor(other.start / MINUTE) * MINUTE, end: Math.ceil(other.end / MINUTE) * MINUTE }));
  const day = { start: Math.ceil(window.start / MINUTE) * MINUTE, end: Math.floor(window.end / MINUTE) * MINUTE };
  preferredEnd = Math.floor(preferredEnd / MINUTE) * MINUTE;
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

export interface ProjectHints {
  /** Ticket id -> the project of my most recent entry for it. */
  byTicket: Map<number, string>;
  /** Azure project name (lower-cased) -> the project I used most for its tickets. */
  byAzureProject: Map<string, string>;
}

/**
 * A project name for comparing: case, spaces, dashes (- – —), underscores
 * and dots do not count. "Engineer-Cockpit" = "engineer cockpit" = "Engineer_Cockpit".
 */
export function projectNameKey(name: string): string {
  return name.toLowerCase().replace(/[\s\-\u2013\u2014_.]+/g, "");
}

/** The Solidtime projects whose name equals the Azure project's (see `projectNameKey`). */
export function sameNameProjects<T extends { name: string }>(azureProjectName: string, projects: T[]): T[] {
  const key = projectNameKey(azureProjectName);
  return key ? projects.filter((project) => projectNameKey(project.name) === key) : [];
}

/**
 * The Solidtime project for a ticket, best first: my mapping for its Azure
 * project, the project I last used for this ticket, the project I use most
 * for that Azure project, then the one Solidtime project with the same name
 * (none when several match). Only projects that still exist (unarchived) are chosen.
 */
export function chooseProject(
  ticketId: number,
  projectName: string,
  projectMap: Record<string, string>,
  projects: Array<{ id: string; name: string }>,
  hints: ProjectHints
): { id: string; source: ProjectSource } | null {
  const exists = (id: string | undefined): id is string => id !== undefined && projects.some((project) => project.id === id);
  const key = projectName.trim().toLowerCase();
  const sameName = sameNameProjects(projectName, projects);
  const candidates: Array<[string | undefined, ProjectSource]> = [
    [projectMap[key], "mapping"],
    [hints.byTicket.get(ticketId), "ticket"],
    [hints.byAzureProject.get(key), "azure-project"],
    [sameName.length === 1 ? sameName[0]!.id : undefined, "name"],
  ];

  for (const [id, source] of candidates) {
    if (exists(id)) return { id, source };
  }

  return null;
}

/** Which projects my earlier entries used, per ticket and (once the tickets are looked up) per Azure project. */
export function projectHints(entries: SolidtimeTimeEntry[], azureProjectOf: (ticketId: number) => string | undefined): ProjectHints {
  const byTicket = new Map<number, string>();
  const latestAt = new Map<number, number>();
  const counts = new Map<string, Map<string, { count: number; latest: number }>>();

  for (const entry of entries) {
    if (!entry.project_id) continue;
    const at = Date.parse(entry.start);

    for (const ticketId of candidateTicketIds(entry.description)) {
      // Entries come newest first, but do not rely on it.
      if (!byTicket.has(ticketId) || at > (latestAt.get(ticketId) ?? 0)) {
        byTicket.set(ticketId, entry.project_id);
        latestAt.set(ticketId, at);
      }

      const azureProject = azureProjectOf(ticketId)?.trim().toLowerCase();
      if (!azureProject) continue;
      const perProject = counts.get(azureProject) ?? new Map<string, { count: number; latest: number }>();
      const tally = perProject.get(entry.project_id) ?? { count: 0, latest: 0 };
      perProject.set(entry.project_id, { count: tally.count + 1, latest: Math.max(tally.latest, at) });
      counts.set(azureProject, perProject);
    }
  }

  const byAzureProject = new Map<string, string>();

  for (const [azureProject, perProject] of counts) {
    const [best] = [...perProject.entries()].sort((a, b) => b[1].count - a[1].count || b[1].latest - a[1].latest);
    if (best) byAzureProject.set(azureProject, best[0]);
  }

  return { byTicket, byAzureProject };
}

/**
 * A suggested timesheet for one day, built from what I did in Azure DevOps:
 * hours from the evidence (see `hoursEvidence`) minus what Solidtime already
 * has for the ticket that day, with my activity (state changes, comments,
 * other edits) listed so the hours can be checked. Projects come from my
 * mapping or my earlier entries (see `chooseProject`). Read-only: nothing is written.
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
  const historyStart = zonedDayRange(addDays(day, -PROJECT_HISTORY_DAYS), timeZone).start;
  const warnings: string[] = [];
  const [identity, touched, history, projects] = await Promise.all([
    getIdentity(azure),
    // Azure compares days in its own zone; one day earlier is safe, revisions are checked exactly below. One more than read tells whether some were left out.
    listWorkItemIdsChangedByMeSince(azure, addDays(day, -1), MAX_SCAN + 1),
    // My entries up to the end of the day: that day's (busy time, already tracked) and earlier ones (projects used).
    listEntries(client, connection.organizationId, { memberId: connection.memberId, start: historyStart, end: range.end }),
    listProjects(client, connection.organizationId).catch((error: unknown): SolidtimeProject[] => {
      logFallback("Reading Solidtime projects for the draft failed", error);
      warnings.push("Solidtime projects could not be read; choose projects yourself.");
      return [];
    }),
  ]);
  // Entries with time inside the day, including one that started the evening before (only their part of the day counts).
  const existing = history.entries.filter((entry) => overlapsRange(entry, range, now));
  const ids = touched.slice(0, MAX_SCAN);
  const earlierIds = [...new Set(history.entries.flatMap((entry) => (entry.project_id ? candidateTicketIds(entry.description) : [])))]
    .filter((id) => !ids.includes(id))
    .slice(0, MAX_HISTORY_TICKETS);
  // Earlier tickets are looked up on their own: if that fails, only the project hints are missing.
  const [lookup, earlier] = await Promise.all([lookUpTickets(azure, ids), lookUpTickets(azure, earlierIds)]);

  if (!lookup.checked) {
    // Without the tickets every row would be dropped: an empty draft would look like a day without work.
    throw new AppError(502, "AZURE_UNAVAILABLE", "Azure DevOps could not be read, so the day cannot be drafted. Try again.");
  }
  const projectOf = (ticketId: number) => (lookup.tickets.get(ticketId) ?? earlier.tickets.get(ticketId))?.projectName;
  const hints = projectHints(history.entries, projectOf);
  const inDay = (iso: string) => {
    const time = Date.parse(iso);
    return time >= range.start.getTime() && time < range.end.getTime();
  };
  const email = identity.email?.toLowerCase() ?? null;
  const isMe = (identityRef: { id?: string | null; uniqueName?: string | null } | undefined) =>
    Boolean(identityRef && ((identityRef.id && identityRef.id === identity.id) || (email !== null && identityRef.uniqueName?.toLowerCase() === email)));
  // Whether a state is a finished one (null: Azure's states unreadable), read once per project, type and state.
  const finishedStates = new Map<string, Promise<boolean | null>>();
  const isFinishedState = (ticket: { projectName: string; type: string }, state: string) => {
    const key = `${ticket.projectName}\u0000${ticket.type}\u0000${state}`;
    if (!finishedStates.has(key)) finishedStates.set(key, finishedState(azure, { ...ticket, state }));
    return finishedStates.get(key)!;
  };

  const limit = createLimiter(4);
  const perTicket = await mapWithLimit(ids, limit, async (id) => {
    const ticket = lookup.tickets.get(id);

    if (!ticket) {
      return null;
    }

    const [{ updates, truncated: historyCut }, commentRead] = await Promise.all([
      readWorkItemUpdates(azure, ticket.projectName, id, { rev: ticket.rev }),
      readWorkItemComments(azure, ticket.projectName, id).catch((error: unknown) => {
        logFallback(`Reading comments on #${id} for the draft failed`, error);
        warnings.push(`Comments on #${id} could not be read; its activity may be incomplete.`);
        return { comments: [], truncated: false };
      }),
    ]);

    if (historyCut || commentRead.truncated) {
      warnings.push(`#${id} has very long history; part of it was not read, so its activity may be incomplete.`);
    }

    const activity: DraftActivity[] = [];
    let added = 0;
    let removed = 0;
    let lowered = 0;
    let lastIncreaseAt: number | null = null;
    let lastLoweredAt: number | null = null;
    // Remaining Work as it stood at the end of that day (by anyone): the last value set by then, else the value the next change started from.
    let remainingAtDayEnd: number | null | undefined;
    // Remaining Work I set to 0 (from more): only work if the ticket was not finished that day (checked below).
    const zeroed: Array<{ hours: number; at: string }> = [];
    // States the ticket moved into that day, by anyone.
    const statesThatDay = new Set<string>();
    let remainingAfterDay: number | null | undefined;

    for (const update of updates) {
      const at = updateDate(update);
      const remainingChange = update.fields?.[WORK_ITEM_FIELDS.remainingWork];

      if (at && remainingChange) {
        if (Date.parse(at) < range.end.getTime()) remainingAtDayEnd = asNumber(remainingChange.newValue);
        else if (remainingAfterDay === undefined) remainingAfterDay = asNumber(remainingChange.oldValue);
      }

      const newState = update.fields?.[WORK_ITEM_FIELDS.state]?.newValue;

      if (at && inDay(at) && typeof newState === "string") {
        statesThatDay.add(newState);
      }

      if (!at || !inDay(at) || !isMe(update.revisedBy)) continue;

      const fields = update.fields ?? {};
      const state = fields[WORK_ITEM_FIELDS.state];
      const completed = fields[WORK_ITEM_FIELDS.completedWork];
      const remaining = fields[WORK_ITEM_FIELDS.remainingWork];

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

      if (remaining) {
        const before = asNumber(remaining.oldValue);
        const after = asNumber(remaining.newValue);

        // Lowering Remaining Work (from a known value to a known value) says that much was done; clearing it says nothing.
        if (before !== null && after === 0 && before > 0) {
          zeroed.push({ hours: before, at });
        } else if (before !== null && after !== null && after < before) {
          lowered += before - after;
          lastLoweredAt = Date.parse(at);
        }

        activity.push({ at, what: `Remaining Work ${before ?? "not set"} → ${after ?? "cleared"}` });
      }

      const other = Object.keys(fields).filter(
        (field) => ![WORK_ITEM_FIELDS.state, WORK_ITEM_FIELDS.completedWork, WORK_ITEM_FIELDS.remainingWork, WORK_ITEM_FIELDS.changedDate, "System.ChangedBy", "System.Rev", "System.AuthorizedDate", "System.RevisedDate", "System.AuthorizedAs", "System.PersonId", "System.Watermark", "System.StateChangeDate", "Microsoft.VSTS.Common.StateChangeDate"].includes(field)
      );

      if (!state && !completed && !remaining && other.length > 0) {
        activity.push({ at, what: `Edited ${other.map((field) => field.split(".").pop()).join(", ")}` });
      }
    }

    for (const comment of commentRead.comments) {
      if (inDay(comment.createdDate) && isMe(comment.createdBy)) {
        activity.push({ at: comment.createdDate, what: "Commented" });
      }
    }

    if (activity.length === 0) {
      return null;
    }

    activity.sort((a, b) => a.at.localeCompare(b.at));
    const lastActivityAt = Math.max(...activity.map((item) => Date.parse(item.at)));
    let statesUnreadable = false;

    // Zeroing Remaining Work when closing a ticket tidies it up; it is not that much work (the timeline decides instead).
    // Closing may come in another change that day, or the ticket may be finished now.
    if (zeroed.length > 0) {
      const finished = await Promise.all([...statesThatDay, ticket.state].map((state) => isFinishedState(ticket, state)));
      statesUnreadable = finished.includes(null);

      if (!statesUnreadable && !finished.includes(true)) {
        for (const item of zeroed) {
          lowered += item.hours;
          lastLoweredAt = Math.max(lastLoweredAt ?? 0, Date.parse(item.at));
        }
      }
    }

    const remainingThatDay = remainingAtDayEnd !== undefined ? remainingAtDayEnd : remainingAfterDay !== undefined ? remainingAfterDay : ticket.remainingWork;
    return { ticket, activity, added, removed, lowered, remainingThatDay, lastIncreaseAt, lastLoweredAt, lastActivityAt, statesUnreadable };
  });

  // Time Solidtime already has on each ticket that day (whatever the description wording), split when an entry names two tickets.
  const lookedUp = (id: number) => (ids.includes(id) && lookup.checked) || (earlierIds.includes(id) && earlier.checked);
  const isTicket = (id: number) => (lookup.tickets.has(id) || earlier.tickets.has(id) ? true : lookedUp(id) ? false : null);
  const tracked = new Map<number, number>();

  for (const entry of existing) {
    for (const [ticketId, seconds] of shareSeconds(entry.description, secondsWithin(entry, range, now), isTicket)) {
      tracked.set(ticketId, (tracked.get(ticketId) ?? 0) + seconds / 3600);
    }
  }

  // Only each entry's part inside the day is busy (a timer from the evening before starts the day at midnight).
  const busy: Interval[] = existing.map((entry) => ({
    start: Math.max(Date.parse(entry.start), range.start.getTime()),
    end: Math.min(entry.end ? Date.parse(entry.end) : now.getTime(), range.end.getTime()),
  }));
  const withActivity = perTicket.filter((item): item is NonNullable<typeof item> => item !== null);
  // Tickets come newest change first: the most recently changed ones are kept.
  const found = withActivity.slice(0, MAX_TICKETS);
  const fromActivity = activityHours(
    found.flatMap(({ ticket, activity }) => activity.map((item) => ({ ticketId: ticket.id, at: Date.parse(item.at) }))),
    busy
  );
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Where the evidence ends: entries are placed to end there.
  const evidenceAt = (item: (typeof found)[number]) => (item.added > 0 ? item.lastIncreaseAt : item.lowered > 0 ? item.lastLoweredAt : item.lastActivityAt) ?? item.lastActivityAt;
  // Place the ones with recorded hours (Completed or Remaining Work) first, then the activity ones; each earliest first, so later work stays later.
  const recorded = (item: (typeof found)[number]) => (item.added > 0 || item.lowered > 0 ? 0 : 1);
  found.sort((a, b) => recorded(a) - recorded(b) || evidenceAt(a) - evidenceAt(b));

  const busyBefore = busy.map((interval) => ({ start: new Date(interval.start).toISOString(), end: new Date(interval.end).toISOString() }));
  const trackedSeconds = existing.reduce((sum, entry) => sum + secondsWithin(entry, range, now), 0);

  const rows: DraftRow[] = found.map((item) => {
    const { ticket, activity, added, removed, lowered } = item;
    const already = roundQuarter(tracked.get(ticket.id) ?? 0);
    const evidence = hoursEvidence(item, fromActivity.get(ticket.id) ?? MIN_ACTIVITY_HOURS, (at) => clock.format(new Date(at)));
    const hours = Math.max(0, roundQuarter(evidence.hours - already));
    let start: string | null = null;
    let end: string | null = null;
    const notes: string[] = [];

    if (removed > 0) notes.push(`Completed Work was also lowered by ${removed} h that day (not counted).`);
    if (item.statesUnreadable) notes.push("Azure states could not be read; Remaining Work set to 0 was not counted.");

    if (hours > 0) {
      const slot = placeEntry(busy, hours * 3_600_000, evidenceAt(item), window);

      if (slot) {
        busy.push(slot);
        start = new Date(slot.start).toISOString();
        end = new Date(slot.end).toISOString();
      } else {
        notes.push("No free time left in the day for this; set the times yourself.");
      }
    } else {
      notes.push("Already tracked in Solidtime.");
    }

    const project = chooseProject(ticket.id, ticket.projectName, connection.projectMap, projects, hints);
    const sameName = project ? [] : sameNameProjects(ticket.projectName, projects);
    const anchor = Math.min(Math.max(evidenceAt(item), window.start), window.end);

    return {
      ticketId: ticket.id,
      title: ticket.title,
      projectName: ticket.projectName,
      type: ticket.type,
      state: ticket.state,
      originalEstimate: ticket.originalEstimate,
      completedWork: ticket.completedWork,
      remainingWork: ticket.remainingWork,
      activity,
      completedWorkAdded: roundQuarter(added),
      completedWorkRemoved: roundQuarter(removed),
      remainingWorkLowered: roundQuarter(lowered),
      alreadyTrackedHours: already,
      hours,
      hoursSource: evidence.source,
      hoursBasis: evidence.basis,
      anchor: new Date(anchor).toISOString(),
      start,
      end,
      description: ticketDescription(ticket.id, ticket.title),
      solidtimeProjectId: project?.id ?? null,
      projectSource: project?.source ?? null,
      projectMatches: sameName.length > 1 ? sameName.map((match) => match.name) : [],
      note: notes.length ? notes.join(" ") : null,
    };
  });
  const truncatedReason = touched.length > MAX_SCAN ? "scan" : withActivity.length > found.length ? "rows" : null;

  return {
    day,
    timeZone,
    targetHours: connection.dailyTargetHours,
    trackedHours: Math.round((trackedSeconds / 3600) * 100) / 100,
    busy: busyBefore,
    rows: rows.sort((a, b) => a.ticketId - b.ticketId),
    truncated: truncatedReason !== null,
    truncatedReason,
    warnings,
  };
}
