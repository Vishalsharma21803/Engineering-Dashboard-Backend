import { Router } from "express";

import {
  getBuildTimelineController,
  getCapabilitiesController,
  getDashboardController,
  getDeploymentsController,
  getProjectController,
  getPullRequestController,
  getWorkItemController,
  listBranchesController,
  listBuildsController,
  listCommitsController,
  listComplianceController,
  listPipelineRunsController,
  listPipelinesController,
  listProjectsController,
  listPullRequestsController,
  listRepositoriesController,
  listWorkItemsController,
  getMyWorkController,
  getTeamWorkController,
  listDashboardPipelineRunsController,
  listDashboardPullRequestsController,
  listRecommendationsController,
  listTeamsController,
} from "../controllers/azure.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { loadAzureCredential } from "../middleware/azure-credential.middleware.js";

// Mounted at /api/azure/:credentialId. Read-only: no route here writes to Azure.
const router = Router({ mergeParams: true });

router.use(authenticate, loadAzureCredential);

router.get("/capabilities", getCapabilitiesController);
router.get("/dashboard", getDashboardController);
router.get("/dashboard/recommendations", listRecommendationsController);
router.get("/dashboard/pull-requests", listDashboardPullRequestsController);
router.get("/dashboard/pipeline-runs", listDashboardPipelineRunsController);
router.get("/projects", listProjectsController);
router.get("/projects/:projectId", getProjectController);
router.get("/work-items", listWorkItemsController);
router.get("/compliance", listComplianceController);
router.get("/my-work", getMyWorkController);
router.get("/pull-requests", listPullRequestsController);
router.get("/projects/:projectId/work-items/:workItemId", getWorkItemController);
router.get("/projects/:projectId/team-work-items", getTeamWorkController);
router.get(
  "/projects/:projectId/repos/:repositoryId/pull-requests/:pullRequestId",
  getPullRequestController
);
router.get("/projects/:projectId/pipelines", listPipelinesController);
router.get("/projects/:projectId/pipelines/:pipelineId/runs", listPipelineRunsController);
router.get("/projects/:projectId/builds", listBuildsController);
router.get("/projects/:projectId/builds/:buildId/timeline", getBuildTimelineController);
router.get("/projects/:projectId/deployments", getDeploymentsController);
router.get("/projects/:projectId/repos", listRepositoriesController);
router.get("/projects/:projectId/teams", listTeamsController);
router.get("/projects/:projectId/repos/:repositoryId/branches", listBranchesController);
router.get("/projects/:projectId/repos/:repositoryId/commits", listCommitsController);

export default router;
