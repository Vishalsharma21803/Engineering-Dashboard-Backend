-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('VALID', 'INVALID', 'ERROR');

-- DropIndex
DROP INDEX "Credential_userId_idx";

-- AlterTable
ALTER TABLE "Credential" DROP COLUMN "patToken",
ADD COLUMN     "encryptedPatToken" TEXT NOT NULL,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "lastValidatedAt" TIMESTAMP(3),
ADD COLUMN     "lastValidationStatus" "ValidationStatus",
ADD COLUMN     "organizationUrl" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Credential_userId_platform_organizationUrl_key" ON "Credential"("userId", "platform", "organizationUrl");

