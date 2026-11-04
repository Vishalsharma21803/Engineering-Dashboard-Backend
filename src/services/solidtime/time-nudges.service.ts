import { addDays, isValidTimeZone, weekdayOf, zonedDay, zonedDayRange } from "../../lib/zoned-time.js";
import type { AzureIdentity, Recommendation } from "../../types/azure.types.js";
import type { WorkItemRecord } from "../azure/work-items.service.js";
import { linkedSolidtimeFor } from "./connection.service.js";
import type { SolidtimeTimeEntry } from "../../lib/solidtime/types.js";
import { aggregateByDescription, entrySeconds, getActiveEntry, getMe, listEntries, overlapsRange, secondsWithin } from "./read.service.js";
import { candidateTicketIds } from "./ticket-ids.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";

/** After this local hour on a working day, today's total is compared with the target. */
const END_OF_DAY_HOUR = 17;
/** Closed tickets are checked for tracked time for this long after closing. */
const CLOSED_LOOKBACK_DAYS = 7;
const TIME_LOOKBACK_DAYS = 365;

const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;
const DAY_MS = 86_400_000;

/** A day's range widened to the 24 h before it, so an entry started the evening before is read too (its part of the day counts). */
const withEveningBefore = (range: { start: Date; end: Date }) => ({ start: new Date(range.start.getTime() - DAY_MS), end: range.end });
const isWorkingDay = (day: string) => weekdayOf(day) !== 0 && weekdayOf(day) !== 6;

function previousWorkingDay(day: string): string {
  let candidate = addDays(day, -1);
  while (!isWorkingDay(candidate)) candidate = addDays(candidate, -1);
  return candidate;
}

function localHour(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" }).format(at));
}

function ticketNudge(workItem: WorkItemRecord["summary"], suffix: string, score: number, reason: string, signal: string): Recommendation {
  return {
    id: `time:wi:${workItem.id}:${suffix}`,
    score,
    category: "TIME",
    title: `#${workItem.id} ${workItem.title}`,
    reasons: [reason],
    signals: [signal],
    target: { type: "workItem", projectName: workItem.projectName, id: workItem.id, webUrl: workItem.webUrl },
    suggestedAction: null,
  };
}

function timeNudge(credentialId: string, key: string, score: number, title: string, reason: string, signal: string): Recommendation {
  return {
    id: key,
    score,
    category: "TIME",
    title,
    reasons: [reason],
    signals: [signal],
    target: { type: "time", projectName: "", id: 0, key, solidtimeCredentialId: credentialId, webUrl: null },
    suggestedAction: null,
  };
}

/** "Mon, Oct 26" for a YYYY-MM-DD day (the day itself, not shifted by any time zone). */
function readableDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, date)));
}

export interface TimeCheck {
  nudges: Recommendation[];
  /** Solidtime was read: a reminder missing from `nudges` is really gone (not just unknown). */
  ok: boolean;
  /** Tickets with any time tracked on them in the last year. */
  trackedEver: Set<number>;
  /** True when `nudges` speaks for this key (a missing one is fixed); other day reminders need `recheck`. */
  covers: (key: string) => boolean;
  /**
   * For day reminders (time:day:<day>, time:wi:<id>:untracked:<day>): the keys whose cause is
   * fixed now (the day reached the target, or time names the ticket that day). Null when Solidtime could not be read.
   */
  recheck: (keys: string[]) => Promise<Set<string> | null>;
}

const NOT_READ: TimeCheck = { nudges: [], ok: false, trackedEver: new Set(), covers: () => false, recheck: async () => null };
const DAY_KEY = /^time:day:(\d{4}-\d{2}-\d{2})$/;
const UNTRACKED_KEY = /^time:wi:(\d+):untracked:(\d{4}-\d{2}-\d{2})$/;

/**
 * Time-tracking nudges for the dashboard of one Azure organization, from the
 * user's Solidtime connection linked to it. Never fails the dashboard: any
 * Solidtime problem means no nudges (and `ok: false`).
 */
export async function timeNudges(userId: string, azureCredentialId: string, identity: AzureIdentity, records: WorkItemRecord[], now = new Date()): Promise<TimeCheck> {
  try {
    const linked = await linkedSolidtimeFor(userId, azureCredentialId, { background: true });

    if (!linked) {
      return NOT_READ;
    }

    const { client, connection } = linked;
    const link = { credentialId: connection.credentialId };

    const zone = (await getMe(client)).timezone;
    const timeZone = zone && isValidTimeZone(zone) ? zone : "UTC";
    const today = zonedDay(now, timeZone);
    const todayRange = zonedDayRange(today, timeZone);
    const previous = previousWorkingDay(today);
    const previousRange = zonedDayRange(previous, timeZone);
    const own = { memberId: connection.memberId };

    const [todayRead, previousRead, active, lifetime] = await Promise.all([
      listEntries(client, connection.organizationId, { ...own, ...withEveningBefore(todayRange) }),
      listEntries(client, connection.organizationId, { ...own, ...withEveningBefore(previousRange) }),
      getActiveEntry(client),
      aggregateByDescription(client, connection.organizationId, { ...own, start: new Date(now.getTime() - TIME_LOOKBACK_DAYS * 86_400_000), end: now }, false),
    ]);
    // A day's entries are those with time inside it, including my running timer even when it started before.
    const inDay = (entries: SolidtimeTimeEntry[], range: { start: Date; end: Date }) =>
      [...entries, ...(active && !entries.some((entry) => entry.id === active.id) ? [active] : [])].filter((entry) => overlapsRange(entry, range, now));
    const todayEntries = inDay(todayRead.entries, todayRange);
    const previousEntries = inDay(previousRead.entries, previousRange);

    const nudges: Recommendation[] = [];
    const trackedToday = new Set(todayEntries.flatMap((entry) => candidateTicketIds(entry.description)));
    const trackedEver = new Set((lifetime.grouped_data ?? []).filter((group) => group.seconds > 0).flatMap((group) => candidateTicketIds(group.key)));
    const changedByMe = (record: WorkItemRecord) => {
      const changedBy = record.raw.fields["System.ChangedBy"] as { id?: string; uniqueName?: string } | undefined;
      return Boolean(changedBy && (changedBy.id === identity.id || (identity.email && changedBy.uniqueName?.toLowerCase() === identity.email.toLowerCase())));
    };

    for (const record of records) {
      const item = record.summary;
      const changedToday = item.changedDate !== null && zonedDay(new Date(item.changedDate), timeZone) === today;

      // 1. I changed it today, and no time today names it.
      if (changedToday && changedByMe(record) && !trackedToday.has(item.id) && item.stateCategory !== "Removed") {
        nudges.push(ticketNudge(item, `untracked:${today}`, 15, "You worked on this today but tracked no time on it", `TIME:UNTRACKED:${today}`));
      }

      // 3. Closed recently with no time ever tracked on it.
      const closedRecently = item.stateCategory === "Completed" && item.closedDate !== null && now.getTime() - Date.parse(item.closedDate) <= CLOSED_LOOKBACK_DAYS * 86_400_000;

      if (closedRecently && !trackedEver.has(item.id)) {
        nudges.push(ticketNudge(item, "closed-no-time", 10, "Closed with no time tracked", "TIME:CLOSED_NO_TIME"));
      }
    }

    // 2. A timer that has been running too long.
    if (active) {
      const runningHours = entrySeconds(active, now) / 3600;

      if (runningHours >= connection.timerAlertHours) {
        nudges.push(
          timeNudge(
            link.credentialId,
            "time:timer",
            25,
            `Timer running for ${Math.floor(runningHours)} h: ${active.description ?? "(no description)"}`.slice(0, 200),
            `Started ${active.start}; stop it or correct its time`,
            `TIME:TIMER:${active.id}`
          )
        );
      }
    }

    // 4. Daily total below target: the previous working day, and today after the end of the day. Only time inside the day counts.
    const total = (entries: SolidtimeTimeEntry[], range: { start: Date; end: Date }) => entries.reduce((sum, entry) => sum + secondsWithin(entry, range, now), 0);
    const target = connection.dailyTargetHours;
    const previousTotal = hours(total(previousEntries, previousRange));

    if (previousTotal < target) {
      nudges.push(timeNudge(link.credentialId, `time:day:${previous}`, 8, `Only ${previousTotal} h tracked on ${readableDay(previous)}`, `Your target is ${target} h a working day`, `TIME:DAY:${previous}`));
    }

    if (isWorkingDay(today) && localHour(now, timeZone) >= END_OF_DAY_HOUR) {
      const todayTotal = hours(total(todayEntries, todayRange));

      if (todayTotal < target) {
        nudges.push(timeNudge(link.credentialId, `time:day:${today}`, 9, `Only ${todayTotal} h tracked today`, `Your target is ${target} h a working day`, `TIME:DAY:${today}`));
      }
    }

    const recheck = async (keys: string[]): Promise<Set<string> | null> => {
      const days = keys.flatMap((key) => {
        const match = DAY_KEY.exec(key) ?? UNTRACKED_KEY.exec(key);
        return match ? [match[match.length - 1]!] : [];
      });

      if (days.length === 0) {
        return new Set();
      }

      try {
        // One small read per day (a reminder's day may be weeks back; no long ranges).
        const byDay = new Map<string, SolidtimeTimeEntry[]>();
        const limit = createLimiter(3);
        await mapWithLimit([...new Set(days)], limit, async (day) => {
          try {
            // Clipped like the reminders themselves, so a reminder never flaps between the two.
            const range = zonedDayRange(day, timeZone);
            const read = await listEntries(client, connection.organizationId, { ...own, ...withEveningBefore(range) });
            // A cut-off day cannot prove it is still short (or that the ticket has no time): it is left as it is.
            if (!read.truncated) byDay.set(day, inDay(read.entries, range));
          } catch (error) {
            // One day that cannot be read is left as it is; the others are still checked.
            console.error(`Re-checking time on ${day} failed:`, error instanceof Error ? error.message : "Unknown error");
          }
        });

        const fixed = new Set<string>();

        for (const key of keys) {
          const dayMatch = DAY_KEY.exec(key);
          const untrackedMatch = UNTRACKED_KEY.exec(key);
          const day = dayMatch?.[1] ?? untrackedMatch?.[2];
          const entries = day ? byDay.get(day) : undefined;

          if (!entries) continue;

          if (dayMatch && day && hours(total(entries, zonedDayRange(day, timeZone))) >= target) {
            fixed.add(key);
          } else if (untrackedMatch && entries.some((entry) => candidateTicketIds(entry.description).includes(Number(untrackedMatch[1])))) {
            fixed.add(key);
          }
        }

        return fixed;
      } catch (error) {
        console.error("Re-checking older time reminders failed:", error instanceof Error ? error.message : "Unknown error");
        return null;
      }
    };

    // The timer, the previous working day, today after the end of the day, and today's untracked tickets are read above.
    const covered = new Set(["time:timer", `time:day:${previous}`, ...(isWorkingDay(today) && localHour(now, timeZone) >= END_OF_DAY_HOUR ? [`time:day:${today}`] : [])]);
    const covers = (key: string) => covered.has(key) || UNTRACKED_KEY.exec(key)?.[2] === today;

    return { nudges, ok: true, trackedEver, covers, recheck };
  } catch (error) {
    console.error("Time nudges unavailable:", error instanceof Error ? error.message : "Unknown error");
    return NOT_READ;
  }
}
