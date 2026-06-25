-- CreateTable
CREATE TABLE "AiTokenUsage" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiTokenUsage_source_idx" ON "AiTokenUsage"("source");

-- CreateIndex
CREATE INDEX "AiTokenUsage_createdAt_idx" ON "AiTokenUsage"("createdAt");

-- CreateIndex
CREATE INDEX "AiTokenUsage_userId_idx" ON "AiTokenUsage"("userId");
