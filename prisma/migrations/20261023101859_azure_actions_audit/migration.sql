-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('WORK_ITEM_COMMENT', 'WORK_ITEM_UPDATE_FIELDS', 'WORK_ITEM_TRANSITION_STATE', 'WORK_ITEM_LINK_PR', 'WORK_ITEM_CLOSE_AFTER_MERGE', 'PIPELINE_QUEUE_RUN', 'BUILD_RETRY_STAGE', 'BUILD_CANCEL');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ActionSource" AS ENUM ('RECOMMENDATION', 'USER');

-- CreateEnum
CREATE TYPE "AuditEvent" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTION_STARTED', 'EXECUTION_SUCCEEDED', 'EXECUTION_FAILED');

-- CreateTable
CREATE TABLE "ProposedAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT,
    "organizationUrl" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "ActionKind" NOT NULL,
    "source" "ActionSource" NOT NULL,
    "target" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "baseRev" INTEGER,
    "status" "ActionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposedAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionId" TEXT,
    "event" "AuditEvent" NOT NULL,
    "metadata" JSONB NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProposedAction_userId_status_idx" ON "ProposedAction"("userId", "status");

-- CreateIndex
CREATE INDEX "ProposedAction_credentialId_kind_status_idx" ON "ProposedAction"("credentialId", "kind", "status");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actionId_idx" ON "AuditLog"("actionId");

-- AddForeignKey
ALTER TABLE "ProposedAction" ADD CONSTRAINT "ProposedAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposedAction" ADD CONSTRAINT "ProposedAction_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ProposedAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
