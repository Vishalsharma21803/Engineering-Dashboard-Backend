import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import type { RawRepository, RawWorkItem } from "../../lib/azure/azure-api.types.js";
import type { ActionVariant, UpdatableWorkField } from "../../schemas/action.schema.js";
import type { StateCategory } from "../../types/azure.types.js";
import { asNumber, asString, stripRefPrefix } from "../azure/mappers.js";
import { getBuild, getBuildTimeline, getPipelineDefinition } from "../azure/pipelines.service.js";
import { getPullRequest } from "../azure/pull-requests.service.js";
import { belongsToProject } from "../azure/work-item-detail.service.js";
import {
  WORK_ITEM_FIELDS,
  extractLinks,
  getLinkedPullRequests,
  getSupportedFields,
  getWorkItem,
  getWorkItemTypeStates,
  workItemProjectName,
  workItemType,
} from "../azure/work-items.service.js";

export interface PreviewChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/** Read-only result of proposing an action. Nothing has been written. */
/**
 * Field values the preview was built from, keyed by Azure reference name.
 * Execution is refused only if one of these changed (not on any revision),
 * so a new comment or an unrelated edit does not invalidate a proposal.
 */
export type ExpectedFields = Record<string, string | number | null>;

export interface PreparedAction {
  projectId: string;
  target: Record<string, string | number>;
  params: Record<string, unknown>;
  preview: PreviewChange[];
  summary: string;
  baseRev: number | null;
}

export const WORK_FIELD_REFERENCE: Record<UpdatableWorkField, string> = {
  originalEstimate: WORK_ITEM_FIELDS.originalEstimate,
  remainingWork: WORK_ITEM_FIELDS.remainingWork,
  completedWork: WORK_ITEM_FIELDS.completedWork,
  storyPoints: WORK_ITEM_FIELDS.storyPoints,
  effort: WORK_ITEM_FIELDS.effort,
  priority: WORK_ITEM_FIELDS.priority,
};

const WORK_FIELD_LABEL: Record<UpdatableWorkField, string> = {
  originalEstimate: "Original estimate (h)",
  remainingWork: "Remaining work (h)",
  completedWork: "Completed work (h)",
  storyPoints: "Story points",
  effort: "Effort",
  priority: "Priority",
};

const RUNNING_BUILD_STATUSES = new Set(["inProgress", "notStarted", "postponed"]);
const RETRYABLE_STAGE_RESULTS = new Set(["failed", "canceled"]);
const PREFERRED_CLOSED_STATES = ["Closed", "Done", "Completed"];

function invalid(reason: string, message: string): AppError {
  return new AppError(422, reason, message);
}

/** Always read fresh state so the preview reflects Azure right now. */
export async function loadWorkItemForAction(
  client: AzureClient,
  projectId: string,
  workItemId: number
): Promise<RawWorkItem> {
  const workItem = await getWorkItem(client, workItemId, { cacheTtlMs: 0 });

  if (!belongsToProject(projectId, workItemProjectName(workItem))) {
    throw new AppError(404, "AZURE_NOT_FOUND", "Work item not found in this project");
  }

  return workItem;
}

function title(workItem: RawWorkItem): string {
  return asString(workItem.fields[WORK_ITEM_FIELDS.title]) ?? "(untitled)";
}

function workItemTarget(workItem: RawWorkItem) {
  return { projectId: workItemProjectName(workItem), workItemId: workItem.id };
}

export function pickClosedState(
  states: Array<{ name: string; category: StateCategory }>
): string | null {
  const completed = states.filter((state) => state.category === "Completed");

  return (
    PREFERRED_CLOSED_STATES.find((name) => completed.some((state) => state.name === name)) ??
    completed[0]?.name ??
    null
  );
}

export async function prepareAction(
  client: AzureClient,
  action: ActionVariant
): Promise<PreparedAction> {
  switch (action.kind) {
    case "WORK_ITEM_COMMENT": {
      const workItem = await loadWorkItemForAction(
        client,
        action.target.projectId,
        action.target.workItemId
      );

      return {
        projectId: workItemProjectName(workItem),
        target: workItemTarget(workItem),
        params: { text: action.params.text },
        preview: [{ field: "New comment", before: null, after: action.params.text }],
        summary: `Add a comment to #${workItem.id} ${title(workItem)}`,
        baseRev: null,
      };
    }

    case "WORK_ITEM_UPDATE_FIELDS": {
      const workItem = await loadWorkItemForAction(
        client,
        action.target.projectId,
        action.target.workItemId
      );
      const projectName = workItemProjectName(workItem);
      const supported = await getSupportedFields(client, projectName, workItemType(workItem));
      const params: Partial<Record<UpdatableWorkField, number>> = {};
      const expected: ExpectedFields = {};
      const preview: PreviewChange[] = [];

      for (const [key, value] of Object.entries(action.params) as Array<
        [UpdatableWorkField, number | undefined]
      >) {
        if (value === undefined) {
          continue;
        }

        if (!supported[key]) {
          throw invalid(
            "FIELD_NOT_SUPPORTED",
            `${WORK_FIELD_LABEL[key]} is not available on ${workItemType(workItem)} work items`
          );
        }

        const before = asNumber(workItem.fields[WORK_FIELD_REFERENCE[key]]);

        if (before !== value) {
          params[key] = value;
          expected[WORK_FIELD_REFERENCE[key]] = before;
          preview.push({ field: WORK_FIELD_LABEL[key], before, after: value });
        }
      }

      if (preview.length === 0) {
        throw invalid("NO_CHANGES", "The work item already has these values");
      }

      return {
        projectId: projectName,
        target: workItemTarget(workItem),
        params: { ...params, expected },
        preview,
        summary: `Update ${preview.map((change) => change.field).join(", ")} on #${workItem.id} ${title(workItem)}`,
        baseRev: workItem.rev,
      };
    }

    case "WORK_ITEM_TRANSITION_STATE": {
      const workItem = await loadWorkItemForAction(
        client,
        action.target.projectId,
        action.target.workItemId
      );
      const projectName = workItemProjectName(workItem);
      const states = await getWorkItemTypeStates(client, projectName, workItemType(workItem));
      const current = asString(workItem.fields[WORK_ITEM_FIELDS.state]);
      const next = states.find((state) => state.name === action.params.state);

      if (!next) {
        throw invalid(
          "INVALID_STATE",
          `"${action.params.state}" is not a state of ${workItemType(workItem)}`
        );
      }

      if (next.name === current) {
        throw invalid("NO_CHANGES", `The work item is already ${current}`);
      }

      return {
        projectId: projectName,
        target: workItemTarget(workItem),
        params: { state: next.name, expected: { [WORK_ITEM_FIELDS.state]: current } },
        preview: [{ field: "State", before: current, after: next.name }],
        summary: `Move #${workItem.id} ${title(workItem)} to ${next.name}`,
        baseRev: workItem.rev,
      };
    }

    case "WORK_ITEM_LINK_PR": {
      const workItem = await loadWorkItemForAction(
        client,
        action.target.projectId,
        action.target.workItemId
      );
      const repository = await client.get<RawRepository & { project?: { id: string } }>(
        ["_apis", "git", "repositories", action.params.repositoryId],
        { cacheTtlMs: 0 }
      );
      const repoProjectId = repository.project?.id;

      if (!repoProjectId) {
        throw invalid("REPOSITORY_NOT_FOUND", "Repository was not found");
      }

      const pr = await getPullRequest(
        client,
        repoProjectId,
        action.params.repositoryId,
        action.params.pullRequestId
      );
      const alreadyLinked = extractLinks(workItem).pullRequests.some(
        (link) =>
          link.repositoryId.toLowerCase() === action.params.repositoryId.toLowerCase() &&
          link.pullRequestId === action.params.pullRequestId
      );

      if (alreadyLinked) {
        throw invalid("ALREADY_LINKED", "This pull request is already linked");
      }

      return {
        projectId: workItemProjectName(workItem),
        target: workItemTarget(workItem),
        params: {
          repositoryId: pr.repository.id,
          pullRequestId: pr.pullRequestId,
          pullRequestProjectId: pr.repository.project.id,
          // Linking touches no field; only "already linked" is re-checked at execution.
          expected: {},
        },
        preview: [
          {
            field: "Linked pull request",
            before: null,
            after: `!${pr.pullRequestId} ${pr.title} (${pr.repository.name})`,
          },
        ],
        summary: `Link PR !${pr.pullRequestId} to #${workItem.id} ${title(workItem)}`,
        baseRev: workItem.rev,
      };
    }

    case "WORK_ITEM_CLOSE_AFTER_MERGE": {
      const workItem = await loadWorkItemForAction(
        client,
        action.target.projectId,
        action.target.workItemId
      );
      const projectName = workItemProjectName(workItem);
      const links = extractLinks(workItem).pullRequests;

      if (links.length === 0) {
        throw invalid("NO_LINKED_PRS", "The work item has no linked pull requests");
      }

      const linked = (await getLinkedPullRequests(client, links)).filter(
        (pr) => pr.status !== "abandoned" && pr.status !== "unavailable"
      );

      if (linked.length === 0 || linked.some((pr) => pr.status !== "completed")) {
        throw invalid("PRS_NOT_MERGED", "Not every linked pull request has been completed");
      }

      const type = workItemType(workItem);
      const [states, supported] = await Promise.all([
        getWorkItemTypeStates(client, projectName, type),
        getSupportedFields(client, projectName, type),
      ]);
      const current = asString(workItem.fields[WORK_ITEM_FIELDS.state]);
      const closedState = pickClosedState(states);

      if (!closedState) {
        throw invalid("INVALID_STATE", `${type} has no completed state`);
      }

      if (states.find((state) => state.name === current)?.category === "Completed") {
        throw invalid("NO_CHANGES", `The work item is already ${current}`);
      }

      const expected: ExpectedFields = { [WORK_ITEM_FIELDS.state]: current };
      const params: Record<string, unknown> = { state: closedState, expected };
      const preview: PreviewChange[] = [{ field: "State", before: current, after: closedState }];
      const remaining = asNumber(workItem.fields[WORK_ITEM_FIELDS.remainingWork]);

      if (supported.remainingWork && remaining !== null && remaining > 0) {
        params.remainingWork = 0;
        expected[WORK_ITEM_FIELDS.remainingWork] = remaining;
        preview.push({ field: WORK_FIELD_LABEL.remainingWork, before: remaining, after: 0 });
      }

      return {
        projectId: projectName,
        target: workItemTarget(workItem),
        params,
        preview,
        summary: `Close #${workItem.id} ${title(workItem)} (all linked PRs merged)`,
        baseRev: workItem.rev,
      };
    }

    case "PIPELINE_QUEUE_RUN": {
      const definition = await getPipelineDefinition(
        client,
        action.target.projectId,
        action.target.definitionId,
        { cacheTtlMs: 0 }
      );
      const sourceBranch = action.params.sourceBranch ?? definition.repository?.defaultBranch;

      if (!sourceBranch) {
        throw invalid("BRANCH_REQUIRED", "The pipeline has no default branch; choose one");
      }

      return {
        projectId: action.target.projectId,
        target: { projectId: action.target.projectId, definitionId: definition.id },
        params: { sourceBranch },
        preview: [
          { field: "Pipeline", before: null, after: definition.name },
          { field: "Branch", before: null, after: stripRefPrefix(sourceBranch) },
        ],
        summary: `Queue ${definition.name} on ${stripRefPrefix(sourceBranch)}`,
        baseRev: null,
      };
    }

    case "BUILD_RETRY_STAGE": {
      const { stage, build } = await loadRetryableStage(
        client,
        action.target.projectId,
        action.target.buildId,
        action.params.stageRefName
      );

      return {
        projectId: action.target.projectId,
        target: { projectId: action.target.projectId, buildId: build.id },
        params: { stageRefName: action.params.stageRefName },
        preview: [{ field: `Stage "${stage.name}"`, before: stage.result, after: "retry" }],
        summary: `Retry stage ${stage.name} of ${build.definitionName} #${build.buildNumber}`,
        baseRev: null,
      };
    }

    case "BUILD_CANCEL": {
      const build = await loadRunningBuild(client, action.target.projectId, action.target.buildId);

      return {
        projectId: action.target.projectId,
        target: { projectId: action.target.projectId, buildId: build.id },
        params: {},
        preview: [{ field: "Status", before: build.status, after: "cancelling" }],
        summary: `Cancel ${build.definitionName} #${build.buildNumber}`,
        baseRev: null,
      };
    }
  }
}

export async function loadRetryableStage(
  client: AzureClient,
  projectId: string,
  buildId: number,
  stageRefName: string
) {
  const [build, timeline] = await Promise.all([
    getBuild(client, projectId, buildId, { cacheTtlMs: 0 }),
    getBuildTimeline(client, projectId, buildId, { cacheTtlMs: 0 }),
  ]);

  const stage = timeline.stages.find((candidate) => candidate.identifier === stageRefName);

  if (!stage) {
    throw invalid("STAGE_NOT_FOUND", `Stage ${stageRefName} was not found in this run`);
  }

  if (build.status !== "completed") {
    throw invalid("BUILD_NOT_COMPLETED", "Stages can only be retried after the run completes");
  }

  if (!RETRYABLE_STAGE_RESULTS.has(stage.result ?? "")) {
    throw invalid("STAGE_NOT_RETRYABLE", `Stage ${stage.name} did not fail`);
  }

  return { build, stage };
}

export async function loadRunningBuild(client: AzureClient, projectId: string, buildId: number) {
  const build = await getBuild(client, projectId, buildId, { cacheTtlMs: 0 });

  if (!RUNNING_BUILD_STATUSES.has(build.status)) {
    throw invalid("BUILD_NOT_RUNNING", "Only queued or running builds can be cancelled");
  }

  return build;
}
