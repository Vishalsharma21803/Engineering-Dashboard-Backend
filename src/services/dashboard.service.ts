import type { AzureClient } from "../lib/azure/client.js";
import { AzureApiError } from "../lib/azure/errors.js";
import { createLimiter, mapWithLimit } from "../lib/azure/limiter.js";
import type { BuildSummary, Dashboard, Section } from "../types/azure.types.js";
import { checkCompliance } from "./compliance/compliance.service.js";
import { getIdentity } from "./azure/identity.service.js";
import { listMyLatestBuilds } from "./azure/pipelines.service.js";
import { getProject, listProjects } from "./azure/projects.service.js";
import { listMyPullRequests } from "./azure/pull-requests.service.js";
import { sectionData, toSection } from "./azure/section.js";
import { listAssignedWorkItemRecords } from "./azure/work-items.service.js";
import { buildRecommendations } from "./recommendation.service.js";
import { rememberDashboardLists } from "./work-item-list/dashboard-lists.service.js";
import { rememberMyWork } from "./work-item-list/my-work.service.js";

export const MAX_DASHBOARD_PROJECTS = 30;

interface ScopedProject {
  id: string;
  name: string;
}

async function resolveProjects(
  client: AzureClient,
  projectId: string | undefined
): Promise<Section<{ projects: ScopedProject[]; truncated: boolean }>> {
  return toSection(async () => {
    if (projectId !== undefined) {
      const project = await getProject(client, projectId);
      return { projects: [{ id: project.id, name: project.name }], truncated: false };
    }

    const { projects, truncated } = await listProjects(client);

    return {
      projects: projects
        .slice(0, MAX_DASHBOARD_PROJECTS)
        .map((project) => ({ id: project.id, name: project.name })),
      truncated: truncated || projects.length > MAX_DASHBOARD_PROJECTS,
    };
  });
}

function unavailable<T>(reason: string | null): Section<T> {
  return { status: "error", data: null, reason: reason ?? "PROJECTS_UNAVAILABLE" };
}

export async function getDashboard(
  client: AzureClient,
  userId: string,
  projectId: string | undefined,
  now = new Date()
): Promise<Dashboard> {
  const identity = await getIdentity(client);
  const projectsSection = await resolveProjects(client, projectId);

  if (projectId !== undefined && projectsSection.status !== "ok") {
    // A specific project that cannot be read is a request error, not a degraded section.
    throw new AzureApiError(
      projectsSection.status === "forbidden" ? "AZURE_INSUFFICIENT_SCOPE" : "AZURE_NOT_FOUND",
      null
    );
  }

  const projects = sectionData(projectsSection, { projects: [], truncated: false });
  const projectName = projectId !== undefined ? projects.projects[0]?.name : undefined;
  const projectIds = projects.projects.map((project) => project.id);
  const projectsAvailable = projectsSection.status === "ok";

  const workItemsSection = await toSection(() =>
    listAssignedWorkItemRecords(client, { projectName, scope: "compliance" })
  );
  const records = sectionData(workItemsSection, []);
  const allWorkItems = records.map((record) => record.summary);

  const [compliance, pullRequests, pipelines] = await Promise.all([
    workItemsSection.status === "ok"
      ? toSection(() => checkCompliance(client, userId, records, now))
      : Promise.resolve({ ...workItemsSection, data: null }),
    projectsAvailable
      ? toSection(() => listMyPullRequests(client, identity, projectIds))
      : Promise.resolve(unavailable<never>(projectsSection.reason)),
    projectsAvailable
      ? toSection(async () => {
          const limit = createLimiter(4);
          const perProject = await mapWithLimit(projectIds, limit, async (id) => {
            try {
              return await listMyLatestBuilds(client, identity, id, now);
            } catch (error) {
              if (error instanceof AzureApiError && error.reason === "AZURE_NOT_FOUND") {
                return [] as BuildSummary[];
              }

              throw error;
            }
          });

          return perProject
            .flat()
            .sort((a, b) => (b.queueTime ?? "").localeCompare(a.queueTime ?? ""));
        })
      : Promise.resolve(unavailable<never>(projectsSection.reason)),
  ]);

  const openWorkItems = allWorkItems.filter(
    (item) => item.stateCategory !== "Completed" && item.stateCategory !== "Removed"
  );

  const workItems: Dashboard["sections"]["workItems"] =
    workItemsSection.status === "ok"
      ? { ...workItemsSection, data: openWorkItems }
      : { ...workItemsSection, data: null };

  const recommendations = buildRecommendations({
    workItems: allWorkItems,
    compliance: sectionData(compliance, []),
    pullRequests: sectionData(pullRequests, []),
    builds: sectionData(pipelines, []),
    now,
  });

  // The paged My work table reads these rows instead of re-running every SOP check per page.
  if (workItemsSection.status === "ok" && compliance.status === "ok") {
    rememberMyWork(userId, client.credentialId, projectName, {
      workItems: allWorkItems,
      compliance: sectionData(compliance, []),
      recommendations,
    });
  }

  // The paged dashboard lists (actions, pull requests, pipeline runs) read these.
  rememberDashboardLists(userId, client.credentialId, projectName, {
    recommendations,
    pullRequests: pullRequests.data,
    builds: pipelines.data,
  });

  return {
    identity,
    generatedAt: now.toISOString(),
    projectsScanned: projectIds.length,
    projectsTruncated: projects.truncated,
    sections: {
      workItems,
      pullRequests,
      pipelines,
      compliance,
    },
    recommendations,
  };
}
