import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, isValidTimeZone, zonedDay, zonedDayRange } from "../../lib/zoned-time.js";
import { getIdentity } from "../azure/identity.service.js";
import { WORK_ITEM_FIELDS, getWorkItemComments, getWorkItemUpdates, listTouchedWorkItemIds, updateDate } from "../azure/work-items.service.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import type { SolidtimeTimeEntry } from "../../lib/solidtime/types.js";
import { entrySeconds, getMe, listEntries, listProjects } from "./read.service.js";
import { candidateTicketIds, ticketDescription } from "./ticket-ids.js";
import { lookUpTickets } from "./tickets.service.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

/** Drafts can be made for today and the 14 days before it. */
export const DRAFT_MAX_DAYS_BACK = 14;
/** At most this many tickets are read (and a day can be approved in one batch of 50). */
const MAX_TICKETS = 50;
/** How far back my own Solidtime entries are read to learn which project a ticket goes to. */
const PROJECT_HISTORY_DAYS = 60;
/** At most this many earlier tickets are looked up in Azure for their project. */
const MAX_HISTORY_TICKETS = 200;

export interface DraftActivity {
  at: string;
  what: string;
}

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
  /** Time already in Solidtime for this ticket that day (hours). */
  alreadyTrackedHours: number;
  /** Suggested new time (hours): Completed Work added minus already tracked; null = only activity, enter it yourself. */
  hours: number | null;
  /** "completed-work" when `hours` comes from my Completed Work increases; null when there are no hours yet. */
  hoursSource: "completed-work" | null;
  /** Where an entry for this row would preferably end (UTC): my last Completed Work increase, else my last activity. */
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
  /** More tickets were touched than Cockpit reads at once. */
  truncated: boolean;
}

const MINUTE = 60_000;
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
 * hours from my increases to Completed Work (minus what Solidtime already has
 * for the ticket that day), activity (state changes, comments, other edits)
 * listed for tickets without hours. Projects come from my mapping or my
 * earlier entries (see `chooseProject`). Read-only: nothing is written.
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
  const [identity, touched, history, projects] = await Promise.all([
    getIdentity(azure),
    // Azure compares days in its own zone; one day earlier is safe, revisions are checked exactly below.
    listTouchedWorkItemIds(azure, addDays(day, -1)),
    // My entries up to the end of the day: that day's (busy time, already tracked) and earlier ones (projects used).
    listEntries(client, connection.organizationId, { memberId: connection.memberId, start: historyStart, end: range.end }),
    listProjects(client, connection.organizationId).catch(() => []),
  ]);
  const existing = history.entries.filter((entry) => {
    const start = Date.parse(entry.start);
    return start >= range.start.getTime() && start < range.end.getTime();
  });
  const ids = touched.slice(0, MAX_TICKETS);
  const earlierIds = [...new Set(history.entries.flatMap((entry) => (entry.project_id ? candidateTicketIds(entry.description) : [])))]
    .filter((id) => !ids.includes(id))
    .slice(0, MAX_HISTORY_TICKETS);
  // Earlier tickets are looked up on their own: if that fails, only the project hints are missing.
  const [lookup, earlier] = await Promise.all([lookUpTickets(azure, ids), lookUpTickets(azure, earlierIds)]);
  const projectOf = (ticketId: number) => (lookup.tickets.get(ticketId) ?? earlier.tickets.get(ticketId))?.projectName;
  const hints = projectHints(history.entries, projectOf);
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
    const lastActivityAt = Math.max(...activity.map((item) => Date.parse(item.at)));
    return { ticket, activity, added, removed, lastIncreaseAt, lastActivityAt };
  });

  // Time Solidtime already has on each ticket that day (whatever the description wording).
  const tracked = new Map<number, number>();

  for (const entry of existing) {
    for (const ticketId of candidateTicketIds(entry.description)) {
      tracked.set(ticketId, (tracked.get(ticketId) ?? 0) + entrySeconds(entry, now) / 3600);
    }
  }

  const busy: Interval[] = existing.map((entry) => ({ start: Date.parse(entry.start), end: entry.end ? Date.parse(entry.end) : now.getTime() }));
  const found = perTicket.filter((item): item is NonNullable<typeof item> => item !== null);
  // Place the ones with known hours, earliest change first, so later work stays later.
  found.sort((a, b) => (a.lastIncreaseAt ?? Number.MAX_SAFE_INTEGER) - (b.lastIncreaseAt ?? Number.MAX_SAFE_INTEGER));

  const busyBefore = busy.map((interval) => ({ start: new Date(interval.start).toISOString(), end: new Date(interval.end).toISOString() }));
  const trackedSeconds = existing.reduce((sum, entry) => sum + entrySeconds(entry, now), 0);

  const rows: DraftRow[] = found.map(({ ticket, activity, added, removed, lastIncreaseAt, lastActivityAt }) => {
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

    const project = chooseProject(ticket.id, ticket.projectName, connection.projectMap, projects, hints);
    const sameName = project ? [] : sameNameProjects(ticket.projectName, projects);
    const anchor = Math.min(Math.max(lastIncreaseAt ?? lastActivityAt, window.start), window.end);

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
      alreadyTrackedHours: already,
      hours,
      hoursSource: added > 0 ? "completed-work" : null,
      anchor: new Date(anchor).toISOString(),
      start,
      end,
      description: ticketDescription(ticket.id, ticket.title),
      solidtimeProjectId: project?.id ?? null,
      projectSource: project?.source ?? null,
      projectMatches: sameName.length > 1 ? sameName.map((match) => match.name) : [],
      note,
    };
  });

  return {
    day,
    timeZone,
    targetHours: connection.dailyTargetHours,
    trackedHours: Math.round((trackedSeconds / 3600) * 100) / 100,
    busy: busyBefore,
    rows: rows.sort((a, b) => a.ticketId - b.ticketId),
    truncated: touched.length > ids.length,
  };
}
