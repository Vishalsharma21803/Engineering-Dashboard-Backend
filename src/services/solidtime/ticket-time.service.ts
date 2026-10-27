import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import type { SolidtimeAggregate } from "../../lib/solidtime/types.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { aggregateByDescription, getActiveEntry, listMembers } from "./read.service.js";
import { candidateTicketIds } from "./ticket-ids.js";
import type { TicketInfo } from "./tickets.service.js";

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
  options: { since: Date; now?: Date; withPeople?: boolean }
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
    const members = await listMembers(client, connection.organizationId).catch(() => []);
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

const roundQuarter = (hours: number) => Math.round(hours * 4) / 4;

export interface TimeVsEstimate {
  trackedHours: number;
  estimateHours: number | null;
  /** Tracked time passed the Azure original estimate. */
  overEstimate: boolean;
  /** What Azure's time fields would be if they followed Solidtime (hours, quarter-hour steps). */
  suggested: { completedWork: number; remainingWork: number | null };
  /** Azure already matches the suggestion. */
  inSync: boolean;
}

/**
 * Solidtime is the source of truth for hours: Completed Work = tracked time,
 * Remaining Work = estimate minus tracked (never below zero; kept when there is
 * no estimate). Uses the team total when known, otherwise mine.
 */
export function compareWithEstimate(time: TicketTime, ticket: Pick<TicketInfo, "originalEstimate" | "completedWork" | "remainingWork">): TimeVsEstimate {
  const trackedHours = roundQuarter((time.teamSeconds ?? time.mySeconds) / 3600);
  const estimate = ticket.originalEstimate;
  const remaining = estimate === null ? ticket.remainingWork : Math.max(0, roundQuarter(estimate - trackedHours));

  return {
    trackedHours,
    estimateHours: estimate,
    overEstimate: estimate !== null && trackedHours > estimate,
    suggested: { completedWork: trackedHours, remainingWork: remaining },
    inSync: (ticket.completedWork ?? 0) === trackedHours && (remaining === null || (ticket.remainingWork ?? null) === remaining),
  };
}
