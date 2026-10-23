/**
 * Proof that a human approved a specific action. AzureClient.write()
 * refuses to send anything without a live, unconsumed ticket.
 *
 * Only src/services/actions/executor.ts may call ApprovalTicket.issue;
 * tests/unit/write-guard.test.ts enforces that.
 */
const issuedTickets = new WeakSet<ApprovalTicket>();
const consumedTickets = new WeakSet<ApprovalTicket>();

export class ApprovalTicket {
  private constructor(
    readonly actionId: string,
    readonly credentialId: string
  ) {}

  static issue(actionId: string, credentialId: string): ApprovalTicket {
    const ticket = new ApprovalTicket(actionId, credentialId);
    issuedTickets.add(ticket);
    return ticket;
  }
}

export function assertTicketUsable(
  ticket: unknown,
  credentialId: string
): asserts ticket is ApprovalTicket {
  if (
    !(ticket instanceof ApprovalTicket) ||
    !issuedTickets.has(ticket) ||
    consumedTickets.has(ticket) ||
    ticket.credentialId !== credentialId
  ) {
    throw new Error("WRITE_WITHOUT_APPROVAL");
  }
}

export function consumeTicket(ticket: ApprovalTicket): void {
  consumedTickets.add(ticket);
}

/** True once write() has been attempted with this ticket. */
export function isTicketConsumed(ticket: ApprovalTicket): boolean {
  return consumedTickets.has(ticket);
}
