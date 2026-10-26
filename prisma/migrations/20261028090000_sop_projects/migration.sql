-- CreateEnum
CREATE TYPE "SopProjectChangeKind" AS ENUM ('CREATED', 'UPDATED', 'REMOVED', 'IMPORTED');

-- CreateTable
CREATE TABLE "SopProject" (
    "id" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SopProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SopProjectChange" (
    "id" TEXT NOT NULL,
    "sopProjectId" TEXT,
    "projectName" TEXT NOT NULL,
    "kind" "SopProjectChangeKind" NOT NULL,
    "settings" JSONB,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SopProjectChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SopProjectExclusion" (
    "userId" TEXT NOT NULL,
    "sopProjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SopProjectExclusion_pkey" PRIMARY KEY ("userId","sopProjectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SopProject_nameKey_key" ON "SopProject"("nameKey");

-- CreateIndex
CREATE INDEX "SopProjectChange_projectName_createdAt_idx" ON "SopProjectChange"("projectName", "createdAt");

-- AddForeignKey
ALTER TABLE "SopProjectChange" ADD CONSTRAINT "SopProjectChange_sopProjectId_fkey" FOREIGN KEY ("sopProjectId") REFERENCES "SopProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SopProjectExclusion" ADD CONSTRAINT "SopProjectExclusion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SopProjectExclusion" ADD CONSTRAINT "SopProjectExclusion_sopProjectId_fkey" FOREIGN KEY ("sopProjectId") REFERENCES "SopProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
