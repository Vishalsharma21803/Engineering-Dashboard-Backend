-- CreateEnum
CREATE TYPE "TriageStatus" AS ENUM ('SNOOZED', 'ACKNOWLEDGED', 'ABANDONED');

-- CreateTable
CREATE TABLE "TriageMark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "status" "TriageStatus" NOT NULL,
    "snoozedUntil" TIMESTAMP(3),
    "signals" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriageMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriageMark_userId_credentialId_idx" ON "TriageMark"("userId", "credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "TriageMark_credentialId_itemKey_key" ON "TriageMark"("credentialId", "itemKey");

-- AddForeignKey
ALTER TABLE "TriageMark" ADD CONSTRAINT "TriageMark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageMark" ADD CONSTRAINT "TriageMark_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
