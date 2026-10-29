import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../src/lib/prisma.js";
import { RULE_LEVEL_UPDATES } from "../../src/services/sop/rule-levels.js";
import { writeRequests, type FakeAzure } from "../support/fake-azure.js";
import { azurePath, installFakeAzure, resetDatabase, runSopReport, setupUser, type Agent } from "../support/harness.js";
import { ALPHA_RULEBOOK, useAlphaRulebook } from "../support/test-rulebook.js";

let fake: FakeAzure;
let agent: Agent;
let credentialId: string;

beforeEach(async () => {
  await resetDatabase();
  fake = installFakeAzure();
  ({ agent, credentialId } = await setupUser());
});

const compliance = async (as: Agent, cred: string, refresh = false) =>
  new Map<number, { configured: boolean; sopProject: string; violations: unknown[]; todos: Array<{ ruleId: string }> }>(
    (await as.get(azurePath(cred, `/compliance${refresh ? "?refresh=true" : ""}`)).expect(200)).body.items.map((item: { workItemId: number }) => [item.workItemId, item])
  );

describe("moving projects out of the rulebook", () => {
  it("turns old project blocks into set-ups once, saves a rulebook without them and re-times estimate rules", async () => {
    const legacy = `---
kind: project
project: Alpha
stages:
  ready: [New, Estimations]
  active: [Active]
  done: [Closed]
---
Alpha notes.

---
id: STR-05
title: Estimate exists
checker: code
uses: estimate-present
applies_to: [task, bug]
when: before-active
---
**Rule:** Estimate.
`;
    await prisma.rulebook.create({ data: { version: 1, content: legacy, note: "old" } });
    // Only the project move is under test here (the rule updates have their own tests).
    await prisma.appSetting.createMany({ data: RULE_LEVEL_UPDATES.map((update) => ({ key: update.key, value: { test: true } })) });

    const projects = (await agent.get("/api/sop/projects").expect(200)).body.projects;
    expect(projects).toEqual([
      expect.objectContaining({ projectName: "Alpha", checkedForMe: true, settings: expect.objectContaining({ stages: { ready: ["New"], estimation: ["Estimations"], active: ["Active"], done: ["Closed"] } }) }),
    ]);

    const rulebook = (await agent.get("/api/sop/rulebook").expect(200)).body.rulebook;
    expect(rulebook).toMatchObject({ version: 2, note: expect.stringContaining("Projects moved") });
    expect(rulebook.content).not.toContain("kind: project");
    expect(rulebook.content).toContain("when: at-estimation");
    expect((await agent.get("/api/sop/projects/Alpha/history").expect(200)).body.changes).toEqual([
      expect.objectContaining({ kind: "IMPORTED", changedBy: "Cockpit" }),
    ]);

    // Runs once: nothing more happens on later requests.
    await agent.get("/api/sop/rulebook").expect(200);
    expect(await prisma.rulebook.count()).toBe(2);
  });

  it("refuses saving a rulebook that still has a project block", async () => {
    process.env.SOP_ADMIN_EMAILS = "owner@example.com";
    const owner = await setupUser("owner@example.com");
    const response = await owner.agent.put("/api/sop/rulebook").send({ content: "---\nkind: project\nproject: X\n---\n" }).expect(422);
    expect(response.body.errors[0].message).toContain("Projects tab");
    delete process.env.SOP_ADMIN_EMAILS;
  });
});

describe("fresh installs", () => {
  it("start with the built-in starter's project set-ups", async () => {
    const projects = (await agent.get("/api/sop/projects").expect(200)).body.projects;
    expect(projects.map((project: { projectName: string }) => project.projectName)).toEqual(["automations", "DevOps"]);
    expect(projects[0].settings.stages).toMatchObject({ ready: ["New"], estimation: ["Estimations"] });
    // The starter is not a saved version, so no rulebook version is created.
    expect(await prisma.rulebook.count()).toBe(0);
  });
});

describe("rule timing", () => {
  it("does not flag new tickets: before-work rules wait for Active, estimate rules for Estimations", async () => {
    await useAlphaRulebook(ALPHA_RULEBOOK.replace("when: before-active\nseverity: fail", "when: at-estimation\nseverity: fail"), {
      stages: { ready: ["New"], estimation: ["Estimations"], active: ["Active"], review: ["Resolved"], done: ["Closed"] },
    });
    const byId = await compliance(agent, credentialId);

    // #106 is New: no gaps, and the estimate is not asked for yet (before-work items are only to-dos).
    expect(byId.get(106)).toMatchObject({ configured: true, violations: [] });
    expect(byId.get(106)?.todos.map((todo) => todo.ruleId)).not.toContain("T-01");
    // #102 is Active without an estimate: a gap from an earlier stage.
    expect(byId.get(102)?.violations).toEqual([expect.objectContaining({ ruleId: "T-01", phase: "earlier" })]);

    // Moved to Estimations: the estimate is a to-do there, not a gap yet.
    fake.workItems.get(106)!.fields["System.State"] = "Estimations";
    const later = await compliance(agent, credentialId, true);
    expect(later.get(106)?.violations).toEqual([]);
    expect(later.get(106)?.todos).toEqual([expect.objectContaining({ ruleId: "T-01", phase: "now" })]);
  });
});

describe("project set-ups", () => {
  it("lists the organization's projects, pre-fills a set-up from Azure, and records every change", async () => {
    const listed = (await agent.get(`/api/sop/azure-projects/${credentialId}?page=x&elsewherePage=9`).expect(200)).body;
    expect(listed.projects).toMatchObject({ page: 1, pageSize: 10, total: 2 });
    expect(listed.projects.items.map((project: { name: string; setUp: boolean }) => [project.name, project.setUp])).toEqual([
      ["Alpha", false],
      ["Beta", false],
    ]);
    // Fresh installs start with the starter's set-ups, which are not in this organization.
    expect(listed.elsewhere).toMatchObject({ page: 1, total: 2 });
    expect(listed.elsewhere.items.map((setUp: { projectName: string }) => setUp.projectName)).toEqual(["automations", "DevOps"]);

    const suggestion = (await agent.get(`/api/sop/azure-projects/${credentialId}/Alpha/suggestion`).expect(200)).body.suggestion;
    expect(suggestion).toMatchObject({ projectName: "Alpha", setUp: false });
    expect(suggestion.settings.stages).toMatchObject({ ready: ["New"], active: ["Active"], review: ["Resolved"], done: ["Closed"] });
    expect(suggestion.settings.fields.category).toBe("Microsoft.VSTS.Common.Activity");
    expect(suggestion.states.map((state: { name: string }) => state.name)).toEqual(expect.arrayContaining(["New", "Active", "Resolved", "Closed"]));

    await agent.put("/api/sop/projects/Alpha").send({ settings: suggestion.settings }).expect(200);
    const changed = { ...suggestion.settings, timeZone: "Asia/Kolkata" };
    const saved = (await agent.put("/api/sop/projects/Alpha").send({ settings: changed }).expect(200)).body.project;
    expect(saved).toMatchObject({ projectName: "Alpha", updatedBy: "Test User", settings: { timeZone: "Asia/Kolkata" } });

    const history = (await agent.get("/api/sop/projects/Alpha/history").expect(200)).body.changes;
    expect(history.map((change: { kind: string }) => change.kind)).toEqual(["UPDATED", "CREATED"]);
    expect(writeRequests(fake)).toEqual([]);
  });

  it("lets only SOP owners change the branch pattern (a regex run in everyone's checks)", async () => {
    const risky = { stages: { active: ["Active"] }, branchPattern: "^refs/heads/(a+)+{id}$" };
    const saved = (await agent.put("/api/sop/projects/Alpha").send({ settings: risky }).expect(200)).body.project;
    expect(saved.settings.branchPattern).not.toBe(risky.branchPattern);

    process.env.SOP_ADMIN_EMAILS = "owner@example.com";
    const owner = await setupUser("owner@example.com");
    const ownerSaved = (await owner.agent.put("/api/sop/projects/Alpha").send({ settings: { ...risky, branchPattern: "^feature/{id}-.+$" } }).expect(200)).body.project;
    expect(ownerSaved.settings.branchPattern).toBe("^feature/{id}-.+$");
    // A later save by someone else keeps the owner's pattern.
    const kept = (await agent.put("/api/sop/projects/Alpha").send({ settings: risky }).expect(200)).body.project;
    expect(kept.settings.branchPattern).toBe("^feature/{id}-.+$");
    delete process.env.SOP_ADMIN_EMAILS;
  });

  it("rejects invalid settings with field errors", async () => {
    const response = await agent
      .put("/api/sop/projects/Alpha")
      .send({ settings: { stages: { ready: ["New"], active: ["new"] }, timeZone: "Mars/Base", colour: "red" } })
      .expect(400);
    const fields = response.body.errors.map((error: { field: string }) => error.field);
    expect(fields).toEqual(expect.arrayContaining(["stages", "timeZone"]));
  });

  it("lets each user switch a set-up project off for themselves only", async () => {
    await useAlphaRulebook();
    const other = await setupUser();

    await agent.put("/api/sop/projects/Alpha/checked").send({ checked: false }).expect(200);
    expect((await agent.get("/api/sop/projects").expect(200)).body.projects[0]).toMatchObject({ projectName: "Alpha", checkedForMe: false });

    const mine = await compliance(agent, credentialId);
    expect(mine.get(102)).toMatchObject({ configured: false, sopProject: "switched-off", violations: [] });
    // Someone else still gets Alpha checked, and so do team reports.
    expect((await compliance(other.agent, other.credentialId)).get(102)).toMatchObject({ configured: true, sopProject: "checked" });
    const report = await runSopReport(agent, credentialId, "Alpha");
    expect(report.itemsChecked).toBeGreaterThan(0);

    await agent.put("/api/sop/projects/Alpha/checked").send({ checked: true }).expect(200);
    expect((await compliance(agent, credentialId)).get(102)).toMatchObject({ sopProject: "checked" });
    await agent.put("/api/sop/projects/Beta/checked").send({ checked: true }).expect(404);
  });

  it("removes a set-up for everyone and keeps its history", async () => {
    await useAlphaRulebook();
    await agent.delete("/api/sop/projects/Alpha").expect(200);

    expect((await compliance(agent, credentialId)).get(102)).toMatchObject({ configured: false, sopProject: "not-set-up" });
    expect((await agent.get("/api/sop/projects/Alpha/history").expect(200)).body.changes[0]).toMatchObject({ kind: "REMOVED" });
    await agent.delete("/api/sop/projects/Alpha").expect(404);
  });
});
