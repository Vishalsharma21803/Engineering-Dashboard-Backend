import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { logFallback } from "../../lib/log-fallback.js";
import type { GroupHeading, WorkItemSummary } from "../../types/azure.types.js";
import { getWorkItemsByIds, toWorkItemSummaries } from "../azure/work-items.service.js";

/**
 * Types that hold other work (Azure's backlog levels): they head a group, and
 * the tasks and bugs under them are listed below. Process names differ
 * (Agile, Scrum, CMMI, Basic), so all of them are here.
 */
const BACKLOG_TYPES = new Set(["user story", "product backlog item", "requirement", "issue", "feature", "epic"]);

/** One group: a heading (null for a ticket under no story) and the listed tickets under it, newest change first. */
export interface WorkItemGroup<T> {
  heading: GroupHeading | null;
  /** The heading ticket's own row, when it is one of the listed tickets (e.g. my own story). */
  headingRow: T | null;
  rows: T[];
  /** The newest change to the group's listed tickets (the heading's own when nothing is under it): what the list is sorted by. */
  latest: string | null;
}

const changed = (item: WorkItemSummary) => (item.changedDate ? Date.parse(item.changedDate) || 0 : 0);
const newestFirst = (a: WorkItemSummary, b: WorkItemSummary) => changed(b) - changed(a) || b.id - a.id;

export type { GroupHeading };

function isBacklogType(type: string): boolean {
  return BACKLOG_TYPES.has(type.trim().toLowerCase());
}

/** A parent Azure did not return (deleted, or no access): only its number is known. */
export function unreadableHeading(id: number): GroupHeading {
  return { id, title: "", type: "", state: "", stateCategory: "Unknown", projectName: "", assignedTo: null, changedDate: null, readable: false };
}

export function toHeading(item: WorkItemSummary): GroupHeading {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    state: item.state,
    stateCategory: item.stateCategory,
    projectName: item.projectName,
    // Name only: other people's details stay out of my lists.
    assignedTo: item.assignedTo ? { id: item.assignedTo.id, displayName: item.assignedTo.displayName, uniqueName: null } : null,
    changedDate: item.changedDate,
    readable: true,
  };
}

interface GroupDraft {
  headingId: number | null;
  headingItem: WorkItemSummary | null;
  children: WorkItemSummary[];
  latest: number;
  key: string;
}

/**
 * Groups listed tickets like Azure's backlog: a story (or feature, PBI…) on
 * top with the listed tasks and bugs under it. A listed backlog item heads its
 * own group; a task or bug goes under its parent; one with no parent is its
 * own group without a heading. All groups are ordered by the newest change
 * to their listed tickets under the heading (the heading's own edits count
 * only when nothing is under it), newest first, so what changed last is on
 * top whether it is under a story or not. Rows inside too.
 */
export function groupWorkItems(items: WorkItemSummary[]): GroupDraft[] {
  const listed = new Map(items.map((item) => [item.id, item]));
  const hasListedChildren = (item: WorkItemSummary) => item.links.childIds.some((id) => listed.has(id));
  const heads = (item: WorkItemSummary) => isBacklogType(item.type) || hasListedChildren(item);
  const groups = new Map<string, GroupDraft>();
  const group = (key: string, headingId: number | null, headingItem: WorkItemSummary | null): GroupDraft => {
    const existing = groups.get(key);
    if (existing) return existing;
    const created: GroupDraft = { headingId, headingItem, children: [], latest: 0, key };
    groups.set(key, created);
    return created;
  };

  for (const item of items) {
    if (heads(item)) {
      group(`h:${item.id}`, item.id, item);
      continue;
    }

    const parentId = item.links.parentId;
    // A listed parent heads the group itself (it has this listed child); otherwise its heading is read later.
    const target = parentId === null ? group(`o:${item.id}`, null, null) : group(`h:${parentId}`, parentId, listed.get(parentId) ?? null);
    target.children.push(item);
    target.latest = Math.max(target.latest, changed(item));
  }

  return [...groups.values()]
    // A story with nothing listed under it is ordered by its own change.
    .map((draft) => ({ ...draft, latest: draft.children.length === 0 && draft.headingItem ? changed(draft.headingItem) : draft.latest, children: draft.children.sort(newestFirst) }))
    .sort((a, b) => b.latest - a.latest || (b.headingId ?? b.children[0]?.id ?? 0) - (a.headingId ?? a.children[0]?.id ?? 0));
}

/**
 * Headings for parents that are not listed (someone else's story, or one
 * filtered out), read from Azure. `known` are tickets already read (e.g. my
 * other tickets). A parent Azure cannot return still heads its group by id.
 */
export async function loadHeadings(client: AzureClient, ids: number[], known: Map<number, WorkItemSummary>): Promise<Map<number, GroupHeading>> {
  const headings = new Map<number, GroupHeading>();
  const missing: number[] = [];

  for (const id of new Set(ids)) {
    const item = known.get(id);
    if (item) headings.set(id, toHeading(item));
    else missing.push(id);
  }

  if (missing.length > 0) {
    try {
      for (const item of await toWorkItemSummaries(client, await getWorkItemsByIds(client, missing))) {
        known.set(item.id, item);
        headings.set(item.id, toHeading(item));
      }
    } catch (error) {
      if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") throw error;
      logFallback(`Reading ${missing.length} parent ticket(s) for list headings failed; shown by number`, error);
    }
  }

  for (const id of missing) {
    if (!headings.has(id)) headings.set(id, unreadableHeading(id));
  }

  return headings;
}

/** Turns one page of drafts into groups, with headings for parents that are not listed. */
export async function resolveGroups<T>(
  client: AzureClient,
  drafts: GroupDraft[],
  known: Map<number, WorkItemSummary>,
  toRow: (item: WorkItemSummary) => T
): Promise<Array<WorkItemGroup<T>>> {
  const outside = drafts.filter((draft) => draft.headingId !== null && !draft.headingItem).map((draft) => draft.headingId as number);
  const headings = await loadHeadings(client, outside, known);

  return drafts.map((draft) => ({
    heading: draft.headingItem ? toHeading(draft.headingItem) : draft.headingId !== null ? (headings.get(draft.headingId) ?? null) : null,
    headingRow: draft.headingItem ? toRow(draft.headingItem) : null,
    rows: draft.children.map(toRow),
    latest: draft.latest > 0 ? new Date(draft.latest).toISOString() : null,
  }));
}
