-- CreateTable
CREATE TABLE "UserNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "batchId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "UserNotification_userId_readAt_idx" ON "UserNotification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "UserNotification_batchId_idx" ON "UserNotification"("batchId");

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
