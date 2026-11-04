import type { AzureClient } from "../lib/azure/client.js";
import { AzureApiError } from "../lib/azure/errors.js";
import { createLimiter, mapWithLimit } from "../lib/azure/limiter.js";
import type { BuildSummary, Dashboard, PullRequestSummary, ReadCompleteness, Section } from "../types/azure.types.js";
import { checkCompliance } from "./compliance/compliance.service.js";
import { applyAiReviews } from "./sop/ai/sop-ai-review.js";
import { getIdentity } from "./azure/identity.service.js";
import { RECENT_BUILDS_TOP, listMyLatestBuilds } from "./azure/pipelines.service.js";
import { getProject, listProjects } from "./azure/projects.service.js";
import { getPullRequest, listMyPullRequests, readCompleteness } from "./azure/pull-requests.service.js";
import { sectionData, toSection } from "./azure/section.js";
import { getWorkItemsByIds, listAssignedWorkItemRecords, stateLookupFailures, toWorkItemSummaries } from "./azure/work-items.service.js";
import { buildRecommendations } from "./recommendation.service.js";
import { rememberDashboardLists } from "./work-item-list/dashboard-lists.service.js";
import { timeNudges } from "./solidtime/time-nudges.service.js";
import { myWorkRecommendations, rememberMyWork } from "./work-item-list/my-work.service.js";
import { currentSprints } from "./work-item-list/sprints.js";
import { fallbackTo, logFallback } from "../lib/log-fallback.js";
import { closedTicketCandidates, notificationCandidates, storedClosedTickets, pipelineNotificationKey, syncNotifications } from "./notifications/notification.service.js";

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

  const workItemsRead = await toSection(() =>
    listAssignedWorkItemRecords(client, { projectName, scope: "compliance" })
  );
  const workItemsSection: Section<null> = { ...workItemsRead, data: null };
  const records = workItemsRead.data?.items ?? [];
  const workItemsTruncated = workItemsRead.data?.truncated ? { cap: workItemsRead.data.cap } : null;
  const allWorkItems = records.map((record) => record.summary);
  // Time nudges read Solidtime in parallel with the rest (short timeout; never fails the dashboard).
  const nudges = timeNudges(userId, client.credentialId, identity, records, now);

  const [compliance, pullRequestsRead, pipelinesRead, sprints] = await Promise.all([
    workItemsSection.status === "ok"
      ? toSection(() => checkCompliance(client, userId, records, now))
      : Promise.resolve({ ...workItemsSection, data: null }),
    projectsAvailable
      ? toSection(() => listMyPullRequests(client, identity, projects.projects))
      : Promise.resolve(unavailable<never>(projectsSection.reason)),
    projectsAvailable
      ? toSection(() => readMyBuilds(client, identity, projects.projects, now))
      : Promise.resolve(unavailable<never>(projectsSection.reason)),
    // Read here so the paged My work list (current sprint by default) needs no Azure call per page.
    // A failure leaves the list without a sprint view instead of failing the dashboard.
    currentSprints(client, allWorkItems.map((item) => item.projectName)).catch(fallbackTo("Reading current sprints for My work failed", undefined)),
  ]);
  const pullRequests: Section<PullRequestSummary[]> = { ...pullRequestsRead, data: pullRequestsRead.data?.pullRequests ?? null };
  const pipelines: Section<BuildSummary[]> = { ...pipelinesRead, data: pipelinesRead.data?.builds ?? null };
  const completeness: Dashboard["completeness"] = {
    pullRequests: pullRequestsRead.data?.completeness ?? null,
    pipelines: pipelinesRead.data?.completeness ?? null,
  };

  // The user's saved AI reviews (no AI call here): clears and AI-only rules count everywhere on the dashboard.
  const reviewed: typeof compliance =
    compliance.status === "ok" && compliance.data
      ? { ...compliance, data: await applyAiReviews(userId, client.credentialId, compliance.data, new Map(allWorkItems.map((item) => [item.id, item.rev]))) }
      : compliance;

  const openWorkItems = allWorkItems.filter(
    (item) => item.stateCategory !== "Completed" && item.stateCategory !== "Removed"
  );

  const workItems: Dashboard["sections"]["workItems"] =
    workItemsSection.status === "ok"
      ? { ...workItemsSection, data: openWorkItems }
      : { ...workItemsSection, data: null };

  const time = await nudges;
  const reviewedResults = sectionData(reviewed, []);
  const recommendations = [
    ...buildRecommendations({
      workItems: allWorkItems,
      compliance: reviewedResults,
      pullRequests: sectionData(pullRequests, []),
      builds: sectionData(pipelines, []),
      now,
    }),
    // Time-tracking nudges, when a Solidtime connection is linked to this organization.
    ...time.nudges,
  ].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // The paged My work table reads these rows instead of re-running every SOP check per page.
  if (workItemsSection.status === "ok" && compliance.status === "ok") {
    rememberMyWork(userId, client.credentialId, projectName, {
      workItems: allWorkItems,
      compliance: sectionData(compliance, []),
      // Built the same way as a cold My work load, so a ticket's signals do not depend on which path filled the list.
      recommendations: myWorkRecommendations(allWorkItems, reviewedResults, time.nudges, now),
      sprints,
      workItemsTruncated,
    }, now.getTime());
  }

  // The paged dashboard lists (actions, pull requests, pipeline runs) read these.
  rememberDashboardLists(userId, client.credentialId, projectName, {
    recommendations,
    pullRequests: pullRequests.data,
    builds: pipelines.data,
    completeness,
  }, now.getTime());

  // The notifications read after this see what this read found (and lose what it found fixed).
  await updateNotifications(client, userId, now, {
    recommendations,
    builds: sectionData(pipelines, []),
    workItems: allWorkItems,
    compliance: reviewed.status === "ok" ? reviewedResults : [],
    time,
    projectName,
    workItemsRead: workItemsSection.status === "ok" && reviewed.status === "ok",
    pullRequests: pullRequests.status === "ok" ? sectionData(pullRequests, []) : null,
  });

  return {
    identity,
    generatedAt: now.toISOString(),
    projectName: projectName ?? null,
    projectsScanned: projectIds.length,
    projectsTruncated: projects.truncated,
    sections: {
      workItems,
      pullRequests,
      pipelines,
      compliance: reviewed,
    },
    recommendations,
    stateLookupFailed: stateLookupFailures(allWorkItems),
    workItemsTruncated,
    completeness,
  };
}

/** My latest runs across the projects. A project without builds (not found) has none; one that cannot be read is reported, unless none can. */
async function readMyBuilds(
  client: AzureClient,
  identity: Dashboard["identity"],
  projects: ScopedProject[],
  now: Date
): Promise<{ builds: BuildSummary[]; completeness: ReadCompleteness }> {
  const failures: Array<{ name: string; error: unknown }> = [];
  let truncated = false;

  const perProject = await mapWithLimit(projects, createLimiter(4), async (project) => {
    try {
      const read = await listMyLatestBuilds(client, identity, project.id, now);
      truncated ||= read.truncated;
      return read.builds;
    } catch (error) {
      if (error instanceof AzureApiError && error.reason === "AZURE_NOT_FOUND") {
        return [] as BuildSummary[];
      }

      if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
        throw error;
      }

      logFallback(`Reading the pipeline runs of ${project.name} failed`, error);
      failures.push({ name: project.name, error });
      return [] as BuildSummary[];
    }
  });

  if (failures.length > 0 && failures.length === projects.length) {
    throw failures[0]!.error;
  }

  return {
    builds: perProject.flat().sort((a, b) => (b.queueTime ?? "").localeCompare(a.queueTime ?? "")),
    completeness: readCompleteness(
      "Pipeline runs",
      { truncated, cap: RECENT_BUILDS_TOP, failedProjects: failures.map((failure) => failure.name) },
      `You had more than ${RECENT_BUILDS_TOP} runs in a project in the last week; older ones are not listed.`
    ),
  };
}

async function updateNotifications(
  client: AzureClient,
  userId: string,
  now: Date,
  read: Omit<Parameters<typeof notificationCandidates>[0], "flaggedNoTime" | "previousGaps"> & {
    projectName: string | undefined;
    workItemsRead: boolean;
    pullRequests: PullRequestSummary[] | null;
  }
): Promise<void> {
  try {
    const stored = await storedClosedTickets(userId, client.credentialId);
    const candidates = notificationCandidates({ ...read, ...stored });

    await syncNotifications(
      userId,
      client.credentialId,
      candidates,
      {
        projectName: read.projectName,
        workItemsRead: read.workItemsRead,
        // Only tickets whose open/closed state Azure confirmed: a guessed one is re-checked, never taken as fixed.
        readTicketIds: new Set(read.workItems.filter((item) => item.stateCategorySource !== "guessed").map((item) => item.id)),
        readPullRequests: new Map((read.pullRequests ?? []).map((pr) => [`pr:${pr.repositoryId}:${pr.pullRequestId}`, { threadsRead: pr.unresolvedThreads !== null, mergeKnown: pr.mergeStatus !== null && pr.mergeStatus !== "queued" && pr.mergeStatus !== "notSet" }])),
        // Passed means a finished, successful run: one still running, canceled or partly passed proves nothing.
        readPipelines: new Map(read.builds.flatMap((build) => (build.projectName ? [[pipelineNotificationKey(build.projectName, build), { passed: build.status === "completed" && build.result === "succeeded" }]] : []))),
      },
      read.time,
      {
        // Closed tickets outside the dashboard's window: read again by id, checked the same way.
        recheckClosedTickets: async (ids) => {
          try {
            const raw = await getWorkItemsByIds(client, ids);
            const summaries = await toWorkItemSummaries(client, raw);
            const records = summaries.map((summary, index) => ({ summary, raw: raw[index]! }));
            const checked = await applyAiReviews(userId, client.credentialId, await checkCompliance(client, userId, records, now), new Map(summaries.map((item) => [item.id, item.rev])));
            const candidates = closedTicketCandidates(summaries, checked, { time: read.time, ...stored });
            // Azure leaves out tickets it will not show (deleted or no longer visible to this PAT), and a ticket
            // whose states could not be read only has a guessed open/closed: unknown, so kept.
            const confirmed = new Set(summaries.filter((item) => item.stateCategorySource !== "guessed").map((item) => item.id));
            return { candidates, unchecked: new Set(ids.filter((id) => !confirmed.has(id))) };
          } catch (error) {
            logFallback("Re-checking closed tickets for notifications failed", error);
            return null;
          }
        },
        // Pull requests not in the read (beyond its limit, or no longer active): fixed once completed or abandoned.
        recheckPullRequests: async (pullRequests) => {
          const closed = new Set<string>();
          await mapWithLimit(pullRequests, createLimiter(4), async (pr) => {
            try {
              const raw = await getPullRequest(client, pr.projectName, pr.repositoryId, pr.id);
              if (raw.status !== "active") closed.add(pr.key);
            } catch (error) {
              // Not found may only mean the project was renamed: unknown, so kept.
              logFallback(`Re-checking PR ${pr.id} for notifications failed`, error);
            }
          });
          return closed;
        },
      }
    );
  } catch (error) {
    // Notifications never fail the dashboard; the list shows what was stored before.
    logFallback("Updating notifications failed", error);
  }
}
