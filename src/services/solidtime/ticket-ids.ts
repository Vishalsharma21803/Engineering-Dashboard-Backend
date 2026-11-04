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

/**
 * Whether an id is a ticket: true or false when Azure was asked, null when
 * unknown (no lookup made, or Azure unreadable).
 */
export type IsTicket = (id: number) => boolean | null;

/**
 * The ids a description's time belongs to. An id counts when Azure says it is
 * a ticket, or when that is unknown and it is written as "#123" or has at
 * least 4 digits (a bare "standup 30" is not a ticket). An id Azure says is
 * not a ticket never counts.
 */
export function ticketIdsOf(description: string | null | undefined, isTicket: IsTicket): number[] {
  if (!description) {
    return [];
  }

  const ids = new Set<number>();

  for (const match of description.matchAll(CANDIDATE)) {
    const id = Number(match[1]);
    const known = isTicket(id);

    if (known === true || (known === null && (match[0].startsWith("#") || (match[1] ?? "").length >= 4))) {
      ids.add(id);
    }
  }

  return [...ids];
}

/** An entry's seconds split equally across the tickets it names (see ticketIdsOf), so two tickets never both get the full time. */
export function shareSeconds(description: string | null | undefined, seconds: number, isTicket: IsTicket): Map<number, number> {
  const ids = ticketIdsOf(description, isTicket);
  return new Map(ids.map((id) => [id, seconds / ids.length]));
}

export function mentionsTicket(description: string | null | undefined, ticketId: number): boolean {
  return candidateTicketIds(description).includes(ticketId);
}

/** The description Cockpit writes for a ticket's timer or entry. */
export function ticketDescription(ticketId: number, title: string): string {
  return `#${ticketId} ${title}`.slice(0, 5000);
}
