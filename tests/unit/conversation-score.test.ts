import { describe, expect, it } from "vitest";
import { hashValue, type reviewControlSchema } from "../../src/evaluation/schemas";
import type { z } from "zod";
import {
  CONVERSATION_RUBRIC_METRICS, conversationAnnotationSetSchema, conversationAssistantId, conversationCaseInputHash,
  conversationDatasetSchema, conversationGoldReviewPayload, conversationOutputReviewPayload, conversationOutputReviewSetSchema,
  conversationRunSchema, conversationTranscriptHash, conversationTranscriptProjection, type ConversationAnnotationSet, type ConversationDataset, type ConversationOutputReviewSet, type ConversationRun,
} from "../../src/evaluation/conversation-schemas";
import { advanceConversationContext, scoreConversationEvaluation } from "../../src/evaluation/conversation-score";
import type { DiagnosisTurn } from "../../src/server/ai/schemas/diagnosis";

// All teacher signatures and LIVE_API records below are pure scorer fixtures, never supplier calls or genuine teacher gold.
const clone = <T>(value: T): T => structuredClone(value);
function dataset(formal = false): ConversationDataset {
  return conversationDatasetSchema.parse({
    schemaVersion: "1.0", datasetId: "unit-conversation", version: "fixture-1", provenance: formal ? "AUTHOR_CREATED_TEACHER_REVIEWED" : "AUTHOR_CREATED_PROVISIONAL", description: "Unit fixtures only; no real teacher/student claims.",
    cases: [{ id: "case-a", familyId: "quadratic-unit", subject: "MATH", gradeBand: "初三", split: formal ? "BLIND" : "DEBUG", reviewStatus: formal ? "TEACHER_REVIEWED" : "PROVISIONAL", scenarioType: "student_counterevidence", source: { kind: "AUTHOR_CREATED", reference: "unit fixture", license: "test-only" }, tags: [],
      initialContext: { questionId: "q1", questionText: "解方程 x²−5x+6=0。", subject: "MATH", gradeBand: "初三", steps: [{ id: "s1", text: "a=1,b=−5,c=6" }, { id: "s2", text: "Δ=25+24=49" }], messages: [], findings: [], turnCount: 0, hintLevel: 0 },
      studentReplies: [{ id: "reply-a", content: "−4ac=−24，我先前抄错了。" }, { id: "reply-b", content: "我会检查符号并用新题再验。" }],
    }],
  });
}
function output(last: boolean): DiagnosisTurn {
  return {
    schemaVersion: "1.0", action: last ? "FINISH_REPORT" : "ASK_ONE_QUESTION", studentFacingText: last ? "已确认：原步骤有符号差异，学生的补充构成反证。待确认：不能判断长期原因，建议用新题核查。" : "请单独核算−4ac？", followUpQuestion: last ? null : "请单独核算−4ac？", hintLevel: 0, referencedStepIds: ["s2"], safetyFlags: [],
    findings: [{ findingKey: "observation", category: "EXECUTION", statement: "原步骤的符号差异与原因假设应区分。", status: last ? "SUPPORTED" : "HYPOTHESIS", supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: "s2", excerpt: "Δ=25+24=49" }], contradictingEvidence: last ? [{ kind: "STUDENT_REPLY", sourceId: "reply-a", excerpt: "−4ac=−24" }] : [], verificationNeeded: true }],
  };
}
function runFor(data: ConversationDataset): ConversationRun {
  const sample = data.cases[0], inputHash = conversationCaseInputHash(sample);
  const run: ConversationRun = { schemaVersion: "1.0", runId: "unit-run", createdAt: "2026-10-23T00:00:00Z", datasetId: data.datasetId, datasetVersion: data.version, datasetHash: hashValue(data), caseIds: [sample.id], mode: data.cases[0].split === "BLIND" ? "LIVE_API" : "SIMULATED", purpose: data.cases[0].split === "BLIND" ? "FINAL_EVALUATION" : "ENGINEERING_DEBUG", auditReason: null, provider: data.cases[0].split === "BLIND" ? "unit-fixture-provider" : "mock", model: "unit-fixture", promptVersion: "unit-prompt", records: [{ caseId: sample.id, inputHash, turns: [] }] };
  let context = clone(sample.initialContext);
  for (let index = 0; index <= sample.studentReplies.length; index++) {
    const turn = output(index === sample.studentReplies.length);
    run.records[0].turns.push({ turnIndex: index, context: clone(context), contextHash: hashValue(context), status: "SUCCESS", output: turn, invocation: { latencyMs: 10, inputTokens: null, outputTokens: null, attempts: 1, estimatedCostCny: null, costBasis: null } });
    if (index < sample.studentReplies.length) context = advanceConversationContext(sample, context, turn, index);
  }
  return run;
}
function approved(payload: unknown): z.infer<typeof reviewControlSchema> {
  return { status: "AGREED", independentReviews: ["teacher-a", "teacher-b"].map(reviewerId => ({ reviewerId, labelHash: hashValue(payload), reviewedAt: "2026-10-23T01:00:00Z" })) };
}
function labelsFor(data: ConversationDataset, teacher = false): ConversationAnnotationSet {
  const annotation: ConversationAnnotationSet["annotations"][number] = { caseId: data.cases[0].id, inputHash: conversationCaseInputHash(data.cases[0]), provenance: teacher ? "TEACHER_REVIEWED" : "AUTHOR_PROVISIONAL", expected: { trueWrongStepIdSets: [["s2"]], allowedCategories: ["EXECUTION"], requiresAbstention: false, noErrorExpected: false, requiresCounterevidenceCorrection: true, forbidPrematureAnswer: true, teacherNotes: "Fixture label only. Human semantics cannot be inferred from matching category strings." }, review: { status: "DRAFT", independentReviews: [] } };
  if (teacher) annotation.review = approved(conversationGoldReviewPayload(annotation));
  return { schemaVersion: "1.0", datasetId: data.datasetId, datasetVersion: data.version, datasetHash: hashValue(data), annotations: [annotation] };
}
function reviewsFor(run: ConversationRun): ConversationOutputReviewSet {
  const record = run.records[0];
  const entry: ConversationOutputReviewSet["reviews"][number] = { caseId: record.caseId, inputHash: record.inputHash, transcriptHash: conversationTranscriptHash(record), ratings: { trueWrongStepIdentification: 2, factHypothesisSeparation: 2, followUpEffectiveness: 2, counterevidenceCorrection: 2, noPrematureAnswerLeakage: 2, appropriateAbstention: 2, suggestionSpecificity: 2, rationale: "Scorer fixture, not a human evaluation." }, review: { status: "DRAFT", independentReviews: [] } };
  entry.review = approved(conversationOutputReviewPayload(entry));
  return { schemaVersion: "1.0", runId: run.runId, reviews: [entry] };
}
function rebind(data: ConversationDataset, run: ConversationRun, labels: ConversationAnnotationSet) {
  run.datasetHash = hashValue(data); labels.datasetHash = hashValue(data);
}

describe("M7 conversation structure and immutable context chain", () => {
  it("retains model text/findings and every persistent student reply through three turns", () => {
    const data = dataset(), run = runFor(data), result = scoreConversationEvaluation(data, run, labelsFor(data));
    expect(result.reliability).toMatchObject({ scheduledConversations: 1, scheduledTurns: 3, validatedTurns: 3, failedTurns: 0 });
    expect(run.records[0].turns[2].context.messages.map(message => message.id)).toEqual([conversationAssistantId("case-a", 0), "reply-a", conversationAssistantId("case-a", 1), "reply-b"]);
    expect(run.records[0].turns[1].context.findings).toEqual(output(false).findings);
    expect(result.engineeringDiagnostics.contextContinuation).toEqual({ value: 1, denominator: 1, missingCount: 0 });
    expect(result.formalQuality).toBeNull();
  });
  it("detects rewritten assistant history even if the attacker recomputes its context hash", () => {
    const data = dataset(), run = runFor(data), turn = run.records[0].turns[1];
    turn.context.messages[0].content = "Changed previous model output"; turn.contextHash = hashValue(turn.context);
    const result = scoreConversationEvaluation(data, run);
    expect(result.rows[0].turns[1]).toMatchObject({ structureValidity: 1, evidenceScopeValidity: 1, contextContinuation: 0, errorCode: "CONTEXT_CONTINUATION_MISMATCH" });
    expect(result.rows[0].turns[2].contextContinuation).toBe(0);
  });
  it.each(["reply-id", "reply-content", "findings", "turnCount"])("rejects context continuation drift in %s", change => {
    const data = dataset(), run = runFor(data), turn = run.records[0].turns[1];
    if (change === "reply-id") turn.context.messages[1].id = "fresh-not-persisted";
    if (change === "reply-content") turn.context.messages[1].content += "modified";
    if (change === "findings") turn.context.findings = [];
    if (change === "turnCount") turn.context.turnCount = 2;
    turn.contextHash = hashValue(turn.context);
    expect(scoreConversationEvaluation(data, run).rows[0].turns[1].contextContinuation).toBe(0);
  });
  it("includes missing attempts and broken subsequent history in scheduled denominators", () => {
    const data = dataset(), run = runFor(data); run.records[0].turns.splice(1, 1);
    const result = scoreConversationEvaluation(data, run, labelsFor(data));
    expect(result.reliability).toMatchObject({ scheduledTurns: 3, recordedTurns: 2, failedTurns: 2 });
    expect(result.rows[0].turns[1].errorCode).toBe("MISSING_TURN_RECORD");
    expect(result.rows[0].scores.finalStepSetExact).toBe(0);
    expect(result.latency.unknownCount).toBe(1);
  });
  it("counts an entirely absent conversation rather than silently dropping it", () => {
    const data = dataset(), run = runFor(data); run.records = [];
    expect(scoreConversationEvaluation(data, run, labelsFor(data)).reliability).toMatchObject({ recordedConversations: 0, failedConversations: 1, scheduledTurns: 3, failedTurns: 3 });
  });
  it("keeps schema validity separate from scoped evidence and education", () => {
    const data = dataset(), run = runFor(data);
    (run.records[0].turns[0].output as DiagnosisTurn).findings[0].supportingEvidence[0].sourceId = "foreign-step";
    const first = scoreConversationEvaluation(data, run).rows[0].turns[0];
    expect(first).toMatchObject({ structureValidity: 1, evidenceScopeValidity: 0, contextContinuation: 1, status: "FAILED" });
  });
  it("keeps malformed structure and provider errors in the denominator", () => {
    const data = dataset(), run = runFor(data);
    run.records[0].turns[0].output = { nonsense: true };
    expect(scoreConversationEvaluation(data, run).rows[0].turns[0].structureValidity).toBe(0);
    run.records[0].turns[0] = { ...run.records[0].turns[0], status: "ERROR", output: undefined, errorCode: "AI_TIMEOUT" };
    expect(scoreConversationEvaluation(data, run).rows[0].turns[0].errorCode).toBe("AI_TIMEOUT");
  });
  it("stops at a valid terminal output and does not call unused scripted replies missing", () => {
    const data = dataset(), run = runFor(data);
    run.records[0].turns[1].output = { ...output(true), findings: [] }; run.records[0].turns.pop();
    const result = scoreConversationEvaluation(data, run);
    expect(result.reliability).toMatchObject({ scheduledTurns: 2, recordedTurns: 2, notScheduledAfterTerminal: 1, failedTurns: 0 });
    expect(result.rows[0].status).toBe("VALIDATED_CONVERSATION");
  });
  it("rejects any record after terminal, including otherwise well-shaped later inputs", () => {
    const data = dataset(), run = runFor(data); run.records[0].turns[1].output = output(true);
    expect(() => scoreConversationEvaluation(data, run)).toThrow("RECORD_AFTER_TERMINAL");
  });
  it("cannot hide missing turns behind an invalid terminal claim", () => {
    const data = dataset(), run = runFor(data);
    run.records[0].turns[1].output = { ...output(true), studentFacingText: "I am done" }; run.records[0].turns.pop();
    expect(scoreConversationEvaluation(data, run).reliability).toMatchObject({ scheduledTurns: 3, notScheduledAfterTerminal: 0, failedTurns: 2 });
  });
  it("does not allow nonempty expected categories to pass vacuously with no findings", () => {
    const data = dataset(), run = runFor(data), labels = labelsFor(data);
    (run.records[0].turns.at(-1)!.output as DiagnosisTurn).findings = [];
    expect(scoreConversationEvaluation(data, run, labels).rows[0].scores.finalCategoriesAllowed).toBe(0);
    labels.annotations[0].expected.allowedCategories = [];
    expect(scoreConversationEvaluation(data, run, labels).rows[0].scores.finalCategoriesAllowed).toBe(1);
  });
  it("does not turn unknown tokens/prices or missing attempts into zero usage/cost", () => {
    const data = dataset(), run = runFor(data); run.records[0].turns.pop();
    const result = scoreConversationEvaluation(data, run);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
    expect(result.cost).toMatchObject({ estimatedTotal: null, knownPartialEstimate: null, unknownCount: 3, billingVerified: false });
  });
});

describe("M7 human semantics and formal cohort gates", () => {
  it("requires actual human rubric ratings, independent of matching step/category strings", () => {
    const data = dataset(true), run = runFor(data), labels = labelsFor(data, true);
    expect(scoreConversationEvaluation(data, run, labels).formalQuality?.metrics.trueWrongStepIdentification).toEqual({ value: null, denominator: 0, missingCount: 1 });
    const reviews = reviewsFor(run); reviews.reviews[0].ratings.trueWrongStepIdentification = 0; reviews.reviews[0].ratings.factHypothesisSeparation = 0; reviews.reviews[0].review = approved(conversationOutputReviewPayload(reviews.reviews[0]));
    const report = scoreConversationEvaluation(data, run, labels, reviews);
    expect(report.engineeringDiagnostics.finalStepSetExact.value).toBe(1);
    expect(report.formalQuality?.metrics.trueWrongStepIdentification.value).toBe(0);
    expect(report.formalQuality?.metrics.followUpEffectiveness.value).toBe(1);
  });
  it("counts failed outputs as zero for known applicable teacher targets while missing labels stay null", () => {
    const data = dataset(true), run = runFor(data), labels = labelsFor(data, true); run.records[0].turns.pop();
    const report = scoreConversationEvaluation(data, run, labels);
    expect(report.formalQuality?.metrics.trueWrongStepIdentification).toEqual({ value: 0, denominator: 1, missingCount: 0 });
    expect(report.formalQuality?.metrics.followUpEffectiveness.denominator).toBe(1);
    expect(scoreConversationEvaluation(data, run).rows[0].scores.trueWrongStepIdentification).toBeNull();
  });
  it.each(["dataset-provisional", "case-provisional", "debug-split", "gold-provisional", "simulation", "audit-purpose", "debug-purpose"])("blocks formal quality when %s", gate => {
    const data = dataset(true), run = runFor(data), labels = labelsFor(data, true);
    if (gate === "dataset-provisional") data.provenance = "AUTHOR_CREATED_PROVISIONAL";
    if (gate === "case-provisional") data.cases[0].reviewStatus = "PROVISIONAL";
    if (gate === "debug-split") data.cases[0].split = "DEBUG";
    if (gate === "gold-provisional") labels.annotations[0].provenance = "AUTHOR_PROVISIONAL";
    if (gate === "simulation") { run.mode = "SIMULATED"; run.provider = "mock"; run.purpose = "BLIND_AUDIT"; run.auditReason = "unit audit"; }
    if (gate === "audit-purpose") { run.purpose = "BLIND_AUDIT"; run.auditReason = "unit audit"; }
    if (gate === "debug-purpose") run.purpose = "ENGINEERING_DEBUG";
    rebind(data, run, labels);
    expect(scoreConversationEvaluation(data, run, labels, reviewsFor(run)).formalQuality).toBeNull();
  });
  it("counts an approved original blind teacher cohort without falsifying adult-student provenance", () => {
    const data = dataset(true), run = runFor(data);
    const report = scoreConversationEvaluation(data, run, labelsFor(data, true), reviewsFor(run));
    expect(report.formalQuality).toMatchObject({ caseCount: 1, reviewedOutputCount: 1, failedConversations: 0 });
    expect(report.formalQuality?.metrics.suggestionSpecificity.value).toBe(1);
  });
  it("does not accept a follow-up rating for an immediate abstention with no actual question", () => {
    const data = dataset(true), run = runFor(data), labels = labelsFor(data, true);
    run.records[0].turns = [run.records[0].turns[0]];
    run.records[0].turns[0].output = { ...output(false), action: "MARK_INCONCLUSIVE", followUpQuestion: null, findings: [] };
    const reviews = reviewsFor(run);
    expect(() => scoreConversationEvaluation(data, run, labels, reviews)).toThrow("RUBRIC_RATING_NOT_APPLICABLE");
    reviews.reviews[0].ratings.followUpEffectiveness = null; reviews.reviews[0].review = approved(conversationOutputReviewPayload(reviews.reviews[0]));
    expect(scoreConversationEvaluation(data, run, labels, reviews).formalQuality?.metrics.followUpEffectiveness.value).toBeNull();
  });
  it("leaves unknown human ratings null rather than averaging missing values as zero", () => {
    const data = dataset(true), run = runFor(data), reviews = reviewsFor(run);
    for (const key of CONVERSATION_RUBRIC_METRICS) reviews.reviews[0].ratings[key] = null;
    reviews.reviews[0].review = approved(conversationOutputReviewPayload(reviews.reviews[0]));
    expect(scoreConversationEvaluation(data, run, labelsFor(data, true), reviews).formalQuality?.metrics.factHypothesisSeparation).toEqual({ value: null, denominator: 0, missingCount: 1 });
  });
  it("does not count DRAFT output ratings as teacher quality", () => {
    const data = dataset(true), run = runFor(data), reviews = reviewsFor(run); reviews.reviews[0].review = { status: "DRAFT", independentReviews: [] };
    expect(scoreConversationEvaluation(data, run, labelsFor(data, true), reviews).formalQuality?.reviewedOutputCount).toBe(0);
    expect(scoreConversationEvaluation(data, run, labelsFor(data, true), reviews).formalQuality?.metrics.suggestionSpecificity.value).toBeNull();
  });
});

describe("M7 review signatures, held-out data and binding", () => {
  it("requires two independent teachers or an independent third-person adjudication", () => {
    const data = dataset(true), labels = labelsFor(data, true), annotation = labels.annotations[0];
    annotation.review.independentReviews[1].reviewerId = "teacher-a";
    expect(() => conversationAnnotationSetSchema.parse(labels)).toThrow();
    annotation.review.independentReviews[1].reviewerId = "teacher-b"; annotation.review.independentReviews[1].labelHash = "0".repeat(64); annotation.review.status = "ADJUDICATED";
    annotation.review.adjudication = { reviewerId: "teacher-c", labelHash: hashValue(conversationGoldReviewPayload(annotation)), reviewedAt: "2026-10-23T02:00:00Z", reason: "Fixture adjudication only." };
    expect(() => conversationAnnotationSetSchema.parse(labels)).not.toThrow();
    annotation.review.adjudication.reviewerId = "teacher-b"; expect(() => conversationAnnotationSetSchema.parse(labels)).toThrow();
  });
  it("signs input identity as well as gold/ratings to prevent transplanted signatures", () => {
    const data = dataset(true), labels = labelsFor(data, true); labels.annotations[0].inputHash = "1".repeat(64);
    expect(() => conversationAnnotationSetSchema.parse(labels)).toThrow();
    const reviews = reviewsFor(runFor(data)); reviews.reviews[0].inputHash = "2".repeat(64);
    expect(() => conversationOutputReviewSetSchema.parse(reviews)).toThrow();
  });
  it("binds teacher ratings to the entire transcript, including an earlier turn", () => {
    const data = dataset(true), run = runFor(data), reviews = reviewsFor(run);
    (run.records[0].turns[0].output as DiagnosisTurn).studentFacingText += " Earlier output changed.";
    expect(() => scoreConversationEvaluation(data, run, labelsFor(data, true), reviews)).toThrow("OUTPUT_REVIEW_TRANSCRIPT_MISMATCH");
  });
  it("keeps provider billing metadata out of the teacher transcript and teaching signature", () => {
    const data = dataset(true), run = runFor(data), before = conversationTranscriptHash(run.records[0]), reviews = reviewsFor(run);
    run.records[0].turns[0].invocation = { latencyMs: 999, inputTokens: 300, outputTokens: 50, attempts: 1, estimatedCostCny: .1, costBasis: "supplier-identifying billing source" };
    expect(conversationTranscriptHash(run.records[0])).toBe(before);
    expect(scoreConversationEvaluation(data, run, labelsFor(data, true), reviews).formalQuality?.reviewedOutputCount).toBe(1);
    const text = JSON.stringify(conversationTranscriptProjection(run.records[0]));
    for (const key of ["invocation", "costBasis", "inputTokens", "outputTokens", "latencyMs", "provider", "supplier-identifying"]) expect(text).not.toContain(key);
    expect(text).toContain("reply-a"); expect(text).toContain("请单独核算");
  });
  it("binds student-reply scripts into input hash and prevents cross-dataset reuse", () => {
    const data = dataset(), run = runFor(data), oldHash = conversationCaseInputHash(data.cases[0]);
    data.cases[0].studentReplies[0].content += " changed";
    expect(conversationCaseInputHash(data.cases[0])).not.toBe(oldHash);
    expect(() => scoreConversationEvaluation(data, run)).toThrow("RUN_DATASET_MISMATCH");
    run.datasetHash = hashValue(data); expect(() => scoreConversationEvaluation(data, run)).toThrow("CASE_INPUT_MISMATCH");
  });
  it("validates scoped gold for unselected cases and rejects unknown steps", () => {
    const data = dataset(), labels = labelsFor(data); labels.annotations[0].expected.trueWrongStepIdSets = [["nonexistent"]];
    expect(() => scoreConversationEvaluation(data, runFor(data), labels)).toThrow("ANNOTATION_UNKNOWN_STEP");
  });
  it("blocks blind simulation unless explicit audit purpose and rationale are recorded", () => {
    const data = dataset(true), run = runFor(data); run.mode = "SIMULATED"; run.provider = "mock"; run.purpose = "ENGINEERING_DEBUG";
    expect(() => scoreConversationEvaluation(data, run)).toThrow("BLIND_SIMULATION_REQUIRES_AUDIT_PURPOSE");
    run.purpose = "BLIND_AUDIT"; expect(() => conversationRunSchema.parse(run)).toThrow();
    run.auditReason = "unit audit only"; expect(scoreConversationEvaluation(data, run).formalQuality).toBeNull();
  });
  it("rejects provider relabeling, duplicate turns, unknown cases and success/error ambiguity", () => {
    const data = dataset(), run = runFor(data); run.mode = "LIVE_API";
    expect(() => conversationRunSchema.parse(run)).toThrow(); run.mode = "SIMULATED";
    const duplicate = clone(run); duplicate.records[0].turns.push(duplicate.records[0].turns[0]); expect(() => conversationRunSchema.parse(duplicate)).toThrow();
    const ambiguous = clone(run); ambiguous.records[0].turns[0].errorCode = "AI_TIMEOUT"; expect(() => conversationRunSchema.parse(ambiguous)).toThrow();
    const unknown = clone(run); unknown.caseIds.push("unknown"); expect(() => scoreConversationEvaluation(data, unknown)).toThrow("RUN_UNKNOWN_CASE");
  });
  it("rejects gold in model inputs, duplicate student IDs and family leakage across splits", () => {
    const data = dataset(); expect(() => conversationDatasetSchema.parse({ ...data, cases: [{ ...data.cases[0], gold: { answer: 3 } }] })).toThrow();
    const duplicate = clone(data); duplicate.cases[0].studentReplies[0].id = "s1"; expect(() => conversationDatasetSchema.parse(duplicate)).toThrow();
    const leak = clone(data); leak.cases.push({ ...clone(data.cases[0]), id: "case-b", split: "BLIND" }); expect(() => conversationDatasetSchema.parse(leak)).toThrow();
  });
});
