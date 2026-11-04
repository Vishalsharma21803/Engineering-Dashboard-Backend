import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { OTHER, addFakeHierarchy, addFakeTasks, type FakeAzure } from "../support/fake-azure.js";
import { azurePath, installFakeAzure, resetDatabase, setupUser, type Agent } from "../support/harness.js";
import { useAlphaRulebook } from "../support/test-rulebook.js";
import { myWorkRows } from "../support/my-work.js";

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
const ids = (page: { items: Array<{ headingRow: { workItem: { id: number } } | null; rows: Array<{ workItem: { id: number } }> }> }) => myWorkRows(page).map((row) => row.workItem.id);

describe("My work pagination", () => {
  it("serves 10 groups per page with totals, and the last page holds the rest", async () => {
    // No ticket here has a parent: each is a group of its own, without a heading.
    const first = await myWork("?page=1");
    expect(first).toMatchObject({ page: 1, pageSize: 10, total: 27, totalPages: 3, ticketCount: 27, poolTotal: 27, hiddenCount: 0, sprint: { mode: "all", inSprint: 0 }, closed: { included: false } });
    expect(first.items).toHaveLength(10);
    expect(first.items[0]).toMatchObject({ heading: null, headingRow: null, rows: [{ workItem: { id: expect.any(Number) }, compliance: { configured: true } }] });

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

    const listed = await myWork("");
    expect(listed).toMatchObject({ total: 25, hiddenCount: 2, showingHidden: false });
    const hidden = await myWork("?hidden=1");
    expect(hidden).toMatchObject({ total: 2, showingHidden: true });
    expect(ids(hidden).sort()).toEqual([1001, 1002]);
    // The sprint header keeps describing my list, not the snoozed view.
    expect(hidden.overview).toEqual(listed.overview);

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
        results: [{ ruleId: "T-05", ruleTitle: "Approach is described", severity: "medium", review: "ai-rule", verdict: "fail", reason: "No plan.", advice: null, quotes: [], fix: null, note: null, codeMessage: null, verifier: 2 }],
      },
    });

    const result = await myWork("?sop=T-05");
    expect(ids(result)).toEqual([101]);
    const [row] = myWorkRows<{ compliance: { violations: unknown[]; aiReview: unknown } }>(result);
    expect(row!.compliance.violations).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "T-05", checker: "ai" })]));
    expect(row!.compliance.aiReview).toMatchObject({ status: "DONE", outdated: false });

    // Once the ticket changes, the review no longer counts (it is shown as outdated).
    fake.workItems.get(101)!.rev += 1;
    const changed = await myWork("?refresh=true&search=Implement%20login");
    const item = myWorkRows<{ workItem: { id: number }; compliance: { aiReview: unknown; violations: unknown[] } }>(changed).find((row) => row.workItem.id === 101)!;
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

describe("My work grouped by story", () => {
  type Group = { heading: { id: number; title: string; assignedTo: { displayName: string } | null; readable: boolean } | null; headingRow: { workItem: { id: number } } | null; rows: Array<{ workItem: { id: number } }> };
  const groupOf = (page: { items: Group[] }, headingId: number) => page.items.find((group) => group.heading?.id === headingId);
  /** Every page of a query, as one page of all groups (the order is the one shown). */
  const allPages = async (query: string) => {
    const first = await myWork(`${query}${query ? "&" : "?"}page=1`);
    const rest = [];
    for (let page = 2; page <= first.totalPages; page += 1) rest.push(await myWork(`${query}${query ? "&" : "?"}page=${page}`));
    return { ...first, items: [...first.items, ...rest.flatMap((next) => next.items)] };
  };
  const rowIds = (group: Group | undefined) => (group?.rows ?? []).map((row) => row.workItem.id);

  it("puts my tickets under their story, shows whose story it is, and never lists other people's tickets", async () => {
    addFakeHierarchy(fake);
    // #102 changed just now: its story's group comes first.
    fake.workItems.get(102)!.fields["System.ChangedDate"] = new Date().toISOString();
    await myWork("?refresh=true");
    const page = await allPages("");

    const checkout = groupOf(page, 120);
    expect(page.items[0]).toBe(page.items.find((group: Group) => group.heading?.id === 120));
    // Someone else's story: a heading with their name, not one of my rows; their #105 is not listed.
    expect(checkout).toMatchObject({ heading: { title: "Checkout flow", assignedTo: { displayName: OTHER.displayName }, readable: true }, headingRow: null });
    // In progress #102 here; resolved #103 is under the same story in the Resolved section.
    expect(rowIds(checkout)).toEqual([102]);
    expect(page.items.filter((group: Group) => group.heading?.id === 120).flatMap((group: Group) => rowIds(group))).toEqual([102, 103]);
    // The group carries its newest change (my #102, just now), not the story's own older date: that is what it is sorted and labelled by.
    expect(Date.now() - Date.parse((checkout as unknown as { latest: string }).latest)).toBeLessThan(60_000);

    // My own story heads its group as one of my rows.
    // (In progress itself; my New #106 under it is in To do, under the same heading.)
    const settings = page.items.filter((group: Group) => group.heading?.id === 121);
    expect(settings[0]?.headingRow?.workItem.id).toBe(121);
    expect(settings.flatMap((group: Group) => rowIds(group))).toEqual([106]);

    // #101 has no parent: a group of its own without a heading.
    expect(page.items.some((group: Group) => group.heading === null && rowIds(group).includes(101))).toBe(true);
    // 4 seeded + 23 tasks + my story; #105 and #120 are not mine.
    expect(page.ticketCount).toBe(28);
    expect(ids(page)).not.toContain(105);
    expect(ids(page)).not.toContain(120);
  });

  it("shows the current sprint by default when some tickets are in it, and everything on request", async () => {
    for (const id of [101, 102]) fake.workItems.get(id)!.fields["System.IterationPath"] = "Alpha\\Sprint 12";
    const current = await myWork("?refresh=true");
    expect(current).toMatchObject({ sprint: { mode: "current", inSprint: 2, names: ["Sprint 12"] }, ticketCount: 2 });
    expect(ids(current).sort()).toEqual([101, 102]);
    expect((await myWork("?sprint=all")).ticketCount).toBe(27);
    // A tampered value is the default.
    expect((await myWork("?sprint=next")).sprint.mode).toBe("current");
  });

  it("shows on each ticket what it needs and the fix, and can list only those tickets", async () => {
    const all = await allPages("?refresh=true");
    type Row = { workItem: { id: number }; attention: { category: string; reasons: string[]; suggestedAction: { kind: string } | null } | null };
    const rows = myWorkRows<Row>(all);
    // #102 lacks an estimate (SOP gap, with the fields to fix); #106 is New and fine.
    expect(rows.find((row) => row.workItem.id === 102)?.attention).toMatchObject({ category: "SOP", reasons: ["No original estimate (hours)."], suggestedAction: { kind: "WORK_ITEM_UPDATE_FIELDS" } });
    const needing = rows.filter((row) => row.attention !== null).map((row) => row.workItem.id).sort();
    expect(all.attention).toEqual({ only: false, count: needing.length });

    const only = await allPages("?attention=1");
    expect(only.attention.only).toBe(true);
    expect(myWorkRows<Row>(only).map((row) => row.workItem.id).sort()).toEqual(needing);
  });

  it("orders My work by status (in progress, to do, resolved) with stories inside, and sums up the sprint", async () => {
    addFakeHierarchy(fake);
    for (const id of [101, 102, 103, 106]) fake.workItems.get(id)!.fields["System.IterationPath"] = "Alpha\\Sprint 12";
    const page = await allPages("?refresh=true");
    type Group = { section: string; heading: { id: number } | null; progress: { done: number; total: number; remainingHours: number } | null; rows: Array<{ workItem: { id: number } }> };
    const sections = (page.items as Group[]).map((group) => group.section);
    // Sections never interleave: every in-progress group comes before every to-do group, and so on.
    expect(sections).toEqual([...sections].sort((a, b) => ["inProgress", "todo", "resolved", "done"].indexOf(a) - ["inProgress", "todo", "resolved", "done"].indexOf(b)));
    // My #102 (active) and #103 (resolved) under #120 land in two sections; the story's progress counts both.
    const checkout = (page.items as Group[]).filter((group) => group.heading?.id === 120);
    expect(checkout.map((group) => group.section)).toEqual(["inProgress", "resolved"]);
    expect(checkout[0]!.progress).toEqual({ done: 1, total: 2, remainingHours: 0 });
    expect(page.sections).toEqual([
      { key: "inProgress", count: 2 },
      { key: "todo", count: 1 },
      { key: "resolved", count: 1 },
      { key: "done", count: 0 },
    ]);
    expect(page.overview).toMatchObject({ sprint: { name: "Sprint 12" }, counts: { inProgress: 2, todo: 1, resolved: 1, done: 0 }, remainingHours: 4 });
    // Grouped by story only: no sections.
    expect((await myWork("?groupBy=story")).items.every((group: Group) => group.section === null)).toBe(true);
  });

  it("lists recently closed tickets only when asked", async () => {
    const open = await allPages("");
    expect(open.closed).toEqual({ included: false, count: 1 });
    expect(ids(open)).not.toContain(104);
    const withClosed = await allPages("?closed=true");
    expect(withClosed.closed.included).toBe(true);
    expect(ids(withClosed)).toContain(104);
  });

  it("shows on a ticket page its story (with whose it is) and, for a story, my tickets under it", async () => {
    addFakeHierarchy(fake);
    const detail = async (id: number) => (await agent.get(azurePath(credentialId, `/projects/Alpha/work-items/${id}`)).expect(200)).body.workItem.family;

    expect(await detail(102)).toEqual({
      status: "ok",
      reason: null,
      data: { parent: expect.objectContaining({ id: 120, title: "Checkout flow", assignedTo: expect.objectContaining({ id: OTHER.id }), readable: true }), parentIsMine: false, myChildren: [], otherChildren: 0 },
    });
    // Someone else's story: my #102 and #103 by name, their #105 only counted.
    const story = await detail(120);
    expect(story.data.myChildren.map((child: { id: number }) => child.id).sort()).toEqual([102, 103]);
    expect(story.data).toMatchObject({ parent: null, otherChildren: 1 });
    expect((await detail(101)).data).toEqual({ parent: null, parentIsMine: false, myChildren: [], otherChildren: 0 });
    expect((await detail(106)).data).toMatchObject({ parent: { id: 121 }, parentIsMine: true });
  });

  it("shows a parent Azure cannot return by its number instead of failing", async () => {
    fake.workItems.get(101)!.relations = [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/fake-org/_apis/wit/workItems/999999", attributes: {} }];
    await myWork("?refresh=true");
    const page = await allPages("");
    expect(groupOf(page, 999999)).toMatchObject({ heading: { id: 999999, readable: false }, headingRow: null });
    expect(rowIds(groupOf(page, 999999))).toEqual([101]);
  });
});

describe("Team work items pagination", () => {
  it("groups everyone's tickets by story, with the story itself as a row", async () => {
    addFakeHierarchy(fake);
    const teamWork = (await agent.get(azurePath(credentialId, "/projects/Alpha/team-work-items?search=a")).expect(200)).body.teamWork;
    const groups = [];
    for (let page = 1; page <= teamWork.totalPages; page += 1) groups.push(...(await agent.get(azurePath(credentialId, `/projects/Alpha/team-work-items?page=${page}`)).expect(200)).body.teamWork.items);
    const checkout = groups.find((group: { heading: { id: number } | null }) => group.heading?.id === 120);
    expect(checkout.headingRow).toMatchObject({ id: 120, assignedTo: { id: OTHER.id } });
    expect(checkout.rows.map((row: { id: number }) => row.id).sort()).toEqual([102, 103, 105]);
  });

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
