import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { logFallback } from "../../lib/log-fallback.js";
import type { StateCategory } from "../../types/azure.types.js";
import { getWorkItemsByIds, getWorkItemTypeStates, WORK_ITEM_FIELDS, workItemProjectName, workItemType } from "../azure/work-items.service.js";
import { createAzureClientForCredential } from "../azure/azure-context.service.js";

/** What Cockpit shows about an Azure ticket next to Solidtime time. */
export interface TicketInfo {
  id: number;
  title: string;
  type: string;
  state: string;
  projectName: string;
  originalEstimate: number | null;
  completedWork: number | null;
  remainingWork: number | null;
}

const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The linked Azure organization, or null when none is linked (time then shows without ticket titles). */
export async function linkedAzureClient(userId: string, azureCredentialId: string | null, options: { refresh?: boolean } = {}): Promise<AzureClient | null> {
  return azureCredentialId ? createAzureClientForCredential(userId, azureCredentialId, options) : null;
}

export interface TicketLookup {
  tickets: Map<number, TicketInfo>;
  /** False when no Azure organization is linked or Azure could not be read: ids are then not checked. */
  checked: boolean;
}

/** Looks the ids up in Azure; only ids that are real tickets come back. */
export async function lookUpTickets(azure: AzureClient | null, ids: number[]): Promise<TicketLookup> {
  const unique = [...new Set(ids)].filter((id) => id > 0);

  if (!azure) {
    return { tickets: new Map(), checked: false };
  }

  if (unique.length === 0) {
    return { tickets: new Map(), checked: true };
  }

  try {
    const raws = await getWorkItemsByIds(azure, unique);
    const tickets = new Map(
      raws.map((raw) => [
        raw.id,
        {
          id: raw.id,
          title: typeof raw.fields[WORK_ITEM_FIELDS.title] === "string" ? (raw.fields[WORK_ITEM_FIELDS.title] as string) : "(untitled)",
          type: workItemType(raw),
          state: typeof raw.fields[WORK_ITEM_FIELDS.state] === "string" ? (raw.fields[WORK_ITEM_FIELDS.state] as string) : "",
          projectName: workItemProjectName(raw),
          originalEstimate: asNumber(raw.fields[WORK_ITEM_FIELDS.originalEstimate]),
          completedWork: asNumber(raw.fields[WORK_ITEM_FIELDS.completedWork]),
          remainingWork: asNumber(raw.fields[WORK_ITEM_FIELDS.remainingWork]),
        },
      ])
    );

    return { tickets, checked: true };
  } catch (error) {
    // Without Azure the time still shows; only ticket titles and validation are missing.
    if (error instanceof AzureApiError) {
      logFallback(`Reading ${unique.length} Azure ticket(s) failed`, error);
      return { tickets: new Map(), checked: false };
    }

    throw error;
  }
}

/** States where the work is done: Remaining Work is then left as it is. */
const FINISHED_CATEGORIES: StateCategory[] = ["Resolved", "Completed", "Removed"];

/** Whether the ticket's state is resolved, closed or removed. Unknown (Azure unreadable) counts as open. */
export async function isFinished(azure: AzureClient, ticket: Pick<TicketInfo, "projectName" | "type" | "state">): Promise<boolean> {
  try {
    const states = await getWorkItemTypeStates(azure, ticket.projectName, ticket.type);
    const category = states.find((state) => state.name === ticket.state)?.category;
    return category !== undefined && FINISHED_CATEGORIES.includes(category);
  } catch (error) {
    if (error instanceof AzureApiError) {
      logFallback(`Reading the states of ${ticket.type} in ${ticket.projectName} failed; the ticket counts as open`, error);
      return false;
    }
    throw error;
  }
}
