import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { htmlToText } from "../../lib/html-to-text.js";
import type { SupportedWorkFields, WorkItemDetail } from "../../types/azure.types.js";
import { getEffectiveRulebook, isCloseAfterMergeAllowed } from "../sop/rulebook.service.js";
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

export async function getWorkItemDetail(
  client: AzureClient,
  userId: string,
  projectId: string,
  workItemId: number
): Promise<WorkItemDetail> {
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

  const summary = toWorkItemSummary(raw, sectionData(states, []), client.organizationUrl);

  const [comments, history, linkedPullRequests, compliance, closeAfterMergeAllowed] = await Promise.all([
    toSection(() => getWorkItemComments(client, projectName, workItemId)),
    toSection(() => getWorkFieldHistory(client, projectName, workItemId)),
    toSection(() => getLinkedPullRequests(client, summary.links.pullRequests)),
    getEffectiveRulebook(userId).then((rulebook) => evaluateTicket(client, rulebook, summary, raw, new Date())),
    isCloseAfterMergeAllowed(projectName),
  ]);

  return {
    ...summary,
    description: htmlToText(asString(raw.fields[WORK_ITEM_FIELDS.description])),
    acceptanceCriteria: htmlToText(asString(raw.fields[WORK_ITEM_FIELDS.acceptanceCriteria])),
    reproSteps: htmlToText(asString(raw.fields[WORK_ITEM_FIELDS.reproSteps])),
    comments,
    history,
    linkedPullRequests,
    allowedStates: sectionData(states, []),
    supportedFields: sectionData(supportedFields, NO_SUPPORTED_FIELDS),
    compliance,
    closeAfterMergeAllowed,
  };
}
