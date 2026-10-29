import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { OTHER, addFakeTasks, type FakeAzure } from "../support/fake-azure.js";
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
  // 4 seeded open tickets of mine (101, 102, 103, 106) + 23 more = 27 = pages of 10, 10, 7.
  addFakeTasks(fake, 23);
});

const myWork = async (query: string) => (await agent.get(azurePath(credentialId, `/my-work${query}`)).expect(200)).body.myWork;
const ids = (page: { items: Array<{ workItem: { id: number } }> }) => page.items.map((row) => row.workItem.id);

describe("My work pagination", () => {
  it("serves 10 tickets per page with totals, and the last page holds the rest", async () => {
    const first = await myWork("?page=1");
    expect(first).toMatchObject({ page: 1, pageSize: 10, total: 27, totalPages: 3, poolTotal: 27, hiddenCount: 0 });
    expect(first.items).toHaveLength(10);
    expect(first.items[0]).toMatchObject({ workItem: { id: expect.any(Number) }, compliance: { configured: true } });

    const last = await myWork("?page=3");
    expect(last.items).toHaveLength(7);
    expect(new Set([...ids(first), ...ids(await myWork("?page=2")), ...ids(last)]).size).toBe(27);
  });

  it.each([
    ["", 1],
    ["?page=0", 1],
    ["?page=-4", 1],
    ["?page=abc", 1],
    ["?page=2.5", 1],
    ["?page=1e3", 1],
    ["?page=99999999999", 1],
    ["?page=2&page=3", 1],
    ["?page[]=2", 1],
    ["?page=99", 3],
    ["?page=4", 3],
  ])("turns a tampered page %s into page %i without failing", async (query, expected) => {
    const result = await myWork(query);
    expect(result.page).toBe(expected);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("filters on the server and resets out-of-range pages to the last one", async () => {
    const bugs = await myWork("?type=Bug&page=3");
    expect(bugs).toMatchObject({ page: 1, total: 1, totalPages: 1 });
    expect(ids(bugs)).toEqual([103]);

    // #106 is still New, so it is not flagged; 102, 103 and the 23 active tasks are.
    const gaps = await myWork("?sop=T-01");
    expect(gaps.total).toBe(25);
    expect(gaps.facets.sop).toEqual(expect.arrayContaining([{ value: "T-01", label: "T-01 · Estimate exists", count: 25 }]));

    // Tampered filter values just match nothing.
    const nonsense = await myWork(`?type=${"x".repeat(500)}&sop=%3Cscript%3E&stateCategory=Nope`);
    expect(nonsense).toMatchObject({ page: 1, total: 0, totalPages: 1, items: [] });
  });

  it("hides snoozed tickets before paging and can show only them", async () => {
    const user = await prisma.user.findFirstOrThrow();
    for (const id of [1001, 1002]) {
      // The UI records the ticket's current signals when snoozing; a new signal would resurface it.
      await prisma.triageMark.create({ data: { userId: user.id, credentialId, itemKey: `wi:${id}`, status: "SNOOZED", snoozedUntil: new Date(Date.now() + 86_400_000), signals: ["SOP:T-01"] } });
    }

    expect(await myWork("")).toMatchObject({ total: 25, hiddenCount: 2, showingHidden: false });
    const hidden = await myWork("?hidden=1");
    expect(hidden).toMatchObject({ total: 2, showingHidden: true });
    expect(ids(hidden).sort()).toEqual([1001, 1002]);

    // Snoozed with an older set of signals: the new SOP gap resurfaces it.
    await prisma.triageMark.updateMany({ where: { itemKey: "wi:1002" }, data: { signals: [] } });
    expect((await myWork("")).hiddenCount).toBe(1);
    // A tampered flag is just "not hidden".
    expect((await myWork("?hidden=maybe")).showingHidden).toBe(false);
  });

  it("includes the user's AI verdicts in SOP filters", async () => {
    const user = await prisma.user.findFirstOrThrow();
    await prisma.sopAiCheck.create({
      data: {
        userId: user.id,
        credentialId,
        workItemId: 101,
        projectName: "Alpha",
        inputHash: "x",
        status: "DONE",
        // Judged on the ticket as it is now (a newer ticket makes the review outdated).
        ticketRev: fake.workItems.get(101)!.rev,
        finishedAt: new Date(),
        results: [{ ruleId: "T-05", ruleTitle: "Approach is described", severity: "medium", review: "ai-rule", verdict: "fail", reason: "No plan.", advice: null, quotes: [], fix: null, note: null }],
      },
    });

    const result = await myWork("?sop=T-05");
    expect(ids(result)).toEqual([101]);
    expect(result.items[0].compliance.violations).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "T-05", checker: "ai" })]));
    expect(result.items[0].compliance.aiReview).toMatchObject({ status: "DONE", outdated: false });

    // Once the ticket changes, the review no longer counts (it is shown as outdated).
    fake.workItems.get(101)!.rev += 1;
    const changed = await myWork("?refresh=true");
    const item = changed.items.find((row: { workItem: { id: number } }) => row.workItem.id === 101);
    expect(item.compliance.aiReview).toMatchObject({ outdated: true });
    expect(item.compliance.violations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "T-05" })]));
  });

  it("reuses the dashboard's results, so changing page does not re-run the SOP checks", async () => {
    await agent.get(azurePath(credentialId, "/dashboard")).expect(200);
    const before = fake.requests.length;

    await myWork("?page=2");
    await myWork("?page=3&type=Task");
    expect(fake.requests.length).toBe(before);
  });
});

describe("Team work items pagination", () => {
  it("pages everyone's tickets with assignee filters", async () => {
    addFakeTasks(fake, 2, 2001, OTHER);
    const page = (query: string) => agent.get(azurePath(credentialId, `/projects/Alpha/team-work-items${query}`)).expect(200);

    // Alpha: 101, 102, 103, 105, 106 + 23 + 2 = 30 open tickets.
    const first = (await page("")).body.teamWork;
    expect(first).toMatchObject({ page: 1, total: 30, totalPages: 3 });
    expect(first.items).toHaveLength(10);

    expect((await page("?page=7")).body.teamWork.page).toBe(3);
    expect((await page("?assignee=unassigned")).body.teamWork).toMatchObject({ total: 0, page: 1, totalPages: 1 });
    expect((await page(`?assignee=${OTHER.id}`)).body.teamWork.total).toBe(3);
    expect((await page("?scope=tampered")).body.teamWork.total).toBe(30);
  });
});

describe("SOP report pagination", () => {
  it("pages the tickets with gaps while totals cover all, reading the saved run", async () => {
    const run = (await agent.post(`/api/sop/reports/${credentialId}/Alpha`).send({}).expect(200)).body.run;
    const report = async (query: string) => (await agent.get(`/api/sop/reports/${credentialId}/Alpha/${run.id}${query}`).expect(200)).body.report;

    // 102, 103, 105 and the 23 active tasks (106 is New and not flagged).
    const first = await report("");
    expect(first.itemsWithGaps).toBe(26);
    expect(first.items).toMatchObject({ page: 1, pageSize: 10, total: 26, totalPages: 3 });
    expect(first.items.items).toHaveLength(10);

    const before = fake.requests.length;
    const last = await report("?page=50&rulePage=abc&personPage=-1");
    expect(last.items).toMatchObject({ page: 3 });
    expect(last.items.items).toHaveLength(6);
    expect(last.byRule.page).toBe(1);
    expect(last.byPerson.page).toBe(1);
    // At most the project lookup: a saved run is never rebuilt.
    expect(fake.requests.length).toBeLessThanOrEqual(before + 1);
  });
});
