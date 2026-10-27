-- CreateTable
CREATE TABLE "SopReportRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "defaultVersion" INTEGER NOT NULL,
    "itemsChecked" INTEGER NOT NULL,
    "itemsWithGaps" INTEGER NOT NULL,
    "rules" JSONB NOT NULL,
    "roles" JSONB NOT NULL,
    "tickets" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SopReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SopReportRun_userId_credentialId_projectName_createdAt_idx" ON "SopReportRun"("userId", "credentialId", "projectName", "createdAt");

-- AddForeignKey
ALTER TABLE "SopReportRun" ADD CONSTRAINT "SopReportRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SopReportRun" ADD CONSTRAINT "SopReportRun_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

