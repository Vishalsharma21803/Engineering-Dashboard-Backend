import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawBuild,
  RawBuildDefinition,
  RawList,
  RawTimeline,
  RawTimelineRecord,
} from "../../lib/azure/azure-api.types.js";
import type {
  AzureIdentity,
  BuildSummary,
  BuildTimeline,
  PipelineSummary,
  StageResult,
  TimelineNode,
} from "../../types/azure.types.js";
import { toBuildSummary } from "./mappers.js";

const MAX_DEFINITIONS = 200;
const RECENT_BUILD_DAYS = 7;
const RECENT_BUILDS_TOP = 100;

function pipelineHealth(definition: RawBuildDefinition): PipelineSummary["health"] {
  const latest = definition.latestBuild;

  if (latest && latest.status !== "completed") {
    return "running";
  }

  switch (definition.latestCompletedBuild?.result) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "partiallySucceeded":
      return "partiallySucceeded";
    case "canceled":
      return "canceled";
    default:
      return "never";
  }
}

export async function listPipelines(
  client: AzureClient,
  projectId: string
): Promise<PipelineSummary[]> {
  const data = await client.get<RawList<RawBuildDefinition>>(
    [projectId, "_apis", "build", "definitions"],
    { query: { includeLatestBuilds: true, $top: MAX_DEFINITIONS } }
  );

  return (data.value ?? [])
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      path: definition.path ?? "\\",
      queueStatus: definition.queueStatus ?? null,
      latestBuild: definition.latestBuild ? toBuildSummary(definition.latestBuild) : null,
      latestCompletedBuild: definition.latestCompletedBuild
        ? toBuildSummary(definition.latestCompletedBuild)
        : null,
      health: pipelineHealth(definition),
      webUrl: definition._links?.web?.href ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPipelineDefinition(
  client: AzureClient,
  projectId: string,
  definitionId: number,
  options: { cacheTtlMs?: number } = {}
): Promise<RawBuildDefinition> {
  return client.get<RawBuildDefinition>(
    [projectId, "_apis", "build", "definitions", String(definitionId)],
    options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }
  );
}

export async function listBuilds(
  client: AzureClient,
  projectId: string,
  filter: {
    definitionId?: number | undefined;
    statusFilter?: string | undefined;
    resultFilter?: string | undefined;
    minTime?: string | undefined;
    top?: number | undefined;
  }
): Promise<BuildSummary[]> {
  const data = await client.get<RawList<RawBuild>>(
    [projectId, "_apis", "build", "builds"],
    {
      query: {
        definitions: filter.definitionId,
        statusFilter: filter.statusFilter,
        resultFilter: filter.resultFilter,
        minTime: filter.minTime,
        $top: filter.top ?? 20,
        queryOrder: "queueTimeDescending",
      },
    }
  );

  return (data.value ?? []).map(toBuildSummary);
}

export async function getBuild(
  client: AzureClient,
  projectId: string,
  buildId: number,
  options: { cacheTtlMs?: number } = {}
): Promise<BuildSummary> {
  const raw = await client.get<RawBuild>(
    [projectId, "_apis", "build", "builds", String(buildId)],
    options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }
  );

  return toBuildSummary(raw);
}

/**
 * Latest build per (pipeline, branch) requested by the user in the last
 * week. A failure only counts while no newer run on that branch passed.
 */
export async function listMyLatestBuilds(
  client: AzureClient,
  identity: AzureIdentity,
  projectId: string,
  now = new Date()
): Promise<BuildSummary[]> {
  const minTime = new Date(now.getTime() - RECENT_BUILD_DAYS * 24 * 60 * 60 * 1000);
  const builds = await listBuilds(client, projectId, {
    minTime: minTime.toISOString(),
    top: RECENT_BUILDS_TOP,
  });

  const latest = new Map<string, BuildSummary>();

  for (const build of builds) {
    if (build.requestedFor?.id !== identity.id) {
      continue;
    }

    const key = `${build.definitionId}:${build.sourceBranch ?? ""}`;
    const existing = latest.get(key);

    if (!existing || (build.queueTime ?? "") > (existing.queueTime ?? "")) {
      latest.set(key, build);
    }
  }

  return [...latest.values()].sort((a, b) =>
    (b.queueTime ?? "").localeCompare(a.queueTime ?? "")
  );
}

function toNode(record: RawTimelineRecord): TimelineNode {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    identifier: record.identifier ?? null,
    state: record.state ?? null,
    result: record.result ?? null,
    startTime: record.startTime ?? null,
    finishTime: record.finishTime ?? null,
    errorCount: record.errorCount ?? 0,
    issues: (record.issues ?? [])
      .filter((issue) => issue.type === "error" || issue.type === "warning")
      .slice(0, 20)
      .map((issue) => ({
        type: issue.type ?? "error",
        message: (issue.message ?? "").slice(0, 1000),
      })),
    logId: record.log?.id ?? null,
  };
}

function byOrder(a: RawTimelineRecord, b: RawTimelineRecord): number {
  return (a.order ?? 0) - (b.order ?? 0);
}

export function buildTimelineFromRecords(buildId: number, records: RawTimelineRecord[]): BuildTimeline {
  const children = new Map<string, RawTimelineRecord[]>();

  for (const record of records) {
    if (record.parentId) {
      const list = children.get(record.parentId) ?? [];
      list.push(record);
      children.set(record.parentId, list);
    }
  }

  function descendants(id: string, type: string): RawTimelineRecord[] {
    const result: RawTimelineRecord[] = [];

    for (const child of children.get(id) ?? []) {
      if (child.type === type) {
        result.push(child);
      }

      result.push(...descendants(child.id, type));
    }

    return result.sort(byOrder);
  }

  const stages: StageResult[] = records
    .filter((record) => record.type === "Stage")
    .sort(byOrder)
    .map((stage) => ({
      ...toNode(stage),
      jobs: descendants(stage.id, "Job").map((job) => ({
        ...toNode(job),
        failedTasks: descendants(job.id, "Task")
          .filter((task) => task.result === "failed")
          .map(toNode),
      })),
    }));

  return {
    buildId,
    stages,
    failedStages: stages
      .filter((stage) => stage.result === "failed")
      .map((stage) => stage.identifier ?? stage.name),
  };
}

export async function getBuildTimeline(
  client: AzureClient,
  projectId: string,
  buildId: number,
  options: { cacheTtlMs?: number } = {}
): Promise<BuildTimeline> {
  const data = await client.get<RawTimeline>(
    [projectId, "_apis", "build", "builds", String(buildId), "timeline"],
    options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }
  );

  return buildTimelineFromRecords(buildId, data.records ?? []);
}
