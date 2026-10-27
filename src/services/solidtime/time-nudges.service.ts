import { addDays, isValidTimeZone, weekdayOf, zonedDay, zonedDayRange } from "../../lib/zoned-time.js";
import type { AzureIdentity, Recommendation } from "../../types/azure.types.js";
import type { WorkItemRecord } from "../azure/work-items.service.js";
import { linkedSolidtimeFor } from "./connection.service.js";
import { aggregateByDescription, entrySeconds, getActiveEntry, getMe, listEntries } from "./read.service.js";
import { candidateTicketIds } from "./ticket-ids.js";

/** After this local hour on a working day, today's total is compared with the target. */
const END_OF_DAY_HOUR = 17;
/** Closed tickets are checked for tracked time for this long after closing. */
const CLOSED_LOOKBACK_DAYS = 7;
const TIME_LOOKBACK_DAYS = 365;

const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;
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

/**
 * Time-tracking nudges for the dashboard of one Azure organization, from the
 * user's Solidtime connection linked to it. Never fails the dashboard: any
 * Solidtime problem means no nudges.
 */
export async function timeNudges(userId: string, azureCredentialId: string, identity: AzureIdentity, records: WorkItemRecord[], now = new Date()): Promise<Recommendation[]> {
  try {
    const linked = await linkedSolidtimeFor(userId, azureCredentialId, { background: true });

    if (!linked) {
      return [];
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

    const [todayEntries, previousEntries, active, lifetime] = await Promise.all([
      listEntries(client, connection.organizationId, { ...own, start: todayRange.start, end: todayRange.end }),
      listEntries(client, connection.organizationId, { ...own, start: previousRange.start, end: previousRange.end }),
      getActiveEntry(client),
      aggregateByDescription(client, connection.organizationId, { ...own, start: new Date(now.getTime() - TIME_LOOKBACK_DAYS * 86_400_000), end: now }, false),
    ]);

    const nudges: Recommendation[] = [];
    const trackedToday = new Set(todayEntries.entries.flatMap((entry) => candidateTicketIds(entry.description)));
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

    // 4. Daily total below target: the previous working day, and today after the end of the day.
    const total = (entries: typeof todayEntries.entries) => entries.reduce((sum, entry) => sum + entrySeconds(entry, now), 0);
    const target = connection.dailyTargetHours;
    const previousTotal = hours(total(previousEntries.entries));

    if (previousTotal < target) {
      nudges.push(timeNudge(link.credentialId, `time:day:${previous}`, 8, `Only ${previousTotal} h tracked on ${previous}`, `Your target is ${target} h a working day`, `TIME:DAY:${previous}`));
    }

    if (isWorkingDay(today) && localHour(now, timeZone) >= END_OF_DAY_HOUR) {
      const todayTotal = hours(total(todayEntries.entries));

      if (todayTotal < target) {
        nudges.push(timeNudge(link.credentialId, `time:day:${today}`, 9, `Only ${todayTotal} h tracked today`, `Your target is ${target} h a working day`, `TIME:DAY:${today}`));
      }
    }

    return nudges;
  } catch (error) {
    console.error("Time nudges unavailable:", error instanceof Error ? error.message : "Unknown error");
    return [];
  }
}
