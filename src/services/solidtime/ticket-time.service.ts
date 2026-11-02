import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import type { SolidtimeAggregate } from "../../lib/solidtime/types.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { aggregateByDescription, getActiveEntry, listMembers } from "./read.service.js";
import { candidateTicketIds } from "./ticket-ids.js";
import type { TicketInfo } from "./tickets.service.js";
import { fallbackTo } from "../../lib/log-fallback.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

/** Lists look back this far for time on a ticket (one Solidtime call covers them all). */
export const TICKET_LOOKBACK_DAYS = 365;

export interface TicketTime {
  ticketId: number;
  /** Seconds, including a running timer up to now. */
  mySeconds: number;
  /** Null when the Solidtime role cannot see other people's time. */
  teamSeconds: number | null;
  people: Array<{ name: string; seconds: number }> | null;
  /** My timer is running on this ticket right now. */
  running: boolean;
}

/** Seconds per ticket id from a by-description aggregate (a description naming two tickets counts for both). */
function secondsByTicket(aggregate: SolidtimeAggregate, wanted: Set<number>): Map<number, number> {
  const totals = new Map<number, number>();

  for (const group of aggregate.grouped_data ?? []) {
    for (const id of candidateTicketIds(group.key)) {
      if (wanted.has(id)) {
        totals.set(id, (totals.get(id) ?? 0) + group.seconds);
      }
    }
  }

  return totals;
}

function peopleByTicket(aggregate: SolidtimeAggregate, wanted: Set<number>, names: Map<string, string>): Map<number, Map<string, number>> {
  const result = new Map<number, Map<string, number>>();

  for (const group of aggregate.grouped_data ?? []) {
    for (const id of candidateTicketIds(group.key)) {
      if (!wanted.has(id)) continue;
      const people = result.get(id) ?? new Map<string, number>();

      for (const person of group.grouped_data ?? []) {
        const name = (person.key && names.get(person.key)) ?? "Someone";
        people.set(name, (people.get(name) ?? 0) + person.seconds);
      }

      result.set(id, people);
    }
  }

  return result;
}

/**
 * Time tracked on these tickets, read live from Solidtime: mine always, the
 * team's only when the role can see everyone's time. Matching is by the ticket
 * id written in the entry description.
 */
export async function getTicketTimes(
  client: SolidtimeClient,
  connection: Connection,
  ticketIds: number[],
  /** `since` omitted: all time. */
  options: { since?: Date; now?: Date; withPeople?: boolean }
): Promise<Map<number, TicketTime>> {
  const now = options.now ?? new Date();
  const wanted = new Set(ticketIds);
  const range = { start: options.since, end: now };

  const [mine, active, team] = await Promise.all([
    aggregateByDescription(client, connection.organizationId, { ...range, memberId: connection.memberId }, false),
    getActiveEntry(client),
    connection.canViewTeam ? aggregateByDescription(client, connection.organizationId, range, Boolean(options.withPeople)).catch(forbiddenAsNull) : Promise.resolve(null),
  ]);

  const myTotals = secondsByTicket(mine, wanted);
  const teamTotals = team ? secondsByTicket(team, wanted) : null;
  let people: Map<number, Map<string, number>> | null = null;

  if (team && options.withPeople) {
    const members = await listMembers(client, connection.organizationId).catch(fallbackTo("Reading Solidtime member names failed", []));
    people = peopleByTicket(team, wanted, new Map(members.map((member) => [member.user_id, member.name])));
  }

  const runningIds = new Set(active ? candidateTicketIds(active.description) : []);

  return new Map(
    ticketIds.map((id) => [
      id,
      {
        ticketId: id,
        mySeconds: myTotals.get(id) ?? 0,
        teamSeconds: teamTotals ? (teamTotals.get(id) ?? 0) : null,
        people: people ? [...(people.get(id) ?? new Map<string, number>()).entries()].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds) : null,
        running: runningIds.has(id),
      },
    ])
  );
}

function forbiddenAsNull(error: unknown): null {
  // The role changed in Solidtime since it was stored: fall back to own time only.
  if (error instanceof SolidtimeApiError && error.solidtimeReason === "SOLIDTIME_FORBIDDEN") {
    return null;
  }

  throw error;
}

const roundHours = (hours: number) => Math.round(hours * 100) / 100;

/** Hours that differ by at most a minute are the same time: 40 min is 0.67 h, and Azure may hold 0.66 or 0.67. */
export const SAME_TIME_HOURS = 1 / 60;

export function sameHours(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_TIME_HOURS + 1e-9;
}

export interface TimeVsEstimate {
  /** Exact tracked time, in hours to 2 decimals. */
  trackedHours: number;
  estimateHours: number | null;
  /** Tracked time passed the Azure original estimate. */
  overEstimate: boolean;
  /** What Azure's time fields would be if they followed Solidtime (hours, 2 decimals). */
  suggested: { completedWork: number; remainingWork: number | null };
  /** Azure's Completed Work is the tracked time (within a minute). */
  completedInSync: boolean;
  /** Azure's Remaining Work is what follows from it (or there is no estimate to follow). */
  remainingInSync: boolean;
  /** Both of the above. */
  inSync: boolean;
  /** "team": everyone's time on the ticket; "mine": only my own (my Solidtime role cannot read others'). */
  basis: "team" | "mine";
}

/**
 * Solidtime is the source of truth for hours: Completed Work = tracked time,
 * Remaining Work = estimate minus tracked (never below zero; kept when there is
 * no estimate). Uses the team total when known, otherwise mine. Times are
 * exact; Azure matches when it is within a minute of them. A finished ticket
 * (resolved, closed or removed) keeps its Remaining Work: work may have ended
 * before the estimate ran out.
 */
export function compareWithEstimate(
  time: TicketTime,
  ticket: Pick<TicketInfo, "originalEstimate" | "completedWork" | "remainingWork">,
  options: { finished?: boolean } = {}
): TimeVsEstimate {
  const exactHours = (time.teamSeconds ?? time.mySeconds) / 3600;
  const trackedHours = roundHours(exactHours);
  const estimate = ticket.originalEstimate;
  const exactRemaining = estimate === null || options.finished ? null : Math.max(0, estimate - exactHours);
  const remaining = options.finished ? null : exactRemaining === null ? ticket.remainingWork : roundHours(exactRemaining);
  const completedInSync = sameHours(ticket.completedWork ?? 0, exactHours);
  const remainingInSync = exactRemaining === null || (ticket.remainingWork !== null && sameHours(ticket.remainingWork, exactRemaining));

  return {
    trackedHours,
    estimateHours: estimate,
    overEstimate: estimate !== null && exactHours > estimate + SAME_TIME_HOURS,
    suggested: { completedWork: trackedHours, remainingWork: remaining },
    completedInSync,
    remainingInSync,
    inSync: completedInSync && remainingInSync,
    basis: time.teamSeconds === null ? "mine" : "team",
  };
}
