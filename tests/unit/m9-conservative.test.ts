import { describe, expect, it, vi } from "vitest";
import { auditM9Conservative, buildM9HelpProbes, renderM9ConservativeAudit } from "../../src/evaluation/m9-conservative";
import { advanceConversationContext } from "../../src/evaluation/conversation-score";
import { conversationCaseInputHash, conversationTranscriptHash, type ConversationCase, type ConversationDataset, type ConversationRun } from "../../src/evaluation/conversation-schemas";
import { hashValue } from "../../src/evaluation/schemas";
import type { DiagnosisFinding, DiagnosisTurn } from "../../src/server/ai/schemas/diagnosis";

// Explicit author-created software fixtures; no teacher labels, private real
// responses, live model transport, or alleged human signature is involved.
function sample(id: string, steps = [{ id: `${id}-s1`, text: "u=2+3=6" }]): ConversationCase {
  return { id, familyId: `${id}-family`, subject: "MATH", gradeBand: "GRADE_7_9", split: "DEBUG", reviewStatus: "PROVISIONAL", scenarioType: "insufficient_evidence",
    source: { kind: "AUTHOR_CREATED", reference: "M9 author-created unit test", license: "unit fixture" }, tags: ["AUTHOR_LABEL_SENTINEL"],
    initialContext: { questionId: `${id}-q`, questionText: "计算2+3。", subject: "MATH", gradeBand: "GRADE_7_9", steps, messages: [], findings: [], turnCount: 0, hintLevel: 0 },
    studentReplies: [{ id: `${id}-r1`, content: "UNOBSERVED_SCRIPT_SENTINEL" }, { id: `${id}-r2`, content: "UNOBSERVED_SECOND_SENTINEL" }] };
}
function terminal(findings: DiagnosisFinding[] = [], safetyFlags: string[] = []): DiagnosisTurn {
  return { schemaVersion: "1.0", action: "MARK_INCONCLUSIVE", studentFacingText: "现有证据保留为待确认。", referencedStepIds: [], findings, followUpQuestion: null, hintLevel: 0, safetyFlags };
}
function fixture(samples = [sample("unit-one")], outputs = samples.map(() => terminal())) {
  const dataset: ConversationDataset = { schemaVersion: "1.0", datasetId: "m9-author-unit", version: "unit.1", provenance: "AUTHOR_CREATED_PROVISIONAL", description: "Author synthetic fixtures only", cases: samples };
  const run: ConversationRun = { schemaVersion: "1.0", runId: "m9-unit-offline", createdAt: "2026-10-23T00:00:00.000Z", datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash: hashValue(dataset), caseIds: samples.map(row => row.id), mode: "SIMULATED", purpose: "ENGINEERING_DEBUG", auditReason: null,
    provider: "mock", model: "unit-fixture-only", promptVersion: "unit-existing-prompt", trustPolicyVersion: "M8.1",
    records: samples.map((row, index) => ({ caseId: row.id, inputHash: conversationCaseInputHash(row), turns: [{ turnIndex: 0, context: structuredClone(row.initialContext), contextHash: hashValue(row.initialContext), status: "SUCCESS", output: outputs[index], invocation: { latencyMs: null, inputTokens: null, outputTokens: null, attempts: 0, estimatedCostCny: 0, costBasis: "unit fixture no provider" } }] })) };
  return { dataset, run };
}

describe("M9 offline conservative policy audit", () => {
  it("keeps terminal action, finding kind, legacy status and verification state distinct", () => {
    const one = sample("unit-root");
    const findings: DiagnosisFinding[] = ["one", "two"].map(key => ({ findingKey: key, category: "EXECUTION", statement: "当前所引步骤仍待确认。", status: "UNRESOLVED", supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: one.initialContext.steps[0].id, excerpt: one.initialContext.steps[0].text }], contradictingEvidence: [], verificationNeeded: true,
      trust: { kind: "INCONCLUSIVE", uncertainties: ["作者软件测试候选，非教师判断。"], verification: { state: "INCONCLUSIVE", basis: "NONE", evidence: [] }, rootCause: { role: "INITIAL", candidateRootId: "one", relatedFindingKeys: key === "one" ? [] : ["one"], upstreamStepIds: [] } } }));
    const { dataset, run } = fixture([one], [terminal(findings)]), audit = auditM9Conservative(dataset, run);
    expect(audit.totals.inconclusiveActionTurns).toBe(1);
    expect(audit.totals.finalFindings.kind.INCONCLUSIVE).toBe(2);
    expect(audit.totals.finalFindings.status.UNRESOLVED).toBe(2);
    expect(audit.totals.finalFindings.verificationState.INCONCLUSIVE).toBe(2);
    expect(audit.totals.finalFindings.rootRole.INITIAL).toBe(2);
    expect(audit.totals.finalUniqueCandidateRootsWithinCases).toBe(1);
  });

  it("separates overlapping scope, absent process, local self-consistency and early terminal candidates", () => {
    const samples = [sample("scope", [{ id: "scope-s1", text: "u=2+3=5" }]), sample("absent", []), sample("consistent", [{ id: "consistent-s1", text: "u=2+3=5" }]), sample("candidate"), sample("partial", [{ id: "partial-s1", text: "u=2+3=5" }, { id: "partial-s2", text: "开放证明尚未核对" }])];
    const { dataset, run } = fixture(samples, [terminal([], ["UNSUPPORTED_CASE"]), terminal(), terminal(), terminal(), terminal()]);
    const audit = auditM9Conservative(dataset, run);
    expect(audit.totals).toMatchObject({ earlyTerminalCases: 5, unscheduledTurnsAfterTerminal: 10, supportScopeAbsentCases: 1, noStudentProcessCases: 1, arithmeticSelfConsistentCases: 3, earlyTerminalReviewCandidateCases: 2 });
    expect(audit.rows[0].observedBoundarySignals).toMatchObject({ supportScopeAbsent: true, arithmeticSelfConsistent: true, earlyTerminalReviewCandidate: false });
    expect(audit.rows[3].observedBoundarySignals.earlyTerminalReviewCandidate).toBe(true);
    expect(audit.rows[4].arithmeticScope.completeBoundedStepCoverage).toBe(false);
    expect(audit.rows[4].observedBoundarySignals).toMatchObject({ arithmeticSelfConsistent: true, earlyTerminalReviewCandidate: true });
    expect(audit.educationalAssessment.reasonableAbstentionRate).toBeNull();
  });

  it("counts help unknown separately from level zero and from persisted help", () => {
    const { dataset, run } = fixture(), audit = auditM9Conservative(dataset, run);
    expect(audit.totals).toMatchObject({ unknownHelpTurns: 1, zeroDeclaredUnknownHelpTurns: 1, unknownHelpPersistedInNextContextTurns: 0, unknownHelpRecomputedOnlyTurns: 1 });
    expect(audit.rows[0].helpReviews[0].review).toMatchObject({ status: "UNCERTAIN", declaredLevel: 0, minimumLevel: null, effectiveLevel: null });
  });

  it("exports source-bound pending questions without unobserved scripts or author labels", () => {
    const { dataset, run } = fixture(), audit = auditM9Conservative(dataset, run), queued = audit.teacherQueue[0];
    expect(queued.inputHash).toBe(conversationCaseInputHash(dataset.cases[0]));
    expect(queued.transcriptHash).toBe(conversationTranscriptHash(run.records[0]));
    const text = JSON.stringify(queued);
    expect(text).not.toContain("UNOBSERVED_SCRIPT_SENTINEL"); expect(text).not.toContain("AUTHOR_LABEL_SENTINEL");
    expect(queued.questions).toHaveLength(5);
    for (const question of queued.questions) {
      expect(question.teacherAnswer).toBeNull();
      for (const evidence of question.evidence) {
        const source = queued.sources.find(source => source.sourceId === evidence.sourceId)!;
        expect(evidence.textHash).toBe(hashValue(source.text)); expect(source.text.slice(evidence.start, evidence.end)).toBe(source.text);
      }
    }
  });

  it("retains complete history hashes and reads recordings without rewriting them", () => {
    const { dataset, run } = fixture(), one = dataset.cases[0];
    const ask: DiagnosisTurn = { ...terminal(), action: "ASK_ONE_QUESTION", studentFacingText: "你当时是怎么想的？", followUpQuestion: "你当时是怎么想的？" };
    run.records[0].turns[0].output = ask;
    const next = advanceConversationContext(one, one.initialContext, ask, 0, "M8.1");
    run.records[0].turns.push({ ...run.records[0].turns[0], turnIndex: 1, context: next, contextHash: hashValue(next), output: terminal() });
    const before = hashValue(run), audit = auditM9Conservative(dataset, run);
    expect(hashValue(run)).toBe(before);
    expect(audit.teacherQueue[0].sources.some(source => source.sourceId === one.studentReplies[0].id)).toBe(true);
    expect(audit.teacherQueue[0].sources.some(source => source.sourceId === one.studentReplies[1].id)).toBe(false);
    expect(audit.rows[0].helpReviews[0].persistedInNextContext).toBe(true);
    const modified = structuredClone(run), modifiedAsk = { ...ask, studentFacingText: "你这一步是怎么想的？", followUpQuestion: "你这一步是怎么想的？" };
    modified.records[0].turns[0].output = modifiedAsk;
    const modifiedNext = advanceConversationContext(one, one.initialContext, modifiedAsk, 0, "M8.1");
    modified.records[0].turns[1].context = modifiedNext; modified.records[0].turns[1].contextHash = hashValue(modifiedNext);
    expect(auditM9Conservative(dataset, modified).rows[0].transcriptHash).not.toBe(audit.rows[0].transcriptHash);
  });

  it("rejects BLIND, live, reviewed or legacy-policy inputs without evaluating them", () => {
    const blind = fixture([ { ...sample("blind"), split: "BLIND" } ]);
    expect(() => auditM9Conservative(blind.dataset, blind.run)).toThrow("M9_DEV_ONLY_BLIND_OUTPUTS_FORBIDDEN");
    const { dataset, run } = fixture();
    expect(() => auditM9Conservative(dataset, { ...run, mode: "LIVE_API", provider: "unit-live-forbidden" })).toThrow("M9_AUTHOR_DEV_M8_MOCK_ONLY");
    expect(() => auditM9Conservative({ ...dataset, provenance: "AUTHOR_CREATED_TEACHER_REVIEWED" }, run)).toThrow("M9_AUTHOR_DEV_M8_MOCK_ONLY");
    expect(() => auditM9Conservative(dataset, { ...run, trustPolicyVersion: undefined })).toThrow("M9_AUTHOR_DEV_M8_MOCK_ONLY");
  });

  it("uses turnIndex chronology even if immutable recording arrays are reordered", () => {
    const { dataset, run } = fixture(), one = dataset.cases[0];
    const ask: DiagnosisTurn = { ...terminal(), action: "ASK_ONE_QUESTION", studentFacingText: "你当时是怎么想的？", followUpQuestion: "你当时是怎么想的？" };
    run.records[0].turns[0].output = ask;
    const next = advanceConversationContext(one, one.initialContext, ask, 0, "M8.1");
    run.records[0].turns.push({ ...run.records[0].turns[0], turnIndex: 1, context: next, contextHash: hashValue(next), output: terminal() });
    const chronological = auditM9Conservative(dataset, run);
    run.records[0].turns.reverse();
    const before = hashValue(run), reordered = auditM9Conservative(dataset, run);
    expect(hashValue(run)).toBe(before);
    expect(reordered.rows[0].finalAction).toBe("MARK_INCONCLUSIVE");
    expect(reordered.rows[0].helpReviews.map(review => review.turnIndex)).toEqual([0, 1]);
    expect(reordered.rows[0].helpReviews[0].persistedInNextContext).toBe(true);
    expect(reordered.totals).toEqual(chronological.totals);
    expect(reordered.rows[0].transcriptHash).toBe(conversationTranscriptHash(run.records[0]));
    expect(reordered.rows[0].transcriptHash).not.toBe(chronological.rows[0].transcriptHash);
  });

  it("rejects changed input and broken continuation instead of silently rehashing recordings", () => {
    const { dataset, run } = fixture(), badInput = structuredClone(run), badContext = structuredClone(run);
    badInput.records[0].inputHash = "a".repeat(64);
    expect(() => auditM9Conservative(dataset, badInput)).toThrow("CASE_INPUT_MISMATCH");
    badContext.records[0].turns[0].context.questionText = "changed";
    expect(() => auditM9Conservative(dataset, badContext)).toThrow("M9_REQUIRES_VALIDATED_RECORDED_CONVERSATIONS");
  });

  it("preserves ambiguous help probes as candidates with unknown teacher verdicts", () => {
    const probes = buildM9HelpProbes();
    expect(probes.map(probe => probe.observedReview.minimumLevel)).toEqual([2, 3, 1]);
    for (const probe of probes) { expect(probe.teacherVerdict).toBeNull(); expect(probe.state).toBe("CANDIDATE_REQUIRES_TEACHER_REVIEW"); }
    const { dataset, run } = fixture(), audit = auditM9Conservative(dataset, run);
    expect(audit.educationalAssessment).toMatchObject({ reasonableAbstentionRate: null, unreasonableAbstentionRate: null, hintFalsePositiveRate: null, educationalAccuracy: null });
    expect(audit.formalQuality).toBeNull(); expect(audit.teacherReviewedCases).toBe(0);
    expect(renderM9ConservativeAudit(audit)).toContain("教师判断=null");
  });

  it("does not invoke network transport during offline inspection", () => {
    const forbiddenFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("UNIT_NETWORK_FORBIDDEN"); });
    try { const { dataset, run } = fixture(); expect(auditM9Conservative(dataset, run).networkRequests).toBe(0); expect(forbiddenFetch).not.toHaveBeenCalled(); }
    finally { forbiddenFetch.mockRestore(); }
  });
});
