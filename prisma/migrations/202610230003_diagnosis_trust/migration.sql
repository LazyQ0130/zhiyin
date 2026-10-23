-- Additive nullable metadata only: old binaries can ignore these columns.
-- Existing claims and submissions are not silently upgraded/backfilled.
ALTER TABLE "DiagnosisMessage" ADD COLUMN "assistance" JSONB;
ALTER TABLE "DiagnosisFinding" ADD COLUMN "trust" JSONB;
ALTER TABLE "PracticeItem" ADD COLUMN "hintUsedAt" TIMESTAMP(3), ADD COLUMN "assistance" JSONB;
ALTER TABLE "PracticeSubmission" ADD COLUMN "verifierDetails" JSONB;
