-- CreateTable
CREATE TABLE "AiMealPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "plan" JSONB NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiMealPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiMealPlan_userId_idx" ON "AiMealPlan"("userId");

-- CreateIndex
CREATE INDEX "AiMealPlan_userId_isActive_idx" ON "AiMealPlan"("userId", "isActive");

-- AddForeignKey
ALTER TABLE "AiMealPlan" ADD CONSTRAINT "AiMealPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
