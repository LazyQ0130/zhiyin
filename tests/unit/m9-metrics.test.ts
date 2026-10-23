import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { conversationCaseInputHash, type ConversationDataset, type ConversationRun } from "../../src/evaluation/conversation-schemas";
import { advanceConversationContext } from "../../src/evaluation/conversation-score";
import { diagnosisTurnSchema } from "../../src/server/ai/schemas/diagnosis";
import { scoreM8Evaluation } from "../../src/evaluation/m8-metrics";
import { buildM8TeacherPackets, createM8AgreementDecision } from "../../src/evaluation/m8-teacher";
import { m8SignedSourceArtifactSchema } from "../../src/evaluation/m8-teacher-schemas";
import { aggregateM9Codes, aggregateM9HelpLevelDifferences, buildM9SupplementalPackets, compareM9SupplementalReviews, createM9SupplementalDecision, hasM9RecordedQuestionAndReply, isM9HumanVerifiedSupplementalDecision, scoreM9Evaluation, validateM9SupplementalForm } from "../../src/evaluation/m9-metrics";
import { M9_CASE_MEASURES, m9SupplementalArtifactSchema, type M9SupplementalArtifact } from "../../src/evaluation/m9-metrics-schemas";
import { hashValue } from "../../src/evaluation/schemas";

// All names, bytes and verification assertions below are in-memory software
// adversarial fixtures, NOT actual teachers, signed originals, or human outcomes.
function fixture() {
  const dataset: ConversationDataset = { schemaVersion: "1.0", datasetId: "m9-software-test", version: "test.1", provenance: "AUTHOR_CREATED_PROVISIONAL", description: "No real people or educational outcomes", cases: [{
    id: "case-test", familyId: "family-test", subject: "MATH", gradeBand: "GRADE_7_9", split: "DEBUG", reviewStatus: "PROVISIONAL", scenarioType: "calculation_error", tags: ["AUTHOR_LABEL_NEVER_A_QUALITY_CODE"], source: { kind: "AUTHOR_CREATED", reference: "software test", license: "software test" },
    initialContext: { questionId: "q-test", questionText: "计算2+3。", subject: "MATH", gradeBand: "GRADE_7_9", steps: [{ id: "s-test", text: "2+3=6" }], messages: [], findings: [], turnCount: 0, hintLevel: 0 }, studentReplies: [{ id: "r-test", content: "未发生的预设回复" }],
  }] };
  const sample = dataset.cases[0];
  const run: ConversationRun = { schemaVersion: "1.0", runId: "m9-unit-mock", createdAt: "2026-10-23T00:00:00.000Z", datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash: hashValue(dataset), caseIds: [sample.id], mode: "SIMULATED", purpose: "ENGINEERING_DEBUG", auditReason: null, provider: "mock", model: "software-test", promptVersion: "software-test", records: [{ caseId: sample.id, inputHash: conversationCaseInputHash(sample), turns: [{ turnIndex: 0, context: sample.initialContext, contextHash: hashValue(sample.initialContext), status: "SUCCESS", output: { schemaVersion: "1.0", action: "MARK_INCONCLUSIVE", studentFacingText: "你这一步是怎么想的？", referencedStepIds: [], findings: [], followUpQuestion: null, hintLevel: 0, safetyFlags: [] }, invocation: { latencyMs: null, inputTokens: null, outputTokens: null, attempts: 0, estimatedCostCny: 0, costBasis: "test only, no API" } }] }] };
  return { dataset, run };
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function pendingSupplemental() {
  const { dataset, run } = fixture(), packets = buildM9SupplementalPackets(dataset, run);
  const originals = (["A", "B"] as const).map(slot => {
    const submission = { ...packets[slot].form, reviewerPseudonym: `SOFTWARE_FIXTURE_${slot}_NOT_A_PERSON`, reviewedAt: "2026-10-23T00:00:00.000Z", status: "SUBMITTED" as const };
    return m9SupplementalArtifactSchema.parse({ schemaVersion: "M9.1", packet: packets[slot].packet, submission, submissionHash: hashValue(submission), signedSource: { sourceHash: sha(Buffer.from(`SUPPLEMENT_${slot}_NOT_A_SIGNED_SOURCE`)), byteLength: Buffer.byteLength(`SUPPLEMENT_${slot}_NOT_A_SIGNED_SOURCE`), mediaType: "SOFTWARE_TEST_ONLY" }, humanAudit: { state: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, boundSubmissionHash: null, actualTeacherAndSignatureConfirmed: false, auditNote: "Software adversarial fixture; no human verification" } });
  }) as [M9SupplementalArtifact, M9SupplementalArtifact];
  return { dataset, run, originals };
}

describe("M9 separate educational rates and source gates", () => {
  it("keeps engineering emissions separate from unknown educational quality and preserves M8", () => {
    const { dataset, run } = fixture(), report = scoreM9Evaluation(dataset, run);
    expect(report.engineeringDescriptive.markInconclusiveEmission.value).toBe(1);
    expect(report.coverage.qualityCodesUsableCount).toBe(0); expect(report.formalQuality).toBeNull();
    expect(report.m8).toEqual(scoreM8Evaluation(dataset, run));
    expect(Object.keys(report.educationalQuality.caseMetrics)).toHaveLength(7);
    for (const [key, metric] of Object.entries(report.educationalQuality.caseMetrics)) {
      expect(metric.value).toBeNull(); expect(metric.numerator).toBe(0); expect(metric.denominator).toBe(0);
      if (key !== "effectiveQuestioning") {
        expect(metric.missingCount).toBe(1); expect(metric.possibleEligibilityCount).toEqual({ min: 0, max: 1 });
        expect(metric.pendingCompletionBounds).toMatchObject({ min: 0, max: 1 });
      }
    }
    expect(report.educationalQuality.caseMetrics.effectiveQuestioning).toMatchObject({ candidateCount: 0, missingCount: 0, structurallyExcludedCount: 1, possibleEligibilityCount: { min: 0, max: 0 } });
    for (const rates of [report.educationalQuality.hintMiss, report.educationalQuality.hintFalsePositive]) for (const metric of Object.values(rates)) {
      expect(metric.value).toBeNull(); expect(metric.denominator).toBe(0); expect(metric.missingCount).toBe(1); expect(metric.unit).toBe("TURN");
    }
    expect(report.helpTurnComparisons[0].m8GuardReplay).toBe(0);
    expect(report.helpTurnComparisons[0].actualHelpLevel).toBeNull();
  });
  it("uses actual reviewed denominators; false applicability and missing outcomes never become zero scores", () => {
    const rate = aggregateM9Codes([{ applicable: true, outcome: true }, { applicable: true, outcome: false }, { applicable: true, outcome: null }, { applicable: false, outcome: null }, { applicable: null, outcome: null }], 2);
    expect(rate).toMatchObject({ value: .5, numerator: 1, denominator: 2, eligibleCount: 3, notApplicableCount: 1, eligibilityUnknownCount: 1, outcomeUnknownCount: 1, missingCount: 2, executionExcludedCount: 2, possibleEligibilityCount: { min: 3, max: 4 }, pendingCompletionBounds: { min: .25, max: .75 } });
    expect(aggregateM9Codes([{ applicable: false, outcome: null }]).value).toBeNull();
  });
  it("reports under/overclassification even when both teacher and channel report positive help", () => {
    const levels = aggregateM9HelpLevelDifferences([{ actual: 2, detected: 1 }, { actual: 1, detected: 3 }, { actual: null, detected: 0 }, { actual: 2, detected: null }]);
    expect(levels.underclassification).toMatchObject({ numerator: 1, denominator: 2, value: .5, missingCount: 2 });
    expect(levels.overclassification).toMatchObject({ numerator: 1, denominator: 2, value: .5 });
    expect(levels.exactLevelAgreement.value).toBe(0); expect(levels.levelCounts[2][1]).toBe(1); expect(levels.levelCounts[1][3]).toBe(1);
    expect(aggregateM9HelpLevelDifferences([{ actual: null, detected: 1 }]).underclassification.value).toBeNull();
  });
  it("does not use old USER messages as answers to a newly asked question", () => {
    const { run } = fixture(), record = run.records[0], first = record.turns[0];
    first.context.messages = [{ id: "old-user", role: "USER", content: "旧输入" }];
    first.output = { ...(first.output as object), action: "ASK_ONE_QUESTION", followUpQuestion: "你这一步是怎么想的？" };
    const next = structuredClone(first); next.turnIndex = 1;
    record.turns.push(next);
    expect(hasM9RecordedQuestionAndReply(record)).toBe(false);
    const previous = structuredClone(first.context.messages);
    // A reply must follow the actual recorded assistant question and preserve the
    // entire prior history, not merely be any USER somewhere later.
    const assistantId = `m7-assistant-${hashValue({ caseId: record.caseId, turnIndex: 0 }).slice(0, 24)}`;
    next.context.messages = [...previous, { id: assistantId, role: "ASSISTANT", content: "你这一步是怎么想的？" }, { id: "new-user", role: "USER", content: "本次实际保存的回答" }];
    expect(hasM9RecordedQuestionAndReply(record)).toBe(true);
    record.turns.reverse();
    const sourceHashBefore = hashValue(record);
    expect(hasM9RecordedQuestionAndReply(record)).toBe(true);
    expect(hashValue(record)).toBe(sourceHashBefore);
    next.context.messages.at(-1)!.id = "old-user";
    expect(hasM9RecordedQuestionAndReply(record)).toBe(false);
  });
  it("uses turnIndex for the actual final and answered question without rewriting shuffled originals", () => {
    const { dataset, run } = fixture(), record = run.records[0], first = record.turns[0];
    first.output = { ...(first.output as object), action: "ASK_ONE_QUESTION", followUpQuestion: "你这一步是怎么想的？" };
    const next = structuredClone(first); next.turnIndex = 1;
    next.output = { ...(next.output as object), action: "MARK_INCONCLUSIVE", followUpQuestion: null };
    next.context = advanceConversationContext(dataset.cases[0], first.context, diagnosisTurnSchema.parse(first.output), 0); next.contextHash = hashValue(next.context);
    record.turns = [next, first];
    const before = hashValue(run), report = scoreM9Evaluation(dataset, run);
    expect(report.coverage.completedCases).toBe(1); expect(report.engineeringDescriptive.markInconclusiveEmission.numerator).toBe(1);
    expect(report.educationalQuality.caseMetrics.effectiveQuestioning).toMatchObject({ candidateCount: 1, structurallyExcludedCount: 0, missingCount: 1 });
    expect(hashValue(run)).toBe(before);
  });
  it("does not derive educational labels from author taxonomy, tags or INCONCLUSIVE", () => {
    const { dataset, run } = fixture(), before = scoreM9Evaluation(dataset, run).educationalQuality;
    dataset.cases[0].scenarioType = "correct"; dataset.cases[0].tags = ["FORCE_SUCCESS"];
    run.datasetHash = hashValue(dataset);
    expect(scoreM9Evaluation(dataset, run).educationalQuality).toEqual(before);
    const packets = buildM9SupplementalPackets(dataset, run), serialized = JSON.stringify(packets.A.packet);
    expect(serialized).not.toContain("FORCE_SUCCESS"); expect(serialized).not.toContain("scenarioType"); expect(serialized).not.toContain("未发生的预设回复");
    for (const key of M9_CASE_MEASURES) expect(packets.A.form.cases[0].codes[key]).toEqual({ applicable: null, outcome: null, rationale: "", evidence: [] });
    expect(packets.A.form.signature).toBe(""); expect(packets.A.form.reviewerPseudonym).toBeNull();
  });
  it("binds packet/specification, coverage, exact evidence and teacher applicability independently", () => {
    const { dataset, run } = fixture(), { A, B } = buildM9SupplementalPackets(dataset, run);
    expect(() => validateM9SupplementalForm(A.packet, B.form)).toThrow("M9_PACKET_BINDING_MISMATCH");
    const swapped = structuredClone(A.packet); swapped.specificationHash = "a".repeat(64);
    expect(() => validateM9SupplementalForm(swapped, A.form)).toThrow("M9_SPECIFICATION_MISMATCH");
    const form = structuredClone(A.form);
    form.cases[0].helpTurns = [];
    expect(() => validateM9SupplementalForm(A.packet, form)).toThrow("M9_HELP_TURN_COVERAGE_MISMATCH");
    const invalid = structuredClone(A.form); invalid.cases[0].codes.conclusionCoverage.outcome = true;
    expect(() => validateM9SupplementalForm(A.packet, invalid)).toThrow();
    const forged = structuredClone(A.form); forged.cases[0].codes.conclusionCoverage = { applicable: true, outcome: true, rationale: "software fixture", evidence: [{ sourceId: "s-test", start: 0, end: 5, excerpt: "forged" }] };
    expect(() => validateM9SupplementalForm(A.packet, forged)).toThrow("M9_EVIDENCE_POSITION_MISMATCH");
    forged.cases[0].codes.conclusionCoverage.evidence[0].excerpt = "2+3=6";
    expect(validateM9SupplementalForm(A.packet, forged).form.cases[0].codes.conclusionCoverage.outcome).toBe(true);
    forged.cases[0].codes.effectiveQuestioning = structuredClone(forged.cases[0].codes.conclusionCoverage);
    expect(() => validateM9SupplementalForm(A.packet, forged)).toThrow("M9_ACTUAL_QUESTION_AND_REPLY_REQUIRED");
  });
  it("requires actual help evidence from the same saved output turn", () => {
    const { dataset, run } = fixture(), { A } = buildM9SupplementalPackets(dataset, run);
    const help = A.form.cases[0].helpTurns[0];
    help.actualHelpLevel = 0; help.rationale = "software fixture";
    help.evidence = [{ sourceId: "q-test", start: 0, end: 6, excerpt: "计算2+3。" }];
    expect(() => validateM9SupplementalForm(A.packet, A.form)).toThrow("M9_CURRENT_VISIBLE_OUTPUT_EVIDENCE_REQUIRED");
    const source = A.packet.m8Packet.cases[0].sources.find(source => source.kind === "MODEL_OUTPUT")!;
    const excerpt = "你这一步是怎么想的？", start = source.text.indexOf(excerpt);
    help.evidence = [{ sourceId: source.sourceId, start, end: start + excerpt.length, excerpt }];
    expect(validateM9SupplementalForm(A.packet, A.form).form.cases[0].helpTurns[0].actualHelpLevel).toBe(0);
    expect(scoreM9Evaluation(dataset, run).educationalQuality.hintFalsePositive.m8GuardReplay.denominator).toBe(0);
  });
  it("preserves differing A/B originals and requires a distinct unsigned third reviewer", () => {
    const { originals } = pendingSupplemental(), [a, b] = originals;
    a.submission.cases[0].codes.conclusionCoverage = { applicable: true, outcome: true, rationale: "software fixture only", evidence: [{ sourceId: "s-test", start: 0, end: 5, excerpt: "2+3=6" }] };
    a.submissionHash = hashValue(a.submission);
    const before = hashValue(originals), comparison = compareM9SupplementalReviews(a, b)[0];
    expect(comparison.agrees).toBe(false);
    const draft = createM9SupplementalDecision(a, b, "case-test", { reviewerPseudonym: "SOFTWARE_THIRD_NOT_A_PERSON", reason: "software fixture only" });
    expect(draft.state).toBe("DRAFT_ADJUDICATION"); expect(draft.final).toBeNull(); expect(draft.adjudication?.actualTeacherAndSignatureConfirmed).toBe(false);
    expect(isM9HumanVerifiedSupplementalDecision(draft)).toBe(false); expect(hashValue(originals)).toBe(before);
    expect(() => createM9SupplementalDecision(a, b, "case-test", { reviewerPseudonym: a.submission.reviewerPseudonym!, reason: "software fixture" })).toThrow("M9_THIRD_REVIEWER_MUST_BE_DISTINCT");
    expect(() => createM9SupplementalDecision(a, b, "case-test")).toThrow("M9_AGREEMENT_REQUIRES_IDENTICAL_HUMAN_AUDITED_ORIGINALS");
  });
  it("an unbound boolean/state, changed original, or copied source cannot unlock quality", () => {
    const { originals } = pendingSupplemental(), [a, b] = originals;
    const unbound = structuredClone(a); unbound.humanAudit.state = "HUMAN_VERIFIED"; unbound.humanAudit.actualTeacherAndSignatureConfirmed = true;
    expect(m9SupplementalArtifactSchema.safeParse(unbound).success).toBe(false);
    const tampered = structuredClone(a); tampered.submission.cases[0].helpTurns[0].rationale = "after original hashing";
    expect(m9SupplementalArtifactSchema.safeParse(tampered).success).toBe(false);
    const copied = structuredClone(b); copied.signedSource.sourceHash = a.signedSource.sourceHash;
    expect(() => compareM9SupplementalReviews(a, copied)).toThrow("M9_DISTINCT_SIGNED_ORIGINAL_SOURCES_REQUIRED");
  });
  it("valid-looking human assertions still require both M8 decisions and actual bound source bytes", () => {
    const { dataset, run, originals } = pendingSupplemental(), signedSourceBytes: Uint8Array[] = [];
    for (const [index, original] of originals.entries()) {
      const slot = index === 0 ? "A" : "B", bytes = Buffer.from(`SUPPLEMENT_${slot}_NOT_A_SIGNED_SOURCE`); signedSourceBytes.push(bytes);
      original.submission.cases[0].codes.usefulNextStepAdvice = { applicable: true, outcome: false, rationale: "SOFTWARE TEST ONLY", evidence: [{ sourceId: "s-test", start: 0, end: 5, excerpt: "2+3=6" }] };
      original.submissionHash = hashValue(original.submission);
      original.humanAudit = { state: "HUMAN_VERIFIED", verifierPseudonym: "SOFTWARE_AUDITOR_NOT_A_PERSON", verifiedAt: "2026-10-23T00:00:00.000Z", boundSubmissionHash: original.submissionHash, actualTeacherAndSignatureConfirmed: true, auditNote: "IN-MEMORY SOFTWARE ADVERSARIAL ASSERTION; no actual human review" };
    }
    const supplemental = createM9SupplementalDecision(...originals, "case-test");
    expect(isM9HumanVerifiedSupplementalDecision(supplemental)).toBe(true);
    expect(scoreM9Evaluation(dataset, run, { supplementalDecisions: [supplemental], signedSourceBytes }).coverage.qualityCodesUsableCount).toBe(0);
    function m8Decision(output: boolean) {
      const packets = buildM8TeacherPackets(dataset, output ? run : undefined);
      const artifacts = (["A", "B"] as const).map(slot => {
        const submission = { ...packets[slot].form, status: "SUBMITTED" as const, reviewerPseudonym: `SOFTWARE_M8_${slot}_NOT_A_PERSON`, reviewedAt: "2026-10-23T00:00:00.000Z" }, bytes = Buffer.from(`M8_${output}_${slot}_NOT_A_SIGNED_SOURCE`); signedSourceBytes.push(bytes);
        return m8SignedSourceArtifactSchema.parse({ schemaVersion: "M8.1", packet: packets[slot].packet, submission, submissionHash: hashValue(submission), signedSource: { sourceHash: sha(bytes), byteLength: bytes.length, mediaType: "SOFTWARE_TEST_ONLY" }, humanAudit: { state: "HUMAN_VERIFIED", verifierPseudonym: "SOFTWARE_AUDITOR_NOT_A_PERSON", verifiedAt: "2026-10-23T00:00:00.000Z", boundSubmissionHash: hashValue(submission), actualTeacherAndSignatureConfirmed: true, auditNote: "IN-MEMORY SOFTWARE ADVERSARIAL ASSERTION; not an actual human review" } });
      });
      return createM8AgreementDecision(artifacts[0], artifacts[1], "case-test");
    }
    const gold = m8Decision(false), output = m8Decision(true), options = { goldDecisions: [gold], outputDecisions: [output], supplementalDecisions: [supplemental] };
    const absent = scoreM9Evaluation(dataset, run, options);
    expect(absent.coverage.supplementalHumanVerifiedCount).toBe(1); expect(absent.coverage.qualityCodesUsableCount).toBe(0);
    const softwareOnly = scoreM9Evaluation(dataset, run, { ...options, signedSourceBytes });
    expect(softwareOnly.coverage.qualityCodesUsableCount).toBe(1);
    expect(softwareOnly.educationalQuality.caseMetrics.usefulNextStepAdvice).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(softwareOnly.educationalQuality.caseMetrics.conclusionCoverage.value).toBeNull();
    expect(softwareOnly.formalQuality).toBeNull(); // Mock/DEV cannot become formal.
    const changed = structuredClone(supplemental); changed.transcriptHash = "a".repeat(64);
    expect(() => scoreM9Evaluation(dataset, run, { ...options, supplementalDecisions: [changed], signedSourceBytes })).toThrow("M9_DECISION_BINDING_MISMATCH");
  });
  it("reports operational failure separately, leaving educational rates unknown", () => {
    const { dataset, run } = fixture(); run.records = [];
    const report = scoreM9Evaluation(dataset, run);
    expect(report.engineeringDescriptive.operationalFailure.value).toBe(1);
    expect(report.educationalQuality.caseMetrics.conclusionCoverage).toMatchObject({ value: null, denominator: 0, executionExcludedCount: 1 });
    expect(report.formalQuality).toBeNull();
  });
});
