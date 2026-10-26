-- CreateEnum
CREATE TYPE "SopAiStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "SopAiCheck" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "workItemId" INTEGER NOT NULL,
    "projectName" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" "SopAiStatus" NOT NULL DEFAULT 'QUEUED',
    "results" JSONB,
    "errorReason" TEXT,
    "provider" "AiProvider",
    "model" TEXT,
    "costUsd" DOUBLE PRECISION,
    "notBefore" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SopAiCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SopAiCheck_status_notBefore_idx" ON "SopAiCheck"("status", "notBefore");

-- CreateIndex
CREATE UNIQUE INDEX "SopAiCheck_userId_credentialId_workItemId_key" ON "SopAiCheck"("userId", "credentialId", "workItemId");

-- AddForeignKey
ALTER TABLE "SopAiCheck" ADD CONSTRAINT "SopAiCheck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SopAiCheck" ADD CONSTRAINT "SopAiCheck_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
