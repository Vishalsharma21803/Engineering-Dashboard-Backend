import { beforeEach, describe, expect, it } from "vitest";

import { rememberDashboardLists } from "../../src/services/work-item-list/dashboard-lists.service.js";
import type { FakeAzure } from "../support/fake-azure.js";
import { azurePath, installFakeAzure, resetDatabase, setupUser, type Agent } from "../support/harness.js";
import { useAlphaRulebook } from "../support/test-rulebook.js";

let fake: FakeAzure;
let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  fake = installFakeAzure();
  ({ agent, credentialId } = await setupUser());
  await useAlphaRulebook();
});

const get = async (path: string) => (await agent.get(azurePath(credentialId, path)).expect(200)).body;

/** Twelve more open pull requests authored by me (14 of mine in all). */
function addPullRequests() {
  const template = fake.pullRequests[0]!;

  for (let index = 0; index < 12; index += 1) {
    fake.pullRequests.push({ ...template, pullRequestId: 100 + index, title: `Extra ${index}`, threads: [], workItemIds: [] });
  }
}

describe("dashboard lists", () => {
  it("pages my pull requests on the server and hides abandoned ones before paging", async () => {
    addPullRequests();

    const first = (await get("/dashboard/pull-requests")).pullRequests;
    expect(first).toMatchObject({ page: 1, pageSize: 10, total: 14, totalPages: 2, poolTotal: 14, hiddenCount: 0 });
    expect((await get("/dashboard/pull-requests?page=99")).pullRequests).toMatchObject({ page: 2 });
    expect((await get("/dashboard/pull-requests?person=reviewer")).pullRequests.total).toBe(1);
    expect((await get("/dashboard/pull-requests?search=Extra%201")).pullRequests.total).toBe(3);

    const pr = first.items.find((item: { pullRequestId: number }) => item.pullRequestId === 1);
    await agent
      .put("/api/triage")
      .send({ credentialId, itemKey: `pr:${pr.repositoryId}:1`, status: "ABANDONED", signals: [] })
      .expect(200);

    expect((await get("/dashboard/pull-requests")).pullRequests).toMatchObject({ total: 13, hiddenCount: 1, showingHidden: false });
    const hidden = (await get("/dashboard/pull-requests?hidden=true")).pullRequests;
    expect(hidden).toMatchObject({ total: 1, showingHidden: true });
    expect(hidden.items[0].pullRequestId).toBe(1);
  });

  it("pages prioritized actions with a category filter and numbers the active ones", async () => {
    addPullRequests();
    const all = (await get("/dashboard/recommendations")).recommendations;

    expect(all.page).toBe(1);
    expect(all.items.length).toBeLessThanOrEqual(10);
    expect(all.items[0].rank).toBe(1);
    expect(all.total).toBe(all.activeTotal + all.acknowledgedTotal);

    const category = all.facets.categories[0].value;
    const filtered = (await get(`/dashboard/recommendations?category=${category}`)).recommendations;
    expect(filtered.items.every((item: { recommendation: { category: string } }) => item.recommendation.category === category)).toBe(true);
    // An unknown category is ignored, not an error.
    expect((await get("/dashboard/recommendations?category=NOPE")).recommendations.total).toBe(all.total);
  });

  it("reports a section Azure could not read as an error, not as an empty list", async () => {
    const userId = (await agent.get("/api/auth/me").expect(200)).body.user.id;
    rememberDashboardLists(userId, credentialId, undefined, { recommendations: [], pullRequests: null, builds: null });

    const prs = await agent.get(azurePath(credentialId, "/dashboard/pull-requests")).expect(503);
    expect(prs.body.reason).toBe("SECTION_UNAVAILABLE");
    await agent.get(azurePath(credentialId, "/dashboard/pipeline-runs")).expect(503);
    expect((await get("/dashboard/recommendations")).recommendations.total).toBe(0);
  });

  it("pages my pipeline runs with a result filter", async () => {
    const runs = (await get("/dashboard/pipeline-runs")).runs;
    expect(runs).toMatchObject({ page: 1, pageSize: 10 });
    expect(runs.facets.results.length).toBeGreaterThan(0);

    const failed = (await get("/dashboard/pipeline-runs?result=failed")).runs;
    expect(failed.items.every((run: { result: string }) => run.result === "failed")).toBe(true);
  });
});

describe("project overview lists", () => {
  it("pages pipelines, opening the page of a linked run, and teams and repositories", async () => {
    expect((await get("/projects/Alpha/pipelines?build=501")).pipelines).toMatchObject({ page: 1, total: 2 });
    expect((await get("/projects/Alpha/teams")).teams).toMatchObject({ page: 1, total: 1, items: [{ name: "Alpha Team" }] });
    expect((await get("/projects/Alpha")).project.teams).toBeUndefined();

    // Pickers get every repository; lists ask for a page.
    expect(Array.isArray((await get("/projects/Alpha/repos")).repositories)).toBe(true);
    expect((await get("/projects/Alpha/repos?page=abc")).repositoryPage).toMatchObject({ page: 1, pageSize: 10 });
  });
});
