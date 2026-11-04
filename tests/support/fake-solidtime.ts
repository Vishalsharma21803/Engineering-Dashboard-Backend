import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";

import { HttpResponse, http } from "msw";

/**
 * In-memory Solidtime server following the real API v1 (paths, envelopes,
 * permissions by role, the one-running-timer rule, start/end filters on an
 * entry's start). Every call is recorded so tests can assert what was written.
 */
export const SOLIDTIME_URL = "https://solidtime.test";
export const EMPLOYEE_TOKEN = "st-employee-token-0123456789abcdefghijklmnop";
export const MANAGER_TOKEN = "st-manager-token-0123456789abcdefghijklmnopq";
export const REVOKED_TOKEN = "st-revoked-token-0123456789abcdefghijklmnopq";

/** The Solidtime address check resolves solidtime.test to a public address (no real DNS); other names resolve normally. */
export async function solidtimeTestResolver(hostname: string): Promise<string[]> {
  if (hostname === new URL(SOLIDTIME_URL).hostname) return ["93.184.215.14"];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

export const ORG_ID = "aaaaaaaa-0000-4000-8000-000000000001";
export const EMPLOYEE = { userId: "bbbbbbbb-0000-4000-8000-000000000001", memberId: "cccccccc-0000-4000-8000-000000000001", name: "Dev Example", email: "dev@example.com" };
export const MANAGER = { userId: "bbbbbbbb-0000-4000-8000-000000000002", memberId: "cccccccc-0000-4000-8000-000000000002", name: "Lead Person", email: "lead@example.com" };
export const PROJECT_ALPHA = "dddddddd-0000-4000-8000-000000000001";
export const TAG_BACKEND = "eeeeeeee-0000-4000-8000-000000000001";

interface Entry {
  id: string;
  start: string;
  end: string | null;
  description: string | null;
  task_id: string | null;
  project_id: string | null;
  organization_id: string;
  user_id: string;
  member_id: string;
  tags: string[];
  billable: boolean;
  type: string;
}

export interface FakeSolidtime {
  entries: Entry[];
  projects: Array<{ id: string; name: string; color: string; client_id: string | null; is_archived: boolean; is_billable: boolean; estimated_time: number | null; spent_time: number }>;
  tasks: Array<{ id: string; name: string; is_done: boolean; project_id: string; estimated_time: number | null; spent_time: number }>;
  tags: Array<{ id: string; name: string }>;
  clients: Array<{ id: string; name: string; is_archived: boolean }>;
  requests: Array<{ method: string; path: string; body: unknown; token: string | null }>;
  timeZone: string;
  /** Entry creations allowed before the server starts failing (simulates an outage mid-batch). */
  createsBeforeFailure: number | null;
  /** Entry creations answered normally before the following ones are saved but answered with `200 {}` (no entry in the reply). */
  createsBeforeMalformed: number | null;
  /** The next write is answered with this status without being applied (e.g. 502 from a gateway). */
  failNextWrite: number | null;
}

const PER_PAGE = 15;

export function createFakeSolidtime(): FakeSolidtime {
  return {
    entries: [],
    projects: [{ id: PROJECT_ALPHA, name: "Alpha", color: "#4f46e5", client_id: null, is_archived: false, is_billable: false, estimated_time: null, spent_time: 0 }],
    tasks: [],
    tags: [{ id: TAG_BACKEND, name: "backend" }],
    clients: [],
    requests: [],
    timeZone: "UTC",
    createsBeforeFailure: null,
    createsBeforeMalformed: null,
    failNextWrite: null,
  };
}

/** Adds a finished (or running, with end null) entry for a member. */
export function addEntry(fake: FakeSolidtime, entry: { start: string; end: string | null; description: string; who?: "employee" | "manager"; projectId?: string | null }): Entry {
  const person = entry.who === "manager" ? MANAGER : EMPLOYEE;
  const created: Entry = {
    id: randomUUID(),
    start: entry.start,
    end: entry.end,
    description: entry.description,
    task_id: null,
    project_id: entry.projectId ?? null,
    organization_id: ORG_ID,
    user_id: person.userId,
    member_id: person.memberId,
    tags: [],
    billable: false,
    type: "work",
  };
  fake.entries.push(created);
  return created;
}

const resource = (entry: Entry) => ({
  id: entry.id,
  start: entry.start,
  end: entry.end,
  duration: entry.end ? Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / 1000) : null,
  description: entry.description,
  task_id: entry.task_id,
  project_id: entry.project_id,
  organization_id: entry.organization_id,
  user_id: entry.user_id,
  tags: entry.tags,
  billable: entry.billable,
  type: entry.type,
});

function paged<T>(items: T[], url: URL) {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const last = Math.max(1, Math.ceil(items.length / PER_PAGE));
  return { data: items.slice((page - 1) * PER_PAGE, page * PER_PAGE), meta: { current_page: page, last_page: last, per_page: PER_PAGE, total: items.length } };
}

const apiError = (status: number, key: string, message: string) => HttpResponse.json({ error: true, key, message }, { status });

export function fakeSolidtimeHandlers(fake: FakeSolidtime) {
  return [
    http.all(`${SOLIDTIME_URL}/api/v1/*`, async ({ request }) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v1\//, "");
      const method = request.method;
      const auth = request.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const body = method === "GET" || method === "DELETE" ? null : await request.json().catch(() => null);
      fake.requests.push({ method, path, body, token });

      const me = token === EMPLOYEE_TOKEN ? EMPLOYEE : token === MANAGER_TOKEN ? MANAGER : null;

      if (!me) {
        return HttpResponse.json({ message: "Unauthenticated." }, { status: 401 });
      }

      const role = me === MANAGER ? "manager" : "employee";
      const seg = path.split("/");

      if (path === "users/me") {
        return HttpResponse.json({ data: { id: me.userId, name: me.name, email: me.email, timezone: fake.timeZone, week_start: "monday" } });
      }

      if (path === "users/me/memberships") {
        return HttpResponse.json({ data: [{ id: me.memberId, organization: { id: ORG_ID, name: "Sifars", currency: "USD" }, role }] });
      }

      if (path === "users/me/time-entries/active") {
        const active = fake.entries.find((entry) => entry.user_id === me.userId && entry.end === null);
        return active ? HttpResponse.json({ data: resource(active) }) : HttpResponse.json({ message: "No active time entry" }, { status: 404 });
      }

      if (seg[0] !== "organizations" || seg[1] !== ORG_ID) {
        return HttpResponse.json({ message: "Not found" }, { status: 404 });
      }

      const rest = seg.slice(2);
      const viewAll = role !== "employee";

      if (rest[0] === "members" && method === "GET") {
        if (!viewAll) return HttpResponse.json({ message: "This action is unauthorized." }, { status: 403 });
        return HttpResponse.json(paged([EMPLOYEE, MANAGER].map((person) => ({ id: person.memberId, user_id: person.userId, name: person.name, email: person.email, role: person === MANAGER ? "manager" : "employee", is_placeholder: false })), url));
      }

      for (const [name, list] of [["projects", fake.projects], ["tasks", fake.tasks], ["tags", fake.tags], ["clients", fake.clients]] as const) {
        if (rest[0] !== name) continue;

        if (method === "GET") {
          const projectId = url.searchParams.get("project_id");
          const items = name === "tasks" && projectId ? (list as FakeSolidtime["tasks"]).filter((task) => task.project_id === projectId) : list;
          return HttpResponse.json(paged([...items], url));
        }

        if (method === "POST") {
          // Employees cannot create projects, tasks, tags or clients (by default).
          if (!viewAll) return HttpResponse.json({ message: "This action is unauthorized." }, { status: 403 });
          const input = body as Record<string, unknown>;
          const id = randomUUID();
          const created =
            name === "projects"
              ? { id, name: String(input.name), color: String(input.color), client_id: (input.client_id as string | null) ?? null, is_archived: false, is_billable: input.is_billable === true, estimated_time: null, spent_time: 0 }
              : name === "tasks"
                ? { id, name: String(input.name), is_done: false, project_id: String(input.project_id), estimated_time: (input.estimated_time as number | null) ?? null, spent_time: 0 }
                : name === "clients"
                  ? { id, name: String(input.name), is_archived: false }
                  : { id, name: String(input.name) };
          (list as unknown as Array<typeof created>).push(created);
          return HttpResponse.json({ data: created }, { status: 201 });
        }
      }

      if (rest[0] !== "time-entries") {
        return HttpResponse.json({ message: "Not found" }, { status: 404 });
      }

      if (method !== "GET" && fake.failNextWrite !== null) {
        const status = fake.failNextWrite;
        fake.failNextWrite = null;
        return HttpResponse.json({ message: "Bad Gateway" }, { status });
      }

      const memberFilter = url.searchParams.get("member_id");

      if (method === "GET") {
        // Without my own member id, everyone's time is asked for: a team role is needed.
        if (memberFilter !== me.memberId && !viewAll) {
          return HttpResponse.json({ message: "This action is unauthorized." }, { status: 403 });
        }

        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        const projectIds = url.searchParams.getAll("project_ids[]");
        const matching = fake.entries
          .filter((entry) => !memberFilter || entry.member_id === memberFilter)
          .filter((entry) => !start || entry.start >= start)
          .filter((entry) => !end || entry.start < end)
          .filter((entry) => projectIds.length === 0 || (entry.project_id !== null && projectIds.includes(entry.project_id)))
          .sort((a, b) => b.start.localeCompare(a.start));

        if (rest[1] === "aggregate") {
          const now = Date.now();
          const seconds = (entry: Entry) => Math.round(((entry.end ? Date.parse(entry.end) : now) - Date.parse(entry.start)) / 1000);
          const byDescription = new Map<string, Entry[]>();
          for (const entry of matching) byDescription.set(entry.description ?? "", [...(byDescription.get(entry.description ?? "") ?? []), entry]);
          const subUser = url.searchParams.get("sub_group") === "user";
          return HttpResponse.json({
            data: {
              seconds: matching.reduce((sum, entry) => sum + seconds(entry), 0),
              cost: null,
              grouped_type: "description",
              grouped_data: [...byDescription.entries()].map(([key, group]) => ({
                key: key || null,
                seconds: group.reduce((sum, entry) => sum + seconds(entry), 0),
                cost: null,
                grouped_type: subUser ? "user" : null,
                grouped_data: subUser
                  ? [...new Set(group.map((entry) => entry.user_id))].map((userId) => ({ key: userId, seconds: group.filter((entry) => entry.user_id === userId).reduce((sum, entry) => sum + seconds(entry), 0), cost: null, grouped_type: null, grouped_data: null }))
                  : null,
              })),
            },
          });
        }

        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? "100"));
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return HttpResponse.json({ data: matching.slice(offset, offset + limit).map(resource), meta: { total: matching.length } });
      }

      if (method === "POST" && !rest[1]) {
        const input = body as Record<string, unknown>;

        if (fake.createsBeforeFailure !== null) {
          if (fake.createsBeforeFailure <= 0) return HttpResponse.json({ message: "Server Error" }, { status: 500 });
          fake.createsBeforeFailure -= 1;
        }

        if (input.member_id !== me.memberId && !viewAll) {
          return HttpResponse.json({ message: "This action is unauthorized." }, { status: 403 });
        }

        if (input.end === null && fake.entries.some((entry) => entry.user_id === me.userId && entry.end === null)) {
          return apiError(400, "time_entry_still_running", "Time entry is still running");
        }

        const created: Entry = {
          id: randomUUID(),
          start: String(input.start),
          end: (input.end as string | null) ?? null,
          description: (input.description as string | null) ?? null,
          task_id: (input.task_id as string | null) ?? null,
          project_id: (input.project_id as string | null) ?? null,
          organization_id: ORG_ID,
          user_id: me.userId,
          member_id: String(input.member_id),
          tags: (input.tags as string[]) ?? [],
          billable: input.billable === true,
          type: "work",
        };
        fake.entries.push(created);

        if (fake.createsBeforeMalformed !== null) {
          if (fake.createsBeforeMalformed <= 0) return HttpResponse.json({}, { status: 200 });
          fake.createsBeforeMalformed -= 1;
        }

        return HttpResponse.json({ data: resource(created) }, { status: 201 });
      }

      const entry = fake.entries.find((candidate) => candidate.id === rest[1]);

      if (!entry) {
        return HttpResponse.json({ message: "Not found" }, { status: 404 });
      }

      if (entry.member_id !== me.memberId && !viewAll) {
        return HttpResponse.json({ message: "This action is unauthorized." }, { status: 403 });
      }

      if (method === "PUT") {
        const input = body as Record<string, unknown>;
        for (const [field, key] of [["start", "start"], ["end", "end"], ["description", "description"], ["project_id", "project_id"], ["task_id", "task_id"], ["tags", "tags"], ["billable", "billable"]] as const) {
          if (field in input) (entry as unknown as Record<string, unknown>)[key] = input[field];
        }
        return HttpResponse.json({ data: resource(entry) });
      }

      if (method === "DELETE") {
        fake.entries.splice(fake.entries.indexOf(entry), 1);
        return new HttpResponse(null, { status: 204 });
      }

      return HttpResponse.json({ message: "Method not allowed" }, { status: 405 });
    }),
  ];
}

/** Writes Cockpit sent to Solidtime (anything but GET). */
export const solidtimeWrites = (fake: FakeSolidtime) => fake.requests.filter((request) => request.method !== "GET");
