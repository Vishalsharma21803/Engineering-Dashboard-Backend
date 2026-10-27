-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'SOLIDTIME';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_TIMER_START';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_TIMER_STOP';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_ENTRY_CREATE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_ENTRY_UPDATE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_ENTRY_DELETE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_ENTRIES_CREATE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_PROJECT_CREATE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_TASK_CREATE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_TAG_CREATE';
ALTER TYPE "ActionKind" ADD VALUE 'SOLIDTIME_CLIENT_CREATE';

-- CreateTable
CREATE TABLE "SolidtimeConnection" (
    "credentialId" TEXT NOT NULL,
    "organizationId" TEXT,
    "organizationName" TEXT,
    "memberId" TEXT,
    "solidtimeUserId" TEXT,
    "role" TEXT,
    "azureCredentialId" TEXT,
    "projectMap" JSONB NOT NULL DEFAULT '{}',
    "dailyTargetHours" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "timerAlertHours" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolidtimeConnection_pkey" PRIMARY KEY ("credentialId")
);

-- AddForeignKey
ALTER TABLE "SolidtimeConnection" ADD CONSTRAINT "SolidtimeConnection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolidtimeConnection" ADD CONSTRAINT "SolidtimeConnection_azureCredentialId_fkey" FOREIGN KEY ("azureCredentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

