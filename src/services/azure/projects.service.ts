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

export async function getProjectOverview(
  client: AzureClient,
  projectId: string
): Promise<ProjectOverview> {
  const raw = await getProject(client, projectId);
  const defaultTeam = raw.defaultTeam ?? null;

  const [teams, currentIteration, repositories, myOpenWorkItems, activePullRequests, failingPipelines] =
    await Promise.all([
      toSection(async () => {
        const data = await client.get<RawList<RawTeam>>(
          ["_apis", "projects", raw.id, "teams"],
          { query: { $top: 100 } }
        );
        return (data.value ?? []).map((team) => ({ id: team.id, name: team.name }));
      }),
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
        return ids.length;
      }),
      toSection(async () => {
        const data = await client.get<RawList<RawPullRequest>>(
          [raw.id, "_apis", "git", "pullrequests"],
          { query: { "searchCriteria.status": "active", $top: 500 } }
        );
        return data.value?.length ?? 0;
      }),
      toSection(async () => {
        const data = await client.get<RawList<RawBuildDefinition>>(
          [raw.id, "_apis", "build", "definitions"],
          { query: { includeLatestBuilds: true, $top: 500 } }
        );
        return (data.value ?? []).filter(
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
    teams,
    currentIteration,
    counts: {
      repositories,
      myOpenWorkItems,
      activePullRequests,
      failingPipelines,
    },
  };
}
