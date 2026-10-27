-- CreateTable
CREATE TABLE "RevokedToken" (
    "jti" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevokedToken_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "RevokedToken" ADD CONSTRAINT "RevokedToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
