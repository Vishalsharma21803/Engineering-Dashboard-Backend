import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { clearAzureCache } from "../../src/lib/azure/cache.js";
import { prisma } from "../../src/lib/prisma.js";
import { closedTicketCandidates, syncNotifications, type NotificationCandidate, type NotificationScope } from "../../src/services/notifications/notification.service.js";
import type { ComplianceResult, WorkItemSummary } from "../../src/types/azure.types.js";
import type { TimeCheck } from "../../src/services/solidtime/time-nudges.service.js";
import { ALPHA_REPO, ME, writeRequests, type FakeAzure } from "../support/fake-azure.js";
import { azurePath, getApp, installFakeAzure, resetDatabase, setupUser, type Agent } from "../support/harness.js";

let fake: FakeAzure;
let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  fake = installFakeAzure();
  ({ agent, credentialId } = await setupUser());
});

interface NotificationBody {
  id: string;
  key: string;
  kind: string;
  projectName: string | null;
  title: string;
  reasons: string[];
  status: "UNREAD" | "READ" | "ABANDONED";
}

async function loadDashboard(query = "") {
  await agent.get(azurePath(credentialId, `/dashboard${query}`)).expect(200);
}

async function list(projectName?: string, as: Agent = agent): Promise<NotificationBody[]> {
  const response = await as.get(`/api/notifications?credentialId=${credentialId}${projectName ? `&projectName=${encodeURIComponent(projectName)}` : ""}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.notifications as NotificationBody[];
}

const byKey = (rows: NotificationBody[]) => new Map(rows.map((row) => [row.key, row]));
const setStatus = (id: string, status: string, as: Agent = agent) => as.patch(`/api/notifications/${id}`).send({ status });
const reviewKey = `pr:${ALPHA_REPO.id}:3`;
const authorKey = `pr:${ALPHA_REPO.id}:1`;
const pipelineKey = "pipeline:Alpha:10:refs/heads/main";

describe("notifications", () => {
  it("requires authentication", async () => {
    expect((await request(getApp()).get(`/api/notifications?credentialId=${credentialId}`)).status).toBe(401);
    expect((await request(getApp()).post("/api/notifications/read-all").send({ credentialId })).status).toBe(401);
  });

  it("stores what needs me from the dashboard read: pull requests and failed pipelines, unread", async () => {
    await loadDashboard();
    const rows = byKey(await list());

    expect(rows.get(reviewKey)).toMatchObject({ kind: "pullRequest", projectName: "Alpha", status: "UNREAD", reasons: [expect.stringMatching(/^Review requested/)] });
    expect(rows.get(authorKey)?.reasons).toContain("Changes requested by Reviewer Two");
    expect(rows.get(pipelineKey)).toMatchObject({ kind: "pipeline", title: expect.stringContaining("alpha-ci"), status: "UNREAD" });
    // Reading and storing them writes nothing to Azure DevOps.
    expect(writeRequests(fake)).toEqual([]);
  });

  it("keeps a read one listed, and brings it back to unread when something new happens", async () => {
    await loadDashboard();
    const pipeline = byKey(await list()).get(pipelineKey)!;
    await setStatus(pipeline.id, "READ").expect(200);

    await loadDashboard();
    expect(byKey(await list()).get(pipelineKey)?.status).toBe("READ");

    // A newer run of the same pipeline fails: a new signal.
    fake.builds.push({ ...fake.builds[0]!, id: 503, buildNumber: "2026.503", queueTime: new Date().toISOString() });
    await loadDashboard();
    expect(byKey(await list()).get(pipelineKey)?.status).toBe("UNREAD");
  });

  it("removes one only when its cause is fixed, whatever its status", async () => {
    await loadDashboard();
    const rows = byKey(await list());
    await setStatus(rows.get(reviewKey)!.id, "ABANDONED").expect(200);
    await setStatus(rows.get(pipelineKey)!.id, "READ").expect(200);

    // I review the pull request; the pipeline's next run passes.
    fake.pullRequests[2]!.reviewers = [{ ...ME, vote: 10 }];
    fake.builds.push({ ...fake.builds[1]!, id: 504, definition: { id: 10, name: "alpha-ci" }, queueTime: new Date().toISOString() });
    // Azure reads are cached for a short while; Refresh reads them again.
    clearAzureCache();
    await loadDashboard();

    const after = byKey(await list());
    expect(after.has(reviewKey)).toBe(false);
    expect(after.has(pipelineKey)).toBe(false);
    expect(after.has(authorKey)).toBe(true);
  });

  it("keeps an abandoned one abandoned when something new happens, until it is restored", async () => {
    await loadDashboard();
    const pipeline = byKey(await list()).get(pipelineKey)!;
    await setStatus(pipeline.id, "ABANDONED").expect(200);

    fake.builds.push({ ...fake.builds[0]!, id: 505, buildNumber: "2026.505", queueTime: new Date().toISOString() });
    await loadDashboard();
    expect(byKey(await list()).get(pipelineKey)?.status).toBe("ABANDONED");

    await setStatus(pipeline.id, "UNREAD").expect(200);
    expect(byKey(await list()).get(pipelineKey)?.status).toBe("UNREAD");
  });

  it("never removes what a read could not check: a failed section or a project outside the read", async () => {
    await loadDashboard();
    expect(byKey(await list()).has(reviewKey)).toBe(true);

    // Pull requests cannot be read: the review stays, even though no candidate came back.
    fake.missingScopes.add("code");
    await loadDashboard();
    expect(byKey(await list()).has(reviewKey)).toBe(true);
    fake.missingScopes.delete("code");

    // Narrowed to Beta: Alpha's pull requests and pipelines were not read, so they stay too.
    await loadDashboard("?projectId=bbbbbbbb-0000-4000-8000-000000000002");
    const rows = byKey(await list());
    expect(rows.has(reviewKey)).toBe(true);
    expect(rows.has(pipelineKey)).toBe(true);
  });

  it("lists one project's notifications plus those tied to none", async () => {
    await loadDashboard();
    await prisma.notification.create({ data: { userId: (await prisma.credential.findUniqueOrThrow({ where: { id: credentialId } })).userId, credentialId, key: "time:day:2026-11-02", kind: "timeDay", projectName: null, title: "Only 6 h tracked on Mon, Nov 2", reasons: [], target: { type: "time", projectName: null, id: 0 }, signals: ["TIME:DAY:2026-11-02"], readSignals: [] } });

    expect((await list("Beta")).map((row) => row.key)).toEqual(["time:day:2026-11-02"]);
    expect((await list("alpha")).map((row) => row.key).sort()).toEqual([authorKey, reviewKey, pipelineKey, "time:day:2026-11-02"].sort());
  });

  it("marks every unread one as read, and nothing else changes", async () => {
    await loadDashboard();
    const pipeline = byKey(await list()).get(pipelineKey)!;
    await setStatus(pipeline.id, "ABANDONED").expect(200);

    const response = await agent.post("/api/notifications/read-all").send({ credentialId }).expect(200);
    expect(response.body.count).toBe(2);
    const rows = await list();
    expect(rows.filter((row) => row.status === "READ").map((row) => row.key).sort()).toEqual([authorKey, reviewKey].sort());
    expect(byKey(rows).get(pipelineKey)?.status).toBe("ABANDONED");
  });

  it("shows pending approvals as one notification that goes when nothing is pending", async () => {
    const proposed = await agent.post("/api/actions").send({ credentialId, kind: "WORK_ITEM_COMMENT", target: { projectId: "Alpha", workItemId: 102 }, params: { text: "Approach: retry" } }).expect(201);
    expect(byKey(await list()).get("approvals")).toMatchObject({ title: "1 change awaits your approval", status: "UNREAD" });

    await agent.post(`/api/actions/${proposed.body.action.id}/reject`).send({}).expect(200);
    expect(byKey(await list()).has("approvals")).toBe(false);
  });

  it("does not let another user read or change my notifications", async () => {
    await loadDashboard();
    const mine = (await list())[0]!;
    const other = await setupUser();

    expect((await other.agent.get(`/api/notifications?credentialId=${credentialId}`)).status).toBe(404);
    expect((await setStatus(mine.id, "READ", other.agent)).status).toBe(404);
    expect((await other.agent.post("/api/notifications/read-all").send({ credentialId })).status).toBe(404);
  });

  it("validates input", async () => {
    expect((await agent.get("/api/notifications?credentialId=nope")).status).toBe(400);
    expect((await agent.patch("/api/notifications/not-a-uuid").send({ status: "READ" })).status).toBe(400);
    await loadDashboard();
    const mine = (await list())[0]!;
    expect((await setStatus(mine.id, "DELETED")).status).toBe(400);
  });
});

describe("syncing notifications", () => {
  const scope: NotificationScope = { projectName: undefined, workItemsRead: true, readTicketIds: new Set(), readPullRequests: new Map(), readPipelines: new Map() };
  const noRecheck = { recheckClosedTickets: async () => ({ candidates: [], unchecked: new Set<number>() }), recheckPullRequests: async () => new Set<string>() };
  const time = (overrides: Partial<TimeCheck> = {}): TimeCheck => ({ nudges: [], ok: true, trackedEver: new Set(), covers: () => false, recheck: async () => new Set(), ...overrides });
  const day = (date: string): NotificationCandidate => ({ key: `time:day:${date}`, kind: "timeDay", projectName: null, title: `Only 6 h tracked on ${date}`, reasons: [], target: { type: "time", projectName: null, id: 0 }, signals: [`TIME:DAY:${date}`] });
  const closed = (id: number, reasons: string[]): NotificationCandidate => ({ key: `closed:wi:${id}`, kind: "closedTicket", projectName: "Alpha", title: `#${id} Closed`, reasons, target: { type: "workItem", projectName: "Alpha", id }, signals: reasons.map((reason) => `SOP:${reason}`) });
  let userId: string;

  beforeEach(async () => {
    userId = (await prisma.credential.findUniqueOrThrow({ where: { id: credentialId } })).userId;
  });

  const keys = async () => (await prisma.notification.findMany({ where: { credentialId }, orderBy: { key: "asc" } })).map((row) => row.key);

  it("keeps an older day reminder until Solidtime shows the day reached the target", async () => {
    await syncNotifications(userId, credentialId, [day("2026-10-27"), day("2026-10-28")], scope, time(), noRecheck);

    // The next days: neither is a candidate any more (outside the window). Still short, so they stay.
    await syncNotifications(userId, credentialId, [], scope, time(), noRecheck);
    expect(await keys()).toEqual(["time:day:2026-10-27", "time:day:2026-10-28"]);

    // The 27th was filled in.
    await syncNotifications(userId, credentialId, [], scope, time({ recheck: async () => new Set(["time:day:2026-10-27"]) }), noRecheck);
    expect(await keys()).toEqual(["time:day:2026-10-28"]);

    // Solidtime down: nothing is removed.
    await syncNotifications(userId, credentialId, [], scope, time({ ok: false, recheck: async () => null }), noRecheck);
    expect(await keys()).toEqual(["time:day:2026-10-28"]);
  });

  it("re-reads closed tickets outside the window, and removes only those that are fixed", async () => {
    await syncNotifications(userId, credentialId, [closed(1, ["No estimate"]), closed(2, ["No estimate"]), closed(3, ["No estimate"])], { ...scope, readTicketIds: new Set([1, 2, 3]) }, time(), noRecheck);

    // 1 is still read with the dashboard and its gap is fixed; 2 and 3 fell out of the window: 2 still has its gap, 3 is fixed; 4 was not checked.
    const recheck = async (ids: number[]) => {
      expect(ids.sort()).toEqual([2, 3]);
      return { candidates: [closed(2, ["No estimate", "No story"])], unchecked: new Set<number>() };
    };
    await syncNotifications(userId, credentialId, [], { ...scope, readTicketIds: new Set([1]) }, time(), { ...noRecheck, recheckClosedTickets: recheck });

    expect(await keys()).toEqual(["closed:wi:2"]);
    expect((await prisma.notification.findFirstOrThrow({ where: { credentialId, key: "closed:wi:2" } })).reasons).toEqual(["No estimate", "No story"]);
  });

  it("keeps closed tickets when Azure could not be read again", async () => {
    await syncNotifications(userId, credentialId, [closed(2, ["No estimate"])], { ...scope, readTicketIds: new Set([2]) }, time(), noRecheck);
    await syncNotifications(userId, credentialId, [], scope, time(), { ...noRecheck, recheckClosedTickets: async () => null });
    await syncNotifications(userId, credentialId, [], { ...scope, workItemsRead: false, readTicketIds: new Set([2]) }, time(), noRecheck);
    expect(await keys()).toEqual(["closed:wi:2"]);
  });

  it("adds each one once when two reads store it at the same time", async () => {
    await Promise.all([
      syncNotifications(userId, credentialId, [day("2026-10-27")], scope, time(), noRecheck),
      syncNotifications(userId, credentialId, [day("2026-10-27")], scope, time(), noRecheck),
    ]);
    expect(await keys()).toEqual(["time:day:2026-10-27"]);
  });

  const pipeline = (failedRun: number): NotificationCandidate => ({ key: "pipeline:Alpha:10:refs/heads/main", kind: "pipeline", projectName: "Alpha", title: "alpha-ci failed", reasons: [], target: { type: "build", projectName: "Alpha", id: failedRun }, signals: [`FAILED:${failedRun}`] });
  const untracked: NotificationCandidate = { key: "time:wi:7:untracked:2026-11-02", kind: "timeUntracked", projectName: "Alpha", title: "#7", reasons: [], target: { type: "workItem", projectName: "Alpha", id: 7 }, signals: ["TIME:UNTRACKED:2026-11-02"] };
  const pr = (id: number): NotificationCandidate => ({ key: `pr:repo:${id}`, kind: "pullRequest", projectName: "Alpha", title: `PR ${id}`, reasons: [], target: { type: "pullRequest", projectName: "Alpha", id, repositoryId: "repo" }, signals: ["UNRESOLVED_THREADS"] });

  it("keeps a failed pipeline until a newer run of it passes, even when no recent run is read or the rerun is still going", async () => {
    await syncNotifications(userId, credentialId, [pipeline(501)], scope, time(), noRecheck);
    // A week later its runs are outside the read: nothing says it was fixed.
    await syncNotifications(userId, credentialId, [], scope, time(), noRecheck);
    // A rerun in progress (or canceled) proves nothing either.
    await syncNotifications(userId, credentialId, [], { ...scope, readPipelines: new Map([["pipeline:Alpha:10:refs/heads/main", { passed: false }]]) }, time(), noRecheck);
    expect(await keys()).toEqual(["pipeline:Alpha:10:refs/heads/main"]);
    await syncNotifications(userId, credentialId, [], { ...scope, readPipelines: new Map([["pipeline:Alpha:10:refs/heads/main", { passed: true }]]) }, time(), noRecheck);
    expect(await keys()).toEqual([]);
  });

  it("removes today's untracked ticket only when Solidtime shows time on it, not because the ticket was not read", async () => {
    await syncNotifications(userId, credentialId, [untracked], scope, time(), noRecheck);
    await syncNotifications(userId, credentialId, [], { ...scope, workItemsRead: false }, time({ covers: () => true }), noRecheck);
    expect(await keys()).toEqual([untracked.key]);
    await syncNotifications(userId, credentialId, [], scope, time({ recheck: async (asked) => new Set(asked) }), noRecheck);
    expect(await keys()).toEqual([]);
  });

  it("judges a pull request from the read only when it was read; otherwise looks it up", async () => {
    await syncNotifications(userId, credentialId, [pr(1), pr(2), pr(3)], scope, time(), noRecheck);
    const looked: string[] = [];
    await syncNotifications(
      userId,
      credentialId,
      [],
      // 1: read, threads counted, nothing needs me. 2: read but its threads could not be counted. 3: not read (past the limit), merged since.
      { ...scope, readPullRequests: new Map([["pr:repo:1", { threadsRead: true }], ["pr:repo:2", { threadsRead: false }]]) },
      time(),
      { ...noRecheck, recheckPullRequests: async (asked) => { looked.push(...asked.map((one) => one.key)); return new Set(["pr:repo:3"]); } }
    );
    expect(looked).toEqual(["pr:repo:3"]);
    expect(await keys()).toEqual(["pr:repo:2"]);
  });

  it("re-checks at most a batch per load, the least recently checked first, so every one gets its turn", async () => {
    const many = Array.from({ length: 25 }, (_, index) => closed(100 + index, ["No estimate"]));
    await syncNotifications(userId, credentialId, many, { ...scope, readTicketIds: new Set(many.map((_, index) => 100 + index)) }, time(), noRecheck);
    const asked: number[][] = [];
    const still = { ...noRecheck, recheckClosedTickets: async (ids: number[]) => { asked.push([...ids]); return { candidates: ids.map((id) => closed(id, ["No estimate"])), unchecked: new Set<number>() }; } };
    await syncNotifications(userId, credentialId, [], scope, time(), still);
    await syncNotifications(userId, credentialId, [], scope, time(), still);
    expect(asked[0]).toHaveLength(20);
    // The 5 not checked the first time come first the next time.
    const first = new Set(asked[0]);
    expect(asked[1]!.slice(0, 5).every((id) => !first.has(id))).toBe(true);
    expect(await keys()).toHaveLength(25);
  });

  it("moves re-checks that could not be done to the back, so they never block the others", async () => {
    const many = Array.from({ length: 25 }, (_, index) => closed(200 + index, ["No estimate"]));
    await syncNotifications(userId, credentialId, many, { ...scope, readTicketIds: new Set(many.map((_, index) => 200 + index)) }, time(), noRecheck);
    const asked: number[][] = [];
    // Azure never returns any of them (deleted or hidden).
    const hidden = { ...noRecheck, recheckClosedTickets: async (ids: number[]) => { asked.push([...ids]); return { candidates: [], unchecked: new Set(ids) }; } };
    await syncNotifications(userId, credentialId, [], scope, time(), hidden);
    await syncNotifications(userId, credentialId, [], scope, time(), hidden);
    const first = new Set(asked[0]);
    expect(asked[1]!.slice(0, 5).every((id) => !first.has(id))).toBe(true);
    expect(await keys()).toHaveLength(25);
  });

  it("keeps a read pull request whose comment threads could not be counted", async () => {
    await syncNotifications(userId, credentialId, [{ ...pr(5), signals: ["READY_TO_COMPLETE"] }], scope, time(), noRecheck);
    await syncNotifications(userId, credentialId, [], { ...scope, readPullRequests: new Map([["pr:repo:5", { threadsRead: false }]]) }, time(), noRecheck);
    expect(await keys()).toEqual(["pr:repo:5"]);
  });

  it("keeps a pull request's conflicts while Azure is still working out its merge status", async () => {
    await syncNotifications(userId, credentialId, [{ ...pr(6), signals: ["MERGE_CONFLICTS"] }], scope, time(), noRecheck);
    await syncNotifications(userId, credentialId, [], { ...scope, readPullRequests: new Map([["pr:repo:6", { threadsRead: true, mergeKnown: false }]]) }, time(), noRecheck);
    expect(await keys()).toEqual(["pr:repo:6"]);
    await syncNotifications(userId, credentialId, [], { ...scope, readPullRequests: new Map([["pr:repo:6", { threadsRead: true, mergeKnown: true }]]) }, time(), noRecheck);
    expect(await keys()).toEqual([]);
  });

  it("keeps a still-listed pull request's conflicts in its words while the merge status is unknown", async () => {
    const both = { ...pr(7), reasons: ["Changes requested by Reviewer Two", "Merge conflicts"], signals: ["CHANGES_REQUESTED", "MERGE_CONFLICTS"] };
    await syncNotifications(userId, credentialId, [both], scope, time(), noRecheck);
    // Next read: still changes requested, merge status being worked out (no conflicts reason this time).
    await syncNotifications(userId, credentialId, [{ ...both, reasons: ["Changes requested by Reviewer Two"], signals: ["CHANGES_REQUESTED"] }], { ...scope, readPullRequests: new Map([["pr:repo:7", { threadsRead: true, mergeKnown: false }]]) }, time(), noRecheck);
    expect((await prisma.notification.findFirstOrThrow({ where: { credentialId, key: "pr:repo:7" } })).reasons).toEqual(["Changes requested by Reviewer Two", "Merge conflicts"]);
  });

  it("keeps closed tickets Azure did not return (deleted or no longer visible)", async () => {
    await syncNotifications(userId, credentialId, [closed(9, ["No estimate"])], { ...scope, readTicketIds: new Set([9]) }, time(), noRecheck);
    await syncNotifications(userId, credentialId, [], scope, time(), { ...noRecheck, recheckClosedTickets: async () => ({ candidates: [], unchecked: new Set([9]) }) });
    expect(await keys()).toEqual(["closed:wi:9"]);
  });
});

describe("closed tickets' SOP gaps", () => {
  const ticket = { ...({} as WorkItemSummary), id: 31, title: "Old fix", projectName: "Alpha", stateCategory: "Completed" as const };
  const rule = { ruleId: "state-change-comment" as never, ruleTitle: "Comment on state changes" };
  const result = (overrides: Partial<ComplianceResult>): ComplianceResult => ({ workItemId: 31, configured: true, violations: [], notices: [], todos: [], passedRules: [], skippedRules: [], aiRules: [], cleared: [], ...overrides } as ComplianceResult);
  const previous = new Map([[31, [{ signal: "SOP:state-change-comment", reason: "State changed without a comment" }]]]);
  const input = { time: { nudges: [], ok: true, trackedEver: new Set([31]), covers: () => false, recheck: async () => new Set<string>() }, flaggedNoTime: new Set<number>(), previousGaps: previous };

  it("keeps a stored gap whose rule was skipped this time (history unavailable) or not judged (outdated AI review)", () => {
    const skipped = closedTicketCandidates([ticket], [result({ skippedRules: [{ ...rule, reason: "History unavailable" }] })], input);
    expect(skipped.map((candidate) => candidate.reasons)).toEqual([["State changed without a comment"]]);
    expect(closedTicketCandidates([ticket], [result({})], input)).toHaveLength(1);
  });

  it("drops an AI-only rule's gap only when a current AI review explicitly passes it", () => {
    const aiPrevious = { ...input, previousGaps: new Map([[31, [{ signal: "SOP:ai-rule-x", reason: "No test notes" }]]]) };
    const aiRule = { ruleId: "ai-rule-x" as never, ruleTitle: "Test notes", due: true, phase: "earlier" as const };
    const review = { status: "DONE" as const, checkedAt: null, outdated: false };
    // Outdated, unsure or no verdict for it: nothing is proven, the gap stays.
    expect(closedTicketCandidates([ticket], [result({ aiRules: [aiRule], aiReview: { ...review, outdated: true } })], aiPrevious)).toHaveLength(1);
    expect(closedTicketCandidates([ticket], [result({ aiRules: [aiRule], aiReview: review })], aiPrevious)).toHaveLength(1);
    // Explicitly passed by the current review: gone.
    expect(closedTicketCandidates([ticket], [result({ aiRules: [aiRule], aiReview: review, aiPassed: [aiRule] })], aiPrevious)).toEqual([]);
  });

  it("keeps it while the rule is only a to-do (its window is open) or a notice: neither is a pass", () => {
    const finding = { ...rule, checker: "code", severity: "low", message: "x", evidence: [], suggestedAction: null, phase: "now" } as never;
    expect(closedTicketCandidates([ticket], [result({ todos: [finding] })], input)).toHaveLength(1);
    expect(closedTicketCandidates([ticket], [result({ notices: [finding] })], input)).toHaveLength(1);
  });

  it("drops it once the rule is seen to pass or an AI review clears it", () => {
    expect(closedTicketCandidates([ticket], [result({ passedRules: [rule] })], input)).toEqual([]);
    expect(closedTicketCandidates([ticket], [result({ cleared: [{ ...rule, reason: "ok", quotes: [] }] })], input)).toEqual([]);
  });
});
