import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { ALPHA_REPO, writeRequests, type FakeAzure } from "../support/fake-azure.js";
import { ALPHA_RULEBOOK, ALPHA_SETTINGS, useAlphaRulebook } from "../support/test-rulebook.js";
import {
  azurePath,
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

interface ActionBody {
  id: string;
  status: string;
  payloadHash: string;
  preview: Array<{ field: string; before: unknown; after: unknown }>;
  summary: string;
  params: Record<string, unknown>;
  errorCode: string | null;
  result: Record<string, unknown> | null;
  credentialId: string | null;
}

async function propose(body: Record<string, unknown>, expected = 201): Promise<ActionBody> {
  const response = await agent.post("/api/actions").send({ credentialId, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body.action as ActionBody;
}

function approve(action: { id: string; payloadHash: string }, as: Agent = agent) {
  return as.post(`/api/actions/${action.id}/approve`).send({ payloadHash: action.payloadHash });
}

async function auditEvents(actionId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { actionId }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => row.event);
}

const comment = (text = "Approach: retry with backoff") => ({
  kind: "WORK_ITEM_COMMENT",
  target: { projectId: "Alpha", workItemId: 102 },
  params: { text },
});

describe("proposing actions", () => {
  it("creates a pending action with a preview and writes nothing to Azure", async () => {
    const action = await propose(comment());

    expect(action).toMatchObject({
      status: "PENDING",
      preview: [{ field: "New comment", before: null, after: "Approach: retry with backoff" }],
    });
    expect(action.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(writeRequests(fake)).toEqual([]);
    expect(await auditEvents(action.id)).toEqual(["PROPOSED"]);
  });

  it("validates the action payload", async () => {
    const unknownKind = await agent.post("/api/actions").send({ credentialId, kind: "DELETE_PROJECT", target: {}, params: {} });
    expect(unknownKind.status).toBe(400);

    const extraParam = await agent
      .post("/api/actions")
      .send({ credentialId, ...comment(), params: { text: "hi", fields: { "System.AssignedTo": "x" } } });
    expect(extraParam.status).toBe(400);

    const emptyUpdate = await agent
      .post("/api/actions")
      .send({ credentialId, kind: "WORK_ITEM_UPDATE_FIELDS", target: { projectId: "Alpha", workItemId: 102 }, params: {} });
    expect(emptyUpdate.status).toBe(400);

    expect(fake.requests).toEqual([]);
  });

  it("requires JSON bodies on action routes", async () => {
    const response = await agent.post("/api/actions").type("form").send("kind=WORK_ITEM_COMMENT");
    expect(response.status).toBe(415);
  });

  it("rejects proposals against another user's credential", async () => {
    const intruder = await signIn();
    const response = await intruder.post("/api/actions").send({ credentialId, ...comment() });
    expect(response.status).toBe(404);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    [{ kind: "WORK_ITEM_UPDATE_FIELDS", target: { projectId: "Alpha", workItemId: 104 }, params: { storyPoints: 5 } }, 404, "AZURE_NOT_FOUND"],
    [{ kind: "WORK_ITEM_UPDATE_FIELDS", target: { projectId: "Alpha", workItemId: 102 }, params: { storyPoints: 5 } }, 422, "FIELD_NOT_SUPPORTED"],
    [{ kind: "WORK_ITEM_UPDATE_FIELDS", target: { projectId: "Alpha", workItemId: 101 }, params: { originalEstimate: 8 } }, 422, "NO_CHANGES"],
    [{ kind: "WORK_ITEM_TRANSITION_STATE", target: { projectId: "Alpha", workItemId: 102 }, params: { state: "Shipped" } }, 422, "INVALID_STATE"],
    [{ kind: "WORK_ITEM_CLOSE_AFTER_MERGE", target: { projectId: "Alpha", workItemId: 101 }, params: {} }, 422, "PRS_NOT_MERGED"],
    [{ kind: "WORK_ITEM_CLOSE_AFTER_MERGE", target: { projectId: "Alpha", workItemId: 102 }, params: {} }, 422, "NO_LINKED_PRS"],
    [{ kind: "WORK_ITEM_LINK_PR", target: { projectId: "Alpha", workItemId: 101 }, params: { repositoryId: ALPHA_REPO.id, pullRequestId: 1 } }, 422, "ALREADY_LINKED"],
    [{ kind: "BUILD_CANCEL", target: { projectId: "Alpha", buildId: 501 }, params: {} }, 422, "BUILD_NOT_RUNNING"],
    [{ kind: "BUILD_RETRY_STAGE", target: { projectId: "Alpha", buildId: 501 }, params: { stageRefName: "Deploy" } }, 422, "STAGE_NOT_RETRYABLE"],
    [{ kind: "BUILD_RETRY_STAGE", target: { projectId: "Alpha", buildId: 503 }, params: { stageRefName: "Build" } }, 422, "STAGE_NOT_FOUND"],
  ])("refuses invalid proposals (%#)", async (body, status, reason) => {
    const response = await agent.post("/api/actions").send({ credentialId, ...body });
    expect(response.status).toBe(status);
    expect(response.body.reason).toBe(reason);
    expect(writeRequests(fake)).toEqual([]);
    expect(await prisma.proposedAction.count()).toBe(0);
  });
});

describe("approval enforcement", () => {
  it("executes exactly once after approval and records the full audit trail", async () => {
    const action = await propose(comment("Line 1\n<b>not html</b>"));

    const response = await approve(action).expect(200);

    expect(response.body.action).toMatchObject({ status: "SUCCEEDED", result: { workItemId: 102 } });
    expect(response.body.verification.verified).toBe(true);

    const writes = writeRequests(fake);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", body: { text: "Line 1<br>&lt;b&gt;not html&lt;/b&gt;" } });
    expect(fake.comments.get(102)?.at(-1)?.text).toBe("Line 1<br>&lt;b&gt;not html&lt;/b&gt;");

    expect(await auditEvents(action.id)).toEqual([
      "PROPOSED",
      "APPROVED",
      "EXECUTION_STARTED",
      "EXECUTION_SUCCEEDED",
    ]);

    const again = await approve(action).expect(409);
    expect(again.body.reason).toBe("ACTION_NOT_PENDING");
    expect(writeRequests(fake)).toHaveLength(1);
  });

  it("refuses a payload hash that does not match the proposal", async () => {
    const action = await propose(comment());
    const response = await approve({ id: action.id, payloadHash: "0".repeat(64) }).expect(409);

    expect(response.body.reason).toBe("PAYLOAD_MISMATCH");
    expect(writeRequests(fake)).toEqual([]);
    expect((await prisma.proposedAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
  });

  it("refuses approval without a payload hash", async () => {
    const action = await propose(comment());
    await agent.post(`/api/actions/${action.id}/approve`).send({}).expect(400);
    expect(writeRequests(fake)).toEqual([]);
  });

  it("runs only one of several concurrent approvals", async () => {
    const action = await propose(comment());

    const responses = await Promise.all([approve(action), approve(action), approve(action)]);
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409, 409]);
    expect(writeRequests(fake)).toHaveLength(1);
  });

  it("never executes a rejected action", async () => {
    const action = await propose(comment());

    const rejected = await agent.post(`/api/actions/${action.id}/reject`).send({ reason: "Not now" }).expect(200);
    expect(rejected.body.action).toMatchObject({ status: "REJECTED", result: { rejectionReason: "Not now" } });

    const response = await approve(action).expect(409);
    expect(response.body.reason).toBe("ACTION_NOT_PENDING");
    expect(writeRequests(fake)).toEqual([]);
    expect(await auditEvents(action.id)).toEqual(["PROPOSED", "REJECTED"]);
  });

  it("never executes an expired action", async () => {
    const action = await propose(comment());
    await prisma.proposedAction.update({ where: { id: action.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await approve(action).expect(409);
    expect(response.body.reason).toBe("ACTION_EXPIRED");
    expect(writeRequests(fake)).toEqual([]);
    expect(await auditEvents(action.id)).toEqual(["PROPOSED", "EXPIRED"]);
  });

  it("keeps actions private to their owner", async () => {
    const action = await propose(comment());
    const intruder = await signIn();

    await intruder.get(`/api/actions/${action.id}`).expect(404);
    await approve(action, intruder).expect(404);
    await intruder.post(`/api/actions/${action.id}/reject`).send({}).expect(404);
    expect((await intruder.get("/api/actions").expect(200)).body.actions).toEqual([]);
    expect((await intruder.get("/api/audit-logs").expect(200)).body.auditLogs).toEqual([]);
    expect(writeRequests(fake)).toEqual([]);
  });

  it("refuses to execute when a field it changes was edited after the proposal", async () => {
    const action = await propose({
      kind: "WORK_ITEM_UPDATE_FIELDS",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { originalEstimate: 5 },
    });

    const item = fake.workItems.get(102)!;
    item.fields["Microsoft.VSTS.Scheduling.OriginalEstimate"] = 2;
    item.rev += 1;

    const response = await approve(action).expect(409);
    expect(response.body).toMatchObject({ reason: "ACTION_STALE", action: { status: "FAILED", errorCode: "ACTION_STALE" } });
    expect(response.body.message).toContain("Original Estimate changed in Azure DevOps after this was proposed (was empty, now 2)");
    expect(writeRequests(fake)).toEqual([]);
    expect(await auditEvents(action.id)).toEqual(["PROPOSED", "APPROVED", "EXECUTION_STARTED", "EXECUTION_FAILED"]);
  });

  it("still executes field changes after a comment or unrelated edit created new revisions", async () => {
    // Regression: approving a comment first used to make every pending field update stale.
    const update = await propose({
      kind: "WORK_ITEM_UPDATE_FIELDS",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { originalEstimate: 5 },
    });
    const transition = await propose({
      kind: "WORK_ITEM_TRANSITION_STATE",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { state: "Closed" },
    });
    const link = await propose({
      kind: "WORK_ITEM_LINK_PR",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { repositoryId: ALPHA_REPO.id, pullRequestId: 3 },
    });

    await approve(await propose(comment())).expect(200);
    fake.workItems.get(102)!.fields["System.Title"] = "Renamed by a teammate";
    fake.workItems.get(102)!.rev += 1;

    await approve(update).expect(200);
    await approve(transition).expect(200);
    await approve(link).expect(200);

    const item = fake.workItems.get(102)!;
    expect(item.fields).toMatchObject({
      "Microsoft.VSTS.Scheduling.OriginalEstimate": 5,
      "System.State": "Closed",
      "System.Title": "Renamed by a teammate",
    });
    expect(writeRequests(fake).filter((request) => request.method === "PATCH")).toHaveLength(3);
  });

  it("guards the write itself against an edit racing the final re-read", async () => {
    const action = await propose({
      kind: "WORK_ITEM_UPDATE_FIELDS",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { originalEstimate: 5 },
    });

    await approve(action).expect(200);
    const [patch] = writeRequests(fake);
    expect((patch?.body as unknown[])[0]).toEqual({ op: "test", path: "/rev", value: 3 });
  });

  it("refuses to execute after the credential was pointed at another organization", async () => {
    const action = await propose(comment());
    await agent
      .patch(`/api/credentials/${credentialId}`)
      .send({ organizationUrl: "https://dev.azure.com/another-org" })
      .expect(200);

    const response = await approve(action).expect(409);
    expect(response.body.reason).toBe("CREDENTIAL_CHANGED");
    expect(writeRequests(fake)).toEqual([]);
    expect((await prisma.proposedAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");
  });

  it("keeps the action and its audit trail after the credential is deleted", async () => {
    const action = await propose(comment());
    await agent.delete(`/api/credentials/${credentialId}`).expect(200);

    const stored = await agent.get(`/api/actions/${action.id}`).expect(200);
    expect(stored.body.action.credentialId).toBeNull();

    const response = await approve(action).expect(409);
    expect(response.body.reason).toBe("CREDENTIAL_REMOVED");
    expect(writeRequests(fake)).toEqual([]);
    expect(await auditEvents(action.id)).toEqual(["PROPOSED"]);
  });
});

describe("executing each action kind", () => {
  it("updates work fields with a revision guard and verifies them", async () => {
    const action = await propose({
      kind: "WORK_ITEM_UPDATE_FIELDS",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { originalEstimate: 5, completedWork: 1.5 },
    });
    expect(action.preview).toEqual([
      { field: "Original estimate (h)", before: null, after: 5 },
      { field: "Completed work (h)", before: 0, after: 1.5 },
    ]);

    const response = await approve(action).expect(200);
    expect(response.body.verification).toMatchObject({ verified: true });

    const [patch] = writeRequests(fake);
    const operations = patch?.body as unknown[];
    expect(operations[0]).toEqual({ op: "test", path: "/rev", value: 3 });
    expect(operations.slice(1)).toHaveLength(2);
    expect(operations.slice(1)).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", value: 5 },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork", value: 1.5 },
      ])
    );
    expect(fake.workItems.get(102)?.fields["Microsoft.VSTS.Scheduling.OriginalEstimate"]).toBe(5);
  });

  it("transitions state", async () => {
    const action = await propose({
      kind: "WORK_ITEM_TRANSITION_STATE",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { state: "Closed" },
    });

    await approve(action).expect(200);
    expect(fake.workItems.get(102)?.fields["System.State"]).toBe("Closed");
  });

  it("closes a ticket after its PR merged and zeroes remaining work", async () => {
    const action = await propose({
      kind: "WORK_ITEM_CLOSE_AFTER_MERGE",
      target: { projectId: "Alpha", workItemId: 103 },
      params: {},
    });
    expect(action.preview).toEqual([
      { field: "State", before: "Resolved", after: "Closed" },
      { field: "Remaining work (h)", before: 1, after: 0 },
    ]);

    const response = await approve(action).expect(200);
    expect(response.body.action.result).toMatchObject({ previousState: "Resolved", verification: { verified: true } });
    expect(fake.workItems.get(103)?.fields).toMatchObject({
      "System.State": "Closed",
      "Microsoft.VSTS.Scheduling.RemainingWork": 0,
    });
  });

  it("refuses to close after merge when the project's SOP has a Testing stage", async () => {
    await useAlphaRulebook(ALPHA_RULEBOOK, { stages: { ...ALPHA_SETTINGS.stages, testing: ["Testing"] } });

    const response = await agent.post("/api/actions").send({
      credentialId,
      kind: "WORK_ITEM_CLOSE_AFTER_MERGE",
      target: { projectId: "Alpha", workItemId: 103 },
      params: {},
    });

    expect(response.status).toBe(422);
    expect(response.body.reason).toBe("CLOSE_AFTER_MERGE_DISABLED");
    expect(writeRequests(fake)).toEqual([]);

    const detail = await agent.get(azurePath(credentialId, "/projects/Alpha/work-items/103")).expect(200);
    expect(detail.body.workItem.closeAfterMergeAllowed).toBe(false);
  });

  it("links a pull request", async () => {
    const action = await propose({
      kind: "WORK_ITEM_LINK_PR",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { repositoryId: ALPHA_REPO.id, pullRequestId: 3 },
    });

    const response = await approve(action).expect(200);
    expect(response.body.verification.verified).toBe(true);
    expect(fake.workItems.get(102)?.relations?.at(-1)).toMatchObject({
      rel: "ArtifactLink",
      url: expect.stringMatching(/^vstfs:\/\/\/Git\/PullRequestId\/.+%2F.+%2F3$/),
    });
  });

  it("queues a pipeline run", async () => {
    const action = await propose({
      kind: "PIPELINE_QUEUE_RUN",
      target: { projectId: "Alpha", definitionId: 10 },
      params: {},
    });
    expect(action.params).toEqual({ sourceBranch: "refs/heads/main" });

    const response = await approve(action).expect(200);
    expect(response.body.action.result).toMatchObject({ buildId: 900 });
    expect(fake.builds.some((build) => build.id === 900)).toBe(true);
  });

  it("retries a failed stage", async () => {
    const action = await propose({
      kind: "BUILD_RETRY_STAGE",
      target: { projectId: "Alpha", buildId: 501 },
      params: { stageRefName: "Build" },
    });

    const response = await approve(action).expect(200);
    expect(response.body.verification.verified).toBe(true);
    expect(writeRequests(fake)[0]).toMatchObject({ method: "PATCH", body: { state: "retry", forceRetryAllJobs: false } });
  });

  it("cancels a running build", async () => {
    const action = await propose({ kind: "BUILD_CANCEL", target: { projectId: "Alpha", buildId: 503 }, params: {} });

    await approve(action).expect(200);
    expect(fake.builds.find((build) => build.id === 503)?.status).toBe("cancelling");
  });
});

describe("execution failures", () => {
  it("records a missing write scope and surfaces it in capabilities", async () => {
    fake.missingScopes.add("workWrite");
    const action = await propose(comment());

    const response = await approve(action).expect(403);
    expect(response.body).toMatchObject({ reason: "AZURE_INSUFFICIENT_SCOPE", action: { status: "FAILED" } });

    const capabilities = await agent.get(azurePath(credentialId, "/capabilities")).expect(200);
    expect(capabilities.body.capabilities.writeScopes).toEqual({ work: "missing", build: "unknown" });
  });

  it("learns a granted write scope from a successful action", async () => {
    await approve(await propose(comment())).expect(200);

    const capabilities = await agent.get(azurePath(credentialId, "/capabilities")).expect(200);
    expect(capabilities.body.capabilities.writeScopes.work).toBe("granted");
  });

  it("surfaces Azure validation messages", async () => {
    const action = await propose({
      kind: "WORK_ITEM_UPDATE_FIELDS",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { remainingWork: 3 },
    });
    fake.failNextWrite = 400;

    const response = await approve(action).expect(422);
    expect(response.body.reason).toBe("AZURE_BAD_REQUEST");
    expect(response.body.message).toContain("TF401320");
  });

  it("marks the outcome unknown when Azure drops the write", async () => {
    const action = await propose(comment());
    fake.dropWrites = true;

    const response = await approve(action).expect(502);
    expect(response.body).toMatchObject({ reason: "OUTCOME_UNKNOWN", action: { status: "FAILED", errorCode: "OUTCOME_UNKNOWN" } });
    expect(writeRequests(fake)).toHaveLength(1);
  });

  it("treats an upstream 5xx after the write as an unknown outcome", async () => {
    const action = await propose(comment());
    fake.failNextWrite = 503;

    const response = await approve(action).expect(502);
    expect(response.body.reason).toBe("OUTCOME_UNKNOWN");
  });

  it("does not report a missing write scope when a pre-write read was refused", async () => {
    const action = await propose({
      kind: "WORK_ITEM_UPDATE_FIELDS",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { originalEstimate: 5 },
    });
    fake.missingScopes.add("work");

    await approve(action).expect(403);
    expect(writeRequests(fake)).toEqual([]);

    fake.missingScopes.delete("work");
    const capabilities = await agent.get(azurePath(credentialId, "/capabilities?refresh=1")).expect(200);
    expect(capabilities.body.capabilities.writeScopes.work).toBe("unknown");
  });

  it("lists actions and audit logs for the owner", async () => {
    const first = await propose(comment("one"));
    await propose(comment("two"));
    await approve(first).expect(200);

    const pending = await agent.get("/api/actions?status=PENDING").expect(200);
    expect(pending.body.actions).toHaveLength(1);

    const logs = await agent.get(`/api/audit-logs?actionId=${first.id}`).expect(200);
    expect(logs.body.auditLogs.map((log: { event: string }) => log.event)).toEqual(
      expect.arrayContaining(["PROPOSED", "APPROVED", "EXECUTION_STARTED", "EXECUTION_SUCCEEDED"])
    );
    expect(JSON.stringify(logs.body)).not.toContain("fake-pat");
  });
});

describe("AI fix actions", () => {
  const CATEGORY_SETTINGS = {
    ...ALPHA_SETTINGS,
    fields: { category: "Microsoft.VSTS.Common.Activity", targetCompletion: null },
    categories: { Development: "Writing code.", Testing: "Writing or running tests." },
  };

  it("replaces a description with escaped HTML after approval, and records the old value", async () => {
    const action = await propose({
      kind: "WORK_ITEM_EDIT_TEXT",
      source: "AI_SUGGESTION",
      target: { projectId: "Alpha", workItemId: 101 },
      params: { field: "description", text: "As a user I want <login> & logout\nso that I stay safe." },
    });

    expect(action.preview).toEqual([{ field: "Description", before: "Use JWT & cookies", after: "As a user I want <login> & logout\nso that I stay safe." }]);
    expect(action.summary).not.toContain("not kept");
    expect(writeRequests(fake)).toEqual([]);

    const response = await approve(action).expect(200);
    expect(response.body.verification.verified).toBe(true);
    expect(fake.workItems.get(101)?.fields["System.Description"]).toBe("As a user I want &lt;login&gt; &amp; logout<br>so that I stay safe.");
    expect(response.body.action.result).toMatchObject({ field: "System.Description", previousValue: expect.stringContaining("JWT") });
    expect((await prisma.proposedAction.findUniqueOrThrow({ where: { id: action.id } })).source).toBe("AI_SUGGESTION");
  });

  it("warns that rich formatting is replaced by plain text", async () => {
    fake.workItems.get(101)!.fields["System.Description"] = '<p>See <a href="https://x.test">spec</a></p><table><tr><td>1</td></tr></table>';
    const action = await propose({ kind: "WORK_ITEM_EDIT_TEXT", target: { projectId: "Alpha", workItemId: 101 }, params: { field: "description", text: "Plain" } });
    expect(action.summary).toContain("current links, lists, tables and images are not kept");
  });

  it("refuses multi-line titles and stale text", async () => {
    await propose({ kind: "WORK_ITEM_EDIT_TEXT", target: { projectId: "Alpha", workItemId: 101 }, params: { field: "title", text: "Two\nlines" } }, 400);

    const action = await propose({ kind: "WORK_ITEM_EDIT_TEXT", target: { projectId: "Alpha", workItemId: 101 }, params: { field: "title", text: "[Blocked] Implement login" } });
    fake.workItems.get(101)!.fields["System.Title"] = "Implement login v2";

    const response = await approve(action).expect(409);
    expect(response.body.reason).toBe("ACTION_STALE");
    expect(writeRequests(fake)).toEqual([]);
  });

  it("sets the category only to one of the project's categories", async () => {
    await useAlphaRulebook(ALPHA_RULEBOOK, CATEGORY_SETTINGS);

    const wrong = await agent.post("/api/actions").send({ credentialId, kind: "WORK_ITEM_SET_CATEGORY", target: { projectId: "Alpha", workItemId: 102 }, params: { category: "Coding" } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.reason).toBe("INVALID_CATEGORY");

    const action = await propose({ kind: "WORK_ITEM_SET_CATEGORY", target: { projectId: "Alpha", workItemId: 102 }, params: { category: "development" } });
    expect(action.preview).toEqual([{ field: "Category", before: null, after: "Development" }]);

    await approve(action).expect(200);
    expect(fake.workItems.get(102)?.fields["Microsoft.VSTS.Common.Activity"]).toBe("Development");
  });

  it("refuses a category when the rulebook has no category field", async () => {
    const response = await agent.post("/api/actions").send({ credentialId, kind: "WORK_ITEM_SET_CATEGORY", target: { projectId: "Alpha", workItemId: 102 }, params: { category: "Development" } });
    expect(response.body.reason).toBe("CATEGORY_NOT_CONFIGURED");
  });

  it("adds only new tags and keeps the existing ones", async () => {
    await propose({ kind: "WORK_ITEM_ADD_TAGS", target: { projectId: "Alpha", workItemId: 106 }, params: { tags: ["a;b"] } }, 400);
    const unchanged = await agent.post("/api/actions").send({ credentialId, kind: "WORK_ITEM_ADD_TAGS", target: { projectId: "Alpha", workItemId: 106 }, params: { tags: ["VENDOR"] } });
    expect(unchanged.body.reason).toBe("NO_CHANGES");

    const action = await propose({ kind: "WORK_ITEM_ADD_TAGS", target: { projectId: "Alpha", workItemId: 106 }, params: { tags: ["vendor", "Backend"] } });
    expect(action.preview).toEqual([{ field: "Tags", before: "Blocked; vendor", after: "Blocked; vendor; Backend" }]);

    const response = await approve(action).expect(200);
    expect(response.body.verification.verified).toBe(true);
    expect(fake.workItems.get(106)?.fields["System.Tags"]).toBe("Blocked; vendor; Backend");
  });
});

describe("hardening", () => {
  it("refuses AI drafts that still contain [[fill in]] gaps", async () => {
    const response = await agent.post("/api/actions").send({
      credentialId,
      kind: "WORK_ITEM_COMMENT",
      source: "AI_SUGGESTION",
      target: { projectId: "Alpha", workItemId: 102 },
      params: { text: "Root cause: [[fill in: root cause]]" },
    });
    expect(response.status).toBe(422);
    expect(response.body.reason).toBe("PLACEHOLDER_NOT_FILLED");
    expect(fake.requests).toEqual([]);
  });

  it("answers malformed JSON with a JSON 400 and no stack trace", async () => {
    const response = await agent.post("/api/actions").set("Content-Type", "application/json").send("{not json");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "The request body is not valid JSON", reason: "INVALID_JSON" });
    expect(response.text).not.toContain("at ");
  });

  it("does not advertise the framework", async () => {
    const response = await agent.get("/");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});
