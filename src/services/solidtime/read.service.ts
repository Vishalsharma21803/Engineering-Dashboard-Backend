import { SolidtimeClient } from "../../lib/solidtime/client.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import type {
  SolidtimeAggregate,
  SolidtimeClient as SolidtimeClientRecord,
  SolidtimeMe,
  SolidtimeMember,
  SolidtimePage,
  SolidtimeProject,
  SolidtimeTag,
  SolidtimeTask,
  SolidtimeTimeEntry,
} from "../../lib/solidtime/types.js";
import { solidtimeTime } from "../../lib/zoned-time.js";

/** Lists Solidtime pages through (15 per page by default); capped so a huge organization cannot run away. */
const MAX_LIST_PAGES = 40;
/** Entries per request (Solidtime allows up to 500) and the most read for one question. */
const ENTRY_BATCH = 500;
const MAX_ENTRIES = 10_000;

const org = (organizationId: string) => `organizations/${encodeURIComponent(organizationId)}`;

async function listAll<T>(client: SolidtimeClient, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const response = await client.get<SolidtimePage<T>>(path, { ...query, page });
    items.push(...(response.data ?? []));
    const last = response.meta?.last_page ?? page;

    if (page >= last || (response.data ?? []).length === 0) {
      break;
    }
  }

  return items;
}

export async function getMe(client: SolidtimeClient): Promise<SolidtimeMe> {
  return (await client.get<{ data: SolidtimeMe }>("users/me")).data;
}

export async function listProjects(client: SolidtimeClient, organizationId: string, archived: "false" | "all" = "false") {
  return listAll<SolidtimeProject>(client, `${org(organizationId)}/projects`, { archived });
}

export async function listTasks(client: SolidtimeClient, organizationId: string, projectId?: string) {
  return listAll<SolidtimeTask>(client, `${org(organizationId)}/tasks`, { done: "all", ...(projectId ? { project_id: projectId } : {}) });
}

export async function listTags(client: SolidtimeClient, organizationId: string) {
  return listAll<SolidtimeTag>(client, `${org(organizationId)}/tags`);
}

export async function listClients(client: SolidtimeClient, organizationId: string) {
  return listAll<SolidtimeClientRecord>(client, `${org(organizationId)}/clients`, { archived: "all" });
}

/** Needs a Manager, Admin or Owner token. */
export async function listMembers(client: SolidtimeClient, organizationId: string) {
  return listAll<SolidtimeMember>(client, `${org(organizationId)}/members`);
}

export interface EntryQuery {
  /** Only this member's entries; omit for everyone (needs a team role). */
  memberId?: string | undefined;
  start?: Date | undefined;
  end?: Date | undefined;
  projectIds?: string[] | undefined;
  active?: boolean | undefined;
}

const MINUTE = 60_000;

/**
 * The range is widened to whole minutes (start down, end up), so reads made
 * moments apart ask the same question and reuse the short read cache.
 * Entries are selected by their start; a minute more at the end only adds
 * entries started in the last seconds.
 */
function entryFilters(query: EntryQuery) {
  return {
    member_id: query.memberId,
    start: query.start ? solidtimeTime(new Date(Math.floor(query.start.getTime() / MINUTE) * MINUTE)) : undefined,
    end: query.end ? solidtimeTime(new Date(Math.ceil(query.end.getTime() / MINUTE) * MINUTE)) : undefined,
    project_ids: query.projectIds?.length ? query.projectIds : undefined,
    active: query.active === undefined ? undefined : String(query.active),
  };
}

/** Every entry matching the query, newest first (read in batches of 500). */
export async function listEntries(client: SolidtimeClient, organizationId: string, query: EntryQuery): Promise<{ entries: SolidtimeTimeEntry[]; truncated: boolean }> {
  const entries: SolidtimeTimeEntry[] = [];

  for (let offset = 0; offset < MAX_ENTRIES; offset += ENTRY_BATCH) {
    const response = await client.get<SolidtimePage<SolidtimeTimeEntry>>(`${org(organizationId)}/time-entries`, {
      ...entryFilters(query),
      limit: ENTRY_BATCH,
      offset,
    });
    const batch = response.data ?? [];
    entries.push(...batch);

    if (batch.length < ENTRY_BATCH) {
      return { entries, truncated: false };
    }
  }

  return { entries, truncated: true };
}

/** Seconds per distinct description (and per user when `byUser`), computed by Solidtime. */
export async function aggregateByDescription(client: SolidtimeClient, organizationId: string, query: EntryQuery, byUser: boolean): Promise<SolidtimeAggregate> {
  const response = await client.get<{ data: SolidtimeAggregate }>(`${org(organizationId)}/time-entries/aggregate`, {
    ...entryFilters(query),
    group: "description",
    ...(byUser ? { sub_group: "user" } : {}),
  });
  return response.data;
}

/** The signed-in user's running timer, if any. */
export async function getActiveEntry(client: SolidtimeClient): Promise<SolidtimeTimeEntry | null> {
  try {
    return (await client.get<{ data: SolidtimeTimeEntry }>("users/me/time-entries/active")).data;
  } catch (error) {
    if (error instanceof SolidtimeApiError && error.solidtimeReason === "SOLIDTIME_NOT_FOUND") {
      return null;
    }

    throw error;
  }
}

/** Seconds an entry covers; a running one counts up to `now`. */
export function entrySeconds(entry: Pick<SolidtimeTimeEntry, "start" | "end" | "duration">, now: Date): number {
  if (entry.end) {
    return entry.duration ?? Math.max(0, Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / 1000));
  }

  return Math.max(0, Math.round((now.getTime() - Date.parse(entry.start)) / 1000));
}

/**
 * Seconds of an entry inside a range (a day): the overlap of [start, end] (a
 * running one up to `now`) with it, so a timer crossing midnight counts on
 * each day only for its own part.
 */
export function secondsWithin(entry: Pick<SolidtimeTimeEntry, "start" | "end" | "duration">, range: { start: Date; end: Date }, now: Date): number {
  const start = Date.parse(entry.start);
  const end = entry.end ? Date.parse(entry.end) : now.getTime();

  if (start >= range.start.getTime() && end <= range.end.getTime()) {
    return entrySeconds(entry, now);
  }

  return Math.max(0, Math.round((Math.min(end, range.end.getTime()) - Math.max(start, range.start.getTime())) / 1000));
}

/** The entry has time inside the range (see secondsWithin). */
export function overlapsRange(entry: Pick<SolidtimeTimeEntry, "start" | "end">, range: { start: Date; end: Date }, now: Date): boolean {
  return Date.parse(entry.start) < range.end.getTime() && (entry.end ? Date.parse(entry.end) : now.getTime()) > range.start.getTime();
}
