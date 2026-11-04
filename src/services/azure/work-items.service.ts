import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawCommentList,
  RawList,
  RawPullRequest,
  RawWiqlResult,
  RawWorkItem,
  RawWorkItemState,
  RawWorkItemTypeField,
  RawWorkItemUpdate,
} from "../../lib/azure/azure-api.types.js";
import { parseArtifactLink } from "../../lib/azure/artifact-links.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import { htmlToText } from "../../lib/html-to-text.js";
import type {
  LinkedPullRequest,
  StateCategory,
  SupportedWorkFields,
  WorkFieldChange,
  WorkItemComment,
  WorkItemLinks,
  WorkItemSummary,
} from "../../types/azure.types.js";
import { logFallback } from "../../lib/log-fallback.js";
import { complianceConfig } from "../compliance/compliance.config.js";
import { asNumber, asString, requireIdentityRef, toIdentityRef } from "./mappers.js";

export const WORK_ITEM_FIELDS = {
  teamProject: "System.TeamProject",
  type: "System.WorkItemType",
  title: "System.Title",
  state: "System.State",
  reason: "System.Reason",
  assignedTo: "System.AssignedTo",
  iterationPath: "System.IterationPath",
  areaPath: "System.AreaPath",
  tags: "System.Tags",
  createdDate: "System.CreatedDate",
  changedDate: "System.ChangedDate",
  commentCount: "System.CommentCount",
  description: "System.Description",
  priority: "Microsoft.VSTS.Common.Priority",
  stateChangeDate: "Microsoft.VSTS.Common.StateChangeDate",
  closedDate: "Microsoft.VSTS.Common.ClosedDate",
  acceptanceCriteria: "Microsoft.VSTS.Common.AcceptanceCriteria",
  reproSteps: "Microsoft.VSTS.TCM.ReproSteps",
  originalEstimate: "Microsoft.VSTS.Scheduling.OriginalEstimate",
  remainingWork: "Microsoft.VSTS.Scheduling.RemainingWork",
  completedWork: "Microsoft.VSTS.Scheduling.CompletedWork",
  storyPoints: "Microsoft.VSTS.Scheduling.StoryPoints",
  effort: "Microsoft.VSTS.Scheduling.Effort",
  dueDate: "Microsoft.VSTS.Scheduling.DueDate",
  blocked: "Microsoft.VSTS.CMMI.Blocked",
  boardColumn: "System.BoardColumn",
  activity: "Microsoft.VSTS.Common.Activity",
} as const;

const METADATA_CACHE_TTL_MS = 10 * 60_000;
/**
 * Tickets a list reads at most. Lists whose tickets all get SOP checks keep 200 (each check costs
 * several Azure calls); plain lists read more. One more is asked for, so a cut is known.
 */
const SOP_CHECKED_CAP = 200;
const PLAIN_LIST_CAP = { me: 500, any: 1000 } as const;
const BATCH_SIZE = 200;
const UPDATES_PAGE_SIZE = 200;
/** Pages of history read per ticket: the first (creation) and the newest ones; a longer middle is skipped. */
const UPDATES_MAX_PAGES = 5;
const COMMENTS_PAGE_SIZE = 200;
const COMMENTS_MAX_PAGES = 5;
const COMMENTS_API_VERSION = "7.1-preview.4";
const COMPLETED_STATE_NAMES = ["Closed", "Done", "Removed", "Completed", "Cut"];
const REMOVED_STATE_NAMES = ["Removed", "Cut"];
const STATE_CATEGORIES: StateCategory[] = [
  "Proposed",
  "InProgress",
  "Resolved",
  "Completed",
  "Removed",
];

export type WorkItemScope = "open" | "all" | "compliance";

export interface WorkItemQuery {
  projectName?: string | undefined;
  scope: WorkItemScope;
  /** "any" lists the whole project (all assignees); it requires projectName. */
  assignee?: "me" | "any" | undefined;
}

function buildAssignedWiql(query: WorkItemQuery, recentDays: number): string {
  const notCompleted = `[System.State] NOT IN (${COMPLETED_STATE_NAMES.map(
    (name) => `'${name}'`
  ).join(", ")})`;

  const everyone = query.assignee === "any";

  if (everyone && query.projectName === undefined) {
    throw new Error("PROJECT_REQUIRED_FOR_ALL_ASSIGNEES");
  }

  const clauses = everyone ? [] : ["[System.AssignedTo] = @Me"];

  if (query.projectName !== undefined) {
    clauses.push("[System.TeamProject] = @project");
  }

  if (query.scope === "open") {
    clauses.push(notCompleted);
  } else if (query.scope === "compliance") {
    clauses.push(`(${notCompleted} OR [System.ChangedDate] >= @Today - ${recentDays})`);
  } else {
    clauses.push("[System.ChangedDate] >= @Today - 90");
  }

  // Lists show what moved most recently first (what needs attention is ranked by the dashboard's actions).
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
}

/** How many tickets this list reads at most (see SOP_CHECKED_CAP). */
export function workItemListCap(query: WorkItemQuery): number {
  return query.scope === "compliance" ? SOP_CHECKED_CAP : PLAIN_LIST_CAP[query.assignee ?? "me"];
}

/** A list of tickets, most recently changed first; `truncated` when more existed than `cap`. */
export interface CappedList<T> {
  truncated: boolean;
  cap: number;
  items: T[];
}

export async function listAssignedWorkItemIds(
  client: AzureClient,
  query: WorkItemQuery,
  recentDays = complianceConfig.recentlyClosedDays
): Promise<CappedList<number>> {
  const segments =
    query.projectName === undefined
      ? ["_apis", "wit", "wiql"]
      : [query.projectName, "_apis", "wit", "wiql"];
  const cap = workItemListCap(query);

  const result = await client.readPost<RawWiqlResult>(
    segments,
    { query: buildAssignedWiql(query, recentDays) },
    { query: { $top: cap + 1 } }
  );
  const ids = (result.workItems ?? []).map((item) => item.id);

  return { items: ids.slice(0, cap), truncated: ids.length > cap, cap };
}

/**
 * Tickets changed since a day (YYYY-MM-DD) that I ever changed (a comment is a
 * revision by me too), newest change first, at most `top`. Callers check each
 * revision. Being assigned is not enough: it says nothing about that day.
 */
export async function listWorkItemIdsChangedByMeSince(client: AzureClient, sinceDay: string, top: number): Promise<number[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDay)) {
    throw new Error("INVALID_DAY");
  }

  const result = await client.readPost<RawWiqlResult>(
    ["_apis", "wit", "wiql"],
    {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '${sinceDay}' AND [System.ChangedBy] EVER @Me ORDER BY [System.ChangedDate] DESC`,
    },
    { query: { $top: top } }
  );

  return (result.workItems ?? []).map((item) => item.id);
}

export async function getWorkItemsByIds(
  client: AzureClient,
  ids: number[]
): Promise<RawWorkItem[]> {
  const chunks: number[][] = [];

  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    chunks.push(ids.slice(index, index + BATCH_SIZE));
  }

  const results = await mapWithLimit(chunks, createLimiter(4), (chunk) =>
    client.readPost<RawList<RawWorkItem | null>>(
      ["_apis", "wit", "workitemsbatch"],
      // $expand cannot be combined with an explicit field list.
      { ids: chunk, $expand: "relations", errorPolicy: "omit" }
    )
  );

  return results.flatMap((result) =>
    (result.value ?? []).filter((item): item is RawWorkItem => item !== null)
  );
}

export async function getWorkItem(
  client: AzureClient,
  id: number,
  options: { cacheTtlMs?: number } = {}
): Promise<RawWorkItem> {
  return client.get<RawWorkItem>(["_apis", "wit", "workitems", String(id)], {
    query: { $expand: "relations" },
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  });
}

/** Names of the project's enabled work item types. */
export async function listWorkItemTypeNames(client: AzureClient, projectName: string): Promise<string[]> {
  const data = await client.get<RawList<{ name: string; isDisabled?: boolean }>>(
    [projectName, "_apis", "wit", "workitemtypes"],
    { cacheTtlMs: METADATA_CACHE_TTL_MS }
  );

  return (data.value ?? []).filter((type) => !type.isDisabled).map((type) => type.name);
}

export async function getWorkItemTypeStates(
  client: AzureClient,
  projectName: string,
  type: string
): Promise<Array<{ name: string; category: StateCategory }>> {
  const data = await client.get<RawList<RawWorkItemState>>(
    [projectName, "_apis", "wit", "workitemtypes", type, "states"],
    { cacheTtlMs: METADATA_CACHE_TTL_MS }
  );

  return (data.value ?? []).map((state) => ({
    name: state.name,
    category: STATE_CATEGORIES.includes(state.category as StateCategory)
      ? (state.category as StateCategory)
      : "Unknown",
  }));
}

/** Reference names of every field on a work item type. */
export async function getWorkItemTypeFieldNames(
  client: AzureClient,
  projectName: string,
  type: string
): Promise<Set<string>> {
  const data = await client.get<RawList<RawWorkItemTypeField>>(
    [projectName, "_apis", "wit", "workitemtypes", type, "fields"],
    { cacheTtlMs: METADATA_CACHE_TTL_MS }
  );

  return new Set((data.value ?? []).map((field) => field.referenceName));
}

export async function getSupportedFields(
  client: AzureClient,
  projectName: string,
  type: string
): Promise<SupportedWorkFields> {
  const names = await getWorkItemTypeFieldNames(client, projectName, type);

  return {
    originalEstimate: names.has(WORK_ITEM_FIELDS.originalEstimate),
    remainingWork: names.has(WORK_ITEM_FIELDS.remainingWork),
    completedWork: names.has(WORK_ITEM_FIELDS.completedWork),
    storyPoints: names.has(WORK_ITEM_FIELDS.storyPoints),
    effort: names.has(WORK_ITEM_FIELDS.effort),
    priority: names.has(WORK_ITEM_FIELDS.priority),
  };
}

export function workItemProjectName(raw: RawWorkItem): string {
  return asString(raw.fields[WORK_ITEM_FIELDS.teamProject]) ?? "";
}

export function workItemType(raw: RawWorkItem): string {
  return asString(raw.fields[WORK_ITEM_FIELDS.type]) ?? "";
}

function relationTargetId(url: string): number | null {
  const match = /\/workItems\/(\d+)$/i.exec(url);
  return match?.[1] ? Number(match[1]) : null;
}

export function extractLinks(raw: RawWorkItem): WorkItemLinks {
  const links: WorkItemLinks = {
    pullRequests: [],
    commits: [],
    branches: [],
    builds: [],
    parentId: null,
    childIds: [],
  };

  for (const relation of raw.relations ?? []) {
    if (relation.rel === "System.LinkTypes.Hierarchy-Reverse") {
      links.parentId = relationTargetId(relation.url);
      continue;
    }

    if (relation.rel === "System.LinkTypes.Hierarchy-Forward") {
      const childId = relationTargetId(relation.url);

      if (childId !== null) {
        links.childIds.push(childId);
      }

      continue;
    }

    if (relation.rel !== "ArtifactLink") {
      continue;
    }

    const artifact = parseArtifactLink(relation.url);

    if (artifact?.kind === "pullRequest") {
      links.pullRequests.push({
        projectId: artifact.projectId,
        repositoryId: artifact.repositoryId,
        pullRequestId: artifact.pullRequestId,
      });
    } else if (artifact?.kind === "commit") {
      links.commits.push({
        repositoryId: artifact.repositoryId,
        commitId: artifact.commitId,
      });
    } else if (artifact?.kind === "branch") {
      links.branches.push({
        repositoryId: artifact.repositoryId,
        refName: artifact.refName,
      });
    } else if (artifact?.kind === "build") {
      links.builds.push(artifact.buildId);
    }
  }

  return links;
}

/** When a type's states could not be read: closed and removed by their usual names, anything else unknown. */
function guessedCategory(state: string): StateCategory {
  if (REMOVED_STATE_NAMES.includes(state)) return "Removed";
  return COMPLETED_STATE_NAMES.includes(state) ? "Completed" : "Unknown";
}

/** `states` null: the type's states could not be read, so the category is guessed from the state name. */
export function toWorkItemSummary(
  raw: RawWorkItem,
  states: Array<{ name: string; category: StateCategory }> | null,
  organizationUrl: string
): WorkItemSummary {
  const fields = raw.fields;
  const state = asString(fields[WORK_ITEM_FIELDS.state]) ?? "Unknown";
  const projectName = workItemProjectName(raw);
  const tags = (asString(fields[WORK_ITEM_FIELDS.tags]) ?? "")
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean);

  return {
    id: raw.id,
    rev: raw.rev,
    projectName,
    type: workItemType(raw),
    title: asString(fields[WORK_ITEM_FIELDS.title]) ?? "(untitled)",
    state,
    stateCategory:
      states === null ? guessedCategory(state) : (states.find((candidate) => candidate.name === state)?.category ?? "Unknown"),
    stateCategorySource: states === null ? "guessed" : "azure",
    reason: asString(fields[WORK_ITEM_FIELDS.reason]),
    priority: asNumber(fields[WORK_ITEM_FIELDS.priority]),
    assignedTo: toIdentityRef(fields[WORK_ITEM_FIELDS.assignedTo]),
    iterationPath: asString(fields[WORK_ITEM_FIELDS.iterationPath]),
    areaPath: asString(fields[WORK_ITEM_FIELDS.areaPath]),
    tags,
    originalEstimate: asNumber(fields[WORK_ITEM_FIELDS.originalEstimate]),
    remainingWork: asNumber(fields[WORK_ITEM_FIELDS.remainingWork]),
    completedWork: asNumber(fields[WORK_ITEM_FIELDS.completedWork]),
    storyPoints: asNumber(fields[WORK_ITEM_FIELDS.storyPoints]),
    effort: asNumber(fields[WORK_ITEM_FIELDS.effort]),
    dueDate: asString(fields[WORK_ITEM_FIELDS.dueDate]),
    blocked:
      asString(fields[WORK_ITEM_FIELDS.blocked])?.toLowerCase() === "yes" ||
      tags.some((tag) => tag.toLowerCase() === "blocked"),
    createdDate: asString(fields[WORK_ITEM_FIELDS.createdDate]),
    changedDate: asString(fields[WORK_ITEM_FIELDS.changedDate]),
    stateChangeDate: asString(fields[WORK_ITEM_FIELDS.stateChangeDate]),
    closedDate: asString(fields[WORK_ITEM_FIELDS.closedDate]),
    commentCount: asNumber(fields[WORK_ITEM_FIELDS.commentCount]) ?? 0,
    links: extractLinks(raw),
    webUrl: `${organizationUrl}/${encodeURIComponent(projectName)}/_workitems/edit/${raw.id}`,
  };
}

/** Resolves state categories for every (project, type) pair present. */
export async function toWorkItemSummaries(
  client: AzureClient,
  rawItems: RawWorkItem[]
): Promise<WorkItemSummary[]> {
  const metadataLimit = createLimiter(4);
  const pairs = new Map<string, { projectName: string; type: string }>();

  for (const raw of rawItems) {
    const projectName = workItemProjectName(raw);
    const type = workItemType(raw);
    pairs.set(`${projectName}\u0000${type}`, { projectName, type });
  }

  type StateList = Awaited<ReturnType<typeof getWorkItemTypeStates>>;

  const stateEntries = await mapWithLimit(
    [...pairs.entries()],
    metadataLimit,
    async ([key, pair]): Promise<[string, StateList | null]> => {
      try {
        return [key, await getWorkItemTypeStates(client, pair.projectName, pair.type)];
      } catch (error) {
        if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
          throw error;
        }

        // The tickets still show with their state name; open/closed is guessed from it (stateCategorySource "guessed").
        logFallback(`Reading the states of ${pair.type} in ${pair.projectName} failed; open/closed is guessed from the state name`, error);
        return [key, null];
      }
    }
  );

  const statesByPair = new Map(stateEntries);

  return rawItems.map((raw) =>
    toWorkItemSummary(
      raw,
      statesByPair.get(`${workItemProjectName(raw)}\u0000${workItemType(raw)}`) ?? null,
      client.organizationUrl
    )
  );
}

/** "Bug in Alpha" for each ticket type whose states could not be read (its tickets' open/closed is guessed). */
export function stateLookupFailures(items: WorkItemSummary[]): string[] {
  return [...new Set(items.filter((item) => item.stateCategorySource === "guessed").map((item) => `${item.type} in ${item.projectName}`))].sort();
}

export interface WorkItemRecord {
  summary: WorkItemSummary;
  /** All fields, for checks that need more than the summary (description, custom fields). */
  raw: RawWorkItem;
}

export async function listAssignedWorkItemRecords(
  client: AzureClient,
  query: WorkItemQuery
): Promise<CappedList<WorkItemRecord>> {
  const { items: ids, truncated, cap } = await listAssignedWorkItemIds(client, query);

  if (ids.length === 0) {
    return { items: [], truncated, cap };
  }

  const rawItems = await getWorkItemsByIds(client, ids);
  const order = new Map(ids.map((id, index) => [id, index]));
  const summaries = await toWorkItemSummaries(client, rawItems);

  const items = summaries
    .map((summary, index) => ({ summary, raw: rawItems[index] as RawWorkItem }))
    .filter(
      ({ summary }) =>
        query.scope !== "open" ||
        (summary.stateCategory !== "Completed" && summary.stateCategory !== "Removed")
    )
    .sort((a, b) => (order.get(a.summary.id) ?? 0) - (order.get(b.summary.id) ?? 0));

  return { items, truncated, cap };
}

export async function listAssignedWorkItems(
  client: AzureClient,
  query: WorkItemQuery
): Promise<CappedList<WorkItemSummary>> {
  const records = await listAssignedWorkItemRecords(client, query);
  return { ...records, items: records.items.map((record) => record.summary) };
}

/**
 * A ticket's comments, newest first, following Azure's continuation up to
 * COMMENTS_MAX_PAGES pages; `truncated` when older ones were left unread.
 */
export async function readWorkItemComments(
  client: AzureClient,
  projectName: string,
  workItemId: number
): Promise<{ comments: WorkItemComment[]; truncated: boolean }> {
  const raw: NonNullable<RawCommentList["comments"]> = [];
  let continuationToken: string | null = null;
  let truncated = false;

  for (let page = 0; page < COMMENTS_MAX_PAGES; page += 1) {
    const data: RawCommentList = await client.get<RawCommentList>(
      [projectName, "_apis", "wit", "workItems", String(workItemId), "comments"],
      { apiVersion: COMMENTS_API_VERSION, query: { $top: COMMENTS_PAGE_SIZE, order: "desc", ...(continuationToken ? { continuationToken } : {}) } }
    );
    raw.push(...(data.comments ?? []));
    continuationToken = data.continuationToken ?? null;

    if (!continuationToken) {
      break;
    }

    truncated = page === COMMENTS_MAX_PAGES - 1;
  }

  if (truncated) {
    logFallback(`Comments of #${workItemId}`, new Error(`more than ${COMMENTS_MAX_PAGES * COMMENTS_PAGE_SIZE} comments; the oldest were not read`));
  }

  return { comments: toComments(raw), truncated };
}

/** A ticket's comments, newest first (see readWorkItemComments). */
export async function getWorkItemComments(client: AzureClient, projectName: string, workItemId: number): Promise<WorkItemComment[]> {
  return (await readWorkItemComments(client, projectName, workItemId)).comments;
}

function toComments(raw: NonNullable<RawCommentList["comments"]>): WorkItemComment[] {
  const seen = new Set<number>();
  return raw
    .filter((comment) => !comment.isDeleted && !seen.has(comment.id) && Boolean(seen.add(comment.id)))
    .map((comment) => ({
      id: comment.id,
      text: htmlToText(comment.text),
      createdBy: requireIdentityRef(comment.createdBy),
      createdDate: comment.createdDate,
      modifiedDate: comment.modifiedDate ?? null,
    }))
    .sort((a, b) => b.createdDate.localeCompare(a.createdDate));
}

const HISTORY_FIELDS: Record<string, WorkFieldChange["field"]> = {
  [WORK_ITEM_FIELDS.originalEstimate]: "OriginalEstimate",
  [WORK_ITEM_FIELDS.remainingWork]: "RemainingWork",
  [WORK_ITEM_FIELDS.completedWork]: "CompletedWork",
  [WORK_ITEM_FIELDS.state]: "State",
};

function historyValue(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/**
 * A ticket's revisions' field changes, oldest first. Up to UPDATES_MAX_PAGES
 * pages are read: on a ticket with more history (`rev`, its revision count,
 * says so) the first page (creation, early moves) and the newest pages are
 * read and the middle is skipped. `truncated`: some history was not read.
 */
export async function readWorkItemUpdates(
  client: AzureClient,
  projectName: string,
  workItemId: number,
  options: { rev?: number } = {}
): Promise<{ updates: RawWorkItemUpdate[]; truncated: boolean }> {
  const readPage = async (page: number, top = UPDATES_PAGE_SIZE) =>
    (
      await client.get<RawList<RawWorkItemUpdate>>([projectName, "_apis", "wit", "workItems", String(workItemId), "updates"], {
        query: { $top: top, $skip: page * UPDATES_PAGE_SIZE },
      })
    ).value ?? [];
  const rev = options.rev ?? 0;
  // Each revision is one update, so the revision number tells where the newest pages are.
  const lastPage = Math.floor((rev - 1) / UPDATES_PAGE_SIZE);
  const tailStart = rev > UPDATES_PAGE_SIZE * UPDATES_MAX_PAGES ? lastPage - (UPDATES_MAX_PAGES - 2) : 1;
  // One page past the expected end is read when needed, in case the revision count runs ahead of the reads.
  const finalPage = tailStart === 1 ? UPDATES_MAX_PAGES - 1 : lastPage + 1;
  const updates: RawWorkItemUpdate[] = [];
  let page = 0;
  let full = false;

  for (;;) {
    const value = await readPage(page);
    updates.push(...value);
    full = value.length === UPDATES_PAGE_SIZE;

    if (!full || page >= finalPage) {
      break;
    }

    page = page === 0 ? tailStart : page + 1;
  }

  // Every page up to the last one read was full: one more update tells a cut from a history of exactly that length.
  if (full && tailStart === 1) {
    full = (await readPage(page + 1, 1)).length > 0;
  }

  const seen = new Set<number>();
  const unique = updates.filter((update) => !seen.has(update.id) && Boolean(seen.add(update.id))).sort((a, b) => a.id - b.id);
  return { updates: unique, truncated: full || tailStart > 1 };
}

/** When a revision happened; the last revision's revisedDate is a far-future placeholder. */
export function updateDate(update: RawWorkItemUpdate): string {
  return asString(update.fields?.[WORK_ITEM_FIELDS.changedDate]?.newValue) ?? update.revisedDate ?? "";
}

/** Newest first; `truncated` when part of the middle of a long history was not read (see readWorkItemUpdates). */
export async function getWorkFieldHistory(
  client: AzureClient,
  projectName: string,
  workItemId: number,
  options: { rev?: number } = {}
): Promise<{ changes: WorkFieldChange[]; truncated: boolean }> {
  const { updates, truncated } = await readWorkItemUpdates(client, projectName, workItemId, options);
  const changes: WorkFieldChange[] = [];

  for (const update of updates) {
    const revisedDate = updateDate(update);

    for (const [referenceName, field] of Object.entries(HISTORY_FIELDS)) {
      const change = update.fields?.[referenceName];

      if (change) {
        changes.push({
          revisedDate,
          revisedBy: toIdentityRef(update.revisedBy),
          field,
          oldValue: historyValue(change.oldValue),
          newValue: historyValue(change.newValue),
        });
      }
    }
  }

  return { changes: changes.sort((a, b) => b.revisedDate.localeCompare(a.revisedDate)), truncated };
}

export async function getLinkedPullRequests(
  client: AzureClient,
  links: WorkItemLinks["pullRequests"]
): Promise<LinkedPullRequest[]> {
  return Promise.all(
    links.map(async (link) => {
      try {
        const pr = await client.get<RawPullRequest>([
          link.projectId,
          "_apis",
          "git",
          "repositories",
          link.repositoryId,
          "pullrequests",
          String(link.pullRequestId),
        ]);

        return {
          projectId: link.projectId,
          repositoryId: link.repositoryId,
          repositoryName: pr.repository.name,
          pullRequestId: pr.pullRequestId,
          title: pr.title,
          status: pr.status,
          closedDate: pr.closedDate ?? null,
          webUrl: pr.repository.webUrl
            ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`
            : null,
        };
      } catch (error) {
        if (error instanceof AzureApiError && error.reason === "AZURE_NOT_FOUND") {
          return {
            ...link,
            repositoryName: null,
            title: null,
            status: "unavailable",
            closedDate: null,
            webUrl: null,
          };
        }

        throw error;
      }
    })
  );
}
