import { HttpResponse, http, type HttpHandler } from "msw";

import type {
  RawBuild,
  RawBuildDefinition,
  RawComment,
  RawEnvironment,
  RawEnvironmentDeployment,
  RawPullRequest,
  RawRelease,
  RawRepository,
  RawThread,
  RawTimelineRecord,
  RawWorkItem,
  RawWorkItemState,
  RawWorkItemUpdate,
} from "../../src/lib/azure/azure-api.types.js";

/**
 * A small, stateful Azure DevOps organization served through msw.
 * Every request is recorded so tests can prove which calls (and writes)
 * reached "Azure".
 */

export const FAKE_ORG_URL = "https://dev.azure.com/fake-org";
export const FAKE_VSRM_URL = "https://vsrm.dev.azure.com/fake-org";
export const FAKE_PAT = "fake-pat-token-0123456789abcdefghij";

export const ME = { id: "11111111-1111-4111-8111-111111111111", displayName: "Dev Example", uniqueName: "dev@example.com" };
export const OTHER = { id: "22222222-2222-4222-8222-222222222222", displayName: "Reviewer Two", uniqueName: "reviewer@example.com" };

export const ALPHA = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Alpha" };
export const BETA = { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Beta" };
export const ALPHA_REPO = { id: "cccccccc-0000-4000-8000-000000000003", name: "alpha-repo" };
export const BETA_REPO = { id: "dddddddd-0000-4000-8000-000000000004", name: "beta-repo" };

export type ScopeArea = "project" | "work" | "code" | "build" | "release" | "environment";
export type WriteScope = "workWrite" | "buildWrite";

export interface RecordedRequest {
  method: string;
  host: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  isWrite: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const STATES: Record<string, RawWorkItemState[]> = {
  Task: [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Closed", category: "Completed" },
    { name: "Removed", category: "Removed" },
  ],
  Bug: [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Resolved", category: "Resolved" },
    { name: "Closed", category: "Completed" },
  ],
  "User Story": [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Resolved", category: "Resolved" },
    { name: "Closed", category: "Completed" },
    { name: "Removed", category: "Removed" },
  ],
};

const FIELDS: Record<string, string[]> = {
  Task: [
    "Microsoft.VSTS.Scheduling.OriginalEstimate",
    "Microsoft.VSTS.Scheduling.RemainingWork",
    "Microsoft.VSTS.Scheduling.CompletedWork",
    "Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Common.Activity",
  ],
  Bug: [
    "Microsoft.VSTS.Scheduling.StoryPoints",
    "Microsoft.VSTS.Scheduling.RemainingWork",
    "Microsoft.VSTS.Scheduling.CompletedWork",
    "Microsoft.VSTS.Common.Priority",
  ],
  "User Story": ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Common.Priority"],
};

function prRelation(project: { id: string }, repo: { id: string }, prId: number) {
  return {
    rel: "ArtifactLink",
    url: `vstfs:///Git/PullRequestId/${project.id}%2F${repo.id}%2F${prId}`,
    attributes: { name: "Pull Request" },
  };
}

function workItem(
  id: number,
  project: string,
  type: string,
  title: string,
  state: string,
  fields: Record<string, unknown>,
  relations: RawWorkItem["relations"] = []
): RawWorkItem {
  return {
    id,
    rev: 3,
    fields: {
      "System.TeamProject": project,
      "System.WorkItemType": type,
      "System.Title": title,
      "System.State": state,
      "System.AssignedTo": ME,
      "System.CreatedDate": ago(20),
      "System.ChangedDate": ago(1),
      "Microsoft.VSTS.Common.StateChangeDate": ago(10),
      ...fields,
    },
    relations,
  };
}

function build(
  id: number,
  definition: { id: number; name: string },
  status: string,
  result: string | undefined,
  requestedFor: typeof ME,
  queuedDaysAgo: number
): RawBuild {
  return {
    id,
    buildNumber: `2026.${id}`,
    status,
    ...(result ? { result } : {}),
    definition,
    project: ALPHA,
    sourceBranch: "refs/heads/main",
    sourceVersion: `sha${id}`,
    reason: "individualCI",
    requestedFor,
    queueTime: ago(queuedDaysAgo),
    startTime: ago(queuedDaysAgo),
    ...(status === "completed" ? { finishTime: ago(queuedDaysAgo) } : {}),
    _links: { web: { href: `${FAKE_ORG_URL}/Alpha/_build/results?buildId=${id}` } },
  };
}

export function createFakeAzure() {
  const workItems = new Map<number, RawWorkItem>([
    [
      101,
      workItem(101, "Alpha", "Task", "Implement login", "Active", {
        "Microsoft.VSTS.Common.Priority": 1,
        "Microsoft.VSTS.Scheduling.OriginalEstimate": 8,
        "Microsoft.VSTS.Scheduling.RemainingWork": 4,
        "Microsoft.VSTS.Scheduling.CompletedWork": 4,
        "System.Description": "<p>Use <b>JWT</b> &amp; cookies</p><script>alert(1)</script>",
      }, [prRelation(ALPHA, ALPHA_REPO, 1)]),
    ],
    [
      102,
      workItem(102, "Alpha", "Task", "Fix flaky test", "Active", {
        "Microsoft.VSTS.Common.Priority": 2,
        "Microsoft.VSTS.Scheduling.CompletedWork": 0,
      }),
    ],
    [
      103,
      workItem(103, "Alpha", "Bug", "Crash on save", "Resolved", {
        "Microsoft.VSTS.Common.Priority": 2,
        "Microsoft.VSTS.Scheduling.StoryPoints": 3,
        "Microsoft.VSTS.Scheduling.RemainingWork": 1,
      }, [prRelation(ALPHA, ALPHA_REPO, 2)]),
    ],
    [
      104,
      workItem(104, "Beta", "User Story", "Profile page", "Closed", {
        "Microsoft.VSTS.Common.Priority": 3,
        "Microsoft.VSTS.Scheduling.StoryPoints": 5,
        "Microsoft.VSTS.Scheduling.RemainingWork": 2,
        "System.ChangedDate": ago(2),
      }),
    ],
    [
      105,
      {
        ...workItem(105, "Alpha", "Task", "Someone else's task", "Active", {}),
        fields: {
          ...workItem(105, "Alpha", "Task", "Someone else's task", "Active", {}).fields,
          "System.AssignedTo": OTHER,
        },
      },
    ],
    [
      106,
      workItem(106, "Alpha", "Task", "Waiting on vendor", "New", {
        "Microsoft.VSTS.Common.Priority": 2,
        "System.Tags": "Blocked; vendor",
      }),
    ],
  ]);

  const comments = new Map<number, RawComment[]>([
    [101, [{ id: 1, text: "<div>Approach: use JWT in httpOnly cookie</div>", createdBy: ME, createdDate: ago(1) }]],
    [103, [{ id: 2, text: "Approach: guard null document", createdBy: ME, createdDate: ago(5) }]],
    [104, [{ id: 3, text: "Approach: reuse avatar component", createdBy: ME, createdDate: ago(6) }]],
  ]);

  const updates = new Map<number, RawWorkItemUpdate[]>([
    [
      101,
      [
        {
          id: 1,
          rev: 2,
          revisedBy: ME,
          fields: {
            "System.ChangedDate": { newValue: ago(1) },
            "Microsoft.VSTS.Scheduling.RemainingWork": { oldValue: 6, newValue: 4 },
          },
        },
      ],
    ],
  ]);

  const repositories: Array<RawRepository & { project: { id: string; name: string } }> = [
    { ...ALPHA_REPO, defaultBranch: "refs/heads/main", webUrl: `${FAKE_ORG_URL}/Alpha/_git/alpha-repo`, project: ALPHA },
    { ...BETA_REPO, defaultBranch: "refs/heads/main", webUrl: `${FAKE_ORG_URL}/Beta/_git/beta-repo`, project: BETA },
  ];

  const repoRef = (repo: (typeof repositories)[number]) => ({
    id: repo.id,
    name: repo.name,
    webUrl: repo.webUrl ?? "",
    project: repo.project,
  });

  const pullRequests: Array<RawPullRequest & { threads: RawThread[]; workItemIds: number[] }> = [
    {
      pullRequestId: 1,
      title: "Login flow",
      status: "active",
      mergeStatus: "succeeded",
      createdBy: ME,
      creationDate: ago(3),
      sourceRefName: "refs/heads/feature/login",
      targetRefName: "refs/heads/main",
      reviewers: [{ ...OTHER, vote: -5, isRequired: true }],
      repository: repoRef(repositories[0]!),
      threads: [
        { id: 1, status: "active", comments: [{ id: 1, author: OTHER, content: "Handle expiry", commentType: "text" }] },
        { id: 2, status: "active", comments: [{ id: 1, author: OTHER, content: "Rename this", commentType: "text" }] },
        { id: 3, status: "fixed", comments: [{ id: 1, author: OTHER, content: "Typo", commentType: "text" }] },
        { id: 4, comments: [{ id: 1, author: OTHER, content: "voted -5", commentType: "system" }] },
      ],
      workItemIds: [101],
    },
    {
      pullRequestId: 2,
      title: "Fix crash",
      status: "completed",
      mergeStatus: "succeeded",
      createdBy: ME,
      creationDate: ago(6),
      closedDate: ago(3),
      sourceRefName: "refs/heads/fix/crash",
      targetRefName: "refs/heads/main",
      reviewers: [{ ...OTHER, vote: 10 }],
      repository: repoRef(repositories[0]!),
      threads: [],
      workItemIds: [103],
    },
    {
      pullRequestId: 3,
      title: "Refactor settings",
      status: "active",
      mergeStatus: "succeeded",
      createdBy: OTHER,
      creationDate: ago(2),
      sourceRefName: "refs/heads/refactor",
      targetRefName: "refs/heads/main",
      reviewers: [{ ...ME, vote: 0 }],
      repository: repoRef(repositories[0]!),
      threads: [],
      workItemIds: [],
    },
  ];

  const definitions: RawBuildDefinition[] = [
    { id: 10, name: "alpha-ci", path: "\\", queueStatus: "enabled", repository: { defaultBranch: "refs/heads/main" } },
    { id: 11, name: "alpha-deploy", path: "\\", queueStatus: "enabled", repository: { defaultBranch: "refs/heads/main" } },
  ];

  const builds: RawBuild[] = [
    build(501, { id: 10, name: "alpha-ci" }, "completed", "failed", ME, 1),
    build(502, { id: 11, name: "alpha-deploy" }, "completed", "succeeded", ME, 2),
    build(503, { id: 10, name: "alpha-ci" }, "inProgress", undefined, OTHER, 0),
  ];

  const timelines = new Map<number, RawTimelineRecord[]>([
    [
      501,
      [
        { id: "s1", type: "Stage", name: "Build", identifier: "Build", state: "completed", result: "failed", order: 1 },
        { id: "p1", parentId: "s1", type: "Phase", name: "Compile", state: "completed", result: "failed", order: 1 },
        { id: "j1", parentId: "p1", type: "Job", name: "Compile", state: "completed", result: "failed", order: 1 },
        {
          id: "t1",
          parentId: "j1",
          type: "Task",
          name: "npm test",
          state: "completed",
          result: "failed",
          errorCount: 1,
          issues: [{ type: "error", message: "3 tests failed" }],
          log: { id: 7 },
          order: 1,
        },
        { id: "t2", parentId: "j1", type: "Task", name: "npm ci", state: "completed", result: "succeeded", order: 0 },
        { id: "s2", type: "Stage", name: "Deploy", identifier: "Deploy", state: "completed", result: "skipped", order: 2 },
      ],
    ],
  ]);

  const environments: RawEnvironment[] = [{ id: 1, name: "staging" }];
  const environmentDeployments = new Map<number, RawEnvironmentDeployment[]>([
    [1, [{ id: 9, definition: { name: "alpha-deploy" }, stageName: "Deploy", result: "succeeded", startTime: ago(2), finishTime: ago(2), owner: { id: 502 } }]],
  ]);
  const releases: RawRelease[] = [
    { id: 70, name: "Release-70", status: "active", createdOn: ago(4), releaseDefinition: { name: "classic" }, environments: [{ name: "prod", status: "succeeded" }] },
  ];

  const state = {
    patValid: true,
    missingScopes: new Set<ScopeArea | WriteScope>(),
    /** Azure uses 401 (TF400813) for missing scopes on many APIs. */
    scopeErrorStatus: 401 as 401 | 403,
    throttleNext: 0,
    failNextWrite: null as null | number,
    /** Make every write time out (connection dropped after send). */
    dropWrites: false,
    workItems,
    comments,
    updates,
    repositories,
    pullRequests,
    definitions,
    builds,
    timelines,
    environments,
    environmentDeployments,
    releases,
    requests: [] as RecordedRequest[],
    nextCommentId: 100,
    nextBuildId: 900,
    /** Runs before each write is answered (e.g. to change state while Azure is "busy"). */
    beforeWrite: null as (() => Promise<void>) | null,
  };

  return state;
}

export type FakeAzure = ReturnType<typeof createFakeAzure>;

export function writeRequests(fake: FakeAzure): RecordedRequest[] {
  return fake.requests.filter((request) => request.isWrite);
}

const READ_POST_SUFFIXES = ["/_apis/wit/wiql", "/_apis/wit/workitemsbatch"];

function scopeFor(path: string): ScopeArea {
  if (path.includes("/_apis/wit/")) return "work";
  if (path.includes("/_apis/git/") || path.includes("/_apis/policy/")) return "code";
  if (path.includes("/_apis/build/")) return "build";
  if (path.includes("/_apis/release/")) return "release";
  if (path.includes("/_apis/distributedtask/")) return "environment";
  return "project";
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return HttpResponse.json(body as never, { status, headers });
}

function notFound() {
  return json({ message: "Not found" }, 404);
}

export function fakeAzureHandlers(fake: FakeAzure): HttpHandler[] {
  const authorization = `Basic ${Buffer.from(`:${FAKE_PAT}`).toString("base64")}`;

  function resolveProject(segment: string | undefined) {
    if (!segment) return null;
    const value = decodeURIComponent(segment).toLowerCase();
    return [ALPHA, BETA].find((p) => p.id === value || p.name.toLowerCase() === value) ?? null;
  }

  function visibleItem(id: number) {
    return fake.workItems.get(id) ?? null;
  }

  async function handle(request: Request, host: "core" | "vsrm") {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/fake-org/, "");
    const lower = path.toLowerCase();
    const method = request.method;
    const isReadPost = method === "POST" && READ_POST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
    const isWrite = method !== "GET" && !isReadPost;
    let body: unknown = null;

    if (method !== "GET") {
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
    }

    fake.requests.push({ method, host, path, search: url.searchParams, body, isWrite });

    if (request.headers.get("authorization") !== authorization || !fake.patValid) {
      return new HttpResponse(null, { status: 401 });
    }

    if (fake.throttleNext > 0) {
      fake.throttleNext -= 1;
      return json({ message: "throttled" }, 429, { "Retry-After": "0" });
    }

    if (lower === "/_apis/connectiondata") {
      return json({
        authenticatedUser: {
          id: ME.id,
          providerDisplayName: ME.displayName,
          properties: { Account: { $value: ME.uniqueName } },
        },
      });
    }

    const area = scopeFor(lower);

    if (fake.missingScopes.has(area)) {
      return new HttpResponse(null, { status: fake.scopeErrorStatus });
    }

    if (isWrite && fake.beforeWrite) {
      await fake.beforeWrite();
    }

    if (isWrite) {
      const writeScope: WriteScope | null = area === "work" ? "workWrite" : area === "build" ? "buildWrite" : null;

      if (writeScope && fake.missingScopes.has(writeScope)) {
        return new HttpResponse(null, { status: fake.scopeErrorStatus });
      }

      if (fake.failNextWrite !== null) {
        const status = fake.failNextWrite;
        fake.failNextWrite = null;
        return json({ message: "TF401320: Rule Error for field Remaining Work" }, status);
      }

      if (fake.dropWrites) {
        return HttpResponse.error();
      }
    }

    const segments = path.split("/").filter(Boolean);
    const segmentsLower = segments.map((s) => s.toLowerCase());
    const apisIndex = segmentsLower.indexOf("_apis");
    const before = segments.slice(0, apisIndex);
    const rest = segmentsLower.slice(apisIndex + 1);
    const restRaw = segments.slice(apisIndex + 1);
    const project = resolveProject(before[0]);

    if (before.length > 0 && !project) {
      return notFound();
    }

    // ---- projects & teams ----
    if (rest[0] === "projects" && method === "GET") {
      if (rest.length === 1) {
        const top = Number(url.searchParams.get("$top") ?? 100);
        const start = Number(url.searchParams.get("continuationToken") ?? 0);
        const all = [ALPHA, BETA].map((p) => ({ ...p, state: "wellFormed", visibility: "private", lastUpdateTime: ago(1) }));
        const page = all.slice(start, start + top);
        const headers: Record<string, string> =
          start + top < all.length ? { "x-ms-continuationtoken": String(start + top) } : {};
        return json({ count: page.length, value: page }, 200, headers);
      }

      const target = resolveProject(restRaw[1]);
      if (!target) return notFound();

      if (rest[2] === "teams") {
        return json({ value: [{ id: `${target.id}-team`, name: `${target.name} Team` }] });
      }

      return json({
        ...target,
        state: "wellFormed",
        visibility: "private",
        defaultTeam: { id: `${target.id}-team`, name: `${target.name} Team` },
        capabilities: { processTemplate: { templateName: "Agile" }, versioncontrol: { sourceControlType: "Git" } },
      });
    }

    if (rest[0] === "work" && rest[1] === "teamsettings") {
      return json({ value: [{ id: "it-1", name: "Sprint 12", path: "Alpha\\Sprint 12", attributes: { startDate: ago(5), finishDate: ago(-5) } }] });
    }

    // ---- work items ----
    if (rest[0] === "wit") {
      if (rest[1] === "wiql" && method === "POST") {
        const query = String((body as { query?: string })?.query ?? "");

        if (query.includes("[System.Id] = 0")) {
          return json({ workItems: [] });
        }

        const openOnly = query.includes("NOT IN") && !query.includes(" OR ");
        const ids = [...fake.workItems.values()]
          .filter(
            (item) =>
              !query.includes("[System.AssignedTo] = @Me") ||
              (item.fields["System.AssignedTo"] as { id?: string })?.id === ME.id
          )
          .filter((item) => !project || item.fields["System.TeamProject"] === project.name)
          .filter((item) => !openOnly || !["Closed", "Done", "Removed"].includes(String(item.fields["System.State"])))
          .map((item) => ({ id: item.id }));

        return json({ workItems: ids });
      }

      if (rest[1] === "workitemsbatch" && method === "POST") {
        const ids = ((body as { ids?: number[] })?.ids ?? []);
        return json({ value: ids.map((id) => visibleItem(id)).filter(Boolean) });
      }

      if (rest[1] === "workitemtypes") {
        const type = decodeURIComponent(restRaw[2] ?? "");

        if (!type) {
          return json({ value: Object.keys(STATES).map((name) => ({ name, isDisabled: false })) });
        }

        if (rest[3] === "states") {
          return STATES[type] ? json({ value: STATES[type] }) : notFound();
        }

        if (rest[3] === "fields") {
          return FIELDS[type]
            ? json({ value: [...FIELDS[type]!, "System.Title", "System.State"].map((referenceName) => ({ referenceName })) })
            : notFound();
        }
      }

      if (rest[1] === "workitems") {
        const id = Number(rest[2]);
        const item = visibleItem(id);
        if (!item) return notFound();

        if (rest[3] === "comments") {
          if (method === "POST") {
            const text = String((body as { text?: string })?.text ?? "");
            const comment: RawComment = { id: fake.nextCommentId++, text, createdBy: ME, createdDate: new Date().toISOString() };
            fake.comments.set(id, [...(fake.comments.get(id) ?? []), comment]);
            item.fields["System.CommentCount"] = (fake.comments.get(id) ?? []).length;
            // Like Azure DevOps, a comment creates a new work item revision.
            item.rev += 1;
            return json(comment);
          }

          return json({ comments: [...(fake.comments.get(id) ?? [])].reverse(), totalCount: (fake.comments.get(id) ?? []).length });
        }

        if (rest[3] === "updates") {
          const skip = Number(url.searchParams.get("$skip") ?? 0);
          const top = Number(url.searchParams.get("$top") ?? 200);
          return json({ value: (fake.updates.get(id) ?? []).slice(skip, skip + top) });
        }

        if (method === "PATCH") {
          if (request.headers.get("content-type") !== "application/json-patch+json") {
            return json({ message: "Unsupported content type" }, 415);
          }

          const operations = (body ?? []) as Array<{ op: string; path: string; value: unknown }>;

          for (const operation of operations) {
            if (operation.op === "test" && operation.path === "/rev" && operation.value !== item.rev) {
              return json({ message: "TF401289: The test operation failed" }, 412);
            }
          }

          for (const operation of operations) {
            if (operation.op !== "add") continue;

            if (operation.path.startsWith("/fields/")) {
              item.fields[operation.path.slice("/fields/".length)] = operation.value;
            } else if (operation.path === "/relations/-") {
              item.relations = [...(item.relations ?? []), operation.value as never];
            }
          }

          item.rev += 1;
          item.fields["System.ChangedDate"] = new Date().toISOString();
          return json(item);
        }

        return json(item);
      }
    }

    // ---- git / PRs ----
    if (rest[0] === "git") {
      if (rest[1] === "repositories" && rest.length === 2) {
        return json({ value: fake.repositories.filter((repo) => !project || repo.project.id === project.id) });
      }

      if (rest[1] === "repositories") {
        const repo = fake.repositories.find((candidate) => candidate.id === rest[2]);
        if (!repo) return notFound();

        if (rest.length === 3) return json(repo);

        if (rest[3] === "refs") {
          return json({ value: [{ name: "refs/heads/main", objectId: "abc", creator: ME }, { name: "refs/heads/feature/login", objectId: "def", creator: ME }] });
        }

        if (rest[3] === "commits") {
          return json({ value: [{ commitId: "abc123", author: { name: ME.displayName, email: ME.uniqueName, date: ago(1) }, comment: "Add login" }] });
        }

        if (rest[3] === "pullrequests") {
          const pr = fake.pullRequests.find((candidate) => candidate.pullRequestId === Number(rest[4]) && candidate.repository.id === repo.id);
          if (!pr) return notFound();

          if (rest[5] === "threads") return json({ value: pr.threads });
          if (rest[5] === "workitems") return json({ value: pr.workItemIds.map((id) => ({ id: String(id) })) });

          const { threads: _threads, workItemIds: _ids, ...rawPr } = pr;
          return json(rawPr);
        }
      }

      if (rest[1] === "pullrequests") {
        const status = url.searchParams.get("searchCriteria.status");
        const creatorId = url.searchParams.get("searchCriteria.creatorId");
        const reviewerId = url.searchParams.get("searchCriteria.reviewerId");

        const matches = fake.pullRequests
          .filter((pr) => !project || pr.repository.project.id === project.id)
          .filter((pr) => !status || status === "all" || pr.status === status)
          .filter((pr) => !creatorId || pr.createdBy?.id === creatorId)
          .filter((pr) => !reviewerId || (pr.reviewers ?? []).some((reviewer) => reviewer.id === reviewerId))
          .map(({ threads: _threads, workItemIds: _ids, ...rawPr }) => rawPr);

        return json({ value: matches });
      }
    }

    if (rest[0] === "policy" && rest[1] === "evaluations") {
      return json({ value: [{ status: "approved", configuration: { isBlocking: true, isEnabled: true, type: { displayName: "Minimum number of reviewers" } } }] });
    }

    // ---- builds ----
    if (rest[0] === "build") {
      // All seeded pipelines live in Alpha.
      if (project && project.id !== ALPHA.id && method === "GET") {
        return rest.length === 2 ? json({ value: [] }) : notFound();
      }

      if (rest[1] === "definitions") {
        const withLatest = (definition: RawBuildDefinition) => {
          const runs = fake.builds
            .filter((candidate) => candidate.definition?.id === definition.id)
            .sort((a, b) => (b.queueTime ?? "").localeCompare(a.queueTime ?? ""));
          return {
            ...definition,
            ...(runs[0] ? { latestBuild: runs[0] } : {}),
            ...(runs.find((run) => run.status === "completed") ? { latestCompletedBuild: runs.find((run) => run.status === "completed") } : {}),
          };
        };

        if (rest.length === 2) return json({ value: fake.definitions.map(withLatest) });

        const definition = fake.definitions.find((candidate) => candidate.id === Number(rest[2]));
        return definition ? json(withLatest(definition)) : notFound();
      }

      if (rest[1] === "builds") {
        if (rest.length === 2 && method === "POST") {
          const request = body as { definition?: { id?: number }; sourceBranch?: string };
          const definition = fake.definitions.find((candidate) => candidate.id === request.definition?.id);
          if (!definition) return json({ message: "Definition not found" }, 400);

          const queued: RawBuild = {
            ...build(fake.nextBuildId++, { id: definition.id, name: definition.name }, "notStarted", undefined, ME, 0),
            sourceBranch: request.sourceBranch ?? "refs/heads/main",
          };
          fake.builds.push(queued);
          return json(queued);
        }

        if (rest.length === 2) {
          const definitionsFilter = url.searchParams.get("definitions");
          const statusFilter = url.searchParams.get("statusFilter")?.split(",");
          const top = Number(url.searchParams.get("$top") ?? 50);

          const matches = fake.builds
            .filter((candidate) => !definitionsFilter || String(candidate.definition?.id) === definitionsFilter)
            .filter((candidate) => !statusFilter || statusFilter.includes(candidate.status ?? ""))
            .sort((a, b) => (b.queueTime ?? "").localeCompare(a.queueTime ?? ""))
            .slice(0, top);

          return json({ value: matches });
        }

        const target = fake.builds.find((candidate) => candidate.id === Number(rest[2]));
        if (!target) return notFound();

        if (rest[3] === "timeline") {
          return json({ records: fake.timelines.get(target.id) ?? [] });
        }

        if (rest[3] === "stages" && method === "PATCH") {
          target.status = "inProgress";
          delete target.result;
          return new HttpResponse(null, { status: 204 });
        }

        if (method === "PATCH") {
          if ((body as { status?: string })?.status === "cancelling") {
            target.status = "cancelling";
          }
          return json(target);
        }

        return json(target);
      }
    }

    // ---- deployments ----
    if (rest[0] === "distributedtask" && rest[1] === "environments") {
      if (rest.length === 2) return json({ value: fake.environments });
      if (rest[3] === "environmentdeploymentrecords") {
        return json({ value: fake.environmentDeployments.get(Number(rest[2])) ?? [] });
      }
    }

    if (rest[0] === "release") {
      if (rest[1] === "releases") return json({ value: fake.releases });
      if (rest[1] === "definitions") return json({ value: [{ id: 1, name: "classic" }] });
    }

    return notFound();
  }

  return [
    http.all(`${FAKE_ORG_URL}/*`, ({ request }) => handle(request, "core")),
    http.all(`${FAKE_VSRM_URL}/*`, ({ request }) => handle(request, "vsrm")),
  ];
}

/** Adds `count` open tasks in Alpha (ids from `firstId`), assigned to the signed-in user unless `assignee` is given. */
export function addFakeTasks(fake: FakeAzure, count: number, firstId = 1001, assignee: typeof ME = ME) {
  for (let index = 0; index < count; index += 1) {
    const id = firstId + index;
    const item = workItem(id, "Alpha", "Task", `Seeded task ${id}`, "Active", { "Microsoft.VSTS.Common.Priority": 2 });
    item.fields["System.AssignedTo"] = assignee;
    fake.workItems.set(id, item);
  }
}

const hierarchy = (rel: "Reverse" | "Forward", id: number) => ({ rel: `System.LinkTypes.Hierarchy-${rel}`, url: `${FAKE_ORG_URL}/_apis/wit/workItems/${id}`, attributes: {} });

/**
 * Stories over the seeded tickets, for grouped lists: #120 "Checkout flow"
 * (someone else's) over my #102 and #103 and their #105; #121 "Settings
 * revamp" (mine) over my #106. #101 stays under no story.
 */
export function addFakeHierarchy(fake: FakeAzure) {
  const story = (id: number, title: string, assignee: typeof ME, children: number[]) => {
    const item = workItem(id, "Alpha", "User Story", title, "Active", { "Microsoft.VSTS.Common.Priority": 2, "System.ChangedDate": ago(3) }, children.map((child) => hierarchy("Forward", child)));
    item.fields["System.AssignedTo"] = assignee;
    fake.workItems.set(id, item);
  };
  story(120, "Checkout flow", OTHER, [102, 103, 105]);
  story(121, "Settings revamp", ME, [106]);

  for (const [child, parent] of [[102, 120], [103, 120], [105, 120], [106, 121]] as const) {
    const item = fake.workItems.get(child)!;
    item.relations = [...(item.relations ?? []), hierarchy("Reverse", parent)];
  }
}
