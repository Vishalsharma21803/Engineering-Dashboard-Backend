import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawBuildDefinition,
  RawIteration,
  RawList,
  RawProject,
  RawPullRequest,
  RawRepository,
  RawTeam,
} from "../../lib/azure/azure-api.types.js";
import type {
  IterationSummary,
  ProjectOverview,
  ProjectSummary,
} from "../../types/azure.types.js";
import { toSection } from "./section.js";
import { listAssignedWorkItemIds } from "./work-items.service.js";

const PROJECTS_PAGE_SIZE = 100;
const PROJECTS_MAX_PAGES = 10;

function toProjectSummary(raw: RawProject, organizationUrl: string): ProjectSummary {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    state: raw.state ?? "unknown",
    visibility: raw.visibility ?? "private",
    lastUpdateTime: raw.lastUpdateTime ?? null,
    url: `${organizationUrl}/${encodeURIComponent(raw.name)}`,
  };
}

export async function listProjects(
  client: AzureClient
): Promise<{ projects: ProjectSummary[]; truncated: boolean }> {
  const { items, truncated } = await client.getAll<RawProject>(
    ["_apis", "projects"],
    {
      query: { $top: PROJECTS_PAGE_SIZE, stateFilter: "wellFormed" },
      maxPages: PROJECTS_MAX_PAGES,
    }
  );

  return {
    projects: items
      .map((raw) => toProjectSummary(raw, client.organizationUrl))
      .sort((a, b) => a.name.localeCompare(b.name)),
    truncated,
  };
}

export async function getProject(
  client: AzureClient,
  projectId: string
): Promise<RawProject> {
  return client.get<RawProject>(["_apis", "projects", projectId], {
    query: { includeCapabilities: true },
  });
}

function toIteration(raw: RawIteration): IterationSummary {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    startDate: raw.attributes?.startDate ?? null,
    finishDate: raw.attributes?.finishDate ?? null,
  };
}

export async function getCurrentIteration(
  client: AzureClient,
  projectId: string,
  teamId: string
): Promise<IterationSummary | null> {
  const data = await client.get<RawList<RawIteration>>(
    [projectId, teamId, "_apis", "work", "teamsettings", "iterations"],
    { query: { $timeframe: "current" } }
  );

  const current = data.value?.[0];
  return current ? toIteration(current) : null;
}

/** The project's teams by name (Azure returns at most 100 here). */
export async function listTeams(client: AzureClient, projectId: string): Promise<Array<{ id: string; name: string }>> {
  const project = await getProject(client, projectId);
  const data = await client.get<RawList<RawTeam>>(["_apis", "projects", project.id, "teams"], { query: { $top: 100 } });
  return (data.value ?? []).map((team) => ({ id: team.id, name: team.name }));
}

/** Pull requests and pipelines the project overview counts at most (one more is read to detect a cut). */
const OVERVIEW_COUNT_CAP = 500;

export async function getProjectOverview(
  client: AzureClient,
  projectId: string
): Promise<ProjectOverview> {
  const raw = await getProject(client, projectId);
  const defaultTeam = raw.defaultTeam ?? null;
  let myOpenWorkItemsTruncated = false;
  let activePullRequestsTruncated = false;
  let failingPipelinesTruncated = false;

  const [currentIteration, repositories, myOpenWorkItems, activePullRequests, failingPipelines] =
    await Promise.all([
      toSection(async () =>
        defaultTeam ? getCurrentIteration(client, raw.id, defaultTeam.id) : null
      ),
      toSection(async () => {
        const data = await client.get<RawList<RawRepository>>([
          raw.id,
          "_apis",
          "git",
          "repositories",
        ]);
        return data.value?.length ?? 0;
      }),
      toSection(async () => {
        const ids = await listAssignedWorkItemIds(client, {
          projectName: raw.name,
          scope: "open",
        });
        myOpenWorkItemsTruncated = ids.truncated;
        return ids.items.length;
      }),
      toSection(async () => {
        // One more than counted is asked for, so a cut is known.
        const data = await client.get<RawList<RawPullRequest>>(
          [raw.id, "_apis", "git", "pullrequests"],
          { query: { "searchCriteria.status": "active", $top: OVERVIEW_COUNT_CAP + 1 } }
        );
        const count = data.value?.length ?? 0;
        activePullRequestsTruncated = count > OVERVIEW_COUNT_CAP;
        return Math.min(count, OVERVIEW_COUNT_CAP);
      }),
      toSection(async () => {
        const data = await client.get<RawList<RawBuildDefinition>>(
          [raw.id, "_apis", "build", "definitions"],
          { query: { includeLatestBuilds: true, $top: OVERVIEW_COUNT_CAP + 1 } }
        );
        const definitions = data.value ?? [];
        // More pipelines than read: failing ones among the rest are not counted.
        failingPipelinesTruncated = definitions.length > OVERVIEW_COUNT_CAP;
        return definitions.slice(0, OVERVIEW_COUNT_CAP).filter(
          (definition) => definition.latestCompletedBuild?.result === "failed"
        ).length;
      }),
    ]);

  return {
    ...toProjectSummary(raw, client.organizationUrl),
    processTemplate: raw.capabilities?.processTemplate?.templateName ?? null,
    sourceControlType:
      raw.capabilities?.versioncontrol?.sourceControlType ?? null,
    defaultTeam,
    currentIteration,
    counts: {
      repositories,
      myOpenWorkItems,
      activePullRequests,
      failingPipelines,
    },
    myOpenWorkItemsTruncated,
    activePullRequestsTruncated,
    failingPipelinesTruncated,
  };
}
