import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { htmlToText } from "../../lib/html-to-text.js";
import type { SupportedWorkFields, WorkItemDetail, WorkItemFamily, WorkItemSummary } from "../../types/azure.types.js";
import { getEffectiveRulebook, isCloseAfterMergeAllowed } from "../sop/rulebook.service.js";
import { clearAzureCache } from "../../lib/azure/cache.js";
import { applyAiReviews } from "../sop/ai/sop-ai-review.js";
import { forgetDashboardLists } from "../work-item-list/dashboard-lists.service.js";
import { forgetMyWorkSnapshots, myWorkIsBehind } from "../work-item-list/my-work.service.js";
import { toHeading, unreadableHeading } from "../work-item-list/grouping.js";
import { getIdentity } from "./identity.service.js";
import { evaluateTicket } from "../sop/sop-evaluator.js";
import { asString } from "./mappers.js";
import { sectionData, toSection } from "./section.js";
import {
  WORK_ITEM_FIELDS,
  getLinkedPullRequests,
  getSupportedFields,
  getWorkFieldHistory,
  getWorkItem,
  getWorkItemComments,
  getWorkItemTypeStates,
  getWorkItemsByIds,
  toWorkItemSummaries,
  toWorkItemSummary,
  workItemProjectName,
  workItemType,
} from "./work-items.service.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_SUPPORTED_FIELDS: SupportedWorkFields = {
  originalEstimate: false,
  remainingWork: false,
  completedWork: false,
  storyPoints: false,
  effort: false,
  priority: false,
};

/** Project ids in routes may be a name or a GUID; work items only carry the name. */
export function belongsToProject(projectId: string, projectName: string): boolean {
  return GUID_PATTERN.test(projectId) || projectId.toLowerCase() === projectName.toLowerCase();
}

/**
 * One ticket as it is in Azure now. Its data (fields, comments, history, pull
 * requests) is always read fresh, never from the minute-long list cache, so a
 * change made in Azure shows on the next load; type metadata stays cached.
 */
export async function getWorkItemDetail(
  cachedClient: AzureClient,
  userId: string,
  projectId: string,
  workItemId: number
): Promise<WorkItemDetail> {
  const client = cachedClient.withFreshData();
  const raw = await getWorkItem(client, workItemId);
  const projectName = workItemProjectName(raw);

  if (!belongsToProject(projectId, projectName)) {
    throw new AzureApiError("AZURE_NOT_FOUND", 404);
  }

  const type = workItemType(raw);

  const [states, supportedFields] = await Promise.all([
    toSection(() => getWorkItemTypeStates(client, projectName, type)),
    toSection(() => getSupportedFields(client, projectName, type)),
  ]);

  // States that could not be read: open/closed is guessed from the state name (stateCategorySource "guessed").
  const summary = toWorkItemSummary(raw, states.status === "ok" ? sectionData(states, []) : null, client.organizationUrl);

  // Changed in Azure since the lists were built: drop them, so My work and the dashboard show it too.
  if (myWorkIsBehind(userId, client.credentialId, summary.id, summary.rev)) {
    forgetMyWorkSnapshots(userId, client.credentialId);
    forgetDashboardLists(userId, client.credentialId);
    clearAzureCache(client.credentialId);
  }

  const [comments, historyRead, linkedPullRequests, compliance, closeAfterMergeAllowed, family] = await Promise.all([
    toSection(() => getWorkItemComments(client, projectName, workItemId)),
    toSection(() => getWorkFieldHistory(client, projectName, workItemId, { rev: raw.rev })),
    toSection(() => getLinkedPullRequests(client, summary.links.pullRequests)),
    getEffectiveRulebook(userId)
      .then((rulebook) => evaluateTicket(client, rulebook, summary, raw, new Date()))
      .then(async (result) => (await applyAiReviews(userId, client.credentialId, [result], new Map([[summary.id, summary.rev]])))[0] ?? result),
    isCloseAfterMergeAllowed(projectName),
    toSection(() => readFamily(client, summary)),
  ]);

  return {
    ...summary,
    description: htmlToText(asString(raw.fields[WORK_ITEM_FIELDS.description])),
    acceptanceCriteria: htmlToText(asString(raw.fields[WORK_ITEM_FIELDS.acceptanceCriteria])),
    reproSteps: htmlToText(asString(raw.fields[WORK_ITEM_FIELDS.reproSteps])),
    comments,
    history: { ...historyRead, data: historyRead.data?.changes ?? null },
    historyTruncated: historyRead.data?.truncated ?? false,
    linkedPullRequests,
    allowedStates: sectionData(states, []),
    supportedFields: sectionData(supportedFields, NO_SUPPORTED_FIELDS),
    compliance,
    closeAfterMergeAllowed,
    family,
  };
}

/** The parent (whoever it belongs to) and the children: mine by name, other people's only counted. */
async function readFamily(client: AzureClient, summary: WorkItemSummary): Promise<WorkItemFamily> {
  const { parentId, childIds } = summary.links;

  if (parentId === null && childIds.length === 0) {
    return { parent: null, parentIsMine: false, myChildren: [], otherChildren: 0 };
  }

  const [identity, related] = await Promise.all([
    getIdentity(client),
    toWorkItemSummaries(client, await getWorkItemsByIds(client, [...(parentId === null ? [] : [parentId]), ...childIds])),
  ]);
  const parent = parentId === null ? null : (related.find((item) => item.id === parentId) ?? null);
  const children = related.filter((item) => childIds.includes(item.id));
  const mine = children.filter((item) => item.assignedTo?.id === identity.id);

  return {
    parentIsMine: parent?.assignedTo?.id === identity.id,
    parent: parent ? toHeading(parent) : parentId === null ? null : unreadableHeading(parentId),
    myChildren: mine.sort((a, b) => (b.changedDate ?? "").localeCompare(a.changedDate ?? "")).map(toHeading),
    otherChildren: children.length - mine.length,
  };
}
