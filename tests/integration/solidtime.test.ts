import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { clearAzureCache } from "../../src/lib/azure/cache.js";
import { clearSolidtimeCache } from "../../src/lib/solidtime/client.js";
import { server } from "../setup.js";
import { VALID_CLAUDE_KEY, createFakeAi, fakeAiHandlers, type FakeAi } from "../support/fake-ai.js";
import type { FakeAzure } from "../support/fake-azure.js";
import { ME, writeRequests } from "../support/fake-azure.js";
import {
  EMPLOYEE,
  EMPLOYEE_TOKEN,
  MANAGER_TOKEN,
  ORG_ID,
  PROJECT_ALPHA,
  REVOKED_TOKEN,
  SOLIDTIME_URL,
  addEntry,
  solidtimeWrites,
  type FakeSolidtime,
} from "../support/fake-solidtime.js";
import { azurePath, connectSolidtime, installFakeAzure, installFakeSolidtime, resetDatabase, setupUser, type Agent } from "../support/harness.js";
import { useAlphaRulebook } from "../support/test-rulebook.js";

let azure: FakeAzure;
let solidtime: FakeSolidtime;
let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  azure = installFakeAzure();
  solidtime = installFakeSolidtime();
  ({ agent, credentialId } = await setupUser());
});

const CLIENT_WORK = "dddddddd-0000-4000-8000-0000000000c1";
const SUPPORT = "dddddddd-0000-4000-8000-0000000000c2";
const BETA_ONE = "dddddddd-0000-4000-8000-0000000000c3";
const BETA_TWO = "dddddddd-0000-4000-8000-0000000000c4";
const shiftUtcDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (hours: number) => `${new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19)}Z`;
const st = (connection: string, path: string) => `/api/solidtime/${connection}${path}`;

async function propose(connection: string, body: Record<string, unknown>, expected = 201) {
  const response = await agent.post("/api/actions").send({ credentialId: connection, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body.action;
}

async function approve(action: { id: string; payloadHash: string }, expected = 200) {
  const response = await agent.post(`/api/actions/${action.id}/approve`).send({ payloadHash: action.payloadHash });
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body;
}

describe("connecting Solidtime", () => {
  it("checks the token, chooses the only organization, links Azure and never returns the token", async () => {
    const response = await agent.post("/api/solidtime/connections").send({ baseUrl: `${SOLIDTIME_URL}/api/v1/`, token: EMPLOYEE_TOKEN }).expect(201);

    expect(response.body.connection).toMatchObject({
      baseUrl: SOLIDTIME_URL,
      organizationId: ORG_ID,
      organizationName: "Sifars",
      memberId: EMPLOYEE.memberId,
      role: "employee",
      canViewTeam: false,
      azureCredentialId: credentialId,
      dailyTargetHours: 8,
      timerAlertHours: 10,
    });
    const listed = await agent.get("/api/solidtime/connections").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(EMPLOYEE_TOKEN);
    expect(JSON.stringify((await agent.get("/api/credentials").expect(200)).body)).not.toContain(EMPLOYEE_TOKEN);

    // The same server twice is refused.
    await agent.post("/api/solidtime/connections").send({ baseUrl: SOLIDTIME_URL, token: EMPLOYEE_TOKEN }).expect(409);
  });

  it("refuses bad tokens and unsafe addresses", async () => {
    expect((await agent.post("/api/solidtime/connections").send({ baseUrl: SOLIDTIME_URL, token: REVOKED_TOKEN }).expect(424)).body.reason).toBe("SOLIDTIME_TOKEN_INVALID");
    await agent.post("/api/solidtime/connections").send({ baseUrl: "http://solidtime.test", token: EMPLOYEE_TOKEN }).expect(400);
    await agent.post("/api/solidtime/connections").send({ baseUrl: "https://user:pass@solidtime.test", token: EMPLOYEE_TOKEN }).expect(400);

    process.env.SOLIDTIME_ALLOWED_HOSTS = "time.example.com";
    const blocked = await agent.post("/api/solidtime/connections").send({ baseUrl: SOLIDTIME_URL, token: EMPLOYEE_TOKEN }).expect(400);
    expect(JSON.stringify(blocked.body)).toContain("SOLIDTIME_ALLOWED_HOSTS");
    delete process.env.SOLIDTIME_ALLOWED_HOSTS;
  });

  it("updates settings and keeps Azure and Solidtime credentials apart", async () => {
    const connection = await connectSolidtime(agent);
    const updated = await agent
      .patch(`/api/solidtime/connections/${connection}`)
      .send({ projectMap: { Alpha: PROJECT_ALPHA }, dailyTargetHours: 7.5, timerAlertHours: 9 })
      .expect(200);
    expect(updated.body.connection).toMatchObject({ projectMap: { alpha: PROJECT_ALPHA }, dailyTargetHours: 7.5, timerAlertHours: 9 });
    await agent.patch(`/api/solidtime/connections/${connection}`).send({ azureCredentialId: connection }).expect(422);
    await agent.patch(`/api/solidtime/connections/${connection}`).send({ unknown: true }).expect(400);

    // An Azure route never accepts a Solidtime credential, and the other way round.
    await agent.get(azurePath(connection, "/projects")).expect(404);
    await agent.get(st(credentialId, "/timer")).expect(404);
    await agent.patch(`/api/credentials/${connection}`).send({ label: "x" }).expect(404);

    // Someone else cannot use my connection.
    const other = await setupUser("other@example.com");
    await other.agent.get(st(connection, "/timer")).expect(404);
    await other.agent.post("/api/actions").send({ credentialId: connection, kind: "SOLIDTIME_TAG_CREATE", params: { name: "x" } }).expect(404);
  });
});

describe("timer and entries through approval", () => {
  it("starts and stops a timer only after approval, from the time Start was pressed", async () => {
    const connection = await connectSolidtime(agent);
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();

    const start = await propose(connection, {
      kind: "SOLIDTIME_TIMER_START",
      params: { startedAt, description: "#101 Implement login", projectId: PROJECT_ALPHA, taskId: null, tags: [], billable: false },
    });
    expect(start.preview).toEqual(expect.arrayContaining([expect.objectContaining({ field: "Project", after: "Alpha" })]));
    expect(solidtimeWrites(solidtime)).toEqual([]);

    await approve(start);
    const running = solidtime.entries.find((entry) => entry.end === null)!;
    expect(running).toMatchObject({ description: "#101 Implement login", member_id: EMPLOYEE.memberId, start: `${startedAt.slice(0, 19)}Z` });

    // One running timer at a time.
    const again = await agent.post("/api/actions").send({ credentialId: connection, kind: "SOLIDTIME_TIMER_START", params: { startedAt: new Date().toISOString(), description: "x", projectId: null, taskId: null } });
    expect(again.body.reason).toBe("TIMER_ALREADY_RUNNING");

    expect((await agent.get(st(connection, "/profile")).expect(200)).body.profile).toEqual({ name: "Dev Example", timeZone: "UTC" });
    const timer = (await agent.get(st(connection, "/timer")).expect(200)).body.timer;
    expect(timer.tickets).toEqual([expect.objectContaining({ id: 101, title: "Implement login" })]);

    const stop = await propose(connection, { kind: "SOLIDTIME_TIMER_STOP", target: { entryId: running.id, entryStart: running.start }, params: { stoppedAt: new Date().toISOString() } });
    await approve(stop);
    expect(running.end).not.toBeNull();

    // A start time outside the approval window is refused.
    await propose(connection, { kind: "SOLIDTIME_TIMER_START", params: { startedAt: hoursAgo(2), description: "x", projectId: null, taskId: null } }, 422);
  });

  it("refuses to stop a timer that was already stopped elsewhere", async () => {
    const connection = await connectSolidtime(agent);
    const running = addEntry(solidtime, { start: hoursAgo(1), end: null, description: "#102 Fix flaky test" });
    const stop = await propose(connection, { kind: "SOLIDTIME_TIMER_STOP", target: { entryId: running.id, entryStart: running.start }, params: { stoppedAt: new Date().toISOString() } });

    running.end = hoursAgo(0.5);
    const failed = await approve(stop, 409);
    expect(failed.reason).toBe("ACTION_STALE");
    expect(solidtimeWrites(solidtime)).toEqual([]);
  });

  it("adds, edits and deletes entries, refusing edits to an entry changed since the preview", async () => {
    const connection = await connectSolidtime(agent);
    const created = await propose(connection, {
      kind: "SOLIDTIME_ENTRY_CREATE",
      params: { start: hoursAgo(3), end: hoursAgo(2), description: "#103 Crash on save", projectId: PROJECT_ALPHA, taskId: null, tags: [], billable: false },
    });
    expect(created.summary).toContain("1h 00m");
    await approve(created);
    const entry = solidtime.entries[0]!;

    const edit = await propose(connection, { kind: "SOLIDTIME_ENTRY_UPDATE", target: { entryId: entry.id, entryStart: entry.start }, params: { description: "#103 Crash on save (fix)" } });
    expect(edit.preview).toEqual([expect.objectContaining({ field: "Description", before: "#103 Crash on save", after: "#103 Crash on save (fix)" })]);
    await approve(edit);
    expect(entry.description).toBe("#103 Crash on save (fix)");

    const remove = await propose(connection, { kind: "SOLIDTIME_ENTRY_DELETE", target: { entryId: entry.id, entryStart: entry.start }, params: {} });
    entry.description = "changed in Solidtime";
    expect((await approve(remove, 409)).reason).toBe("ACTION_STALE");
    expect(solidtime.entries).toHaveLength(1);

    const removeAgain = await propose(connection, { kind: "SOLIDTIME_ENTRY_DELETE", target: { entryId: entry.id, entryStart: entry.start }, params: {} });
    await approve(removeAgain);
    expect(solidtime.entries).toHaveLength(0);

    // Unknown entries and projects are refused before anything is proposed.
    await propose(connection, { kind: "SOLIDTIME_ENTRY_DELETE", target: { entryId: entry.id, entryStart: entry.start }, params: {} }, 404);
    await propose(connection, { kind: "SOLIDTIME_ENTRY_CREATE", params: { start: hoursAgo(3), end: hoursAgo(2), description: "x", projectId: ORG_ID, taskId: null } }, 422);
  });

  it("approves a whole day of entries at once and refuses overlaps", async () => {
    const connection = await connectSolidtime(agent);
    const batch = await propose(connection, {
      kind: "SOLIDTIME_ENTRIES_CREATE",
      params: {
        entries: [
          { start: hoursAgo(5), end: hoursAgo(4), description: "#101 Implement login", projectId: PROJECT_ALPHA, taskId: null },
          { start: hoursAgo(4), end: hoursAgo(3.5), description: "#102 Fix flaky test", projectId: PROJECT_ALPHA, taskId: null },
        ],
      },
    });
    expect(batch.summary).toBe("Add 2 time entries (1h 30m)");
    await approve(batch);
    expect(solidtime.entries.map((entry) => entry.description).sort()).toEqual(["#101 Implement login", "#102 Fix flaky test"]);

    const overlapping = await agent.post("/api/actions").send({
      credentialId: connection,
      kind: "SOLIDTIME_ENTRIES_CREATE",
      params: { entries: [{ start: hoursAgo(5), end: hoursAgo(4), description: "a", projectId: null, taskId: null }, { start: hoursAgo(4.5), end: hoursAgo(3), description: "b", projectId: null, taskId: null }] },
    });
    expect(overlapping.body.reason).toBe("ENTRIES_OVERLAP");
  });

  it("refuses to stop a timer running in another Solidtime organization", async () => {
    const connection = await connectSolidtime(agent);
    const elsewhere = addEntry(solidtime, { start: hoursAgo(1), end: null, description: "other org" });
    elsewhere.organization_id = "ffffffff-0000-4000-8000-000000000009";

    const refused = await agent.post("/api/actions").send({ credentialId: connection, kind: "SOLIDTIME_TIMER_STOP", target: { entryId: elsewhere.id, entryStart: elsewhere.start }, params: { stoppedAt: new Date().toISOString() } });
    expect(refused.body.reason).toBe("TIMER_IN_OTHER_ORGANIZATION");
  });

  it("records which entries of a batch were saved when Solidtime fails part-way", async () => {
    const connection = await connectSolidtime(agent);
    const batch = await propose(connection, {
      kind: "SOLIDTIME_ENTRIES_CREATE",
      params: {
        entries: [
          { start: hoursAgo(5), end: hoursAgo(4), description: "#101 a", projectId: null, taskId: null },
          { start: hoursAgo(4), end: hoursAgo(3), description: "#102 b", projectId: null, taskId: null },
        ],
      },
    });
    solidtime.createsBeforeFailure = 1;

    const failed = await approve(batch, 502);
    expect(failed.message).toContain("1 of 2 entries were saved");
    expect(failed.action.result).toMatchObject({ writeSent: true, savedCount: 1, entryIds: [solidtime.entries[0]!.id] });
  });

  it("lets only team roles create projects and tags (an employee gets a clear refusal)", async () => {
    const connection = await connectSolidtime(agent);
    const tag = await propose(connection, { kind: "SOLIDTIME_TAG_CREATE", params: { name: "frontend" } });
    const failed = await approve(tag, 403);
    expect(failed.reason).toBe("SOLIDTIME_FORBIDDEN");

    const manager = await setupUser("lead@example.com");
    const managerConnection = await connectSolidtime(manager.agent, MANAGER_TOKEN);
    const project = (await manager.agent.post("/api/actions").send({ credentialId: managerConnection, kind: "SOLIDTIME_PROJECT_CREATE", params: { name: "Beta" } }).expect(201)).body.action;
    await manager.agent.post(`/api/actions/${project.id}/approve`).send({ payloadHash: project.payloadHash }).expect(200);
    expect(solidtime.projects.map((item) => item.name)).toContain("Beta");
  });
});

describe("time on tickets", () => {
  it("adds up time by the ticket id in descriptions, mine and (for team roles) everyone's", async () => {
    addEntry(solidtime, { start: hoursAgo(30), end: hoursAgo(28), description: "101 - Implement login" });
    addEntry(solidtime, { start: hoursAgo(10), end: hoursAgo(9), description: "Login flow (#101)" });
    addEntry(solidtime, { start: hoursAgo(8), end: hoursAgo(7), description: "Implement login 101", who: "manager" });
    addEntry(solidtime, { start: hoursAgo(6), end: hoursAgo(5), description: "v1.0.101 release notes" });

    const employee = await connectSolidtime(agent);
    const mine = (await agent.get(st(employee, "/tickets/101/time")).expect(200)).body;
    expect(mine.time).toMatchObject({ ticketId: 101, mySeconds: 3 * 3600, teamSeconds: null, people: null, running: false });
    expect(mine.ticket).toMatchObject({ id: 101, title: "Implement login" });
    expect(mine.comparison).toMatchObject({ trackedHours: 3, basis: "mine" });

    // The total is all time: an entry from two years ago counts too (read fresh with ?refresh=true).
    addEntry(solidtime, { start: hoursAgo(24 * 730), end: hoursAgo(24 * 730 - 2), description: "#101 Implement login" });
    const allTime = (await agent.get(st(employee, "/tickets/101/time?refresh=true")).expect(200)).body;
    expect(allTime.time.mySeconds).toBe(5 * 3600);
    expect(allTime.comparison).toMatchObject({ trackedHours: 5, suggested: { completedWork: 5, remainingWork: 3 }, inSync: false });
    expect(solidtimeWrites(solidtime)).toEqual([]);

    const times = (await agent.get(st(employee, "/ticket-times?ids=101,102")).expect(200)).body.times;
    expect(times).toEqual([expect.objectContaining({ ticketId: 101, mySeconds: 10_800 }), expect.objectContaining({ ticketId: 102, mySeconds: 0 })]);
    await agent.get(st(employee, "/ticket-times?ids=abc")).expect(400);

    const manager = await setupUser("lead@example.com");
    const managerConnection = await connectSolidtime(manager.agent, MANAGER_TOKEN);
    const team = (await manager.agent.get(st(managerConnection, "/tickets/101/time")).expect(200)).body.time;
    expect(team).toMatchObject({ mySeconds: 3600, teamSeconds: 6 * 3600 });
    expect((await manager.agent.get(st(managerConnection, "/tickets/101/time")).expect(200)).body.comparison).toMatchObject({ basis: "team", trackedHours: 6 });
    expect(team.people).toEqual([
      { name: "Dev Example", seconds: 5 * 3600 },
      { name: "Lead Person", seconds: 3600 },
    ]);
  });

  it("shows my timesheet by day and ticket, and lists entries that name no real ticket", async () => {
    const connection = await connectSolidtime(agent);
    const today = new Date().toISOString().slice(0, 10);
    addEntry(solidtime, { start: `${today}T00:10:00Z`, end: `${today}T01:10:00Z`, description: "#101 Implement login" });
    addEntry(solidtime, { start: `${today}T01:10:00Z`, end: `${today}T01:40:00Z`, description: "Standup" });
    addEntry(solidtime, { start: `${today}T01:40:00Z`, end: `${today}T02:10:00Z`, description: "#999999 not a ticket" });
    addEntry(solidtime, { start: `${today}T02:10:00Z`, end: `${today}T02:40:00Z`, description: "#102 other person", who: "manager" });

    const sheet = (await agent.get(st(connection, `/timesheet?from=${today}`)).expect(200)).body.timesheet;
    expect(sheet).toMatchObject({ from: today, to: today, totalSeconds: 2 * 3600, unlinkedSeconds: 3600, ticketsChecked: true });
    expect(sheet.days).toEqual([{ day: today, seconds: 7200 }]);
    expect(sheet.byTicket.items).toEqual([{ ticketId: 101, title: "Implement login", seconds: 3600 }]);
    expect(sheet.entries).toMatchObject({ total: 3, page: 1, pageSize: 10 });

    const unlinked = (await agent.get(st(connection, `/unlinked?from=${today}`)).expect(200)).body.entries;
    expect(unlinked.items.map((entry: { description: string }) => entry.description).sort()).toEqual(["#999999 not a ticket", "Standup"]);
    // One day's entries within a longer period: the totals still cover the period.
    const yesterday = shiftUtcDay(today, -1);
    addEntry(solidtime, { start: `${yesterday}T09:00:00Z`, end: `${yesterday}T10:00:00Z`, description: "#101 Implement login" });
    const oneDay = (await agent.get(st(connection, `/timesheet?from=${yesterday}&to=${today}&day=${yesterday}`)).expect(200)).body.timesheet;
    expect(oneDay.totalSeconds).toBe(3 * 3600);
    expect(oneDay.entries.items.map((entry: { description: string }) => entry.description)).toEqual(["#101 Implement login"]);
    await agent.get(st(connection, `/timesheet?from=${today}&day=${yesterday}`)).expect(400);
    await agent.get(st(connection, "/timesheet?from=2026-01-01&to=2026-03-01")).expect(400);
    await agent.get(st(connection, "/timesheet?from=2026-02-31")).expect(400);
  });

  it("drafts a day from my Azure changes, minus time already tracked, without overlaps", async () => {
    const connection = await connectSolidtime(agent);
    const today = new Date().toISOString().slice(0, 10);
    const at = (hour: number) => `${today}T${String(hour).padStart(2, "0")}:00:00Z`;
    azure.updates.set(102, [
      { id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at(1) }, "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: 0, newValue: 1 } } },
      { id: 2, rev: 5, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at(2) }, "System.State": { oldValue: "Active", newValue: "Resolved" }, "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: 1, newValue: 2 } } },
    ]);
    azure.updates.set(103, [{ id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at(1) }, "System.Title": { oldValue: "a", newValue: "b" } } }]);
    addEntry(solidtime, { start: at(0), end: `${today}T00:30:00Z`, description: "#102 Fix flaky test" });

    const draft = (await agent.get(st(connection, `/draft?day=${today}`)).expect(200)).body.draft;
    const fixFlaky = draft.rows.find((row: { ticketId: number }) => row.ticketId === 102);
    expect(fixFlaky).toMatchObject({ completedWorkAdded: 2, alreadyTrackedHours: 0.5, hours: 1.5, description: "#102 Fix flaky test", solidtimeProjectId: PROJECT_ALPHA });
    expect(fixFlaky.activity.map((item: { what: string }) => item.what)).toEqual(["Completed Work 0 → 1", "State Active → Resolved", "Completed Work 1 → 2"]);
    // Ends when Completed Work last went up, and does not overlap the existing 00:00-00:30 entry.
    expect(fixFlaky.end).toBe(new Date(at(2)).toISOString());
    expect(Date.parse(fixFlaky.start)).toBeGreaterThanOrEqual(Date.parse(`${today}T00:30:00Z`));

    // Only a title edit, at the same time as other work: the least activity counts (0.25 h).
    expect(draft.rows.find((row: { ticketId: number }) => row.ticketId === 103)).toMatchObject({ hours: 0.25, hoursSource: "activity", hoursBasis: "1 change at 01:00", activity: [expect.objectContaining({ what: "Edited Title" })] });
    await agent.get(st(connection, "/draft?day=2020-01-01")).expect(422);
    expect(solidtimeWrites(solidtime)).toEqual([]);
  });

  it("fills every drafted row: the project from my mapping or earlier entries, an anchor time, and the day's totals", async () => {
    const connection = await connectSolidtime(agent);
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const at = (time: string) => `${day}T${time}:00Z`;
    solidtime.projects.push(
      { id: CLIENT_WORK, name: "Client work", color: "#000000", client_id: null, is_archived: false, is_billable: false, estimated_time: null, spent_time: 0 },
      { id: SUPPORT, name: "Support", color: "#000000", client_id: null, is_archived: false, is_billable: false, estimated_time: null, spent_time: 0 }
    );
    // Earlier entries: #102 went to Client work; Alpha tickets mostly went to Support.
    addEntry(solidtime, { start: hoursAgo(24 * 10), end: hoursAgo(24 * 10 - 1), description: "#102 Fix flaky test", projectId: CLIENT_WORK });
    addEntry(solidtime, { start: hoursAgo(24 * 5), end: hoursAgo(24 * 5 - 1), description: "#101 Implement login", projectId: SUPPORT });
    addEntry(solidtime, { start: hoursAgo(24 * 4), end: hoursAgo(24 * 4 - 1), description: "#101 Implement login", projectId: SUPPORT });
    addEntry(solidtime, { start: at("08:00"), end: at("09:00"), description: "Standup" });
    azure.updates.set(102, [{ id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("11:00") }, "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: 0, newValue: 2 } } }]);
    azure.updates.set(103, [
      { id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("13:00") }, "System.Title": { oldValue: "a", newValue: "b" } } },
      { id: 2, rev: 5, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("15:30") }, "System.State": { oldValue: "Active", newValue: "Resolved" } } },
    ]);

    const draft = (await agent.get(st(connection, `/draft?day=${day}`)).expect(200)).body.draft;
    expect(draft).toMatchObject({ day, timeZone: "UTC", targetHours: 8, trackedHours: 1, busy: [{ start: new Date(at("08:00")).toISOString(), end: new Date(at("09:00")).toISOString() }] });
    const row = (id: number) => draft.rows.find((item: { ticketId: number }) => item.ticketId === id);
    expect(row(102)).toMatchObject({ hours: 2, hoursSource: "completed-work", solidtimeProjectId: CLIENT_WORK, projectSource: "ticket", type: "Task", state: "Active" });
    expect(row(102).anchor).toBe(new Date(at("11:00")).toISOString());
    // Hours from my timeline (2 h before 13:00 + 2 h of the 2.5 h before 15:30), capped at its 1 h Remaining Work; ends at my last change.
    expect(row(103)).toMatchObject({ hours: 1, hoursSource: "activity", hoursBasis: "2 changes between 13:00 and 15:30, capped at its 1 h Remaining Work", solidtimeProjectId: SUPPORT, projectSource: "azure-project", remainingWork: 1 });
    expect(row(103)).toMatchObject({ anchor: new Date(at("15:30")).toISOString(), start: new Date(at("14:30")).toISOString(), end: new Date(at("15:30")).toISOString() });

    // A ticket from a project named differently only by case and separators finds it; two such projects: none is guessed.
    azure.workItems.get(103)!.fields["System.TeamProject"] = "beta";
    clearAzureCache();
    solidtime.projects.push({ id: BETA_ONE, name: "BETA-", color: "#000000", client_id: null, is_archived: false, is_billable: false, estimated_time: null, spent_time: 0 });
    clearSolidtimeCache();
    const beta = (await agent.get(st(connection, `/draft?day=${day}`)).expect(200)).body.draft.rows.find((item: { ticketId: number }) => item.ticketId === 103);
    expect(beta).toMatchObject({ solidtimeProjectId: BETA_ONE, projectSource: "name", projectMatches: [] });
    solidtime.projects.push({ id: BETA_TWO, name: "Beta", color: "#000000", client_id: null, is_archived: false, is_billable: false, estimated_time: null, spent_time: 0 });
    clearSolidtimeCache();
    const twoBetas = (await agent.get(st(connection, `/draft?day=${day}`)).expect(200)).body.draft.rows.find((item: { ticketId: number }) => item.ticketId === 103);
    expect(twoBetas).toMatchObject({ solidtimeProjectId: null, projectSource: null, projectMatches: ["BETA-", "Beta"] });

    // My mapping wins over history.
    await agent.patch(`/api/solidtime/connections/${connection}`).send({ projectMap: { alpha: PROJECT_ALPHA } }).expect(200);
    const mapped = (await agent.get(st(connection, `/draft?day=${day}`)).expect(200)).body.draft;
    expect(mapped.rows.find((item: { ticketId: number }) => item.ticketId === 102)).toMatchObject({ projectSource: "mapping", solidtimeProjectId: PROJECT_ALPHA });
    expect(solidtimeWrites(solidtime)).toEqual([]);
  });
});

describe("AI hours for a draft", () => {
  let ai: FakeAi;
  const day = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const at = (time: string) => `${day()}T${time}:00Z`;

  beforeEach(() => {
    ai = createFakeAi();
    server.use(...fakeAiHandlers(ai));
    addEntry(solidtime, { start: at("08:00"), end: at("08:30"), description: "Standup" });
    azure.updates.set(102, [{ id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("11:00") }, "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: 0, newValue: 2 } } }]);
    azure.updates.set(103, [{ id: 1, rev: 4, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("15:00") }, "System.State": { oldValue: "Active", newValue: "Resolved" } } }]);
    azure.updates.set(101, [{ id: 1, rev: 9, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("17:00") }, "System.Tags": { oldValue: "", newValue: "ui" } } }]);
    // The fake's comment on #101 is dated "a day ago" at the current clock time: it would make the hours depend on when the tests run.
    azure.comments.set(101, []);
  });

  async function useClaude() {
    await agent.post("/api/ai/credentials").send({ provider: "CLAUDE", apiKey: VALID_CLAUDE_KEY }).expect(201);
    await agent.put("/api/ai/preferences").send({ provider: "CLAUDE", model: "claude-sonnet-5-5", effort: "LOW", dailyLimitUsd: 2, acceptDataCollection: false }).expect(200);
  }

  const estimate = (connection: string, body: Record<string, unknown>) => agent.post(st(connection, "/draft/estimate")).send(body);
  const judgeCalls = () => ai.requests.filter((request) => request.method === "POST");

  it("needs an AI model, and only estimates tickets with activity that day", async () => {
    const connection = await connectSolidtime(agent);
    expect((await estimate(connection, { day: day(), ticketIds: [103] }).expect(422)).body.reason).toBe("AI_NOT_CONFIGURED");

    await useClaude();
    expect((await estimate(connection, { day: day(), ticketIds: [104] }).expect(422)).body.reason).toBe("NOTHING_TO_ESTIMATE");
    await estimate(connection, { day: day(), ticketIds: [] }).expect(400);
    await estimate(connection, { day: "2020-01-01", ticketIds: [103] }).expect(422);
    expect(judgeCalls()).toEqual([]);
  });

  it("does not count clearing Remaining Work as work, and caps activity at the Remaining Work the ticket had that day", async () => {
    const connection = await connectSolidtime(agent);
    // #101 (Remaining Work 4 h now): cleared by me that day, then set to 1 h by someone the next day.
    azure.updates.set(101, [
      { id: 1, rev: 9, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("15:00") }, "Microsoft.VSTS.Scheduling.RemainingWork": { oldValue: 6, newValue: null } } },
      { id: 2, rev: 10, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("17:00") }, "Microsoft.VSTS.Scheduling.RemainingWork": { oldValue: null, newValue: 1.5 } } },
      { id: 3, rev: 11, revisedBy: ME, fields: { "System.ChangedDate": { newValue: new Date(Date.parse(at("17:00")) + 86_400_000).toISOString() }, "Microsoft.VSTS.Scheduling.RemainingWork": { oldValue: 1.5, newValue: 1 } } },
    ]);
    const draft = (await agent.get(st(connection, `/draft?day=${day()}`)).expect(200)).body.draft;
    // 2 h before 15:00 + 2 h before 17:00 from my timeline, capped at the 1.5 h it had at the end of that day (not today's 1 h).
    expect(draft.rows.find((row: { ticketId: number }) => row.ticketId === 101)).toMatchObject({
      hours: 1.5,
      hoursSource: "activity",
      remainingWorkLowered: 0,
      hoursBasis: expect.stringMatching(/, capped at its 1\.5 h Remaining Work$/),
      activity: expect.arrayContaining([expect.objectContaining({ what: "Remaining Work 6 → cleared" })]),
    });
  });

  it("does not count Remaining Work zeroed while closing a ticket, but does when the ticket stays open", async () => {
    const connection = await connectSolidtime(agent);
    const zeroed = (state: string) => [{ id: 1, rev: 9, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("17:00") }, "System.State": { oldValue: "Active", newValue: state }, "Microsoft.VSTS.Scheduling.RemainingWork": { oldValue: 6, newValue: 0 } } }];
    const row101 = async () => (await agent.get(st(connection, `/draft?day=${day()}&refresh=true`)).expect(200)).body.draft.rows.find((row: { ticketId: number }) => row.ticketId === 101);

    azure.updates.set(101, zeroed("Closed"));
    expect(await row101()).toMatchObject({ hoursSource: "activity", remainingWorkLowered: 0 });

    azure.updates.set(101, zeroed("New"));
    clearAzureCache();
    expect(await row101()).toMatchObject({ hoursSource: "remaining-work", remainingWorkLowered: 6, hours: 6 });
  });

  it("lowers Remaining Work into hours: what I lowered it by is what I worked", async () => {
    const connection = await connectSolidtime(agent);
    azure.updates.set(101, [{ id: 1, rev: 9, revisedBy: ME, fields: { "System.ChangedDate": { newValue: at("17:00") }, "Microsoft.VSTS.Scheduling.RemainingWork": { oldValue: 6, newValue: 3.5 } } }]);
    const draft = (await agent.get(st(connection, `/draft?day=${day()}`)).expect(200)).body.draft;
    expect(draft.rows.find((row: { ticketId: number }) => row.ticketId === 101)).toMatchObject({
      hours: 2.5,
      hoursSource: "remaining-work",
      hoursBasis: "Remaining Work lowered by 2.5 h",
      remainingWorkLowered: 2.5,
      activity: expect.arrayContaining([expect.objectContaining({ what: "Remaining Work 6 → 3.5" })]),
    });
  });

  it("checks the rule hours (within half to one and a half times), places the entries and records the cost, writing nothing", async () => {
    const connection = await connectSolidtime(agent);
    await useClaude();
    ai.timeEstimates = () => [
      { ticketId: 103, hours: 3, confidence: "high", reason: "Resolved after a long stretch." },
      { ticketId: 101, hours: 20, confidence: "low", reason: "Only a tag edit." },
      { ticketId: 999, hours: 2, confidence: "high", reason: "Not asked about." },
      { ticketId: 103, hours: 5, confidence: "low", reason: "Duplicate." },
    ];

    // Rules: #103 1 h (capped at its Remaining Work), #101 2 h (the 2 h before its 17:00 change). 3 h is held to 1.5 h, 20 h to 3 h.
    const response = (await estimate(connection, { day: day(), ticketIds: [101, 103] }).expect(200)).body.estimate;
    expect(response).toMatchObject({ day: day(), model: "claude-sonnet-5-5" });
    expect(response.costUsd).toBeGreaterThan(0);
    expect(response.estimates.map((item: { ticketId: number; ruleHours: number; hours: number; confidence: string }) => [item.ticketId, item.ruleHours, item.hours, item.confidence])).toEqual([
      [103, 1, 1.5, "high"],
      [101, 2, 3, "low"],
    ]);

    // Placed inside the day, around existing time and the Completed Work row, never overlapping.
    const taken = [
      [Date.parse(at("08:00")), Date.parse(at("08:30"))],
      [Date.parse(at("09:00")), Date.parse(at("11:00"))],
      ...response.estimates.map((item: { start: string; end: string }) => [Date.parse(item.start), Date.parse(item.end)]),
    ].sort((a, b) => a[0]! - b[0]!);
    for (let index = 1; index < taken.length; index += 1) expect(taken[index]![0]).toBeGreaterThanOrEqual(taken[index - 1]![1]!);
    expect(response.estimates[0].end).toBe(new Date(at("15:00")).toISOString());

    // One call, about the asked tickets only, without comment text; usage recorded under its own purpose.
    expect(judgeCalls()).toHaveLength(1);
    const prompt = String((judgeCalls()[0]!.body!.messages as Array<{ content: string }>)[0]!.content);
    expect(prompt).toContain("Suggested: 1 h (1 change at 15:00, capped at its 1 h Remaining Work).");
    expect(prompt).not.toContain("target");
    expect(prompt).toContain('- ticketId 103: "Crash on save"');
    expect(prompt).not.toContain("ticketId 102");
    expect(await prisma.aiUsage.findMany({ select: { purpose: true } })).toEqual([{ purpose: "time-draft" }]);
    expect(solidtimeWrites(solidtime)).toEqual([]);
    expect(writeRequests(azure)).toEqual([]);
  });

  it("never estimates Completed Work rows (even ones already in Solidtime) and places around the rows I planned", async () => {
    const connection = await connectSolidtime(agent);
    await useClaude();
    // #102's 2 h of Completed Work is already tracked: its row has 0 h, and it must not get more from the AI.
    addEntry(solidtime, { start: at("09:00"), end: at("11:00"), description: "#102 Fix flaky test" });
    expect((await estimate(connection, { day: day(), ticketIds: [102] }).expect(422)).body.reason).toBe("NOTHING_TO_ESTIMATE");

    ai.timeEstimates = (tickets) => tickets.map((ticketId) => ({ ticketId, hours: 1, confidence: "medium", reason: "x" }));
    // I planned something at 14:00-15:00 in the browser: #103 (last change 15:00) moves before it.
    const response = (await estimate(connection, { day: day(), ticketIds: [102, 103], planned: [{ start: at("14:00"), end: at("15:00") }] }).expect(200)).body.estimate;
    expect(response.estimates.map((item: { ticketId: number }) => item.ticketId)).toEqual([103]);
    expect(response.estimates[0]).toMatchObject({ start: new Date(at("13:00")).toISOString(), end: new Date(at("14:00")).toISOString() });
    expect(String((judgeCalls()[0]!.body!.messages as Array<{ content: string }>)[0]!.content)).not.toContain("ticketId 102");
  });

  it("runs one estimate per person at a time, so parallel requests cannot overshoot the spend limit", async () => {
    const connection = await connectSolidtime(agent);
    await useClaude();
    ai.answerDelayMs = 300;

    const [first, second] = await Promise.all([estimate(connection, { day: day(), ticketIds: [103] }), estimate(connection, { day: day(), ticketIds: [103] })]);
    expect([first.status, second.status].sort()).toEqual([200, 429]);
    expect([first.body.reason, second.body.reason]).toContain("AI_ESTIMATE_IN_PROGRESS");
    expect(judgeCalls()).toHaveLength(1);

    // Once it finished, the next one runs.
    await estimate(connection, { day: day(), ticketIds: [103] }).expect(200);
  });

  it("reports bad answers, saying what was wrong, after counting their cost", async () => {
    const connection = await connectSolidtime(agent);
    await useClaude();
    ai.badJson = true;
    const bad = (await estimate(connection, { day: day(), ticketIds: [103] }).expect(502)).body;
    expect(bad.reason).toBe("AI_BAD_OUTPUT");
    expect(bad.message).toContain("not JSON");
    expect(await prisma.aiUsage.count({ where: { purpose: "time-draft" } })).toBe(1);
  });
});

describe("time verification", () => {
  const COMPLETED = "Microsoft.VSTS.Scheduling.CompletedWork";
  const REMAINING = "Microsoft.VSTS.Scheduling.RemainingWork";
  const today = () => new Date().toISOString().slice(0, 10);
  const verify = async (connection: string, query = `from=${shiftUtcDay(today(), -7)}&to=${shiftUtcDay(today(), 1)}`) =>
    (await agent.get(st(connection, `/verification?${query}`)).expect(200)).body.verification;
  const field = (id: number, name: string) => azure.workItems.get(id)!.fields[name];

  /** One ticket per status, plus an unknown number and an entry naming no ticket. */
  function seedTicketsInEveryState() {
    // #101: 4 h in Solidtime over all time (3 h a month ago, 1 h this week) = Azure's 4 h completed, 8 − 4 remaining.
    addEntry(solidtime, { start: hoursAgo(24 * 30), end: hoursAgo(24 * 30 - 3), description: "#101 Implement login" });
    addEntry(solidtime, { start: hoursAgo(6), end: hoursAgo(5), description: "#101 Implement login" });
    // #102: Azure has 1 h, Solidtime 2 h.
    azure.workItems.get(102)!.fields[COMPLETED] = 1;
    addEntry(solidtime, { start: hoursAgo(9), end: hoursAgo(7), description: "#102 Fix flaky test" });
    // #103: no Completed Work in Azure yet.
    addEntry(solidtime, { start: hoursAgo(12), end: hoursAgo(11), description: "#103 Crash on save" });
    // #104: a User Story, which has no Completed Work field.
    addEntry(solidtime, { start: hoursAgo(14), end: hoursAgo(13), description: "#104 Profile page" });
    // #106: Azure has 5 h, more than the 2 h in Solidtime.
    azure.workItems.get(106)!.fields[COMPLETED] = 5;
    addEntry(solidtime, { start: hoursAgo(18), end: hoursAgo(16), description: "#106 Waiting on vendor" });
    addEntry(solidtime, { start: hoursAgo(20), end: hoursAgo(19), description: "Fix the 404 page" });
    addEntry(solidtime, { start: hoursAgo(22), end: hoursAgo(21.5), description: "Standup" });
  }

  it("compares each ticket's all-time Solidtime total with Azure and sorts the problems first, writing nothing", async () => {
    seedTicketsInEveryState();
    const connection = await connectSolidtime(agent);
    const result = await verify(connection);

    expect(result.basis).toBe("mine");
    expect(result.items.map((item: { ticketId: number; status: string }) => [item.ticketId, item.status])).toEqual([
      [103, "missing"],
      [102, "mismatch"],
      [106, "azure-higher"],
      [104, "cannot-update"],
      [101, "matched"],
    ]);
    expect(result.counts).toEqual({ missing: 1, mismatch: 1, "azure-higher": 1, remaining: 0, running: 0, "cannot-update": 1, matched: 1 });
    expect(result.items.find((item: { ticketId: number }) => item.ticketId === 101)).toMatchObject({ periodHours: 1, trackedHours: 4, azure: { completedWork: 4, remainingWork: 4 } });
    // #103 is a Resolved bug: finished work, so its Remaining Work is not suggested.
    expect(result.items.find((item: { ticketId: number }) => item.ticketId === 103)).toMatchObject({ trackedHours: 1, suggested: { completedWork: 1, remainingWork: null }, azure: { completedWork: null } });
    expect(result.items.find((item: { ticketId: number }) => item.ticketId === 102)).toMatchObject({ trackedHours: 2, suggested: { completedWork: 2 } });
    // Closed (#104) and Resolved (#103) tickets are marked finished; active ones are not.
    const finished = (id: number) => result.items.find((item: { ticketId: number }) => item.ticketId === id).finished;
    expect([finished(104), finished(103), finished(102)]).toEqual([true, true, false]);
    expect(result.notFound).toEqual([{ ticketId: 404, periodHours: 1 }]);
    expect(result.unlinkedHours).toBe(0.5);
    expect(writeRequests(azure)).toEqual([]);
    expect(solidtimeWrites(solidtime)).toEqual([]);

    // Completed Work equal but Remaining Work out of date is its own status, not a difference in time.
    azure.workItems.get(101)!.fields[REMAINING] = 5;
    const remaining = await verify(connection, `from=${shiftUtcDay(today(), -7)}&to=${shiftUtcDay(today(), 1)}&refresh=true`);
    expect(remaining.items.find((item: { ticketId: number }) => item.ticketId === 101)).toMatchObject({
      status: "remaining",
      azure: { completedWork: 4, remainingWork: 5 },
      suggested: { completedWork: 4, remainingWork: 4 },
    });
    // Once the ticket is closed, Remaining Work is left alone: Completed Work matching is enough.
    azure.workItems.get(101)!.fields["System.State"] = "Closed";
    const closed = await verify(connection, `from=${shiftUtcDay(today(), -7)}&to=${shiftUtcDay(today(), 1)}&refresh=true`);
    expect(closed.items.find((item: { ticketId: number }) => item.ticketId === 101)).toMatchObject({ status: "matched", suggested: { completedWork: 4, remainingWork: null } });
    const box = (await agent.get(st(connection, "/tickets/101/time?refresh=true")).expect(200)).body.comparison;
    expect(box).toMatchObject({ inSync: true, remainingInSync: true, suggested: { remainingWork: null } });
    azure.workItems.get(101)!.fields["System.State"] = "Active";
    azure.workItems.get(101)!.fields[REMAINING] = 4;

    // A running timer keeps a ticket out of sync until it stops: its total is still moving.
    addEntry(solidtime, { start: hoursAgo(1), end: null, description: "#103 Crash on save" });
    const running = await verify(connection);
    expect(running.items.find((item: { ticketId: number }) => item.ticketId === 103).status).toBe("running");

    // Only tickets with time in the period are checked.
    const lastMonth = await verify(connection, `from=${shiftUtcDay(today(), -31)}&to=${shiftUtcDay(today(), -29)}`);
    expect(lastMonth.items.map((item: { ticketId: number }) => item.ticketId)).toEqual([101]);

    await agent.get(st(connection, `/verification?from=${today()}&to=${shiftUtcDay(today(), -1)}`)).expect(400);
    await agent.get(st(connection, `/verification?from=${shiftUtcDay(today(), -400)}&to=${today()}`)).expect(400);
  });

  it("compares exact minutes, not quarter hours: 40 min matches Azure's 0.66 h", async () => {
    // 40 minutes is 0.67 h; rounded to a quarter it would wrongly read 0.75 h.
    azure.workItems.get(102)!.fields[COMPLETED] = 0.66;
    addEntry(solidtime, { start: hoursAgo(3), end: hoursAgo(3 - 40 / 60), description: "#102 Fix flaky test" });
    const connection = await connectSolidtime(agent);

    const matched = (await verify(connection)).items.find((item: { ticketId: number }) => item.ticketId === 102);
    expect(matched).toMatchObject({ status: "matched", trackedHours: 0.67, azure: { completedWork: 0.66 } });
    // The Ticket time box and the work item page use the same rule.
    const box = (await agent.get(st(connection, "/tickets/102/time?refresh=true")).expect(200)).body.comparison;
    expect(box).toMatchObject({ trackedHours: 0.67, inSync: true, completedInSync: true });

    // A real difference (more than a minute) is still one, and the update writes exact hours.
    azure.workItems.get(102)!.fields[COMPLETED] = 0.5;
    const differs = (await verify(connection, `from=${shiftUtcDay(today(), -7)}&to=${shiftUtcDay(today(), 1)}&refresh=true`)).items.find((item: { ticketId: number }) => item.ticketId === 102);
    expect(differs).toMatchObject({ status: "mismatch", trackedHours: 0.67, suggested: { completedWork: 0.67 } });
  });

  it("needs a linked Azure organization, and says so when Azure cannot be read", async () => {
    const connection = await connectSolidtime(agent);
    await agent.patch(`/api/solidtime/connections/${connection}`).send({ azureCredentialId: null }).expect(200);
    const unlinked = await agent.get(st(connection, `/verification?from=${today()}&to=${today()}`)).expect(409);
    expect(unlinked.body.reason).toBe("AZURE_NOT_LINKED");

    // Linked again, but Azure fails: an error, not every ticket shown as "not found".
    await agent.patch(`/api/solidtime/connections/${connection}`).send({ azureCredentialId: credentialId }).expect(200);
    addEntry(solidtime, { start: hoursAgo(3), end: hoursAgo(2), description: "#101 Implement login" });
    server.use(http.post(/\/_apis\/wit\/workitemsbatch/, () => HttpResponse.json({ message: "down" }, { status: 503 })));
    const down = await agent.get(st(connection, `/verification?from=${today()}&to=${shiftUtcDay(today(), 1)}`)).expect(502);
    expect(down.body.reason).toBe("AZURE_UNAVAILABLE");
  });

  it("updates several tickets in one approval, never lowering Completed Work", async () => {
    seedTicketsInEveryState();
    const connection = await connectSolidtime(agent);
    const items = [
      { projectId: "Alpha", workItemId: 102, completedWork: 2 },
      { projectId: "Alpha", workItemId: 103, completedWork: 1, remainingWork: 1 },
    ];

    // Refused before anything is proposed: lowering, a type without the field, nothing to change.
    for (const [item, reason] of [
      [{ projectId: "Alpha", workItemId: 106, completedWork: 2 }, "WOULD_LOWER_COMPLETED_WORK"],
      [{ projectId: "Beta", workItemId: 104, completedWork: 1 }, "FIELD_NOT_SUPPORTED"],
      [{ projectId: "Alpha", workItemId: 101, completedWork: 4, remainingWork: 4 }, "NO_CHANGES"],
    ] as const) {
      const refused = await agent.post("/api/actions").send({ credentialId, kind: "WORK_ITEMS_UPDATE_TIME", params: { items: [item] } });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.reason).toBe(reason);
    }
    await agent.post("/api/actions").send({ credentialId, kind: "WORK_ITEMS_UPDATE_TIME", params: { items: [items[0], items[0]] } }).expect(400);

    const action = await propose(credentialId, { kind: "WORK_ITEMS_UPDATE_TIME", params: { items } });
    expect(action.summary).toBe("Update time on 2 tickets: #102, #103");
    expect(action.projectId).toBe("Alpha");
    expect(action.preview).toEqual([
      { field: "#102 Completed work (h)", before: 1, after: 2 },
      { field: "#103 Completed work (h)", before: null, after: 1 },
    ]);
    expect(writeRequests(azure)).toEqual([]);

    const approved = await approve(action);
    expect(approved.verification.verified).toBe(true);
    expect(approved.verification.checks).toEqual([
      { check: "#102: Completed Work 2 h", passed: true },
      { check: "#103: Completed Work 1 h", passed: true },
    ]);
    expect(field(102, COMPLETED)).toBe(2);
    expect(field(103, COMPLETED)).toBe(1);
    expect(field(103, REMAINING)).toBe(1);
    expect(writeRequests(azure)).toHaveLength(2);

    const after = await verify(connection, `from=${shiftUtcDay(today(), -7)}&to=${shiftUtcDay(today(), 1)}&refresh=true`);
    expect(after.counts).toMatchObject({ missing: 0, mismatch: 0, matched: 3 });

    // Only Remaining Work out of date: the batch writes that field alone.
    azure.workItems.get(101)!.fields[REMAINING] = 5;
    const remainingOnly = await propose(credentialId, { kind: "WORK_ITEMS_UPDATE_TIME", params: { items: [{ projectId: "Alpha", workItemId: 101, completedWork: 4, remainingWork: 4 }] } });
    expect(remainingOnly.preview).toEqual([{ field: "#101 Remaining work (h)", before: 5, after: 4 }]);
    await approve(remainingOnly);
    expect(field(101, REMAINING)).toBe(4);
    expect(field(101, COMPLETED)).toBe(4);
  });

  it("skips a ticket changed in Azure since the preview and writes the others; all changed is a failure", async () => {
    seedTicketsInEveryState();
    const items = [
      { projectId: "Alpha", workItemId: 102, completedWork: 2 },
      { projectId: "Alpha", workItemId: 103, completedWork: 1 },
    ];

    const partly = await propose(credentialId, { kind: "WORK_ITEMS_UPDATE_TIME", params: { items } });
    azure.workItems.get(102)!.fields[COMPLETED] = 9;
    const result = await approve(partly);
    expect(result.action.status).toBe("SUCCEEDED");
    expect(result.verification.verified).toBe(false);
    expect(result.verification.checks).toEqual([
      { check: "#102: changed in Azure DevOps since the check, not updated", passed: false },
      { check: "#103: Completed Work 1 h", passed: true },
    ]);
    expect(field(102, COMPLETED)).toBe(9);
    expect(field(103, COMPLETED)).toBe(1);

    const allStale = await propose(credentialId, { kind: "WORK_ITEMS_UPDATE_TIME", params: { items: [{ projectId: "Alpha", workItemId: 106, completedWork: 6 }] } });
    azure.workItems.get(106)!.fields[COMPLETED] = 7;
    const failed = await approve(allStale, 409);
    expect(failed.reason).toBe("ACTION_STALE");
    expect(failed.action.status).toBe("FAILED");
    expect(field(106, COMPLETED)).toBe(7);
  });
});

describe("nudges and reports", () => {
  it("adds time nudges to the dashboard's prioritized actions", async () => {
    await useAlphaRulebook();
    const connection = await connectSolidtime(agent);
    addEntry(solidtime, { start: hoursAgo(12), end: null, description: "#101 Implement login" });
    // #101 changed by me today with no time today (the running timer started yesterday or earlier today counts).
    azure.workItems.get(102)!.fields["System.ChangedDate"] = new Date().toISOString();
    azure.workItems.get(102)!.fields["System.ChangedBy"] = ME;

    const list = (await agent.get(azurePath(credentialId, "/dashboard/recommendations?category=TIME")).expect(200)).body.recommendations;
    const titles = list.items.map((item: { recommendation: { title: string } }) => item.recommendation.title);
    expect(titles).toEqual(expect.arrayContaining([expect.stringMatching(/^Timer running for 12 h/), "#102 Fix flaky test"]));
    const timer = list.items.find((item: { recommendation: { id: string } }) => item.recommendation.id === "time:timer").recommendation;
    expect(timer.target).toMatchObject({ type: "time", key: "time:timer", solidtimeCredentialId: connection });

    // Snoozing a time nudge uses its own key.
    await agent.put("/api/triage").send({ credentialId, itemKey: "time:timer", status: "ABANDONED", signals: [] }).expect(200);
  });

  it("reports estimate compliance (total time at most the estimate), a range CSV and team time in the SOP report", async () => {
    await useAlphaRulebook();
    // #101: estimate 2 h, 3 h tracked → over by 1 h.
    azure.workItems.get(101)!.fields["Microsoft.VSTS.Scheduling.OriginalEstimate"] = 2;
    addEntry(solidtime, { start: hoursAgo(5), end: hoursAgo(2), description: "#101 Implement login" });
    // #102: estimate 3 h; 1 h this week + 2 h a month ago = exactly the estimate → compliant.
    azure.workItems.get(102)!.fields["Microsoft.VSTS.Scheduling.OriginalEstimate"] = 3;
    addEntry(solidtime, { start: hoursAgo(8), end: hoursAgo(7), description: "#102 Fix flaky test" });
    addEntry(solidtime, { start: hoursAgo(24 * 30), end: hoursAgo(24 * 30 - 2), description: "#102 Fix flaky test" });
    const connection = await connectSolidtime(agent);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

    const accuracy = (await agent.get(st(connection, `/reports/accuracy?from=${weekAgo}&to=${today}`)).expect(200)).body.accuracy;
    expect(accuracy.totals).toEqual({ tickets: 2, trackedHours: 6, estimateHours: 5, withinEstimate: 1, compliance: 0.5, overEstimate: 1 });
    expect(accuracy.byTicket.items).toEqual([
      expect.objectContaining({ ticketId: 101, periodHours: 3, trackedHours: 3, estimateHours: 2, withinEstimate: false, overByHours: 1 }),
      expect.objectContaining({ ticketId: 102, periodHours: 1, trackedHours: 3, estimateHours: 3, withinEstimate: true, overByHours: 0 }),
    ]);
    expect(accuracy.byType.items).toEqual([expect.objectContaining({ label: "Task", tickets: 2, withinEstimate: 1, compliance: 0.5, overEstimate: 1 })]);

    const csv = await agent.get(st(connection, `/reports/time.csv?from=${weekAgo}&to=${today}`)).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain(`time-${weekAgo}-to-${today}.csv`);
    expect(csv.text.split("\r\n")[0]).toBe(
      '"Person","Day","Ticket","Title","Type","State","Azure project","Hours","Total tracked (h)","Original estimate (h)","Completed Work (h)","Remaining Work (h)","Within estimate","Over by (h)"'
    );
    expect(csv.text).toContain('"101","Implement login","Task","Active","Alpha","3","3","2","4","4","No","1"');
    expect(csv.text).toContain('"102","Fix flaky test","Task","Active","Alpha","1","3","3","0","","Yes","0"');
    // Only the chosen days are exported (the entry from a month ago is not a row).
    expect(csv.text.split("\r\n").filter((line) => line.includes('"102"'))).toHaveLength(1);
    await agent.get(st(connection, `/reports/time.csv?from=${today}&to=${weekAgo}`)).expect(400);

    const run = (await agent.post(`/api/sop/reports/${credentialId}/Alpha`).send({}).expect(200)).body.run;
    expect(run.timeScope).toBe("mine");
    const view = (await agent.get(`/api/sop/reports/${credentialId}/Alpha/${run.id}`).expect(200)).body.report;
    // #101 (3 h) and #102 (1 h + 2 h): the Team SOP report counts each ticket's time over the last year.
    expect(view.trackedHours).toBe(6);
  });

  it("marks the connection invalid when Solidtime rejects the token", async () => {
    const connection = await connectSolidtime(agent);
    await prisma.credential.update({ where: { id: connection }, data: { encryptedPatToken: (await import("../../src/lib/encryption.js")).encryptSecret(REVOKED_TOKEN) } });

    expect((await agent.get(st(connection, "/timer")).expect(424)).body.reason).toBe("SOLIDTIME_TOKEN_INVALID");
    expect((await prisma.credential.findUnique({ where: { id: connection } }))?.lastValidationStatus).toBe("INVALID");
  });
});
