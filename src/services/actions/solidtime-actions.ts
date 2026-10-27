import { AppError } from "../../lib/app-error.js";
import { SolidtimeWriteError, type SolidtimeClient } from "../../lib/solidtime/client.js";
import type { SolidtimeTimeEntry, TimeEntryInput } from "../../lib/solidtime/types.js";
import { solidtimeTime } from "../../lib/zoned-time.js";
import type { SolidtimeActionVariant } from "../../schemas/action.schema.js";
import type { SolidtimeConnectionDto } from "../solidtime/connection.service.js";
import { getActiveEntry, listEntries, listProjects, listTags, listTasks } from "../solidtime/read.service.js";
import type { ExecutionResult } from "./executor.js";
import type { PreparedAction, PreviewChange } from "./prepare.js";

/**
 * The ONLY module allowed to write to Solidtime. Proposals are prepared here
 * (read-only, with a preview); writes happen only for an approved action.
 */

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

const ORG = (connection: Connection) => `organizations/${encodeURIComponent(connection.organizationId)}`;
/** A timer may be started this long before the proposal (the approval window) and stopped slightly in the future (clock drift). */
const START_WINDOW_MS = 16 * 60_000;
const CLOCK_DRIFT_MS = 60_000;

const hoursMinutes = (seconds: number) => `${Math.floor(seconds / 3600)}h ${String(Math.round((seconds % 3600) / 60)).padStart(2, "0")}m`;
const whole = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

interface Names {
  project: (id: string | null) => string | null;
  task: (id: string | null) => string | null;
  tags: (ids: string[]) => string;
}

async function loadNames(client: SolidtimeClient, connection: Connection): Promise<Names> {
  const [projects, tasks, tags] = await Promise.all([
    listProjects(client, connection.organizationId, "all"),
    listTasks(client, connection.organizationId),
    listTags(client, connection.organizationId),
  ]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const taskNames = new Map(tasks.map((task) => [task.id, task.name]));
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]));

  const known = (map: Map<string, string>, label: string) => (id: string | null) => {
    if (id === null) return null;
    const name = map.get(id);
    if (!name) throw new AppError(422, "SOLIDTIME_UNKNOWN_ITEM", `That ${label} does not exist in this Solidtime organization`);
    return name;
  };

  return {
    project: known(projectNames, "project"),
    task: known(taskNames, "task"),
    tags: (ids) => ids.map((id) => known(tagNames, "tag")(id)).join(", "),
  };
}

/** Solidtime has no "get one entry" call: find my entry by id within a one-second window on its start. */
export async function findMyEntry(client: SolidtimeClient, connection: Connection, entryId: string, entryStart: Date): Promise<SolidtimeTimeEntry | null> {
  const start = whole(entryStart);
  const { entries } = await listEntries(client, connection.organizationId, { memberId: connection.memberId, start, end: new Date(start.getTime() + 1000) });
  return entries.find((entry) => entry.id === entryId) ?? null;
}

function entryPreview(names: Names, entry: { start: Date; end: Date | null; description: string | null; projectId: string | null; taskId: string | null; tags: string[]; billable: boolean }): PreviewChange[] {
  return [
    { field: "Description", before: null, after: entry.description },
    { field: "Project", before: null, after: names.project(entry.projectId) },
    { field: "Task", before: null, after: names.task(entry.taskId) },
    { field: "Tags", before: null, after: names.tags(entry.tags) || null },
    { field: "Billable", before: null, after: entry.billable ? "Yes" : "No" },
    { field: "Start (UTC)", before: null, after: solidtimeTime(entry.start) },
    { field: "End (UTC)", before: null, after: entry.end ? solidtimeTime(entry.end) : "running" },
    ...(entry.end ? [{ field: "Duration", before: null, after: hoursMinutes((entry.end.getTime() - entry.start.getTime()) / 1000) }] : []),
  ];
}

/** Stored params are plain JSON; times are kept as Solidtime UTC strings. */
function storedEntry(entry: { start: Date; end: Date; description: string | null; projectId: string | null; taskId: string | null; tags: string[]; billable: boolean }) {
  return { ...entry, start: solidtimeTime(entry.start), end: solidtimeTime(entry.end) };
}

/** What an existing entry looked like when the change was previewed; the change is refused if it differs at approval. */
function snapshot(entry: SolidtimeTimeEntry) {
  return {
    start: entry.start,
    end: entry.end,
    description: entry.description,
    projectId: entry.project_id,
    taskId: entry.task_id,
    tags: [...(entry.tags ?? [])].sort(),
    billable: entry.billable,
  };
}

/** Read-only: checks the change against Solidtime and builds the preview. Nothing is written. */
export async function prepareSolidtimeAction(client: SolidtimeClient, connection: Connection, action: SolidtimeActionVariant, now = new Date()): Promise<PreparedAction> {
  const base = { projectId: connection.organizationId, baseRev: null };

  switch (action.kind) {
    case "SOLIDTIME_TIMER_START": {
      const startedAt = whole(action.params.startedAt);

      if (startedAt.getTime() < now.getTime() - START_WINDOW_MS || startedAt.getTime() > now.getTime() + CLOCK_DRIFT_MS) {
        throw new AppError(422, "TIMER_START_INVALID", "The start time must be within the last 15 minutes");
      }

      if (await getActiveEntry(client)) {
        throw new AppError(409, "TIMER_ALREADY_RUNNING", "A timer is already running. Stop it first.");
      }

      const names = await loadNames(client, connection);
      const entry = { ...action.params, start: startedAt, end: null };
      return {
        ...base,
        target: {},
        params: { ...action.params, startedAt: solidtimeTime(startedAt) },
        preview: entryPreview(names, entry),
        summary: `Start a timer: ${action.params.description ?? "(no description)"}`.slice(0, 300),
      };
    }

    case "SOLIDTIME_TIMER_STOP": {
      const active = await getActiveEntry(client);

      if (!active || active.id !== action.target.entryId) {
        throw new AppError(409, "TIMER_NOT_RUNNING", "That timer is no longer running");
      }

      if (active.organization_id !== connection.organizationId) {
        throw new AppError(409, "TIMER_IN_OTHER_ORGANIZATION", "That timer runs in another Solidtime organization; stop it there.");
      }

      const stoppedAt = whole(action.params.stoppedAt);

      if (stoppedAt.getTime() < Date.parse(active.start) || stoppedAt.getTime() > now.getTime() + CLOCK_DRIFT_MS) {
        throw new AppError(422, "TIMER_STOP_INVALID", "The stop time must be after the start and not in the future");
      }

      return {
        ...base,
        target: { entryId: active.id, entryStart: active.start },
        params: { stoppedAt: solidtimeTime(stoppedAt) },
        preview: [
          { field: "Description", before: active.description, after: active.description },
          { field: "Start (UTC)", before: active.start, after: active.start },
          { field: "End (UTC)", before: "running", after: solidtimeTime(stoppedAt) },
          { field: "Duration", before: null, after: hoursMinutes((stoppedAt.getTime() - Date.parse(active.start)) / 1000) },
        ],
        summary: `Stop the timer: ${active.description ?? "(no description)"}`.slice(0, 300),
      };
    }

    case "SOLIDTIME_ENTRY_CREATE": {
      const names = await loadNames(client, connection);
      const entry = { ...action.params, start: whole(action.params.start), end: whole(action.params.end) };
      return {
        ...base,
        target: {},
        params: storedEntry(entry),
        preview: entryPreview(names, entry),
        summary: `Add time: ${action.params.description ?? "(no description)"} (${hoursMinutes((entry.end.getTime() - entry.start.getTime()) / 1000)})`.slice(0, 300),
      };
    }

    case "SOLIDTIME_ENTRIES_CREATE": {
      const names = await loadNames(client, connection);
      const entries = action.params.entries.map((entry) => ({ ...entry, start: whole(entry.start), end: whole(entry.end) })).sort((a, b) => a.start.getTime() - b.start.getTime());

      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index]!.start < entries[index - 1]!.end) {
          throw new AppError(422, "ENTRIES_OVERLAP", "Two of these entries overlap; adjust their times");
        }
      }

      const total = entries.reduce((sum, entry) => sum + (entry.end.getTime() - entry.start.getTime()) / 1000, 0);
      return {
        ...base,
        target: {},
        params: { entries: entries.map(storedEntry) },
        preview: entries.map((entry) => ({
          field: `${solidtimeTime(entry.start).slice(11, 16)}–${solidtimeTime(entry.end).slice(11, 16)} UTC${entry.projectId ? ` · ${names.project(entry.projectId)}` : ""}`,
          before: null,
          after: `${entry.description ?? "(no description)"} (${hoursMinutes((entry.end.getTime() - entry.start.getTime()) / 1000)})`,
        })),
        summary: `Add ${entries.length} time entr${entries.length === 1 ? "y" : "ies"} (${hoursMinutes(total)})`,
      };
    }

    case "SOLIDTIME_ENTRY_UPDATE":
    case "SOLIDTIME_ENTRY_DELETE": {
      const current = await findMyEntry(client, connection, action.target.entryId, action.target.entryStart);

      if (!current) {
        throw new AppError(404, "SOLIDTIME_ENTRY_NOT_FOUND", "That time entry was not found among your entries");
      }

      const names = await loadNames(client, connection);
      const target = { entryId: current.id, entryStart: current.start };

      if (action.kind === "SOLIDTIME_ENTRY_DELETE") {
        return {
          ...base,
          target,
          params: { expected: snapshot(current) },
          preview: [
            { field: "Description", before: current.description, after: null },
            { field: "Start (UTC)", before: current.start, after: null },
            { field: "End (UTC)", before: current.end ?? "running", after: null },
          ],
          summary: `Delete time entry: ${current.description ?? "(no description)"}`.slice(0, 300),
        };
      }

      const change = action.params;
      const next = {
        start: change.start ? whole(change.start) : new Date(current.start),
        end: change.end ? whole(change.end) : current.end ? new Date(current.end) : null,
        description: change.description !== undefined ? change.description : current.description,
        projectId: change.projectId !== undefined ? change.projectId : current.project_id,
        taskId: change.taskId !== undefined ? change.taskId : current.task_id,
        tags: change.tags ?? current.tags ?? [],
        billable: change.billable ?? current.billable,
      };

      if (next.end && next.end <= next.start) {
        throw new AppError(422, "ENTRY_TIMES_INVALID", "The end must be after the start");
      }

      if (next.taskId && !next.projectId) {
        throw new AppError(422, "ENTRY_TASK_WITHOUT_PROJECT", "A task needs its project");
      }

      const preview: PreviewChange[] = [
        { field: "Description", before: current.description, after: next.description },
        { field: "Project", before: names.project(current.project_id), after: names.project(next.projectId) },
        { field: "Task", before: names.task(current.task_id), after: names.task(next.taskId) },
        { field: "Tags", before: names.tags(current.tags ?? []) || null, after: names.tags(next.tags) || null },
        { field: "Billable", before: current.billable ? "Yes" : "No", after: next.billable ? "Yes" : "No" },
        { field: "Start (UTC)", before: current.start, after: solidtimeTime(next.start) },
        { field: "End (UTC)", before: current.end ?? "running", after: next.end ? solidtimeTime(next.end) : "running" },
      ].filter((row) => row.before !== row.after);

      if (preview.length === 0) {
        throw new AppError(422, "NOTHING_TO_CHANGE", "That entry already has these values");
      }

      return {
        ...base,
        target,
        params: { expected: snapshot(current), next: { ...next, start: solidtimeTime(next.start), end: next.end ? solidtimeTime(next.end) : null } },
        preview,
        summary: `Edit time entry: ${next.description ?? "(no description)"}`.slice(0, 300),
      };
    }

    case "SOLIDTIME_PROJECT_CREATE":
      return {
        ...base,
        target: {},
        params: action.params,
        preview: [
          { field: "New project", before: null, after: action.params.name },
          { field: "Billable", before: null, after: action.params.billable ? "Yes" : "No" },
        ],
        summary: `Create Solidtime project ${action.params.name}`,
      };

    case "SOLIDTIME_TASK_CREATE": {
      const names = await loadNames(client, connection);
      return {
        ...base,
        target: {},
        params: action.params,
        preview: [
          { field: "Project", before: null, after: names.project(action.params.projectId) },
          { field: "New task", before: null, after: action.params.name },
          { field: "Estimate (h)", before: null, after: action.params.estimatedHours },
        ],
        summary: `Create Solidtime task ${action.params.name}`,
      };
    }

    case "SOLIDTIME_TAG_CREATE":
      return { ...base, target: {}, params: action.params, preview: [{ field: "New tag", before: null, after: action.params.name }], summary: `Create Solidtime tag ${action.params.name}` };

    case "SOLIDTIME_CLIENT_CREATE":
      return { ...base, target: {}, params: action.params, preview: [{ field: "New client", before: null, after: action.params.name }], summary: `Create Solidtime client ${action.params.name}` };
  }
}

/* ------------------------------------------------------------------ writes */

/** A Solidtime write failed; `writeSent` says whether it may have been applied. */
export class SolidtimeExecutionFailure extends Error {
  constructor(
    readonly error: unknown,
    readonly writeSent: boolean,
    /** What was already saved before the failure (e.g. entries created by a batch). */
    readonly partial: Record<string, unknown> | null = null
  ) {
    super(error instanceof Error ? error.message : "Solidtime change failed");
    this.name = "SolidtimeExecutionFailure";
  }
}

const str = (params: Record<string, unknown>, key: string) => {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`INVALID_STORED_PARAM:${key}`);
  return value;
};

type StoredEntry = { start: string; end: string | null; description: string | null; projectId: string | null; taskId: string | null; tags: string[]; billable: boolean };

function storedToInput(connection: Connection, entry: StoredEntry): TimeEntryInput {
  return {
    member_id: connection.memberId,
    project_id: entry.projectId,
    task_id: entry.taskId,
    start: entry.start,
    end: entry.end,
    billable: entry.billable,
    description: entry.description,
    tags: entry.tags ?? [],
  };
}

/** Field-by-field (stored JSON comes back with its keys reordered). */
function sameSnapshot(current: ReturnType<typeof snapshot>, stored: unknown): boolean {
  if (!stored || typeof stored !== "object") return false;
  const expected = stored as Record<string, unknown>;
  return (Object.keys(current) as Array<keyof typeof current>).every((key) => JSON.stringify(current[key]) === JSON.stringify(expected[key]));
}

interface ApprovedSolidtimeAction {
  kind: string;
  target: Record<string, unknown>;
  params: Record<string, unknown>;
}

/** Runs an approved change. Errors are wrapped so the caller knows whether anything reached Solidtime. */
export async function executeSolidtimeAction(client: SolidtimeClient, connection: Connection, action: ApprovedSolidtimeAction): Promise<ExecutionResult> {
  let sent = false;
  // Counts every write attempt: a failure after the first one may leave part of the change applied.
  const write = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      const result = await run();
      sent = true;
      return result;
    } catch (error) {
      if (error instanceof SolidtimeWriteError) {
        throw new SolidtimeExecutionFailure(error.cause, sent || error.writeSent);
      }

      throw new SolidtimeExecutionFailure(error, sent);
    }
  };

  const ok = (result: Record<string, unknown>, checks: Array<{ check: string; passed: boolean }> = []): ExecutionResult => ({
    result,
    verification: { verified: checks.every((check) => check.passed), checks },
  });

  const path = ORG(connection);

  switch (action.kind) {
    case "SOLIDTIME_TIMER_START": {
      const params = action.params as unknown as StoredEntry & { startedAt: string };
      const created = await write(() => client.post<{ data: SolidtimeTimeEntry }>(`${path}/time-entries`, storedToInput(connection, { ...params, start: params.startedAt, end: null })));
      return ok({ entryId: created.data.id }, [{ check: "Timer is running", passed: created.data.end === null }]);
    }

    case "SOLIDTIME_TIMER_STOP": {
      const entryId = str(action.target, "entryId");
      const active = await getActiveEntry(client);

      if (!active || active.id !== entryId) {
        throw new SolidtimeExecutionFailure(new AppError(409, "ACTION_STALE", "That timer is no longer running. Nothing was changed."), false);
      }

      // The start is sent unchanged so the end can be validated against it.
      const stopped = await write(() => client.put<{ data: SolidtimeTimeEntry }>(`${path}/time-entries/${encodeURIComponent(entryId)}`, { start: active.start, end: str(action.params, "stoppedAt") }));
      return ok({ entryId }, [{ check: "Timer stopped", passed: stopped.data.end !== null }]);
    }

    case "SOLIDTIME_ENTRY_CREATE": {
      const created = await write(() => client.post<{ data: SolidtimeTimeEntry }>(`${path}/time-entries`, storedToInput(connection, action.params as unknown as StoredEntry)));
      return ok({ entryId: created.data.id }, [{ check: "Entry saved", passed: Boolean(created.data.id) }]);
    }

    case "SOLIDTIME_ENTRIES_CREATE": {
      const entries = (action.params.entries ?? []) as StoredEntry[];
      const ids: string[] = [];

      for (const entry of entries) {
        try {
          const created = await write(() => client.post<{ data: SolidtimeTimeEntry }>(`${path}/time-entries`, storedToInput(connection, entry)));
          ids.push(created.data.id);
        } catch (error) {
          // Keep what was saved so it can be seen (and not added twice).
          const failure = error as SolidtimeExecutionFailure;
          throw new SolidtimeExecutionFailure(failure.error, failure.writeSent, { entryIds: ids, savedCount: ids.length, totalCount: entries.length });
        }
      }

      return ok({ entryIds: ids }, [{ check: `${ids.length} of ${entries.length} entries saved`, passed: ids.length === entries.length }]);
    }

    case "SOLIDTIME_ENTRY_UPDATE":
    case "SOLIDTIME_ENTRY_DELETE": {
      const entryId = str(action.target, "entryId");
      const current = await findMyEntry(client, connection, entryId, new Date(str(action.target, "entryStart")));

      // Refuse if the entry changed (or vanished) since the preview.
      if (!current || !sameSnapshot(snapshot(current), action.params.expected)) {
        throw new SolidtimeExecutionFailure(new AppError(409, "ACTION_STALE", "The entry changed after this was proposed. Nothing was changed; propose it again."), false);
      }

      if (action.kind === "SOLIDTIME_ENTRY_DELETE") {
        await write(() => client.delete(`${path}/time-entries/${encodeURIComponent(entryId)}`));
        return ok({ entryId, deleted: true }, [{ check: "Entry deleted", passed: true }]);
      }

      const next = action.params.next as StoredEntry;
      const input = storedToInput(connection, next);
      const updated = await write(() => client.put<{ data: SolidtimeTimeEntry }>(`${path}/time-entries/${encodeURIComponent(entryId)}`, input));
      return ok({ entryId }, [{ check: "Entry saved with the new values", passed: updated.data.description === next.description && updated.data.start === next.start }]);
    }

    case "SOLIDTIME_PROJECT_CREATE": {
      const created = await write(() =>
        client.post<{ data: { id: string } }>(`${path}/projects`, {
          name: str(action.params, "name"),
          color: str(action.params, "color"),
          is_billable: action.params.billable === true,
          client_id: action.params.clientId ?? null,
        })
      );
      return ok({ projectId: created.data.id }, [{ check: "Project created", passed: Boolean(created.data.id) }]);
    }

    case "SOLIDTIME_TASK_CREATE": {
      const hours = typeof action.params.estimatedHours === "number" ? action.params.estimatedHours : null;
      const created = await write(() =>
        client.post<{ data: { id: string } }>(`${path}/tasks`, {
          name: str(action.params, "name"),
          project_id: str(action.params, "projectId"),
          estimated_time: hours === null ? null : Math.round(hours * 3600),
        })
      );
      return ok({ taskId: created.data.id }, [{ check: "Task created", passed: Boolean(created.data.id) }]);
    }

    case "SOLIDTIME_TAG_CREATE": {
      const created = await write(() => client.post<{ data: { id: string } }>(`${path}/tags`, { name: str(action.params, "name") }));
      return ok({ tagId: created.data.id }, [{ check: "Tag created", passed: Boolean(created.data.id) }]);
    }

    case "SOLIDTIME_CLIENT_CREATE": {
      const created = await write(() => client.post<{ data: { id: string } }>(`${path}/clients`, { name: str(action.params, "name") }));
      return ok({ clientId: created.data.id }, [{ check: "Client created", passed: Boolean(created.data.id) }]);
    }

    default:
      throw new SolidtimeExecutionFailure(new Error(`Unknown Solidtime action ${action.kind}`), false);
  }
}
