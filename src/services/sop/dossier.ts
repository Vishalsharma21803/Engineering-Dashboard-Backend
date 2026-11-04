import type { AzureClient } from "../../lib/azure/client.js";
import type { RawWorkItem, RawWorkItemUpdate } from "../../lib/azure/azure-api.types.js";
import { parseArtifactLink } from "../../lib/azure/artifact-links.js";
import { AzureApiError } from "../../lib/azure/errors.js";
import { htmlToText } from "../../lib/html-to-text.js";
import { logFallback } from "../../lib/log-fallback.js";
import type { IdentityRef, WorkItemComment, WorkItemSummary } from "../../types/azure.types.js";
import { asNumber, asString, requireIdentityRef, stripRefPrefix, toIdentityRef } from "../azure/mappers.js";
import { countUnresolvedThreads, getPullRequest, getThreads } from "../azure/pull-requests.service.js";
import {
  WORK_ITEM_FIELDS,
  getWorkItemsByIds,
  readWorkItemComments,
  readWorkItemUpdates,
  updateDate,
  workItemProjectName,
  workItemType,
} from "../azure/work-items.service.js";
import type { ItemKind, ProjectProfile, SopStage } from "./rulebook.types.js";
import { ITEM_KINDS, SOP_STAGES } from "./rulebook.types.js";

/** Extra Azure reads a check may need; only what applicable checks need is fetched. */
export type DossierNeed = "updates" | "comments" | "pullRequests" | "prThreads" | "relatedItems";

export interface StageEntry {
  /** The state (or board column) the ticket moved into. */
  value: string;
  stage: SopStage | null;
  at: Date;
  by: IdentityRef | null;
  /** The creation revision; not a transition anyone comments on. */
  initial: boolean;
  /** Revisions just before this one were not read (very long history): the state it came from is unknown. */
  afterGap?: boolean;
}

export interface FieldChange {
  field: string;
  at: Date;
  by: IdentityRef | null;
  oldValue: unknown;
  newValue: unknown;
}

export interface DossierPullRequest {
  pullRequestId: number;
  title: string;
  status: string;
  createdBy: IdentityRef;
  closedDate: Date | null;
  targetBranch: string | null;
  reviewers: Array<{ id: string | null; displayName: string; vote: number }>;
  /** null when threads were not needed or could not be read. */
  unresolvedThreads: number | null;
}

export interface RelatedItem {
  id: number;
  relation: "parent" | "child" | "related";
  type: string;
  state: string;
  kind: ItemKind | null;
}

/** Everything the SOP checks look at for one ticket. `null` sections could not be loaded. */
export interface TicketDossier {
  workItem: WorkItemSummary;
  fields: Record<string, unknown>;
  profile: ProjectProfile;
  kind: ItemKind | null;
  stage: SopStage | null;
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  hyperlinks: string[];
  attachments: Array<{ name: string; addedAt: Date | null }>;
  branches: Array<{ refName: string; linkedAt: Date | null }>;
  stageHistory: StageEntry[] | null;
  fieldChanges: FieldChange[] | null;
  comments: WorkItemComment[] | null;
  pullRequests: DossierPullRequest[] | null;
  relatedItems: RelatedItem[] | null;
  /**
   * Part of a very long ticket's history (the middle revisions) or its oldest
   * comments were not read. Verdicts are not changed; the ticket says so.
   */
  historyTruncated: boolean;
}

/** Field changes the checks care about (besides the stage field). */
const TRACKED_FIELDS = [
  WORK_ITEM_FIELDS.originalEstimate,
  WORK_ITEM_FIELDS.remainingWork,
  WORK_ITEM_FIELDS.completedWork,
  WORK_ITEM_FIELDS.storyPoints,
  WORK_ITEM_FIELDS.effort,
  WORK_ITEM_FIELDS.dueDate,
  WORK_ITEM_FIELDS.assignedTo,
];

export function kindOf(profile: ProjectProfile, type: string): ItemKind | null {
  const wanted = type.toLowerCase();
  return ITEM_KINDS.find((kind) => profile.workItemTypes[kind].some((name) => name.toLowerCase() === wanted)) ?? null;
}

export function stageOf(profile: ProjectProfile, value: string | null): SopStage | null {
  if (!value) {
    return null;
  }

  const wanted = value.toLowerCase();
  return SOP_STAGES.find((stage) => profile.stages[stage].some((name) => name.toLowerCase() === wanted)) ?? null;
}

export function stageField(profile: ProjectProfile): string {
  return profile.stageSource === "board_column" ? WORK_ITEM_FIELDS.boardColumn : WORK_ITEM_FIELDS.state;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `truncated`: the middle of the history was skipped (see readWorkItemUpdates); the first move after the skipped revisions is marked `afterGap`. */
export function buildStageHistory(profile: ProjectProfile, updates: RawWorkItemUpdate[], options: { truncated?: boolean } = {}): StageEntry[] {
  const field = stageField(profile);
  const entries: StageEntry[] = [];
  let previousId: number | null = null;
  let gap = false;

  for (const update of [...updates].sort((a, b) => a.id - b.id)) {
    // Update ids count the revisions one by one: a jump is where revisions were not read.
    if (options.truncated && previousId !== null && update.id > previousId + 1) gap = true;
    previousId = update.id;
    const change = update.fields?.[field];
    const value = asString(change?.newValue);
    const at = toDate(updateDate(update));

    if (change && value && at) {
      entries.push({
        value,
        stage: stageOf(profile, value),
        at,
        by: toIdentityRef(update.revisedBy),
        initial: change.oldValue === undefined || change.oldValue === null,
        ...(gap ? { afterGap: true } : {}),
      });
      gap = false;
    }
  }

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function buildFieldChanges(profile: ProjectProfile, updates: RawWorkItemUpdate[]): FieldChange[] {
  const tracked = new Set([...TRACKED_FIELDS, ...(profile.fields.targetCompletion ? [profile.fields.targetCompletion] : [])]);
  const changes: FieldChange[] = [];

  for (const update of updates) {
    const at = toDate(updateDate(update));

    if (!at) {
      continue;
    }

    for (const [field, change] of Object.entries(update.fields ?? {})) {
      if (tracked.has(field)) {
        changes.push({ field, at, by: toIdentityRef(update.revisedBy), oldValue: change.oldValue ?? null, newValue: change.newValue ?? null });
      }
    }
  }

  return changes.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const URL_IN_TEXT = /https?:\/\/\S+/i;

function relationTargetId(url: string): number | null {
  const match = /\/workItems\/(\d+)$/i.exec(url);
  return match?.[1] ? Number(match[1]) : null;
}

/** Reads that fail (other than an invalid PAT) leave their section null; dependent checks are skipped. */
async function optional<T>(needed: boolean, what: string, load: () => Promise<T>): Promise<T | null> {
  if (!needed) {
    return null;
  }

  try {
    return await load();
  } catch (error) {
    if (error instanceof AzureApiError && error.reason === "AZURE_PAT_INVALID") {
      throw error;
    }

    // The dependent checks show as "not checked"; the log says why (rate limit, permissions, outage).
    console.warn(`SOP dossier: could not load ${what}:`, error instanceof AzureApiError ? error.reason : error);
    return null;
  }
}

async function loadPullRequests(client: AzureClient, workItem: WorkItemSummary, withThreads: boolean): Promise<DossierPullRequest[]> {
  const results = await Promise.all(
    workItem.links.pullRequests.map(async (link): Promise<DossierPullRequest | null> => {
      try {
        const pr = await getPullRequest(client, link.projectId, link.repositoryId, link.pullRequestId);
        const threads =
          withThreads && pr.status === "completed"
            ? countUnresolvedThreads(await getThreads(client, link.projectId, link.repositoryId, link.pullRequestId))
            : null;

        return {
          pullRequestId: pr.pullRequestId,
          title: pr.title,
          status: pr.status,
          createdBy: requireIdentityRef(pr.createdBy),
          closedDate: toDate(pr.closedDate),
          targetBranch: stripRefPrefix(pr.targetRefName),
          reviewers: (pr.reviewers ?? []).map((reviewer) => ({
            id: reviewer.id ?? null,
            displayName: reviewer.displayName ?? reviewer.uniqueName ?? "Unknown",
            vote: reviewer.vote ?? 0,
          })),
          unresolvedThreads: threads,
        };
      } catch (error) {
        if (error instanceof AzureApiError && error.reason === "AZURE_NOT_FOUND") {
          return null;
        }

        throw error;
      }
    })
  );

  return results.filter((pr): pr is DossierPullRequest => pr !== null);
}

async function loadRelatedItems(client: AzureClient, profile: ProjectProfile, raw: RawWorkItem): Promise<RelatedItem[]> {
  const wanted = new Map<number, RelatedItem["relation"]>();

  for (const relation of raw.relations ?? []) {
    const id = relationTargetId(relation.url);

    if (id === null) {
      continue;
    }

    if (relation.rel === "System.LinkTypes.Hierarchy-Reverse") {
      wanted.set(id, "parent");
    } else if (relation.rel === "System.LinkTypes.Hierarchy-Forward") {
      wanted.set(id, "child");
    } else if (relation.rel.startsWith("System.LinkTypes.") || relation.rel.startsWith("Microsoft.VSTS.Common.")) {
      wanted.set(id, "related");
    }
  }

  if (wanted.size === 0) {
    return [];
  }

  const items = await getWorkItemsByIds(client, [...wanted.keys()]);

  return items.map((item) => {
    const type = workItemType(item);
    return {
      id: item.id,
      relation: wanted.get(item.id) ?? "related",
      type,
      state: asString(item.fields[WORK_ITEM_FIELDS.state]) ?? "",
      kind: kindOf(profile, type),
    };
  });
}

export async function buildDossier(
  client: AzureClient,
  workItem: WorkItemSummary,
  raw: RawWorkItem,
  profile: ProjectProfile,
  needs: Set<DossierNeed>
): Promise<TicketDossier> {
  const projectName = workItemProjectName(raw) || workItem.projectName;
  const fields = raw.fields;
  const relations = raw.relations ?? [];
  const description = htmlToText(asString(fields[WORK_ITEM_FIELDS.description]));

  const [history, commentRead, pullRequests, relatedItems] = await Promise.all([
    optional(needs.has("updates"), `history of #${workItem.id}`, () => readWorkItemUpdates(client, projectName, workItem.id, { rev: raw.rev })),
    optional(needs.has("comments"), `comments of #${workItem.id}`, () => readWorkItemComments(client, projectName, workItem.id)),
    optional(needs.has("pullRequests"), `pull requests of #${workItem.id}`, () => loadPullRequests(client, workItem, needs.has("prThreads"))),
    optional(needs.has("relatedItems"), `linked items of #${workItem.id}`, () => loadRelatedItems(client, profile, raw)),
  ]);
  const updates = history?.updates ?? null;
  const historyTruncated = Boolean(history?.truncated || commentRead?.truncated);

  if (historyTruncated) {
    logFallback(`SOP dossier: #${workItem.id} has a very long history`, new Error("part of its revisions or comments was not read; its SOP results may miss them"));
  }

  return {
    workItem,
    fields,
    profile,
    kind: kindOf(profile, workItem.type),
    stage: stageOf(profile, asString(fields[stageField(profile)])),
    description,
    acceptanceCriteria: htmlToText(asString(fields[WORK_ITEM_FIELDS.acceptanceCriteria])),
    reproSteps: htmlToText(asString(fields[WORK_ITEM_FIELDS.reproSteps])),
    hyperlinks: [
      ...relations.filter((relation) => relation.rel === "Hyperlink").map((relation) => relation.url),
      ...(URL_IN_TEXT.test(description) ? [URL_IN_TEXT.exec(description)?.[0] ?? ""] : []),
    ],
    attachments: relations
      .filter((relation) => relation.rel === "AttachedFile")
      .map((relation) => ({
        name: relation.attributes?.name ?? "attachment",
        addedAt: toDate(relation.attributes?.resourceCreatedDate ?? relation.attributes?.authorizedDate),
      })),
    branches: relations.flatMap((relation) => {
      const artifact = relation.rel === "ArtifactLink" ? parseArtifactLink(relation.url) : null;
      return artifact?.kind === "branch"
        ? [{ refName: stripRefPrefix(artifact.refName) ?? artifact.refName, linkedAt: toDate(relation.attributes?.authorizedDate) }]
        : [];
    }),
    stageHistory: updates ? buildStageHistory(profile, updates, { truncated: history?.truncated ?? false }) : null,
    fieldChanges: updates ? buildFieldChanges(profile, updates) : null,
    comments: commentRead?.comments ?? null,
    pullRequests,
    relatedItems,
    historyTruncated,
  };
}

export function numberField(dossier: TicketDossier, field: string): number | null {
  return asNumber(dossier.fields[field]);
}
