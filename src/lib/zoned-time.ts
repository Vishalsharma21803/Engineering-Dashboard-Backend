/** Calendar days in a time zone (IANA name) and the UTC instants that bound them. */

function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The UTC instant of local midnight starting `day` (YYYY-MM-DD) in the zone. */
export function startOfZonedDay(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, date);
  // Two passes settle the offset across daylight-saving changes.
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  instant = guess - offsetMinutes(new Date(instant), timeZone) * 60_000;
  return new Date(instant);
}

/** [start, end) of a local day in UTC. */
export function zonedDayRange(day: string, timeZone: string): { start: Date; end: Date } {
  return { start: startOfZonedDay(day, timeZone), end: startOfZonedDay(addDays(day, 1), timeZone) };
}

/** YYYY-MM-DD of an instant in the zone. */
export function zonedDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD day. */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Solidtime wants UTC without milliseconds: 2026-10-27T09:00:00Z. */
export function solidtimeTime(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}
