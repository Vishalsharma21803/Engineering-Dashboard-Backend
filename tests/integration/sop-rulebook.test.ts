import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEffectiveRulebook } from "../../src/services/sop/rulebook.service.js";
import { STARTER_RULEBOOK } from "../../src/services/sop/starter-rulebook.js";
import { writeRequests } from "../support/fake-azure.js";
import { installFakeAzure, resetDatabase, setupUser, signIn, type Agent } from "../support/harness.js";
import { useAlphaRulebook } from "../support/test-rulebook.js";

let owner: Agent;
let developer: Agent;

beforeEach(async () => {
  await resetDatabase();
  owner = await signIn("owner@example.com");
  developer = await signIn();
  process.env.SOP_ADMIN_EMAILS = "owner@example.com";
});

afterEach(() => {
  delete process.env.SOP_ADMIN_EMAILS;
});

const MY_RULE = `---
id: MY-01
title: Bugs name the browser
checker: ai
applies_to: [bug]
when: always
severity: warn
---
**Rule:** Every bug says which browser and version it was found in.

**Passes when:** The description or a comment names a browser and version.

**Fails when:** No browser is mentioned.
`;

describe("default rulebook", () => {
  it("serves the built-in WI-002 starter as version 0 to everyone", async () => {
    const response = await developer.get("/api/sop/rulebook").expect(200);
    expect(response.body.rulebook).toMatchObject({ version: 0, content: STARTER_RULEBOOK, note: "Built-in WI-002 starter" });
  });

  it("only SOP owners can save, and every save is a new version", async () => {
    await developer.put("/api/sop/rulebook").send({ content: STARTER_RULEBOOK }).expect(403);

    const first = await owner.put("/api/sop/rulebook").send({ content: STARTER_RULEBOOK, note: "Initial" }).expect(200);
    expect(first.body.rulebook).toMatchObject({ version: 1, note: "Initial", createdBy: "Test User" });

    const edited = STARTER_RULEBOOK.replace("id: STR-01\ntitle: Title is a short phrase", "id: STR-01\ntitle: Title is short");
    await owner.put("/api/sop/rulebook").send({ content: edited }).expect(200);

    const versions = (await developer.get("/api/sop/rulebook/versions").expect(200)).body.versions;
    expect(versions.map((version: { version: number }) => version.version)).toEqual([2, 1, 0]);

    const old = await developer.get("/api/sop/rulebook/versions/1").expect(200);
    expect(old.body.rulebook.content).toBe(STARTER_RULEBOOK);
    await developer.get("/api/sop/rulebook/versions/9").expect(404);
  });

  it("refuses invalid rulebooks with line-numbered errors and keeps the current version", async () => {
    const response = await owner
      .put("/api/sop/rulebook")
      .send({ content: "---\nid: X-01\ntitle: Bad\nchecker: code\nuses: nope\napplies_to: all\nwhen: always\n---\n**Rule:** x\n" })
      .expect(422);

    expect(response.body.reason).toBe("RULEBOOK_INVALID");
    expect(response.body.errors).toEqual([{ field: "line 1", message: expect.stringContaining('"nope" is not a built-in check') }]);
    expect((await developer.get("/api/sop/rulebook").expect(200)).body.rulebook.version).toBe(0);
  });

  it("validates without saving (dry run for the editor)", async () => {
    const response = await developer.post("/api/sop/validate").send({ content: STARTER_RULEBOOK, scope: "default" }).expect(200);
    expect(response.body.valid).toBe(true);
    // Projects are set up on the Projects screen, not in the rulebook text.
    expect(response.body.summary.projects).toEqual([]);
    expect(response.body.summary.cards.find((card: { id: string }) => card.id === "STR-08")).toMatchObject({ checker: "ai", severity: "warn" });
  });
});

describe("personal rules", () => {
  it("starts empty, saves overrides and MY- rules as versions", async () => {
    expect((await developer.get("/api/sop/my-rules").expect(200)).body.rulebook).toEqual({ version: 0, content: "", createdAt: null });

    const content = `---\nid: DEV-02\nseverity: off\n---\n${MY_RULE}`;
    const saved = await developer.put("/api/sop/my-rules").send({ content }).expect(200);
    expect(saved.body.rulebook).toMatchObject({ version: 1, content });

    await developer.put("/api/sop/my-rules").send({ content: MY_RULE }).expect(200);
    expect((await developer.get("/api/sop/my-rules/versions").expect(200)).body.versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);
    expect((await developer.get("/api/sop/my-rules/versions/1").expect(200)).body.rulebook.content).toBe(content);
  });

  it("rejects personal entries that don't match a default rule or try to change facts", async () => {
    const unknown = await developer.put("/api/sop/my-rules").send({ content: "---\nid: NOPE-01\nseverity: off\n---\n" }).expect(422);
    expect(unknown.body.errors[0].message).toContain("no default rule");

    const facts = await developer.put("/api/sop/my-rules").send({ content: "---\nkind: project\nproject: automations\n---\n" }).expect(422);
    expect(facts.body.errors[0].message).toContain("Projects tab");
  });

  it("keeps personal rules private", async () => {
    await developer.put("/api/sop/my-rules").send({ content: MY_RULE }).expect(200);
    expect((await owner.get("/api/sop/my-rules").expect(200)).body.rulebook.content).toBe("");
    await owner.get("/api/sop/my-rules/versions/1").expect(404);
  });

  it("merges into the effective rules, while team reports ignore personal changes", async () => {
    await developer.put("/api/sop/my-rules").send({ content: `---\nid: DEV-02\nseverity: off\n---\n${MY_RULE}` }).expect(200);

    const effective = (await developer.get("/api/sop/effective").expect(200)).body;
    expect(effective).toMatchObject({ defaultVersion: 0, personalVersion: 1, issues: [] });
    expect(effective.cards.find((card: { id: string }) => card.id === "DEV-02")).toMatchObject({ severity: "off", origin: "personal" });
    expect(effective.cards.find((card: { id: string }) => card.id === "MY-01")).toBeTruthy();

    const userId = (await developer.get("/api/auth/me").expect(200)).body.user.id;
    const team = await getEffectiveRulebook(userId, { forTeamReports: true });
    expect(team.cards.find((card) => card.id === "DEV-02")?.severity).toBe("warn");
    expect(team.cards.some((card) => card.id === "MY-01")).toBe(false);
  });
});

describe("testing rules on a real ticket", () => {
  it("runs saved or draft rules on one ticket without writing anything", async () => {
    const fake = installFakeAzure();
    const { agent, credentialId } = await setupUser();
    await useAlphaRulebook();
    const test = (body: object) => agent.post(`/api/sop/test/${credentialId}`).send({ projectId: "Alpha", workItemId: 102, ...body });

    const saved = (await test({}).expect(200)).body;
    expect(saved.errors).toEqual([]);
    expect(saved.result.violations.map((violation: { ruleId: string }) => violation.ruleId)).toEqual(["T-01"]);

    const personalDraft = (await test({ draft: { scope: "personal", content: "---\nid: T-01\nseverity: off\n---\n" } }).expect(200)).body;
    expect(personalDraft.result.violations).toEqual([]);
    expect(personalDraft.result.rulebook).toEqual({ defaultVersion: 1, personalVersion: -1 });

    const broken = (await test({ draft: { scope: "personal", content: "---\nid: NOPE-01\nseverity: off\n---\n" } }).expect(200)).body;
    expect(broken).toEqual({ result: null, errors: [{ field: "line 1", message: expect.stringContaining("no default rule") }] });

    // Default drafts can carry regexes (branch_pattern): only SOP owners may run them.
    const notOwner = await test({ draft: { scope: "default", content: "---\nkind: project\nproject: Alpha\nbranch_pattern: \"(a+)+$\"\n---\n" } }).expect(403);
    expect(notOwner.body.reason).toBe("SOP_ADMIN_REQUIRED");

    await test({ projectId: "Beta" }).expect(404);
    await agent.post(`/api/sop/test/${credentialId}`).send({ projectId: "Alpha" }).expect(400);
    expect(writeRequests(fake)).toEqual([]);
  });
});

describe("team SOP report", () => {
  it("covers the whole team with the default rules only, ignoring personal rules", async () => {
    installFakeAzure();
    const { agent, credentialId } = await setupUser();
    await useAlphaRulebook();
    // A personal override must not change the team report.
    await agent.put("/api/sop/my-rules").send({ content: "---\nid: T-01\nseverity: off\n---\n" }).expect(200);

    const report = (await agent.get(`/api/azure/${credentialId}/projects/Alpha/sop-report`).expect(200)).body.report;

    // #106 is still New: "before work starts" rules are only checked once work starts.
    expect(report).toMatchObject({ projectName: "Alpha", configured: true, defaultVersion: 1, itemsChecked: 5, itemsWithGaps: 3, compliantShare: 0.4 });
    expect(report.byRule).toEqual([
      { ruleId: "T-01", ruleTitle: "Estimate exists", severity: "high", failing: 3, checked: 4 },
      { ruleId: "T-03", ruleTitle: "Priority is set", severity: "medium", failing: 1, checked: 4 },
      { ruleId: "T-02", ruleTitle: "Pull request linked at review", severity: "medium", failing: 0, checked: 1 },
    ]);
    expect(report.byPerson.map((person: { assignee: { displayName: string }; items: number; gaps: number }) => [person.assignee.displayName, person.items, person.gaps])).toEqual([
      ["Dev Example", 4, 2],
      ["Reviewer Two", 1, 2],
    ]);
    expect(report.items).toMatchObject({ page: 1, pageSize: 10, total: 3, totalPages: 1 });
    expect(report.items.items.map((item: { workItemId: number }) => item.workItemId).sort()).toEqual([102, 103, 105]);

    const beta = (await agent.get(`/api/azure/${credentialId}/projects/Beta/sop-report`).expect(200)).body.report;
    expect(beta).toMatchObject({ configured: false, itemsChecked: 0, byRule: [] });
  });
});
