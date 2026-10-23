import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { writeRequests, type FakeAzure } from "../support/fake-azure.js";
import { getApp, installFakeAzure, resetDatabase, setupUser, signIn, type Agent } from "../support/harness.js";

let fake: FakeAzure;
let agent: Agent;
let credentialId: string;

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

beforeEach(async () => {
  await resetDatabase();
  fake = installFakeAzure();
  ({ agent, credentialId } = await setupUser());
});

interface MarkBody {
  id: string;
  itemKey: string;
  status: string;
  snoozedUntil: string | null;
  signals: string[];
}

async function mark(body: Record<string, unknown>, as: Agent = agent, expected = 200): Promise<MarkBody> {
  const response = await as.put("/api/triage").send({ credentialId, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body.mark as MarkBody;
}

async function list(as: Agent = agent, id = credentialId): Promise<MarkBody[]> {
  const response = await as.get(`/api/triage?credentialId=${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.marks as MarkBody[];
}

describe("triage marks", () => {
  it("requires authentication", async () => {
    expect((await request(getApp()).get(`/api/triage?credentialId=${credentialId}`)).status).toBe(401);
    expect((await request(getApp()).put("/api/triage").send({})).status).toBe(401);
  });

  it("snoozes, acknowledges and abandons items without touching Azure DevOps", async () => {
    const snoozedUntil = inDays(3);
    const snoozed = await mark({ itemKey: "wi:102", status: "SNOOZED", snoozedUntil, signals: ["OVERDUE", "OVERDUE"] });
    expect(snoozed).toMatchObject({ itemKey: "wi:102", status: "SNOOZED", signals: ["OVERDUE"] });
    expect(new Date(snoozed.snoozedUntil ?? "").toISOString()).toBe(snoozedUntil);

    await mark({ itemKey: "pr:alpha-repo:7", status: "ACKNOWLEDGED", signals: ["REVIEW_REQUESTED"] });
    await mark({ itemKey: "pipeline:Alpha:3:refs/heads/main", status: "ABANDONED" });
    await mark({ itemKey: "project:legacy app", status: "ABANDONED" });

    expect((await list()).map((item) => [item.itemKey, item.status]).sort()).toEqual([
      ["pipeline:Alpha:3:refs/heads/main", "ABANDONED"],
      ["pr:alpha-repo:7", "ACKNOWLEDGED"],
      ["project:legacy app", "ABANDONED"],
      ["wi:102", "SNOOZED"],
    ]);
    expect(writeRequests(fake)).toEqual([]);
  });

  it("replaces the existing mark for the same item", async () => {
    const first = await mark({ itemKey: "wi:102", status: "SNOOZED", snoozedUntil: inDays(1) });
    const second = await mark({ itemKey: "wi:102", status: "ACKNOWLEDGED", signals: ["STALE"] });

    expect(second).toMatchObject({ id: first.id, status: "ACKNOWLEDGED", snoozedUntil: null, signals: ["STALE"] });
    expect(await list()).toHaveLength(1);
  });

  it("validates keys, statuses and snooze dates", async () => {
    const cases: Array<Record<string, unknown>> = [
      { itemKey: "wi:abc", status: "ABANDONED" },
      { itemKey: "work:1", status: "ABANDONED" },
      { itemKey: "project:a:b", status: "ABANDONED" },
      { itemKey: "wi:1", status: "DONE" },
      { itemKey: "wi:1", status: "SNOOZED" },
      { itemKey: "wi:1", status: "SNOOZED", snoozedUntil: inDays(-1) },
      { itemKey: "wi:1", status: "SNOOZED", snoozedUntil: inDays(400) },
      { itemKey: "wi:1", status: "ACKNOWLEDGED", snoozedUntil: inDays(1) },
      { itemKey: "wi:1", status: "ABANDONED", signals: ["bad\nsignal"] },
      { itemKey: "wi:1", status: "ABANDONED", extra: true },
    ];

    for (const body of cases) {
      const response = await agent.put("/api/triage").send({ credentialId, ...body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    expect((await agent.put("/api/triage").send({ credentialId: "nope", itemKey: "wi:1", status: "ABANDONED" })).status).toBe(400);
    expect((await agent.get("/api/triage")).status).toBe(400);
    expect(await list()).toEqual([]);
  });

  it("rejects non-JSON writes", async () => {
    const response = await agent
      .put("/api/triage")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(`credentialId=${credentialId}&itemKey=wi:1&status=ABANDONED`);

    expect(response.status).toBe(415);
  });

  it("drops snoozes that have ended", async () => {
    const active = await mark({ itemKey: "wi:1", status: "SNOOZED", snoozedUntil: inDays(1) });
    const ended = await mark({ itemKey: "wi:2", status: "SNOOZED", snoozedUntil: inDays(1) });
    await prisma.triageMark.update({ where: { id: ended.id }, data: { snoozedUntil: new Date(Date.now() - 1000) } });

    expect((await list()).map((item) => item.id)).toEqual([active.id]);
    expect(await prisma.triageMark.count()).toBe(1);
  });

  it("restores an item by clearing its mark", async () => {
    const abandoned = await mark({ itemKey: "wi:1", status: "ABANDONED" });

    expect((await agent.delete(`/api/triage/${abandoned.id}`)).status).toBe(200);
    expect(await list()).toEqual([]);
    expect((await agent.delete(`/api/triage/${abandoned.id}`)).status).toBe(404);
    expect((await agent.delete("/api/triage/not-a-uuid")).status).toBe(400);
  });

  it("isolates marks between users", async () => {
    const mine = await mark({ itemKey: "wi:1", status: "ABANDONED" });
    const other = await signIn();

    expect((await other.get(`/api/triage?credentialId=${credentialId}`)).status).toBe(404);
    expect((await other.put("/api/triage").send({ credentialId, itemKey: "wi:2", status: "ABANDONED" })).status).toBe(404);
    expect((await other.delete(`/api/triage/${mine.id}`)).status).toBe(404);
    expect(await list()).toHaveLength(1);
  });

  it("removes marks when the credential is deleted", async () => {
    await mark({ itemKey: "wi:1", status: "ABANDONED" });

    expect((await agent.delete(`/api/credentials/${credentialId}`)).status).toBe(200);
    expect(await prisma.triageMark.count()).toBe(0);
  });
});
