import { AppError } from "../lib/app-error.js";
import { prisma } from "../lib/prisma.js";
import type { UpsertTriageInput } from "../schemas/triage.schema.js";

const triageSelect = {
  id: true,
  credentialId: true,
  itemKey: true,
  status: true,
  snoozedUntil: true,
  signals: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function assertOwnedCredential(userId: string, credentialId: string): Promise<void> {
  const credential = await prisma.credential.findFirst({
    where: { id: credentialId, userId },
    select: { id: true },
  });

  if (!credential) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
  }
}

export async function listTriageMarks(userId: string, credentialId: string, now = new Date()) {
  await assertOwnedCredential(userId, credentialId);

  // An ended snooze simply returns the item to the dashboard.
  await prisma.triageMark.deleteMany({
    where: { userId, credentialId, status: "SNOOZED", snoozedUntil: { lte: now } },
  });

  return prisma.triageMark.findMany({
    where: { userId, credentialId },
    select: triageSelect,
    orderBy: { updatedAt: "desc" },
  });
}

export async function upsertTriageMark(userId: string, input: UpsertTriageInput) {
  await assertOwnedCredential(userId, input.credentialId);

  const data = {
    status: input.status,
    snoozedUntil:
      input.status === "SNOOZED" && input.snoozedUntil !== undefined
        ? new Date(input.snoozedUntil)
        : null,
    signals: [...new Set(input.signals)],
  };

  return prisma.triageMark.upsert({
    where: {
      credentialId_itemKey: { credentialId: input.credentialId, itemKey: input.itemKey },
    },
    create: { userId, credentialId: input.credentialId, itemKey: input.itemKey, ...data },
    update: data,
    select: triageSelect,
  });
}

export async function deleteTriageMark(userId: string, markId: string): Promise<void> {
  const result = await prisma.triageMark.deleteMany({ where: { id: markId, userId } });

  if (result.count === 0) {
    throw new AppError(404, "TRIAGE_MARK_NOT_FOUND", "Triage mark not found");
  }
}
