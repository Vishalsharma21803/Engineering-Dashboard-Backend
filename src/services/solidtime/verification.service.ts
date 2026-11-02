import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import type { SolidtimeClient } from "../../lib/solidtime/client.js";
import { addDays, startOfZonedDay } from "../../lib/zoned-time.js";
import type { SupportedWorkFields } from "../../types/azure.types.js";
import { getSupportedFields } from "../azure/work-items.service.js";
import type { SolidtimeConnectionDto } from "./connection.service.js";
import { aggregateByDescription } from "./read.service.js";
import { zoneOf } from "./reports.service.js";
import { candidateTicketIds } from "./ticket-ids.js";
import { compareWithEstimate, getTicketTimes } from "./ticket-time.service.js";
import { isFinished, lookUpTickets } from "./tickets.service.js";

type Connection = SolidtimeConnectionDto & { organizationId: string; memberId: string };

/**
 * Completed Work in Azure against the Solidtime total:
 * - matched: equal (and Remaining Work is what follows from it)
 * - missing: Azure has no Completed Work yet
 * - mismatch: Azure has less
 * - azure-higher: Azure has more; Cockpit never lowers it
 * - remaining: Completed Work is equal, only Remaining Work is out of date
 * - running: my timer runs on it, so the total is still moving
 * - cannot-update: the ticket type has no Completed Work field
 */
export type VerificationStatus = "missing" | "mismatch" | "azure-higher" | "remaining" | "running" | "cannot-update" | "matched";

export interface VerificationItem {
  ticketId: number;
  title: string;
  type: string;
  state: string;
  projectName: string;
  /** My time on it in the chosen period. */
  periodHours: number;
  /** Solidtime total over all time (the team's when visible, else mine), exact hours to 2 decimals. */
  trackedHours: number;
  azure: { completedWork: number | null; remainingWork: number | null; originalEstimate: number | null };
  /** What Azure would hold if it followed Solidtime. */
  suggested: { completedWork: number; remainingWork: number | null };
  status: VerificationStatus;
  /** Resolved, closed or removed: the work is done. */
  finished: boolean;
}

export interface TimeVerification {
  from: string;
  to: string;
  /** "team": totals include teammates' time; "mine": the Solidtime role sees only my own. */
  basis: "team" | "mine";
  items: VerificationItem[];
  /** Numbers in my descriptions that are not tickets in the linked organization. */
  notFound: Array<{ ticketId: number; periodHours: number }>;
  /** My time in the period whose description names no ticket. */
  unlinkedHours: number;
  counts: Record<VerificationStatus, number>;
}

/** Problems first, in the order they are worth fixing. */
const STATUS_ORDER: VerificationStatus[] = ["missing", "mismatch", "azure-higher", "remaining", "running", "cannot-update", "matched"];

const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;

/**
 * The tickets I logged time on between two days (my Solidtime time zone),
 * each with its all-time Solidtime total next to Azure's Completed Work.
 * Read-only: updating Azure is a separate, approved action.
 */
export async function verifyTime(
  client: SolidtimeClient,
  connection: Connection,
  azure: AzureClient | null,
  input: { from: string; to: string },
  now = new Date()
): Promise<TimeVerification> {
  if (!azure) {
    throw new AppError(409, "AZURE_NOT_LINKED", "Link this Solidtime connection to an Azure DevOps organization first");
  }

  const timeZone = await zoneOf(client);
  const range = { start: startOfZonedDay(input.from, timeZone), end: startOfZonedDay(addDays(input.to, 1), timeZone), memberId: connection.memberId };
  const period = await aggregateByDescription(client, connection.organizationId, range, false);
  const periodSeconds = new Map<number, number>();
  let unlinkedSeconds = 0;

  for (const group of period.grouped_data ?? []) {
    const ids = candidateTicketIds(group.key);
    if (ids.length === 0) unlinkedSeconds += group.seconds;
    for (const id of ids) periodSeconds.set(id, (periodSeconds.get(id) ?? 0) + group.seconds);
  }

  const lookup = await lookUpTickets(azure, [...periodSeconds.keys()]);

  // Without Azure every ticket would look missing; say so instead.
  if (!lookup.checked) {
    throw new AppError(502, "AZURE_UNAVAILABLE", "Azure DevOps could not be read, so the time cannot be checked. Try again.");
  }

  const ticketIds = [...lookup.tickets.keys()];
  const times = await getTicketTimes(client, connection, ticketIds, { now });
  const fieldsByType = new Map<string, Promise<SupportedWorkFields>>();
  const supportedFor = (projectName: string, type: string) => {
    const key = `${projectName}\u0000${type}`;
    if (!fieldsByType.has(key)) fieldsByType.set(key, getSupportedFields(azure, projectName, type));
    return fieldsByType.get(key)!;
  };

  const finishedByState = new Map<string, Promise<boolean>>();
  const finishedFor = (ticket: { projectName: string; type: string; state: string }) => {
    const key = `${ticket.projectName}\u0000${ticket.type}\u0000${ticket.state}`;
    if (!finishedByState.has(key)) finishedByState.set(key, isFinished(azure, ticket));
    return finishedByState.get(key)!;
  };

  const items = await Promise.all(
    ticketIds.map(async (ticketId): Promise<VerificationItem> => {
      const ticket = lookup.tickets.get(ticketId)!;
      const time = times.get(ticketId)!;
      const supported = await supportedFor(ticket.projectName, ticket.type);
      // Resolved or closed: the work is done, Remaining Work is left as it is.
      const finished = await finishedFor(ticket);
      const comparison = compareWithEstimate(time, ticket, { finished });
      const suggestedRemaining = supported.remainingWork ? comparison.suggested.remainingWork : null;
      const completed = ticket.completedWork ?? 0;
      // Within a minute counts as the same time (see compareWithEstimate).
      const remainingInSync = !supported.remainingWork || comparison.remainingInSync;
      const status: VerificationStatus = !supported.completedWork
        ? "cannot-update"
        : time.running
          ? "running"
          : comparison.completedInSync
            ? remainingInSync
              ? "matched"
              : "remaining"
            : completed > comparison.trackedHours
              ? "azure-higher"
              : completed === 0
                ? "missing"
                : "mismatch";

      return {
        ticketId,
        title: ticket.title,
        type: ticket.type,
        state: ticket.state,
        projectName: ticket.projectName,
        periodHours: hours(periodSeconds.get(ticketId) ?? 0),
        trackedHours: comparison.trackedHours,
        azure: { completedWork: ticket.completedWork, remainingWork: ticket.remainingWork, originalEstimate: ticket.originalEstimate },
        suggested: { completedWork: comparison.trackedHours, remainingWork: suggestedRemaining },
        status,
        finished,
      };
    })
  );

  items.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.ticketId - b.ticketId);

  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, items.filter((item) => item.status === status).length])) as Record<VerificationStatus, number>;
  const notFound = [...periodSeconds.entries()]
    .filter(([id]) => !lookup.tickets.has(id))
    .map(([ticketId, seconds]) => ({ ticketId, periodHours: hours(seconds) }))
    .sort((a, b) => a.ticketId - b.ticketId);
  const basis = ticketIds.some((id) => times.get(id)!.teamSeconds !== null) || (ticketIds.length === 0 && connection.canViewTeam) ? "team" : "mine";

  return { from: input.from, to: input.to, basis, items, notFound, unlinkedHours: hours(unlinkedSeconds), counts };
}
