import type { AzureClient } from "../../lib/azure/client.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type { ComplianceResult } from "../../types/azure.types.js";
import { listAssignedWorkItemRecords, type WorkItemRecord } from "../azure/work-items.service.js";
import { applyAiReviews } from "../sop/ai/sop-ai-review.js";
import { getEffectiveRulebook } from "../sop/rulebook.service.js";
import { evaluateTicket } from "../sop/sop-evaluator.js";

/**
 * SOP checks for a user's tickets, judged by their effective rulebook
 * (default rules + their own), code only. `forTeamReports` uses the default rules only.
 */
export async function checkCompliance(
  client: AzureClient,
  userId: string,
  records: WorkItemRecord[],
  now = new Date(),
  options: { forTeamReports?: boolean } = {}
): Promise<ComplianceResult[]> {
  const rulebook = await getEffectiveRulebook(userId, options);
  // Per request; AzureClient also caps concurrency per credential.
  const complianceLimit = createLimiter(4);

  return mapWithLimit(records, complianceLimit, ({ summary, raw }) =>
    evaluateTicket(client, rulebook, summary, raw, now)
  );
}

export async function listCompliance(
  client: AzureClient,
  userId: string,
  projectName: string | undefined
): Promise<ComplianceResult[]> {
  const records = await listAssignedWorkItemRecords(client, {
    projectName,
    scope: "compliance",
  });

  const results = await checkCompliance(client, userId, records);
  return applyAiReviews(userId, client.credentialId, results, new Map(records.map(({ summary }) => [summary.id, summary.rev])));
}
