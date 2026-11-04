import type { Request, Response } from "express";
import { z } from "zod";

import type { AzureClient } from "../lib/azure/client.js";
import {
  azureProjectIdSchema,
  buildsQuerySchema,
  commitsQuerySchema,
  dashboardPullRequestsQuerySchema,
  dashboardQuerySchema,
  myWorkQuerySchema,
  pageOnlyQuerySchema,
  pipelineRunsQuerySchema,
  pipelinesQuerySchema,
  recommendationsQuerySchema,
  teamWorkQuerySchema,
  positiveIntParam,
  pullRequestsQuerySchema,
  repositoryIdSchema,
  runsQuerySchema,
  workItemsQuerySchema,
} from "../schemas/azure.schema.js";
import { learnedWriteScopes } from "../services/actions/action.service.js";
import { getCapabilities } from "../services/azure/capabilities.service.js";
import { getDeployments } from "../services/azure/deployments.service.js";
import { getIdentity } from "../services/azure/identity.service.js";
import {
  getBuildTimeline,
  listBuilds,
  listPipelines,
} from "../services/azure/pipelines.service.js";
import {
  getProject,
  getProjectOverview,
  listProjects,
  listTeams,
} from "../services/azure/projects.service.js";
import {
  getPullRequestDetail,
  listMyPullRequests,
} from "../services/azure/pull-requests.service.js";
import {
  listBranches,
  listCommits,
  listRepositories,
} from "../services/azure/repositories.service.js";
import { getWorkItemDetail } from "../services/azure/work-item-detail.service.js";
import { listAssignedWorkItems } from "../services/azure/work-items.service.js";
import { listCompliance } from "../services/compliance/compliance.service.js";
import { getMyWorkPage, getTeamWorkPage } from "../services/work-item-list/my-work.service.js";
import {
  getDashboardPipelineRunPage,
  getDashboardPullRequestPage,
  getRecommendationPage,
  pagePullRequests,
} from "../services/work-item-list/dashboard-lists.service.js";
import { PAGE_SIZE, paginate } from "../lib/pagination.js";
import { MAX_DASHBOARD_PROJECTS, getDashboard } from "../services/dashboard.service.js";
import { sendError, sendValidationError } from "./controller-helpers.js";

class RequestValidationError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super("Validation failed");
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new RequestValidationError(result.error);
  }

  return result.data;
}

type AzureHandler = (req: Request, client: AzureClient, userId: string) => Promise<unknown>;

/** Every Azure route is a read: validate, call the service, map errors. */
function azureRead(label: string, handler: AzureHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    const azure = req.azure;

    if (!azure || !req.userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    try {
      res.status(200).json(await handler(req, azure.client, req.userId));
    } catch (error) {
      if (error instanceof RequestValidationError) {
        sendValidationError(res, error.zodError);
        return;
      }

      await sendError(res, error, label, {
        userId: req.userId,
        credentialId: azure.credentialId,
      });
    }
  };
}

const projectParam = (req: Request) => parse(azureProjectIdSchema, req.params.projectId);

async function projectIdsFor(client: AzureClient, projectId: string | undefined) {
  if (projectId !== undefined) {
    const project = await getProject(client, projectId);
    return [project.id];
  }

  const { projects } = await listProjects(client);
  return projects.slice(0, MAX_DASHBOARD_PROJECTS).map((project) => project.id);
}

export const getCapabilitiesController = azureRead(
  "Fetching Azure capabilities failed",
  async (_req, client) => ({
    capabilities: await getCapabilities(client, await learnedWriteScopes(client.credentialId)),
  })
);

export const listProjectsController = azureRead(
  "Listing Azure projects failed",
  async (_req, client) => listProjects(client)
);

export const getProjectController = azureRead(
  "Fetching Azure project failed",
  async (req, client) => ({ project: await getProjectOverview(client, projectParam(req)) })
);

export const listWorkItemsController = azureRead(
  "Listing work items failed",
  async (req, client) => {
    const query = parse(workItemsQuerySchema, req.query);
    let projectName: string | undefined;

    if (query.projectId !== undefined) {
      projectName = (await getProject(client, query.projectId)).name;
    }

    return {
      workItems: await listAssignedWorkItems(client, {
        projectName,
        scope: query.state,
        assignee: query.assignee,
      }),
    };
  }
);

export const getWorkItemController = azureRead(
  "Fetching work item failed",
  async (req, client, userId) => {
    const projectId = projectParam(req);
    const workItemId = parse(positiveIntParam("work item id"), req.params.workItemId);
    return { workItem: await getWorkItemDetail(client, userId, projectId, workItemId) };
  }
);

export const listComplianceController = azureRead(
  "Checking compliance failed",
  async (req, client, userId) => {
    const { projectId } = parse(dashboardQuerySchema, req.query);
    const projectName =
      projectId === undefined ? undefined : (await getProject(client, projectId)).name;

    return { items: await listCompliance(client, userId, projectName) };
  }
);

export const listPullRequestsController = azureRead(
  "Listing pull requests failed",
  async (req, client) => {
    const { projectId, role, page, ...filters } = parse(pullRequestsQuerySchema, req.query);
    const identity = await getIdentity(client);
    const projectIds = await projectIdsFor(client, projectId);
    const pullRequests = await listMyPullRequests(client, identity, projectIds, role);

    // Filtered and paged here, 10 per page; "everyone" lists the whole team's pull requests.
    return {
      pullRequests: pagePullRequests(pullRequests, filters, role === "everyone", page),
    };
  }
);

export const getPullRequestController = azureRead(
  "Fetching pull request failed",
  async (req, client) => {
    const projectId = projectParam(req);
    const repositoryId = parse(repositoryIdSchema, req.params.repositoryId);
    const pullRequestId = parse(positiveIntParam("pull request id"), req.params.pullRequestId);
    const identity = await getIdentity(client);

    return {
      pullRequest: await getPullRequestDetail(
        client,
        identity,
        projectId,
        repositoryId,
        pullRequestId
      ),
    };
  }
);

/** 10 per page. Without a page, `build` opens the page holding that run's pipeline. */
export const listPipelinesController = azureRead("Listing pipelines failed", async (req, client) => {
  const { page, build } = parse(pipelinesQuerySchema, req.query);
  const pipelines = await listPipelines(client, projectParam(req));
  const focused = req.query.page === undefined && build !== undefined
    ? pipelines.findIndex((pipeline) => pipeline.latestBuild?.id === build || pipeline.latestCompletedBuild?.id === build)
    : -1;

  return { pipelines: paginate(pipelines, focused >= 0 ? Math.floor(focused / PAGE_SIZE) + 1 : page) };
});

export const listPipelineRunsController = azureRead(
  "Listing pipeline runs failed",
  async (req, client) => {
    const projectId = projectParam(req);
    const definitionId = parse(positiveIntParam("pipeline id"), req.params.pipelineId);
    const { top } = parse(runsQuerySchema, req.query);

    return { runs: await listBuilds(client, projectId, { definitionId, top }) };
  }
);

export const listBuildsController = azureRead(
  "Listing builds failed",
  async (req, client) => {
    const projectId = projectParam(req);
    const query = parse(buildsQuerySchema, req.query);

    return {
      builds: await listBuilds(client, projectId, {
        statusFilter: query.status,
        top: query.top,
      }),
    };
  }
);

export const getBuildTimelineController = azureRead(
  "Fetching build timeline failed",
  async (req, client) => {
    const projectId = projectParam(req);
    const buildId = parse(positiveIntParam("build id"), req.params.buildId);

    return { timeline: await getBuildTimeline(client, projectId, buildId) };
  }
);

export const getDeploymentsController = azureRead(
  "Fetching deployments failed",
  async (req, client) => ({ deployments: await getDeployments(client, projectParam(req)) })
);

/** Every repository (for pickers), or with `page` one page of 10 as `repositoryPage` (for lists). */
export const listRepositoriesController = azureRead("Listing repositories failed", async (req, client) => {
  const repositories = await listRepositories(client, projectParam(req));

  return req.query.page === undefined
    ? { repositories }
    : { repositoryPage: paginate(repositories, parse(pageOnlyQuerySchema, req.query).page) };
});

/** The project's teams, 10 per page. */
export const listTeamsController = azureRead("Listing teams failed", async (req, client) => {
  const { page } = parse(pageOnlyQuerySchema, req.query);
  return { teams: paginate(await listTeams(client, projectParam(req)), page) };
});

async function dashboardProject(client: AzureClient, projectId: string | undefined) {
  if (projectId === undefined) {
    return undefined;
  }

  const project = await getProject(client, projectId);
  return { id: project.id, name: project.name };
}

/** Prioritized actions, filtered and paged on the server (10 per page). */
export const listRecommendationsController = azureRead("Listing prioritized actions failed", async (req, client, userId) => {
  const { projectId, ...query } = parse(recommendationsQuerySchema, req.query);
  return { recommendations: await getRecommendationPage(client, userId, { ...query, project: await dashboardProject(client, projectId) }) };
});

/** My pull requests and reviews, filtered and paged on the server (10 per page). */
export const listDashboardPullRequestsController = azureRead("Listing your pull requests failed", async (req, client, userId) => {
  const { projectId, page, hidden, ...filters } = parse(dashboardPullRequestsQuerySchema, req.query);
  return {
    pullRequests: await getDashboardPullRequestPage(client, userId, { project: await dashboardProject(client, projectId), filters, hidden, page }),
  };
});

/** My recent pipeline runs, filtered and paged on the server (10 per page). */
export const listDashboardPipelineRunsController = azureRead("Listing your pipeline runs failed", async (req, client, userId) => {
  const { projectId, ...query } = parse(pipelineRunsQuerySchema, req.query);
  return { runs: await getDashboardPipelineRunPage(client, userId, { ...query, project: await dashboardProject(client, projectId) }) };
});

export const listBranchesController = azureRead(
  "Listing branches failed",
  async (req, client) => {
    const projectId = projectParam(req);
    const repositoryId = parse(repositoryIdSchema, req.params.repositoryId);

    return listBranches(client, projectId, repositoryId);
  }
);

export const listCommitsController = azureRead(
  "Listing commits failed",
  async (req, client) => {
    const projectId = projectParam(req);
    const repositoryId = parse(repositoryIdSchema, req.params.repositoryId);
    const query = parse(commitsQuerySchema, req.query);
    const identity = await getIdentity(client);

    return {
      commits: await listCommits(client, identity, projectId, repositoryId, {
        mine: query.author === "me",
        branch: query.branch,
        top: query.top,
      }),
    };
  }
);

export const getDashboardController = azureRead(
  "Building dashboard failed",
  async (req, client, userId) => {
    const { projectId } = parse(dashboardQuerySchema, req.query);
    return { dashboard: await getDashboard(client, userId, projectId) };
  }
);

/** My work tickets grouped by story, filtered and paged on the server (10 groups per page). */
export const getMyWorkController = azureRead("Listing your work items failed", async (req, client, userId) => {
  const query = parse(myWorkQuerySchema, req.query);
  const projectName = query.projectId === undefined ? undefined : (await getProject(client, query.projectId)).name;
  const { projectId: _projectId, page, hidden, sprint, closed, attention, groupBy, ...filters } = query;

  return {
    myWork: await getMyWorkPage(client, userId, {
      projectName,
      filters,
      page,
      hidden,
      sprint,
      closed,
      attention,
      groupBy,
      refresh: req.query.refresh === "1" || req.query.refresh === "true",
    }),
  };
});

/** Everyone's tickets in one project grouped by story, filtered and paged on the server (10 groups per page). */
export const getTeamWorkController = azureRead("Listing team work items failed", async (req, client) => {
  const { scope, page, ...filters } = parse(teamWorkQuerySchema, req.query);
  const project = await getProject(client, projectParam(req));

  return { teamWork: await getTeamWorkPage(client, { projectName: project.name, scope, filters, page }) };
});
