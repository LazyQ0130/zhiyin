import { describe, expect, it } from "vitest";
import { conversationCaseInputHash, type ConversationDataset, type ConversationRun } from "../../src/evaluation/conversation-schemas";
import { hashValue } from "../../src/evaluation/schemas";
import { buildM8TeacherPackets, compareM8IndependentReviews, createM8AdjudicationDraft, createM8AgreementDecision, isM8HumanVerifiedDecision, renderM8TeacherPacket, validateM8TeacherForm } from "../../src/evaluation/m8-teacher";
import { M8_SEMANTIC_DIMENSIONS, m8SignedSourceArtifactSchema, type M8ReviewDecision, type M8SignedSourceArtifact } from "../../src/evaluation/m8-teacher-schemas";
import { scoreM8Evaluation } from "../../src/evaluation/m8-metrics";

// Author-created software fixtures only. No real student data, teacher identities,
// signatures, network traffic, or alleged human source verification.
function dataset(): ConversationDataset {
  return { schemaVersion: "1.0", datasetId: "m8-unit-author-created", version: "unit.1", provenance: "AUTHOR_CREATED_PROVISIONAL", description: "Software fixtures only", cases: [{
    id: "unit-case", familyId: "unit-family", subject: "MATH", gradeBand: "GRADE_7_9", split: "DEBUG", reviewStatus: "PROVISIONAL", scenarioType: "calculation_error", tags: ["AUTHOR_LABEL_MUST_NOT_LEAK"], source: { kind: "AUTHOR_CREATED", reference: "Unit test authored text", license: "project unit fixture" },
    initialContext: { questionId: "unit-q", questionText: "计算2+3。", subject: "MATH", gradeBand: "GRADE_7_9", steps: [{ id: "unit-s1", text: "2+3=6" }], messages: [], findings: [], turnCount: 0, hintLevel: 0 },
    studentReplies: [{ id: "unit-r1", content: "这是预设回复，不是已发生的实际回答。" }],
  }] };
}
function run(data = dataset()): ConversationRun {
  const sample = data.cases[0];
  return { schemaVersion: "1.0", runId: "unit-mock-run", createdAt: "2026-10-23T00:00:00.000Z", datasetId: data.datasetId, datasetVersion: data.version, datasetHash: hashValue(data), caseIds: [sample.id], mode: "SIMULATED", purpose: "ENGINEERING_DEBUG", auditReason: null, provider: "mock", model: "unit-test-only", promptVersion: "unit", records: [{ caseId: sample.id, inputHash: conversationCaseInputHash(sample), turns: [{ turnIndex: 0, context: sample.initialContext, contextHash: hashValue(sample.initialContext), status: "SUCCESS", output: { schemaVersion: "1.0", action: "MARK_INCONCLUSIVE", studentFacingText: "请补充计算过程。", referencedStepIds: [], findings: [], followUpQuestion: null, hintLevel: 0, safetyFlags: [] }, invocation: { latencyMs: null, inputTokens: null, outputTokens: null, attempts: 0, estimatedCostCny: 0, costBasis: "unit fixture; no API call" } }] }] };
}
function pendingOriginals() {
  const packets = buildM8TeacherPackets(dataset());
  return (["A", "B"] as const).map(slot => {
    const submission = { ...packets[slot].form, status: "SUBMITTED" as const, reviewerPseudonym: `UNIT_FIXTURE_${slot}_NOT_A_PERSON`, reviewedAt: "2026-10-23T00:00:00.000Z" };
    return m8SignedSourceArtifactSchema.parse({ schemaVersion: "M8.1", packet: packets[slot].packet, submission, submissionHash: hashValue(submission), signedSource: { sourceHash: hashValue(`UNIT_FIXTURE_${slot}_NO_SIGNED_SOURCE`), byteLength: 1, mediaType: "UNIT_FIXTURE_ONLY" }, humanAudit: { state: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, boundSubmissionHash: null, actualTeacherAndSignatureConfirmed: false, auditNote: "UNIT FIXTURE; no person or signature exists" } });
  }) as [M8SignedSourceArtifact, M8SignedSourceArtifact];
}

describe("M8 independent teacher packet boundaries", () => {
  it("exports sources and blank forms without author labels or cross-review opinions", () => {
    const packets = buildM8TeacherPackets(dataset());
    expect(packets.A.packet.packetId).not.toBe(packets.B.packet.packetId);
    for (const slot of ["A", "B"] as const) {
      const { packet, form } = packets[slot], serialized = JSON.stringify(packet);
      expect(serialized).not.toContain("AUTHOR_LABEL_MUST_NOT_LEAK");
      for (const key of ["scenarioType", "familyId", "tags", "expected", "teacherNotes", "ratings", "model", "provider"]) expect(packet).not.toHaveProperty(key);
      expect(serialized).not.toContain("calculation_error");
      expect(packet.status).toBe("PROVISIONAL");
      expect(form.signature).toBe(""); expect(form.reviewerPseudonym).toBeNull();
      expect(form.cases[0].gold?.trueWrongStepIdSets).toBeNull(); expect(form.cases[0].ratings).toBeNull();
      expect(packet).not.toHaveProperty("sources");
      expect(packet.cases[0].sources.find(source => source.sourceId === "unit-r1")?.exposure).toBe("SCRIPTED_NOT_OBSERVED");
      expect(renderM8TeacherPacket(packet)).not.toContain(packets[slot === "A" ? "B" : "A"].packet.packetId);
      expect(validateM8TeacherForm(packet, form).form.status).toBe("DRAFT_UNSIGNED");
    }
  });
  it("output packets retain transcript and hide invocation billing and unobserved scripted replies", () => {
    const packets = buildM8TeacherPackets(dataset(), run());
    const serialized = JSON.stringify(packets.A.packet);
    expect(serialized).not.toContain("costBasis"); expect(serialized).not.toContain("unit-test-only");
    expect(serialized).not.toContain("这是预设回复");
    expect(packets.A.packet.cases[0].transcriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(packets.A.form.cases[0].gold).toBeNull();
    for (const dimension of M8_SEMANTIC_DIMENSIONS) expect(packets.A.form.cases[0].ratings?.[dimension]).toEqual({ score: null, rationale: "", evidence: [] });
  });
  it("rejects packet swaps, wrong source hashes, invented offsets, and unknown step IDs", () => {
    const { A, B } = buildM8TeacherPackets(dataset());
    expect(() => validateM8TeacherForm(A.packet, B.form)).toThrow("M8_PACKET_BINDING_MISMATCH");
    const badPacket = structuredClone(A.packet); badPacket.cases[0].sources[0].text += "tampered";
    expect(() => validateM8TeacherForm(badPacket, A.form)).toThrow();
    const badGold = structuredClone(A.form); badGold.cases[0].gold!.trueWrongStepIdSets = [["invented-step"]];
    expect(() => validateM8TeacherForm(A.packet, badGold)).toThrow("M8_UNKNOWN_GOLD_STEP");
    const output = buildM8TeacherPackets(dataset(), run()).A;
    output.form.cases[0].ratings!.observationLocation = { score: 2, rationale: "unit authored test", evidence: [{ sourceId: "unit-s1", start: 0, end: 4, excerpt: "invented" }] };
    expect(() => validateM8TeacherForm(output.packet, output.form)).toThrow("M8_EVIDENCE_POSITION_MISMATCH");
  });
  it("a known score requires exact evidence and rationale", () => {
    const { packet, form } = buildM8TeacherPackets(dataset(), run()).A;
    form.cases[0].ratings!.observationLocation.score = 2;
    expect(() => validateM8TeacherForm(packet, form)).toThrow();
    form.cases[0].ratings!.observationLocation = { score: 2, rationale: "unit test evidence only", evidence: [{ sourceId: "unit-s1", start: 0, end: 5, excerpt: "2+3=6" }] };
    expect(validateM8TeacherForm(packet, form).form.cases[0].ratings?.observationLocation.score).toBe(2);
  });
  it("preserves original model claims and full transcript hashes without retroactive normalization", () => {
    const data = dataset(), recorded = run(data);
    const output = recorded.records[0].turns[0].output as { findings: unknown[] };
    output.findings = [{ findingKey: "unit-untrusted-claim", category: "KNOWLEDGE", statement: "原始模型声称学生不懂加法。", status: "VERIFIED", supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: "unit-s1", excerpt: "2+3=6" }], contradictingEvidence: [], verificationNeeded: false }];
    const before = hashValue(recorded), packets = buildM8TeacherPackets(data, recorded);
    const raw = JSON.stringify(packets.A.packet.cases[0].transcript);
    expect(raw).toContain("原始模型声称学生不懂加法。"); expect(raw).toContain('"status":"VERIFIED"'); expect(raw).not.toContain('"trust"');
    expect(hashValue(recorded)).toBe(before);
    const originalTranscriptHash = packets.A.packet.cases[0].transcriptHash;
    (output.findings[0] as { statement: string }).statement = "早期输出改动";
    expect(buildM8TeacherPackets(data, recorded).A.packet.cases[0].transcriptHash).not.toBe(originalTranscriptHash);
  });
  it("preserves differing originals and creates only unsigned third-person drafts", () => {
    const [a, b] = pendingOriginals();
    a.submission.cases[0].gold!.trueWrongStepIdSets = [["unit-s1"]]; a.submissionHash = hashValue(a.submission);
    b.submission.cases[0].gold!.trueWrongStepIdSets = [[]]; b.submissionHash = hashValue(b.submission);
    const before = hashValue([a, b]);
    const comparison = compareM8IndependentReviews(a, b)[0];
    expect(comparison.agrees).toBe(false); expect(comparison.originalAHash).not.toBe(comparison.originalBHash);
    const draft = createM8AdjudicationDraft(a, b, "unit-case", "UNIT_THIRD_NOT_A_PERSON", "Unit fixture disagreement only");
    expect(draft.state).toBe("DRAFT_ADJUDICATION"); expect(draft.final).toBeNull(); expect(draft.adjudication?.signature).toBe("");
    expect(hashValue([a, b])).toBe(before); expect(isM8HumanVerifiedDecision(draft)).toBe(false);
    expect(() => createM8AdjudicationDraft(a, b, "unit-case", a.submission.reviewerPseudonym!, "unit reason")).toThrow("M8_THIRD_REVIEWER_MUST_BE_DISTINCT");
  });
  it("does not equate anonymous IDs and hashes with actual audited signatures", () => {
    const originals = pendingOriginals(), row = originals[0].submission.cases[0];
    const decision: M8ReviewDecision = { schemaVersion: "M8.1", reviewKind: "INPUT_GOLD", caseId: row.caseId, inputHash: row.inputHash, transcriptHash: null, state: "AGREED", originals, final: row, adjudication: null };
    expect(isM8HumanVerifiedDecision(decision)).toBe(false);
    expect(() => createM8AgreementDecision(...originals, row.caseId)).toThrow("M8_AGREEMENT_REQUIRES_ACTUAL_HUMAN_SOURCE_AUDIT");
    const fabricatedAudit = structuredClone(originals[0]); fabricatedAudit.humanAudit.state = "HUMAN_VERIFIED";
    expect(m8SignedSourceArtifactSchema.safeParse(fabricatedAudit).success).toBe(false);
    const overwritten = structuredClone(originals[0]); overwritten.submission.cases[0].gold!.teacherNotes = "changed after hashing";
    expect(m8SignedSourceArtifactSchema.safeParse(overwritten).success).toBe(false);
    const copiedSource = structuredClone(originals[1]); copiedSource.signedSource.sourceHash = originals[0].signedSource.sourceHash;
    expect(() => compareM8IndependentReviews(originals[0], copiedSource)).toThrow("M8_DISTINCT_SIGNED_ORIGINAL_SOURCES_REQUIRED");
  });
  it("engineering success cannot produce teacher semantics or formal metrics", () => {
    const report = scoreM8Evaluation(dataset(), run());
    expect(report.engineeringDiagnostics.structureValidity.value).toBe(1);
    expect(report.formalQuality).toBeNull(); expect(report.coverage.teacherGoldVerifiedCount).toBe(0);
    expect(Object.keys(report.teacherSemanticRubric.metrics)).toHaveLength(8);
    for (const metric of Object.values(report.teacherSemanticRubric.metrics)) expect(metric).toEqual({ value: null, denominator: 0, missingCount: 1 });
    expect(report.rows[0].split).toBe("DEV"); expect(dataset().cases[0].split).toBe("DEBUG");
  });
  it("rejects review/input/run mismatches without silently rehashing original packets", () => {
    const data = dataset(), record = run(data); record.datasetHash = "a".repeat(64);
    expect(() => buildM8TeacherPackets(data, record)).toThrow("M8_RUN_DATASET_MISMATCH");
    expect(() => scoreM8Evaluation(data, record)).toThrow("RUN_DATASET_MISMATCH");
  });
});
