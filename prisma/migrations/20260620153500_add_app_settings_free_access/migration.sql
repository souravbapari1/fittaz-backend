-- CreateTable
CREATE TABLE "AppSettings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'app',
    "freeAccessFeatures" "AccessFeatures"[] DEFAULT ARRAY[]::"AccessFeatures"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_key_key" ON "AppSettings"("key");
