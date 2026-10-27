import { describe, expect, it } from "vitest";

import { normalizeSolidtimeUrl } from "../../src/lib/solidtime/url.js";
import { addDays, startOfZonedDay, zonedDay, zonedDayRange } from "../../src/lib/zoned-time.js";
import { fitEstimates } from "../../src/services/solidtime/draft-ai.service.js";
import { chooseProject, placeEntry, projectHints, projectNameKey, sameNameProjects } from "../../src/services/solidtime/draft.service.js";
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
    expect(compareWithEstimate(time, { originalEstimate: 4, completedWork: 1, remainingWork: 3 })).toEqual({
      trackedHours: 5.25,
      estimateHours: 4,
      overEstimate: true,
      suggested: { completedWork: 5.25, remainingWork: 0 },
      inSync: false,
    });
    expect(compareWithEstimate({ ...time, teamSeconds: null }, { originalEstimate: null, completedWork: 1, remainingWork: 2 })).toMatchObject({
      trackedHours: 1,
      overEstimate: false,
      suggested: { completedWork: 1, remainingWork: 2 },
      inSync: true,
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

describe("fitting AI hours", () => {
  const item = (ticketId: number, hours: number) => ({ ticketId, hours, confidence: "medium" as const, reason: "  why\n it  " });

  it("keeps asked tickets once, in quarter hours, and never more than is available", () => {
    expect(fitEstimates([item(1, 1.1), item(2, -3), item(3, 2), item(1, 4)], [1, 2], 8)).toEqual([
      { ticketId: 1, hours: 1, confidence: "medium", reason: "why it" },
      { ticketId: 2, hours: 0, confidence: "medium", reason: "why it" },
    ]);
    const scaled = fitEstimates([item(1, 6), item(2, 30)], [1, 2], 5.5);
    expect(scaled.map((estimate) => estimate.hours)).toEqual([1.75, 3.5]);
    expect(scaled.reduce((sum, estimate) => sum + estimate.hours, 0)).toBeLessThanOrEqual(5.5);
    expect(fitEstimates([item(1, 2)], [1], 0).map((estimate) => estimate.hours)).toEqual([0]);
  });
});
