-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '学习者',
    "gradeBand" TEXT NOT NULL DEFAULT 'HIGH_SCHOOL',
    "preferredSubjects" TEXT[] DEFAULT ARRAY['MATH']::TEXT[],
    "theme" TEXT NOT NULL DEFAULT 'system',
    "reducedMotion" BOOLEAN NOT NULL DEFAULT false,
    "onboarded" BOOLEAN NOT NULL DEFAULT false,
    "guidanceLevel" TEXT NOT NULL DEFAULT 'QUESTION_FIRST',
    "ageBand" TEXT NOT NULL,
    "consentStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "gradeBand" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "imageIds" TEXT[],
    "currentRevisionId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'TEXT',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemRevision" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "imageIds" TEXT[],
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "problemRevisionId" TEXT NOT NULL,
    "rawProcess" TEXT NOT NULL,
    "stuckReasons" TEXT[],
    "attemptStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptStep" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'STUDENT',

    CONSTRAINT "AttemptStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosisSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INPUT_CONFIRMED',
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "hintLevel" INTEGER NOT NULL DEFAULT 0,
    "promptVersion" TEXT NOT NULL DEFAULT 'diagnosis-v1',
    "modelRoute" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT true,
    "reportVersion" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "lockUntil" TIMESTAMP(3),
    "lockToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosisSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosisMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "referencedStepIds" TEXT[],
    "operationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiagnosisMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosisFinding" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "verificationNeeded" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosisFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEvidence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "excerpt" TEXT,
    "polarity" TEXT NOT NULL,

    CONSTRAINT "FindingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ENGINEERING_SEED',
    "validatedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeFinding" (
    "setId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,

    CONSTRAINT "PracticeFinding_pkey" PRIMARY KEY ("setId","findingId")
);

-- CreateTable
CREATE TABLE "PracticeItem" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "seedId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerSpec" JSONB NOT NULL,
    "hint" TEXT NOT NULL,
    "hintUsed" BOOLEAN NOT NULL DEFAULT false,
    "answerVisibility" TEXT NOT NULL DEFAULT 'HIDDEN',
    "verifierType" TEXT NOT NULL DEFAULT 'DETERMINISTIC',

    CONSTRAINT "PracticeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeSubmission" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "assistance" TEXT NOT NULL,
    "correctness" TEXT NOT NULL,
    "evaluationMethod" TEXT NOT NULL,
    "masteryState" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTask" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelInvocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costEstimate" DECIMAL(65,30),
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MutationKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "resourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutationKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletionRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Upload_userId_createdAt_idx" ON "Upload"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Problem_userId_createdAt_idx" ON "Problem"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemRevision_problemId_revisionNumber_key" ON "ProblemRevision"("problemId", "revisionNumber");

-- CreateIndex
CREATE INDEX "Attempt_userId_createdAt_idx" ON "Attempt"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptStep_attemptId_order_key" ON "AttemptStep"("attemptId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosisSession_attemptId_key" ON "DiagnosisSession"("attemptId");

-- CreateIndex
CREATE INDEX "DiagnosisSession_userId_createdAt_idx" ON "DiagnosisSession"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosisMessage_sessionId_sequence_key" ON "DiagnosisMessage"("sessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosisMessage_sessionId_operationKey_role_key" ON "DiagnosisMessage"("sessionId", "operationKey", "role");

-- CreateIndex
CREATE INDEX "DiagnosisFinding_sessionId_status_idx" ON "DiagnosisFinding"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosisFinding_sessionId_findingKey_key" ON "DiagnosisFinding"("sessionId", "findingKey");

-- CreateIndex
CREATE UNIQUE INDEX "FindingEvidence_findingId_sourceType_sourceId_polarity_key" ON "FindingEvidence"("findingId", "sourceType", "sourceId", "polarity");

-- CreateIndex
CREATE INDEX "PracticeSet_userId_status_idx" ON "PracticeSet"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeItem_setId_order_key" ON "PracticeItem"("setId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeSubmission_itemId_key" ON "PracticeSubmission"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTask_setId_key" ON "ReviewTask"("setId");

-- CreateIndex
CREATE INDEX "ReviewTask_userId_dueAt_idx" ON "ReviewTask"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "ModelInvocation_userId_createdAt_idx" ON "ModelInvocation"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MutationKey_userId_scope_key_key" ON "MutationKey"("userId", "scope", "key");

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemRevision" ADD CONSTRAINT "ProblemRevision_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_problemRevisionId_fkey" FOREIGN KEY ("problemRevisionId") REFERENCES "ProblemRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptStep" ADD CONSTRAINT "AttemptStep_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisSession" ADD CONSTRAINT "DiagnosisSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisSession" ADD CONSTRAINT "DiagnosisSession_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisMessage" ADD CONSTRAINT "DiagnosisMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosisSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisFinding" ADD CONSTRAINT "DiagnosisFinding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosisSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "DiagnosisFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSet" ADD CONSTRAINT "PracticeSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSet" ADD CONSTRAINT "PracticeSet_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosisSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeFinding" ADD CONSTRAINT "PracticeFinding_setId_fkey" FOREIGN KEY ("setId") REFERENCES "PracticeSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeFinding" ADD CONSTRAINT "PracticeFinding_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "DiagnosisFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeItem" ADD CONSTRAINT "PracticeItem_setId_fkey" FOREIGN KEY ("setId") REFERENCES "PracticeSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSubmission" ADD CONSTRAINT "PracticeSubmission_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PracticeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSubmission" ADD CONSTRAINT "PracticeSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_setId_fkey" FOREIGN KEY ("setId") REFERENCES "PracticeSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFeedback" ADD CONSTRAINT "UserFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFeedback" ADD CONSTRAINT "UserFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosisSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelInvocation" ADD CONSTRAINT "ModelInvocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelInvocation" ADD CONSTRAINT "ModelInvocation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DiagnosisSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MutationKey" ADD CONSTRAINT "MutationKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
