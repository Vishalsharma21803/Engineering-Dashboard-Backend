import request from "supertest";
import type { Express } from "express";

import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { server } from "../setup.js";
import { FAKE_ORG_URL, FAKE_PAT, createFakeAzure, fakeAzureHandlers, type FakeAzure } from "./fake-azure.js";
import { EMPLOYEE_TOKEN, SOLIDTIME_URL, createFakeSolidtime, fakeSolidtimeHandlers, type FakeSolidtime } from "./fake-solidtime.js";

export type Agent = ReturnType<typeof request.agent>;

let app: Express | null = null;

export function getApp(): Express {
  app ??= createApp();
  return app;
}

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "ProposedAction", "Credential", "User", "AppSetting", "Rulebook", "SopProject", "SopProjectChange" CASCADE'
  );
}

export function installFakeSolidtime(): FakeSolidtime {
  const fake = createFakeSolidtime();
  server.use(...fakeSolidtimeHandlers(fake));
  return fake;
}

/** Connects Solidtime for this user (one organization, so it is chosen at once), linked to their first Azure organization. */
export async function connectSolidtime(agent: Agent, token = EMPLOYEE_TOKEN): Promise<string> {
  const response = await agent.post("/api/solidtime/connections").send({ baseUrl: SOLIDTIME_URL, token }).expect(201);
  return response.body.connection.credentialId as string;
}

export function installFakeAzure(): FakeAzure {
  const fake = createFakeAzure();
  server.use(...fakeAzureHandlers(fake));
  return fake;
}

let userCounter = 0;

export async function signIn(email = `user${++userCounter}-${Date.now()}@example.com`): Promise<Agent> {
  const agent = request.agent(getApp());

  await agent
    .post("/api/auth/register")
    .send({ name: "Test User", email, password: "password123" })
    .expect(201);

  await agent.post("/api/auth/login").send({ email, password: "password123" }).expect(200);

  return agent;
}

export async function addCredential(agent: Agent, patToken = FAKE_PAT): Promise<string> {
  const response = await agent
    .post("/api/credentials")
    .send({ platform: "AZURE", organizationUrl: FAKE_ORG_URL, patToken })
    .expect(201);

  return response.body.credential.id as string;
}

/** Signed-in user with a credential pointing at the fake org. */
export async function setupUser(email?: string): Promise<{ agent: Agent; credentialId: string }> {
  const agent = await signIn(email);
  const credentialId = await addCredential(agent);
  return { agent, credentialId };
}

export function azurePath(credentialId: string, path: string): string {
  return `/api/azure/${credentialId}${path}`;
}

/** Runs and saves the team SOP report, then reads the run (with optional filters and pages). */
export async function runSopReport(agent: Agent, credentialId: string, project: string, query = "") {
  const run = (await agent.post(`/api/sop/reports/${credentialId}/${project}`).send({}).expect(200)).body.run;
  return (await agent.get(`/api/sop/reports/${credentialId}/${project}/${run.id}${query}`).expect(200)).body.report;
}
