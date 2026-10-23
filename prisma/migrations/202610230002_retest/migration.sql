ALTER TABLE "PracticeSet" ADD COLUMN "retestOfId" TEXT;
CREATE UNIQUE INDEX "PracticeSet_retestOfId_key" ON "PracticeSet"("retestOfId");
ALTER TABLE "PracticeSet" ADD CONSTRAINT "PracticeSet_retestOfId_fkey" FOREIGN KEY ("retestOfId") REFERENCES "PracticeSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
