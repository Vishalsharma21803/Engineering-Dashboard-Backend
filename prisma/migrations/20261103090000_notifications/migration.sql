-- Notifications: kept until their cause is fixed; read/abandoned only change the status.
-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('UNREAD', 'READ', 'ABANDONED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "projectName" TEXT,
    "title" TEXT NOT NULL,
    "reasons" TEXT[],
    "target" JSONB NOT NULL,
    "signals" TEXT[],
    "readSignals" TEXT[],
    "status" "NotificationStatus" NOT NULL DEFAULT 'UNREAD',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_credentialId_status_idx" ON "Notification"("userId", "credentialId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_credentialId_key_key" ON "Notification"("credentialId", "key");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

