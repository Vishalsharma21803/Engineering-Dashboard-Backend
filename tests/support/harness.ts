import request from "supertest";
import type { Express } from "express";

import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { server } from "../setup.js";
import { FAKE_ORG_URL, FAKE_PAT, createFakeAzure, fakeAzureHandlers, type FakeAzure } from "./fake-azure.js";

export type Agent = ReturnType<typeof request.agent>;

let app: Express | null = null;

export function getApp(): Express {
  app ??= createApp();
  return app;
}

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "ProposedAction", "Credential", "User" CASCADE'
  );
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
export async function setupUser(): Promise<{ agent: Agent; credentialId: string }> {
  const agent = await signIn();
  const credentialId = await addCredential(agent);
  return { agent, credentialId };
}

export function azurePath(credentialId: string, path: string): string {
  return `/api/azure/${credentialId}${path}`;
}
