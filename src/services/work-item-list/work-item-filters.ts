import { z } from "zod";

import type { ComplianceResult, StateCategory, WorkItemSummary } from "../../types/azure.types.js";

/** A filter value from the query string. Tampered or oversized values become "no filter" instead of an error. */
const filterValue = z.string().trim().max(200).catch("").default("");

export const workItemFiltersSchema = z.object({
  search: filterValue,
  type: filterValue,
  /** A state category (Proposed, InProgress, ...). */
  stateCategory: filterValue,
  priority: filterValue,
  /** My work: "gaps" | "ok" | a rule id. */
  sop: filterValue,
  /** Team: "mine" | "unassigned" | identity id. */
  assignee: filterValue,
});

export type WorkItemFilters = z.infer<typeof workItemFiltersSchema>;

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

const STATE_LABELS: Record<StateCategory, string> = {
  Proposed: "New",
  InProgress: "In progress",
  Resolved: "Resolved",
  Completed: "Done",
  Removed: "Removed",
  Unknown: "Other",
};

function countBy<T>(items: T[], key: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();

  for (const item of items) {
    const value = key(item);

    if (value !== null) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return counts;
}

export function matchesWorkItem(
  item: WorkItemSummary,
  filters: WorkItemFilters,
  compliance: Map<number, ComplianceResult>,
  myId: string | null
): boolean {
  const search = filters.search.toLowerCase();

  if (search && !`#${item.id} ${item.title} ${item.tags.join(" ")}`.toLowerCase().includes(search)) return false;
  if (filters.type && item.type !== filters.type) return false;
  if (filters.stateCategory && item.stateCategory !== filters.stateCategory) return false;
  if (filters.priority && String(item.priority ?? "none") !== filters.priority) return false;

  if (filters.sop) {
    const result = compliance.get(item.id);
    const violations = result?.violations ?? [];

    if (filters.sop === "gaps" && violations.length === 0) return false;
    if (filters.sop === "ok" && (violations.length > 0 || !result?.configured)) return false;
    if (filters.sop !== "gaps" && filters.sop !== "ok" && !violations.some((violation) => violation.ruleId === filters.sop)) {
      return false;
    }
  }

  if (filters.assignee === "mine" && (myId === null || item.assignedTo?.id !== myId)) return false;
  if (filters.assignee === "unassigned" && item.assignedTo !== null) return false;
  if (filters.assignee && filters.assignee !== "mine" && filters.assignee !== "unassigned" && item.assignedTo?.id !== filters.assignee) {
    return false;
  }

  return true;
}

/** Dropdown options built from the items in view, with counts. */
export function workItemFacets(items: WorkItemSummary[], compliance: Map<number, ComplianceResult>, myId: string | null) {
  const types: FilterOption[] = [...countBy(items, (item) => item.type)]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, label: value, count }));

  const states: FilterOption[] = (Object.keys(STATE_LABELS) as StateCategory[])
    .map((category) => ({ value: category, label: STATE_LABELS[category], count: items.filter((item) => item.stateCategory === category).length }))
    .filter((option) => option.count > 0);

  const priorities: FilterOption[] = [...countBy(items, (item) => String(item.priority ?? "none"))]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value === "none" ? "None" : `P${value}`, count }));

  const violations = items.flatMap((item) => compliance.get(item.id)?.violations ?? []);
  const ruleTitles = new Map(violations.map((violation) => [violation.ruleId, violation.ruleTitle]));
  const ruleCounts = countBy(violations, (violation) => violation.ruleId);
  const withGaps = items.filter((item) => (compliance.get(item.id)?.violations.length ?? 0) > 0).length;
  const compliant = items.filter((item) => {
    const result = compliance.get(item.id);
    return result?.configured && result.violations.length === 0;
  }).length;
  const sop: FilterOption[] = [
    { value: "gaps", label: "Any gap", count: withGaps },
    { value: "ok", label: "Compliant", count: compliant },
    ...[...ruleCounts]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: `${value} · ${ruleTitles.get(value) ?? ""}`, count })),
  ];

  const people = new Map<string, { name: string; count: number }>();

  for (const item of items) {
    if (item.assignedTo?.id && item.assignedTo.id !== myId) {
      const entry = people.get(item.assignedTo.id) ?? { name: item.assignedTo.displayName, count: 0 };
      entry.count += 1;
      people.set(item.assignedTo.id, entry);
    }
  }

  const assignees: FilterOption[] = [
    { value: "mine", label: "Me", count: items.filter((item) => myId !== null && item.assignedTo?.id === myId).length },
    { value: "unassigned", label: "Unassigned", count: items.filter((item) => item.assignedTo === null).length },
    ...[...people]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([value, entry]) => ({ value, label: entry.name, count: entry.count })),
  ];

  return { types, states, priorities, sop, assignees };
}
