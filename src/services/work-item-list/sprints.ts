import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import { logFallback } from "../../lib/log-fallback.js";
import type { WorkItemSummary } from "../../types/azure.types.js";
import { getCurrentIteration, getProject } from "../azure/projects.service.js";

/** A project's current sprint (its default team's current iteration). */
export interface CurrentSprint {
  name: string;
  path: string;
  startDate: string | null;
  finishDate: string | null;
}

/**
 * The current sprint of each project, from its default team. A project
 * without one (or that cannot be read) has none: its tickets then only show
 * under "All sprints".
 */
export async function currentSprints(client: AzureClient, projectNames: string[]): Promise<Map<string, CurrentSprint | null>> {
  const limit = createLimiter(4);
  const entries = await mapWithLimit([...new Set(projectNames)], limit, async (projectName): Promise<[string, CurrentSprint | null]> => {
    try {
      const project = await getProject(client, projectName);
      const team = project.defaultTeam;
      const iteration = team ? await getCurrentIteration(client, project.id, team.id) : null;
      return [projectName, iteration ? { name: iteration.name, path: iteration.path, startDate: iteration.startDate, finishDate: iteration.finishDate } : null];
    } catch (error) {
      if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") throw error;
      logFallback(`Reading the current sprint of ${projectName} failed; its tickets show in every view`, error);
      return [projectName, null];
    }
  });

  return new Map(entries);
}

/**
 * Whether the ticket belongs in the "current sprint" view: in its project's
 * current sprint (the sprint itself or a path under it), or in a project
 * without sprints (Kanban, or its sprint could not be read), whose tickets
 * would otherwise never show by default.
 */
export function inCurrentSprint(item: WorkItemSummary, sprints: Map<string, CurrentSprint | null>): boolean {
  const sprint = sprints.get(item.projectName);
  if (!sprint) return true;
  const path = item.iterationPath;
  if (!path) return false;
  const lower = path.toLowerCase();
  const current = sprint.path.toLowerCase();
  return lower === current || lower.startsWith(`${current}\\`);
}
