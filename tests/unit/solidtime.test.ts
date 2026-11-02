import { describe, expect, it } from "vitest";

import { normalizeSolidtimeUrl } from "../../src/lib/solidtime/url.js";
import { addDays, startOfZonedDay, zonedDay, zonedDayRange } from "../../src/lib/zoned-time.js";
import { fitEstimates } from "../../src/services/solidtime/draft-ai.service.js";
import { activityHours, chooseProject, hoursEvidence, placeEntry, projectHints, projectNameKey, sameNameProjects } from "../../src/services/solidtime/draft.service.js";
import { candidateTicketIds, mentionsTicket, ticketDescription } from "../../src/services/solidtime/ticket-ids.js";
import { compareWithEstimate } from "../../src/services/solidtime/ticket-time.service.js";

describe("ticket ids in descriptions", () => {
  it.each([
    ["21786 - Fix login", [21786]],
    ["#21786 Fix login", [21786]],
    ["Fix login (21786)", [21786]],
    ["WI-21786 login", [21786]],
    ["21786-fix-login", [21786]],
    ["Task 101, 102 and #103", [101, 102, 103]],
    ["21786: Fix login", [21786]],
    ["Fix login #21786.", [21786]],
    ["at 10:30 on 21786", [21786]],
    ["1,500 lines", []],
    ["on 2026-10-27", []],
    ["release v1.2.3", []],
    ["abc123 and http://x/77", []],
    ["", []],
  ])("%s", (text, ids) => {
    expect(candidateTicketIds(text)).toEqual(ids);
  });

  it("matches whole numbers only and writes #ID Title", () => {
    expect(mentionsTicket("#1010 thing", 101)).toBe(false);
    expect(ticketDescription(7, "Export")).toBe("#7 Export");
  });
});

describe("Solidtime address", () => {
  it("accepts https (app or API URL) and refuses the rest", () => {
    expect(normalizeSolidtimeUrl("https://time.example.com/api/v1/")).toEqual({ ok: true, url: "https://time.example.com" });
    expect(normalizeSolidtimeUrl("https://example.com/solidtime/")).toEqual({ ok: true, url: "https://example.com/solidtime" });
    expect(normalizeSolidtimeUrl("http://time.example.com").ok).toBe(false);
    expect(normalizeSolidtimeUrl("http://localhost:8000").ok).toBe(true);
    expect(normalizeSolidtimeUrl("https://a:b@time.example.com").ok).toBe(false);
    expect(normalizeSolidtimeUrl("https://time.example.com/?x=1").ok).toBe(false);
  });
});

describe("days in a time zone", () => {
  it("finds local midnight, including across daylight saving", () => {
    expect(startOfZonedDay("2026-10-27", "Asia/Kolkata").toISOString()).toBe("2026-10-26T18:30:00.000Z");
    expect(zonedDayRange("2026-03-29", "Europe/Berlin")).toEqual({ start: new Date("2026-03-28T23:00:00Z"), end: new Date("2026-03-29T22:00:00Z") });
    expect(zonedDay(new Date("2026-10-26T19:00:00Z"), "Asia/Kolkata")).toBe("2026-10-27");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("placing drafted entries", () => {
  const day = { start: 0, end: 10 * 3_600_000 };
  const hour = 3_600_000;

  it("ends at the change, moves earlier past busy time, then uses the first gap", () => {
    expect(placeEntry([], hour, 5 * hour, day)).toEqual({ start: 4 * hour, end: 5 * hour });
    expect(placeEntry([{ start: 4.5 * hour, end: 6 * hour }], hour, 5 * hour, day)).toEqual({ start: 3.5 * hour, end: 4.5 * hour });
    expect(placeEntry([{ start: 0, end: 2 * hour }], 3 * hour, 2.5 * hour, day)).toEqual({ start: 2 * hour, end: 5 * hour });
    expect(placeEntry([{ start: 0, end: 10 * hour }], hour, 5 * hour, day)).toBeNull();
    // Whole minutes: busy time ending at 1:00:27 pushes the slot to 1:01, never seconds into it.
    expect(placeEntry([{ start: 0, end: hour + 27_000 }], hour, 1.5 * hour, day)).toEqual({ start: hour + 60_000, end: 2 * hour + 60_000 });
  });
});

describe("tracked time vs estimate", () => {
  it("uses team time when known and keeps remaining work at or above zero", () => {
    const time = { ticketId: 1, mySeconds: 3600, teamSeconds: 5 * 3600 + 600, people: null, running: false };
    // Exact time (5 h 10 min = 5.17 h), not rounded to a quarter hour.
    expect(compareWithEstimate(time, { originalEstimate: 4, completedWork: 1, remainingWork: 3 })).toEqual({
      trackedHours: 5.17,
      estimateHours: 4,
      overEstimate: true,
      suggested: { completedWork: 5.17, remainingWork: 0 },
      completedInSync: false,
      remainingInSync: false,
      inSync: false,
      basis: "team",
    });
    // Within a minute is the same time: Azure's 5.16 or 5.17 matches 5 h 10 min.
    expect(compareWithEstimate(time, { originalEstimate: 8, completedWork: 5.16, remainingWork: 2.84 })).toMatchObject({ completedInSync: true, remainingInSync: true, inSync: true });
    expect(compareWithEstimate(time, { originalEstimate: 8, completedWork: 5.1, remainingWork: 2.9 })).toMatchObject({ completedInSync: false, inSync: false });
    expect(compareWithEstimate({ ...time, teamSeconds: null }, { originalEstimate: null, completedWork: 1, remainingWork: 2 })).toMatchObject({
      trackedHours: 1,
      overEstimate: false,
      suggested: { completedWork: 1, remainingWork: 2 },
      inSync: true,
      basis: "mine",
    });
  });
});

describe("choosing a drafted row's project", () => {
  const projects = [
    { id: "p-alpha", name: "Alpha" },
    { id: "p-client", name: "Client work" },
    { id: "p-support", name: "Support" },
  ];
  const entry = (description: string, project_id: string | null, start: string) =>
    ({ id: start, description, project_id, start, end: start, duration: 0, user_id: "u", task_id: null, tags: [], billable: false }) as never;

  it("uses my mapping, then this ticket's last project, then the most used for its Azure project, then the same name", () => {
    const hints = projectHints(
      [
        entry("#70 Old", "p-client", "2026-10-01T09:00:00Z"),
        entry("#70 Newer", "p-support", "2026-10-05T09:00:00Z"),
        entry("#80 a", "p-client", "2026-10-02T09:00:00Z"),
        entry("#90 b", "p-client", "2026-10-03T09:00:00Z"),
        entry("#99 no project", null, "2026-10-04T09:00:00Z"),
      ],
      (id) => (id === 99 ? undefined : "Alpha")
    );
    expect(hints.byTicket.get(70)).toBe("p-support");
    expect(hints.byTicket.has(99)).toBe(false);
    expect(hints.byAzureProject.get("alpha")).toBe("p-client");

    expect(chooseProject(70, "Alpha", { alpha: "p-alpha" }, projects, hints)).toEqual({ id: "p-alpha", source: "mapping" });
    expect(chooseProject(70, "Alpha", {}, projects, hints)).toEqual({ id: "p-support", source: "ticket" });
    expect(chooseProject(77, "Alpha", {}, projects, hints)).toEqual({ id: "p-client", source: "azure-project" });
    expect(chooseProject(77, "Support", {}, projects, { byTicket: new Map(), byAzureProject: new Map() })).toEqual({ id: "p-support", source: "name" });
    // A mapped or remembered project that no longer exists is skipped.
    expect(chooseProject(77, "Gamma", { gamma: "p-gone" }, projects, { byTicket: new Map([[77, "p-gone"]]), byAzureProject: new Map() })).toBeNull();
  });
});

describe("matching project names", () => {
  it("ignores case, spaces, dashes, underscores and dots, but needs the full name", () => {
    for (const name of ["Engineer Cockpit", "engineer-cockpit", "ENGINEER_COCKPIT", " Engineer – Cockpit ", "Engineer.Cockpit", "EngineerCockpit"]) {
      expect(projectNameKey(name)).toBe("engineercockpit");
    }
    const projects = [
      { id: "a", name: "Engineer-Cockpit" },
      { id: "b", name: "Sifars - Engineer Cockpit" },
      { id: "c", name: "Cockpit" },
    ];
    expect(sameNameProjects("engineer cockpit", projects).map((project) => project.id)).toEqual(["a"]);
    expect(sameNameProjects("Engineer", projects)).toEqual([]);
    expect(sameNameProjects("---", projects)).toEqual([]);

    const none = { byTicket: new Map<number, string>(), byAzureProject: new Map<string, string>() };
    expect(chooseProject(70, "Engineer cockpit", {}, projects, none)).toEqual({ id: "a", source: "name" });
    // Two projects with the same name: no guess.
    expect(chooseProject(70, "Engineer cockpit", {}, [...projects, { id: "d", name: "engineer_cockpit" }], none)).toBeNull();
  });
});

describe("hours from evidence", () => {
  const H = 3_600_000;
  const t = (hours: number) => hours * H;

  it("credits the time before each of my changes to that change's ticket, gaps at most 2 h, without tracked time", () => {
    const hours = activityHours(
      [
        { ticketId: 1, at: t(9) },
        { ticketId: 1, at: t(10.5) },
        // After lunch: a 3 h gap counts 2 h.
        { ticketId: 2, at: t(13.5) },
        // 1 h before, but 30 min of it is a Solidtime entry (a meeting).
        { ticketId: 3, at: t(14.5) },
      ],
      [{ start: t(13.5), end: t(14) }]
    );
    expect(Object.fromEntries(hours)).toEqual({ 1: 1.5, 2: 2, 3: 0.5 });
    // An entry and a running timer over the same half hour leave it out once, not twice.
    expect(Object.fromEntries(activityHours([{ ticketId: 1, at: t(9) }, { ticketId: 2, at: t(10) }], [{ start: t(9), end: t(9.5) }, { start: t(9.25), end: t(9.5) }]))).toEqual({ 1: 0.25, 2: 0.5 });
    // The day's first change is measured from my first Solidtime entry (08:00 standup, 30 min of it busy): 1 h.
    expect(Object.fromEntries(activityHours([{ ticketId: 4, at: t(9.5) }], [{ start: t(8), end: t(8.5) }]))).toEqual({ 4: 1 });
    // A lone change still counts a little; same input, same hours.
    expect(Object.fromEntries(activityHours([{ ticketId: 7, at: t(9) }], []))).toEqual({ 7: 0.25 });
  });

  it("uses the strongest evidence: Completed Work, then Remaining Work, then activity capped by Remaining Work", () => {
    const clock = (at: string) => at.slice(11, 16);
    const activity = [
      { at: "2026-11-02T09:00:00Z", what: "Commented" },
      { at: "2026-11-02T11:00:00Z", what: "State Active → Resolved" },
    ];
    expect(hoursEvidence({ remainingThatDay: 1, activity, added: 3, lowered: 2 }, 5, clock)).toEqual({ hours: 3, source: "completed-work", basis: "Completed Work raised by 3 h" });
    expect(hoursEvidence({ remainingThatDay: 1, activity, added: 0, lowered: 2 }, 5, clock)).toEqual({ hours: 2, source: "remaining-work", basis: "Remaining Work lowered by 2 h" });
    expect(hoursEvidence({ remainingThatDay: 1, activity, added: 0, lowered: 0 }, 2.1, clock)).toEqual({
      hours: 1,
      source: "activity",
      basis: "2 changes between 09:00 and 11:00, capped at its 1 h Remaining Work",
    });
    // Lowering 40 h to 0 when closing is not 40 h of work in a day.
    expect(hoursEvidence({ remainingThatDay: 0, activity, added: 0, lowered: 40 }, 1, clock)).toEqual({ hours: 12, source: "remaining-work", basis: "Remaining Work lowered by 40 h, counted as 12 h at most" });
    // No Remaining Work (or 0): no cap.
    expect(hoursEvidence({ remainingThatDay: 0, activity: activity.slice(0, 1), added: 0, lowered: 0 }, 2.1, clock)).toEqual({ hours: 2, source: "activity", basis: "1 change at 09:00" });
  });
});

describe("fitting AI hours", () => {
  const item = (ticketId: number, hours: number) => ({ ticketId, hours, confidence: "medium" as const, reason: "  why\n it  " });

  it("keeps asked tickets once, in quarter hours, within half to one and a half times the rule hours", () => {
    const rules = new Map([
      [1, 2],
      [2, 1],
      [3, 0.25],
    ]);
    expect(fitEstimates([item(1, 1.1), item(2, 30), item(9, 2), item(1, 4), item(3, 0)], rules)).toEqual([
      { ticketId: 1, ruleHours: 2, hours: 1, confidence: "medium", reason: "why it" },
      { ticketId: 2, ruleHours: 1, hours: 1.5, confidence: "medium", reason: "why it" },
      { ticketId: 3, ruleHours: 0.25, hours: 0.25, confidence: "medium", reason: "why it" },
    ]);
    // Nothing is scaled to fill a target, and 12 h per ticket is the most.
    expect(fitEstimates([item(1, 20)], new Map([[1, 10]])).map((estimate) => estimate.hours)).toEqual([12]);
  });
});

