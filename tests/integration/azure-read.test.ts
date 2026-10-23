import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import {
  ALPHA,
  ALPHA_REPO,
  FAKE_PAT,
  writeRequests,
  type FakeAzure,
} from "../support/fake-azure.js";
import {
  azurePath,
  getApp,
  installFakeAzure,
  resetDatabase,
  setupUser,
  signIn,
  type Agent,
} from "../support/harness.js";

let fake: FakeAzure;
let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  fake = installFakeAzure();
  ({ agent, credentialId } = await setupUser());
});

function get(path: string) {
  return agent.get(azurePath(credentialId, path));
}

function expectNoSecrets(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(FAKE_PAT);
  expect(text).not.toContain(Buffer.from(`:${FAKE_PAT}`).toString("base64"));
}

describe("Azure read API — access control", () => {
  it("requires a session", async () => {
    await request(getApp()).get(azurePath(credentialId, "/projects")).expect(401);
  });

  it("rejects malformed credential ids", async () => {
    const response = await agent.get("/api/azure/not-a-uuid/projects").expect(400);
    expect(response.body.errors[0].field).toBe("credentialId");
  });

  it("hides other users' credentials", async () => {
    const intruder = await signIn();
    await intruder.get(azurePath(credentialId, "/projects")).expect(404);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("Azure read API — data", () => {
  it("reports capabilities with learned write scopes unknown", async () => {
    const response = await get("/capabilities").expect(200);

    expect(response.body.capabilities).toEqual({
      identity: { id: expect.any(String), displayName: "Dev Example", email: "dev@example.com" },
      scopes: { project: "granted", work: "granted", code: "granted", build: "granted", release: "granted", environment: "granted" },
      writeScopes: { work: "unknown", build: "unknown" },
    });
  });

  it.each([401, 403] as const)("detects missing read scopes (Azure answers %i)", async (status) => {
    fake.scopeErrorStatus = status;
    fake.missingScopes.add("build");
    fake.missingScopes.add("release");

    const response = await get("/capabilities").expect(200);
    expect(response.body.capabilities.scopes).toMatchObject({ build: "missing", release: "missing", work: "granted" });

    // A missing scope is not an invalid PAT: the credential stays usable.
    const credential = await prisma.credential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(credential.lastValidationStatus).toBeNull();
  });

  it("lists projects", async () => {
    const response = await get("/projects").expect(200);
    expect(response.body.projects.map((project: { name: string }) => project.name)).toEqual(["Alpha", "Beta"]);
    expect(response.body.truncated).toBe(false);
  });

  it("returns a project overview with partial sections", async () => {
    fake.missingScopes.add("build");

    const response = await get(`/projects/${ALPHA.id}`).expect(200);
    const project = response.body.project;

    expect(project).toMatchObject({
      name: "Alpha",
      processTemplate: "Agile",
      currentIteration: { status: "ok", data: { name: "Sprint 12" } },
      counts: {
        repositories: { status: "ok", data: 1 },
        myOpenWorkItems: { status: "ok", data: 4 },
        activePullRequests: { status: "ok", data: 2 },
        failingPipelines: { status: "forbidden", reason: "AZURE_INSUFFICIENT_SCOPE" },
      },
    });
  });

  it("lists my open work items across projects", async () => {
    const response = await get("/work-items").expect(200);
    expect(response.body.workItems.map((item: { id: number }) => item.id)).toEqual([101, 102, 103, 106]);

    const blocked = response.body.workItems.find((item: { id: number }) => item.id === 106);
    expect(blocked).toMatchObject({ blocked: true, stateCategory: "Proposed", tags: ["Blocked", "vendor"] });
  });

  it("filters work items by project", async () => {
    const response = await get("/work-items?projectId=Beta&state=all").expect(200);
    expect(response.body.workItems.map((item: { id: number }) => item.id)).toEqual([104]);
  });

  it("returns work item detail with plain-text description, comments, links and compliance", async () => {
    const response = await get(`/projects/Alpha/work-items/101`).expect(200);
    const workItem = response.body.workItem;

    expect(workItem.description).toBe("Use JWT & cookies");
    expect(workItem.comments.data[0].text).toBe("Approach: use JWT in httpOnly cookie");
    expect(workItem.history.data[0]).toMatchObject({ field: "RemainingWork", oldValue: 6, newValue: 4 });
    expect(workItem.linkedPullRequests.data[0]).toMatchObject({ pullRequestId: 1, status: "active" });
    expect(workItem.allowedStates.map((state: { name: string }) => state.name)).toContain("Closed");
    expect(workItem.supportedFields).toMatchObject({ originalEstimate: true, storyPoints: false });
    expect(workItem.compliance.violations).toEqual([]);
  });

  it("404s a work item requested under the wrong project", async () => {
    const response = await get(`/projects/Beta/work-items/101`).expect(404);
    expect(response.body.reason).toBe("AZURE_NOT_FOUND");
  });

  it("validates numeric ids", async () => {
    await get(`/projects/Alpha/work-items/abc`).expect(400);
  });

  it("rejects dot-segment project ids", async () => {
    await get(`/projects/%2E%2E/pipelines`).expect(400);
  });

  it("evaluates SOP compliance for my tickets", async () => {
    const response = await get("/compliance").expect(200);
    const byId = new Map(
      response.body.items.map((item: { workItemId: number; violations: Array<{ ruleId: string }> }) => [
        item.workItemId,
        item.violations.map((violation) => violation.ruleId),
      ])
    );

    expect(byId.get(101)).toEqual([]);
    expect(byId.get(102)).toEqual(["MISSING_APPROACH", "MISSING_COMMENT", "MISSING_ESTIMATE", "MISSING_WORK_LOG"]);
    expect(byId.get(103)).toEqual(["NOT_CLOSED_AFTER_MERGE"]);
    expect(byId.get(104)).toEqual(["MISSING_PR_LINK", "REMAINING_NOT_ZERO_ON_CLOSE"]);
  });

  it("lists my pull requests with review state and unresolved threads", async () => {
    const response = await get("/pull-requests").expect(200);
    const prs = response.body.pullRequests;

    expect(prs.map((pr: { pullRequestId: number }) => pr.pullRequestId).sort()).toEqual([1, 3]);
    expect(prs.find((pr: { pullRequestId: number }) => pr.pullRequestId === 1)).toMatchObject({
      myRole: "author",
      unresolvedThreads: 2,
      rejections: 1,
      reviewers: [{ voteLabel: "waitingForAuthor", isRequired: true }],
    });
    expect(prs.find((pr: { pullRequestId: number }) => pr.pullRequestId === 3)).toMatchObject({
      myRole: "reviewer",
      myVote: 0,
    });
  });

  it("returns pull request detail with threads, policies and linked work items", async () => {
    const response = await get(`/projects/Alpha/repos/${ALPHA_REPO.id}/pull-requests/1`).expect(200);
    const pr = response.body.pullRequest;

    expect(pr.threads.data).toHaveLength(3);
    expect(pr.threads.data.filter((thread: { isResolved: boolean }) => !thread.isResolved)).toHaveLength(2);
    expect(pr.policies.data[0]).toMatchObject({ name: "Minimum number of reviewers", status: "approved" });
    expect(pr.linkedWorkItemIds.data).toEqual([101]);
  });

  it("returns pipeline health, runs, running builds and failed stages", async () => {
    const pipelines = (await get("/projects/Alpha/pipelines").expect(200)).body.pipelines;
    expect(pipelines.map((pipeline: { name: string; health: string }) => [pipeline.name, pipeline.health])).toEqual([
      ["alpha-ci", "running"],
      ["alpha-deploy", "succeeded"],
    ]);
    expect(pipelines[0].latestCompletedBuild.result).toBe("failed");

    const runs = (await get("/projects/Alpha/pipelines/10/runs").expect(200)).body.runs;
    expect(runs.map((run: { id: number }) => run.id)).toEqual([503, 501]);

    const running = (await get("/projects/Alpha/builds").expect(200)).body.builds;
    expect(running.map((build: { id: number }) => build.id)).toEqual([503]);

    const timeline = (await get("/projects/Alpha/builds/501/timeline").expect(200)).body.timeline;
    expect(timeline.failedStages).toEqual(["Build"]);
    expect(timeline.stages[0].jobs[0].failedTasks[0]).toMatchObject({
      name: "npm test",
      issues: [{ type: "error", message: "3 tests failed" }],
      logId: 7,
    });
  });

  it("returns deployments, degrading per source when a scope is missing", async () => {
    const full = (await get("/projects/Alpha/deployments").expect(200)).body.deployments;
    expect(full.environments.data[0]).toMatchObject({ environmentName: "staging", lastDeployments: [{ result: "succeeded", buildId: 502 }] });
    expect(full.releases.data[0]).toMatchObject({ name: "Release-70", environments: [{ name: "prod", status: "succeeded" }] });

    fake.missingScopes.add("release");
    const partial = (await get("/projects/Alpha/deployments?refresh=1").expect(200)).body.deployments;
    expect(partial.environments.status).toBe("ok");
    expect(partial.releases).toEqual({ status: "forbidden", data: null, reason: "AZURE_INSUFFICIENT_SCOPE" });
  });

  it("returns repositories, branches and commits", async () => {
    const repositories = (await get("/projects/Alpha/repos").expect(200)).body.repositories;
    expect(repositories).toEqual([expect.objectContaining({ name: "alpha-repo", defaultBranch: "main" })]);

    const branches = (await get(`/projects/Alpha/repos/${ALPHA_REPO.id}/branches`).expect(200)).body.branches;
    expect(branches.map((branch: { name: string }) => branch.name)).toEqual(["main", "feature/login"]);

    await get(`/projects/Alpha/repos/${ALPHA_REPO.id}/commits?author=me`).expect(200);
    const commitsRequest = fake.requests.find((entry) => entry.path.endsWith("/commits"));
    expect(commitsRequest?.search.get("searchCriteria.author")).toBe("dev@example.com");
  });

  it("builds a prioritized dashboard", async () => {
    const dashboard = (await get("/dashboard").expect(200)).body.dashboard;

    expect(dashboard.projectsScanned).toBe(2);
    expect(dashboard.sections.workItems.data.map((item: { id: number }) => item.id)).toEqual([101, 102, 103, 106]);
    expect(dashboard.sections.pipelines.data.map((build: { id: number }) => build.id)).toEqual([501, 502]);

    const ids = dashboard.recommendations.map((recommendation: { id: string }) => recommendation.id);
    expect(ids).toEqual(expect.arrayContaining(["wi:102", "wi:103", "wi:104", "wi:106", "build:501", `pr:${ALPHA_REPO.id}:1`, `pr:${ALPHA_REPO.id}:3`]));
    expect(ids).not.toContain("wi:101");

    const scores = dashboard.recommendations.map((recommendation: { score: number }) => recommendation.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("degrades dashboard sections independently", async () => {
    fake.missingScopes.add("build");
    fake.missingScopes.add("code");

    const dashboard = (await get("/dashboard").expect(200)).body.dashboard;

    expect(dashboard.sections.workItems.status).toBe("ok");
    expect(dashboard.sections.compliance.status).toBe("ok");
    expect(dashboard.sections.pipelines).toMatchObject({ status: "forbidden", reason: "AZURE_INSUFFICIENT_SCOPE" });
    expect(dashboard.sections.pullRequests).toMatchObject({ status: "forbidden" });
    expect(dashboard.recommendations.length).toBeGreaterThan(0);
  });

  it("scopes the dashboard to one project", async () => {
    const dashboard = (await get("/dashboard?projectId=Beta").expect(200)).body.dashboard;
    expect(dashboard.projectsScanned).toBe(1);
    expect(dashboard.sections.workItems.data).toEqual([]);
    expect(dashboard.sections.compliance.data.map((item: { workItemId: number }) => item.workItemId)).toEqual([104]);
  });
});

describe("Azure read API — upstream failures", () => {
  it("returns 424 (not 401) for an invalid PAT and marks the credential invalid", async () => {
    fake.patValid = false;

    const response = await get("/projects").expect(424);
    expect(response.body.reason).toBe("AZURE_PAT_INVALID");

    const credential = await prisma.credential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(credential.lastValidationStatus).toBe("INVALID");

    // The cockpit session itself is still valid.
    await agent.get("/api/auth/me").expect(200);
  });

  it("fails the whole dashboard on an invalid PAT", async () => {
    fake.patValid = false;
    await get("/dashboard").expect(424);
  });

  it("retries throttled reads once", async () => {
    fake.throttleNext = 1;
    await get("/projects").expect(200);
  });

  it("returns 503 with Retry-After when throttling persists", async () => {
    fake.throttleNext = 10;
    const response = await get("/projects").expect(503);
    expect(response.body.reason).toBe("AZURE_THROTTLED");
    expect(response.headers["retry-after"]).toBe("0");
  });
});

describe("Azure read API — safety", () => {
  it("never writes to Azure and never leaks the PAT on any read route", async () => {
    const paths = [
      "/capabilities",
      "/dashboard",
      "/projects",
      `/projects/${ALPHA.id}`,
      "/work-items",
      "/compliance",
      "/pull-requests",
      "/projects/Alpha/work-items/102",
      `/projects/Alpha/repos/${ALPHA_REPO.id}/pull-requests/1`,
      "/projects/Alpha/pipelines",
      "/projects/Alpha/pipelines/10/runs",
      "/projects/Alpha/builds",
      "/projects/Alpha/builds/501/timeline",
      "/projects/Alpha/deployments",
      "/projects/Alpha/repos",
      `/projects/Alpha/repos/${ALPHA_REPO.id}/branches`,
      `/projects/Alpha/repos/${ALPHA_REPO.id}/commits`,
    ];

    for (const path of paths) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expectNoSecrets(response.body);
    }

    expect(fake.requests.length).toBeGreaterThan(paths.length);
    expect(writeRequests(fake)).toEqual([]);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});
