/**
 * Server copy of the dashboard's triage rules (frontend utils/triage.ts), so
 * paged lists can hide snoozed and abandoned tickets before paging. Keep the
 * two in step: an abandoned project hides everything in it; otherwise the
 * item's own mark wins; snoozed/acknowledged items come back when a signal
 * appears that was not present when they were marked.
 */
export interface TriageMarkLike {
  itemKey: string;
  status: "SNOOZED" | "ACKNOWLEDGED" | "ABANDONED";
  snoozedUntil: Date | null;
  signals: string[];
}

export type TriageState = "active" | "acknowledged" | "snoozed" | "abandoned";

export const workItemKey = (id: number) => `wi:${id}`;
export const projectKey = (projectName: string) => `project:${projectName.toLowerCase()}`;

const scopedSignals = (itemKey: string, signals: string[]) => signals.map((signal) => `${itemKey}/${signal}`);

function isActiveMark(mark: TriageMarkLike, now: number): boolean {
  return mark.status !== "SNOOZED" || (mark.snoozedUntil !== null && mark.snoozedUntil.getTime() > now);
}

function evaluate(mark: TriageMarkLike | undefined, current: string[], now: number): TriageState | null {
  if (!mark || !isActiveMark(mark, now)) {
    return null;
  }

  if (mark.status === "ABANDONED") {
    return "abandoned";
  }

  const known = new Set(mark.signals);

  if (current.some((signal) => !known.has(signal))) {
    return "active";
  }

  return mark.status === "SNOOZED" ? "snoozed" : "acknowledged";
}

export function resolveWorkItemTriage(
  marks: Map<string, TriageMarkLike>,
  workItemId: number,
  projectName: string,
  signals: string[],
  now = Date.now()
): TriageState {
  const projectMark = marks.get(projectKey(projectName));

  if (projectMark?.status === "ABANDONED") {
    return "abandoned";
  }

  const itemKey = workItemKey(workItemId);
  const own = evaluate(marks.get(itemKey), signals, now);

  if (own) {
    return own;
  }

  return evaluate(projectMark, scopedSignals(itemKey, signals), now) ?? "active";
}

export const isHiddenState = (state: TriageState) => state === "snoozed" || state === "abandoned";
