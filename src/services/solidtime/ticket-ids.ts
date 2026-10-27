/**
 * Ticket ids in time entry descriptions. People mostly write the ticket title
 * with its number somewhere in it ("21786 - Fix login", "#21786 Fix login",
 * "Fix login (21786)", "21786: Fix", "… #21786."). A standalone number counts;
 * numbers inside versions, dates, times, thousands or words do not (v1.2.3,
 * 2026-10-27, 10:30, 1,500, abc123). Callers then keep only
 * numbers that are real Azure tickets.
 */
const CANDIDATE = /(?<![\w.\/:])(?<!\d[-,])#?(\d{2,9})(?![\w\/])(?![.:,-]\d)/g;

export function candidateTicketIds(description: string | null | undefined): number[] {
  if (!description) {
    return [];
  }

  const ids = [...description.matchAll(CANDIDATE)].map((match) => Number(match[1]));
  return [...new Set(ids)];
}

export function mentionsTicket(description: string | null | undefined, ticketId: number): boolean {
  return candidateTicketIds(description).includes(ticketId);
}

/** The description Cockpit writes for a ticket's timer or entry. */
export function ticketDescription(ticketId: number, title: string): string {
  return `#${ticketId} ${title}`.slice(0, 5000);
}
