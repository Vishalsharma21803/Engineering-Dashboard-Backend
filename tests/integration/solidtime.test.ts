import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import type { FakeAzure } from "../support/fake-azure.js";
import { ME } from "../support/fake-azure.js";
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
    expect(mine.comparison).toMatchObject({ trackedHours: 3 });

    const times = (await agent.get(st(employee, "/ticket-times?ids=101,102")).expect(200)).body.times;
    expect(times).toEqual([expect.objectContaining({ ticketId: 101, mySeconds: 10_800 }), expect.objectContaining({ ticketId: 102, mySeconds: 0 })]);
    await agent.get(st(employee, "/ticket-times?ids=abc")).expect(400);

    const manager = await setupUser("lead@example.com");
    const managerConnection = await connectSolidtime(manager.agent, MANAGER_TOKEN);
    const team = (await manager.agent.get(st(managerConnection, "/tickets/101/time")).expect(200)).body.time;
    expect(team).toMatchObject({ mySeconds: 3600, teamSeconds: 4 * 3600 });
    expect(team.people).toEqual([
      { name: "Dev Example", seconds: 3 * 3600 },
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

    expect(draft.rows.find((row: { ticketId: number }) => row.ticketId === 103)).toMatchObject({ hours: null, activity: [expect.objectContaining({ what: "Edited Title" })] });
    await agent.get(st(connection, "/draft?day=2020-01-01")).expect(422);
    expect(solidtimeWrites(solidtime)).toEqual([]);
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

  it("reports estimate accuracy, a weekly CSV and team time in the SOP report", async () => {
    await useAlphaRulebook();
    azure.workItems.get(101)!.fields["Microsoft.VSTS.Scheduling.OriginalEstimate"] = 2;
    addEntry(solidtime, { start: hoursAgo(5), end: hoursAgo(2), description: "#101 Implement login" });
    const connection = await connectSolidtime(agent);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

    const accuracy = (await agent.get(st(connection, `/reports/accuracy?from=${weekAgo}&to=${today}`)).expect(200)).body.accuracy;
    expect(accuracy.byType.items).toEqual([expect.objectContaining({ label: "Task", tickets: 1, trackedHours: 3, estimateHours: 2, ratio: 1.5, overEstimate: 1 })]);

    const csv = await agent.get(st(connection, `/reports/weekly.csv?week=${weekAgo}`)).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain('"Me"');
    expect(csv.text).toContain('"101","Implement login","Alpha","3"');

    const run = (await agent.post(`/api/sop/reports/${credentialId}/Alpha`).send({}).expect(200)).body.run;
    expect(run.timeScope).toBe("mine");
    const view = (await agent.get(`/api/sop/reports/${credentialId}/Alpha/${run.id}`).expect(200)).body.report;
    expect(view.trackedHours).toBe(3);
  });

  it("marks the connection invalid when Solidtime rejects the token", async () => {
    const connection = await connectSolidtime(agent);
    await prisma.credential.update({ where: { id: connection }, data: { encryptedPatToken: (await import("../../src/lib/encryption.js")).encryptSecret(REVOKED_TOKEN) } });

    expect((await agent.get(st(connection, "/timer")).expect(424)).body.reason).toBe("SOLIDTIME_TOKEN_INVALID");
    expect((await prisma.credential.findUnique({ where: { id: connection } }))?.lastValidationStatus).toBe("INVALID");
  });
});
