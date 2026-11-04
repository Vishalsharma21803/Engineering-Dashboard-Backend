import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import type { RawRepository, RawWorkItem } from "../../lib/azure/azure-api.types.js";
import { htmlToText } from "../../lib/html-to-text.js";
import { hasPlaceholder } from "../../lib/placeholders.js";
import { redactSecrets } from "../../lib/redact.js";
import type { ActionVariant, EditableTextField, UpdatableWorkField } from "../../schemas/action.schema.js";
import type { StateCategory } from "../../types/azure.types.js";
import { asNumber, asString, stripRefPrefix } from "../azure/mappers.js";
import { getBuild, getBuildTimeline, getPipelineDefinition } from "../azure/pipelines.service.js";
import { getPullRequest } from "../azure/pull-requests.service.js";
import { belongsToProject } from "../azure/work-item-detail.service.js";
import { getDefaultProjectProfile, isCloseAfterMergeAllowed } from "../sop/rulebook.service.js";
import {
  WORK_ITEM_FIELDS,
  extractLinks,
  getLinkedPullRequests,
  getSupportedFields,
  getWorkItem,
  getWorkItemTypeFieldNames,
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

/** One ticket of a WORK_ITEMS_UPDATE_TIME batch, as stored: the field values to write and what they were in the preview. */
export interface TimeBatchItem {
  projectId: string;
  workItemId: number;
  fields: Record<string, number>;
  expected: ExpectedFields;
}

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

export const TEXT_FIELD_REFERENCE: Record<EditableTextField, string> = {
  title: WORK_ITEM_FIELDS.title,
  description: WORK_ITEM_FIELDS.description,
  acceptanceCriteria: WORK_ITEM_FIELDS.acceptanceCriteria,
};

const TEXT_FIELD_LABEL: Record<EditableTextField, string> = {
  title: "Title",
  description: "Description",
  acceptanceCriteria: "Acceptance criteria",
};

/** Rich-text fields store HTML; the title is plain text. */
export function isHtmlField(field: EditableTextField): boolean {
  return field !== "title";
}

export function splitTags(value: unknown): string[] {
  return (asString(value) ?? "")
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

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

/** AI drafts mark missing facts as [[fill in: …]]; such text must be completed before it can be written. */
function assertNoPlaceholders(text: string): void {
  if (hasPlaceholder(text)) {
    throw invalid("PLACEHOLDER_NOT_FILLED", "Replace every [[fill in: …]] gap with the real information first");
  }
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

export const LINKED_PRS_UNREADABLE = "Linked pull requests could not be checked; nothing was changed. Try again.";

/**
 * Closing after merge is allowed: the project's SOP has no Testing stage after merge, the ticket has linked
 * pull requests, and every one not abandoned is completed. Checked when proposing and again before the write.
 * A linked pull request that cannot be read (404, or the read fails) may not be completed, so it always blocks
 * the close: when proposing, naming the pull request; `refuseUnreadable` (before the write) with "try again".
 */
export async function assertCloseAfterMerge(client: AzureClient, workItem: RawWorkItem, options: { refuseUnreadable?: boolean } = {}): Promise<void> {
  const projectName = workItemProjectName(workItem);
  const links = extractLinks(workItem).pullRequests;

  if (!(await isCloseAfterMergeAllowed(projectName))) {
    throw invalid(
      "CLOSE_AFTER_MERGE_DISABLED",
      `${projectName} has a Testing stage in the SOP rulebook; merged work moves to Testing, not Closed`
    );
  }

  if (links.length === 0) {
    throw invalid("NO_LINKED_PRS", "The work item has no linked pull requests");
  }

  const read = await Promise.all(
    links.map(async (link) => {
      try {
        const pr = (await getLinkedPullRequests(client, [link]))[0]!;
        // getLinkedPullRequests answers a 404 (deleted, or not visible to the PAT) as "unavailable" instead of throwing.
        return pr.status === "unavailable" ? { ...pr, missing: true } : pr;
      } catch (error) {
        // The PAT itself refused: kept as it is, so the credential is marked invalid.
        if (!(error instanceof AzureApiError) || error.reason === "AZURE_PAT_INVALID") {
          throw error;
        }

        console.warn(
          `Reading pull request ${link.pullRequestId} linked to #${workItem.id} failed; closing after merge is refused: ${redactSecrets(
            `${error.message}${error.upstreamMessage ? ` · Azure details: ${error.upstreamMessage}` : ""}`
          )}`
        );
        return { pullRequestId: link.pullRequestId, status: "unavailable", missing: error.reason === "AZURE_NOT_FOUND" };
      }
    })
  );
  const unreadable = read.filter((pr) => pr.status === "unavailable");

  if (unreadable.length > 0) {
    const names = (prs: typeof unreadable) => `${prs.length === 1 ? "Pull request" : "Pull requests"} ${prs.map((pr) => pr.pullRequestId).join(", ")}`;
    // Gone (404) needs the user to act; any other failure may pass, so it only asks to try again.
    const missing = unreadable.filter((pr) => "missing" in pr && pr.missing);
    const failed = unreadable.filter((pr) => !("missing" in pr && pr.missing));
    throw new AppError(
      409,
      "ACTION_LINKED_PRS_UNREADABLE",
      options.refuseUnreadable
        ? LINKED_PRS_UNREADABLE
        : [
            missing.length > 0 ? `${names(missing)} could not be found (deleted, or not visible to your PAT). Close the ticket in Azure DevOps yourself or unlink the PR.` : null,
            failed.length > 0 ? `${names(failed)} could not be checked right now; nothing was proposed. Try again in a moment.` : null,
          ]
            .filter(Boolean)
            .join(" ")
    );
  }

  const linked = read.filter((pr) => pr.status !== "abandoned");

  if (linked.length === 0 || linked.some((pr) => pr.status !== "completed")) {
    throw invalid("PRS_NOT_MERGED", "Not every linked pull request has been completed");
  }
}

export async function prepareAction(
  client: AzureClient,
  action: ActionVariant
): Promise<PreparedAction> {
  switch (action.kind) {
    case "WORK_ITEM_COMMENT": {
      assertNoPlaceholders(action.params.text);
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

    case "WORK_ITEMS_UPDATE_TIME": {
      const items: TimeBatchItem[] = [];
      const preview: PreviewChange[] = [];
      const projects = new Set<string>();

      for (const wanted of action.params.items) {
        const workItem = await loadWorkItemForAction(client, wanted.projectId, wanted.workItemId);
        const projectName = workItemProjectName(workItem);
        const supported = await getSupportedFields(client, projectName, workItemType(workItem));

        if (!supported.completedWork) {
          throw invalid("FIELD_NOT_SUPPORTED", `#${workItem.id}: Completed work is not available on ${workItemType(workItem)} work items`);
        }

        const currentCompleted = asNumber(workItem.fields[WORK_ITEM_FIELDS.completedWork]);

        // Solidtime raises Completed Work, never lowers it: more in Azure may be time logged there directly.
        if (currentCompleted !== null && wanted.completedWork < currentCompleted) {
          throw invalid(
            "WOULD_LOWER_COMPLETED_WORK",
            `#${workItem.id}: Azure has ${currentCompleted} h completed, more than the ${wanted.completedWork} h proposed. Cockpit does not lower Completed Work.`
          );
        }

        const values: Partial<Record<"completedWork" | "remainingWork", number>> = { completedWork: wanted.completedWork };
        if (wanted.remainingWork !== undefined && supported.remainingWork) {
          values.remainingWork = wanted.remainingWork;
        }

        const fields: Record<string, number> = {};
        const expected: ExpectedFields = {};

        for (const [key, value] of Object.entries(values) as Array<["completedWork" | "remainingWork", number]>) {
          const reference = WORK_FIELD_REFERENCE[key];
          const before = asNumber(workItem.fields[reference]);

          if (before !== value) {
            fields[reference] = value;
            expected[reference] = before;
            preview.push({ field: `#${workItem.id} ${WORK_FIELD_LABEL[key]}`, before, after: value });
          }
        }

        if (Object.keys(fields).length > 0) {
          items.push({ projectId: projectName, workItemId: workItem.id, fields, expected });
          projects.add(projectName);
        }
      }

      if (items.length === 0) {
        throw invalid("NO_CHANGES", "Azure already has these hours on every ticket");
      }

      return {
        // One project when they share one; a batch across projects belongs to none of them.
        projectId: projects.size === 1 ? [...projects][0]! : "",
        target: {},
        params: { items },
        preview,
        summary: `Update time on ${items.length} ticket${items.length === 1 ? "" : "s"}: ${items.map((item) => `#${item.workItemId}`).join(", ")}`,
        baseRev: null,
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
            after: `PR ${pr.pullRequestId} ${pr.title} (${pr.repository.name})`,
          },
        ],
        summary: `Link PR ${pr.pullRequestId} to #${workItem.id} ${title(workItem)}`,
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
      await assertCloseAfterMerge(client, workItem);

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

    case "WORK_ITEM_EDIT_TEXT": {
      assertNoPlaceholders(action.params.text);
      const workItem = await loadWorkItemForAction(client, action.target.projectId, action.target.workItemId);
      const { field, text } = action.params;
      const reference = TEXT_FIELD_REFERENCE[field];
      const raw = asString(workItem.fields[reference]);
      const before = isHtmlField(field) ? htmlToText(raw) : (raw ?? "");

      if (before.trim() === text.trim()) {
        throw invalid("NO_CHANGES", `${TEXT_FIELD_LABEL[field]} already has this text`);
      }

      // The new text is plain: say so when the current field has formatting that will be lost.
      const richContent = isHtmlField(field) && /<(img|table|a|ul|ol|pre|code|h[1-6])\b/i.test(raw ?? "");

      return {
        projectId: workItemProjectName(workItem),
        target: workItemTarget(workItem),
        // The stored raw value guards against someone else editing the field meanwhile.
        params: { field, text, expected: { [reference]: raw } },
        preview: [{ field: TEXT_FIELD_LABEL[field], before: before || null, after: text }],
        summary:
          `Replace ${TEXT_FIELD_LABEL[field].toLowerCase()} of #${workItem.id} ${title(workItem)}` +
          (richContent ? " (as plain text: current links, lists, tables and images are not kept)" : ""),
        baseRev: workItem.rev,
      };
    }

    case "WORK_ITEM_SET_CATEGORY": {
      const workItem = await loadWorkItemForAction(client, action.target.projectId, action.target.workItemId);
      const projectName = workItemProjectName(workItem);
      const profile = await getDefaultProjectProfile(projectName);
      const reference = profile?.fields.category ?? null;

      if (!profile || !reference) {
        throw invalid("CATEGORY_NOT_CONFIGURED", `${projectName} has no category field in the SOP rulebook`);
      }

      const category = Object.keys(profile.categories).find((name) => name.toLowerCase() === action.params.category.toLowerCase());

      if (!category) {
        throw invalid("INVALID_CATEGORY", `"${action.params.category}" is not one of ${projectName}'s categories`);
      }

      if (!(await getWorkItemTypeFieldNames(client, projectName, workItemType(workItem))).has(reference)) {
        throw invalid("FIELD_NOT_SUPPORTED", `${workItemType(workItem)} work items have no ${reference} field`);
      }

      const before = asString(workItem.fields[reference]);

      if (before === category) {
        throw invalid("NO_CHANGES", `The category is already ${category}`);
      }

      return {
        projectId: projectName,
        target: workItemTarget(workItem),
        params: { field: reference, value: category, expected: { [reference]: before } },
        preview: [{ field: "Category", before, after: category }],
        summary: `Set category of #${workItem.id} ${title(workItem)} to ${category}`,
        baseRev: workItem.rev,
      };
    }

    case "WORK_ITEM_ADD_TAGS": {
      const workItem = await loadWorkItemForAction(client, action.target.projectId, action.target.workItemId);
      const raw = asString(workItem.fields[WORK_ITEM_FIELDS.tags]);
      const current = splitTags(raw);
      const known = new Set(current.map((tag) => tag.toLowerCase()));
      const added = [...new Map(action.params.tags.map((tag) => [tag.toLowerCase(), tag])).values()].filter(
        (tag) => !known.has(tag.toLowerCase())
      );

      if (added.length === 0) {
        throw invalid("NO_CHANGES", "The work item already has these tags");
      }

      const next = [...current, ...added].join("; ");

      return {
        projectId: workItemProjectName(workItem),
        target: workItemTarget(workItem),
        params: { tags: next, expected: { [WORK_ITEM_FIELDS.tags]: raw } },
        preview: [{ field: "Tags", before: current.join("; ") || null, after: next }],
        summary: `Add tag(s) ${added.join(", ")} to #${workItem.id} ${title(workItem)}`,
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
