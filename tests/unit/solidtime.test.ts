import { describe, expect, it } from "vitest";

import { normalizeSolidtimeUrl } from "../../src/lib/solidtime/url.js";
import { addDays, startOfZonedDay, zonedDay, zonedDayRange } from "../../src/lib/zoned-time.js";
import { placeEntry } from "../../src/services/solidtime/draft.service.js";
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
