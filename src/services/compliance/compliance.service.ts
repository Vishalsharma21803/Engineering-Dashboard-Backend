import type { AzureClient } from "../../lib/azure/client.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type {
  AzureIdentity,
  ComplianceResult,
  LinkedPullRequest,
  SupportedWorkFields,
  WorkFieldChange,
  WorkItemComment,
  WorkItemSummary,
} from "../../types/azure.types.js";
import {
  getLinkedPullRequests,
  getSupportedFields,
  getWorkFieldHistory,
  getWorkItemComments,
  listAssignedWorkItems,
} from "../azure/work-items.service.js";
import { complianceConfig } from "./compliance.config.js";
import { evaluateCompliance, requiredData, type RuleData } from "./rules.js";

export interface LoadedRuleData {
  comments: WorkItemComment[] | null;
  history: WorkFieldChange[] | null;
  linkedPullRequests: LinkedPullRequest[] | null;
  supportedFields: SupportedWorkFields | null;
}

async function optional<T>(needed: boolean, fn: () => Promise<T>): Promise<T | null> {
  if (!needed) {
    return null;
  }

  try {
    return await fn();
  } catch (error) {
    if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
      throw error;
    }

    return null;
  }
}

export async function loadRuleData(
  client: AzureClient,
  workItem: WorkItemSummary,
  needs: Set<RuleData>
): Promise<LoadedRuleData> {
  const [comments, history, linkedPullRequests, supportedFields] = await Promise.all([
    optional(needs.has("comments"), () =>
      getWorkItemComments(client, workItem.projectName, workItem.id)
    ),
    optional(needs.has("history"), () =>
      getWorkFieldHistory(client, workItem.projectName, workItem.id)
    ),
    optional(needs.has("linkedPullRequests"), () =>
      getLinkedPullRequests(client, workItem.links.pullRequests)
    ),
    optional(needs.has("supportedFields"), () =>
      getSupportedFields(client, workItem.projectName, workItem.type)
    ),
  ]);

  return { comments, history, linkedPullRequests, supportedFields };
}

export async function checkCompliance(
  client: AzureClient,
  identity: AzureIdentity,
  workItems: WorkItemSummary[],
  now = new Date()
): Promise<ComplianceResult[]> {
  // Per request; AzureClient also caps concurrency per credential.
  const complianceLimit = createLimiter(4);

  return mapWithLimit(workItems, complianceLimit, async (workItem) => {
    const data = await loadRuleData(
      client,
      workItem,
      requiredData(workItem, complianceConfig)
    );

    return evaluateCompliance({
      workItem,
      me: identity,
      now,
      config: complianceConfig,
      ...data,
    });
  });
}

export async function listCompliance(
  client: AzureClient,
  identity: AzureIdentity,
  projectName: string | undefined
): Promise<ComplianceResult[]> {
  const workItems = await listAssignedWorkItems(client, {
    projectName,
    scope: "compliance",
  });

  return checkCompliance(client, identity, workItems);
}
