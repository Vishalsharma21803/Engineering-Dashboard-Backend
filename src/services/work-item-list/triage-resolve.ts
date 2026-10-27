import type { BuildSummary, Recommendation } from "../../types/azure.types.js";

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
export const pullRequestKey = (repositoryId: string, pullRequestId: number) => `pr:${repositoryId}:${pullRequestId}`;

/** Pipeline + branch, so abandoning a dead pipeline outlives its individual runs. */
export function pipelineKey(build: Pick<BuildSummary, "projectName" | "definitionId" | "sourceBranch">): string | null {
  return build.projectName ? `pipeline:${build.projectName}:${build.definitionId}:${build.sourceBranch ?? ""}` : null;
}

export function recommendationKey(recommendation: Recommendation, buildsById: Map<number, BuildSummary>): string | null {
  const { target } = recommendation;

  switch (target.type) {
    case "workItem":
      return workItemKey(target.id);
    case "pullRequest":
      return target.repositoryId ? pullRequestKey(target.repositoryId, target.id) : null;
    case "build": {
      const build = buildsById.get(target.id);
      return build ? pipelineKey(build) : null;
    }
    case "time":
      return target.key ?? null;
  }
}

/** Current signal codes per item key, taken from the dashboard's recommendations. */
export function buildSignalIndex(recommendations: Recommendation[], builds: BuildSummary[]): Map<string, string[]> {
  const buildsById = new Map(builds.map((build) => [build.id, build]));
  const index = new Map<string, string[]>();

  for (const recommendation of recommendations) {
    const key = recommendationKey(recommendation, buildsById);

    if (key) {
      index.set(key, [...(index.get(key) ?? []), ...recommendation.signals]);
    }
  }

  return index;
}

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
  return resolveTriage(marks, workItemKey(workItemId), projectName, signals, now);
}

/** Any item (ticket, pull request, pipeline): same rules as resolveWorkItemTriage. A null key only follows an abandoned project. */
export function resolveTriage(
  marks: Map<string, TriageMarkLike>,
  itemKey: string | null,
  projectName: string | null,
  signals: string[],
  now = Date.now()
): TriageState {
  const projectMark = projectName ? marks.get(projectKey(projectName)) : undefined;

  if (projectMark?.status === "ABANDONED") {
    return "abandoned";
  }

  if (!itemKey) {
    return "active";
  }

  return evaluate(marks.get(itemKey), signals, now) ?? evaluate(projectMark, scopedSignals(itemKey, signals), now) ?? "active";
}

export const isHiddenState = (state: TriageState) => state === "snoozed" || state === "abandoned";
