import type { DiagnosisContext } from "../server/ai/gateway";
import { diagnosisTurnSchema, type DiagnosisTurn } from "../server/ai/schemas/diagnosis";
import { validateDiagnosisTurn } from "../server/ai/validate-turn";
import {reviewAssistance} from '../server/domain/assistance-review';
import { evaluationContextSchema, hashValue, isApprovedReview } from "./schemas";
import {
  CONVERSATION_RUBRIC_METRICS, conversationAnnotationSetSchema, conversationAssistantId, conversationCaseInputHash,
  conversationDatasetSchema, conversationGoldReviewPayload, conversationOutputReviewPayload, conversationOutputReviewSetSchema,
  conversationRunSchema, conversationTranscriptHash, type ConversationCase, type ConversationRecord, type ConversationRubricMetric,
} from "./conversation-schemas";

export const CONVERSATION_ENGINEERING_METRICS = ["structureValidity", "evidenceScopeValidity", "contextContinuation", "finalStepSetExact", "finalStepSetF1", "finalCategoriesAllowed", "abstentionProtocol", "counterevidenceCitation"] as const;
type EngineeringMetric = typeof CONVERSATION_ENGINEERING_METRICS[number];
type MetricName = EngineeringMetric | ConversationRubricMetric;
export type ConversationMetric = { value: number | null; denominator: number; missingCount: number };
const allMetrics = [...CONVERSATION_ENGINEERING_METRICS, ...CONVERSATION_RUBRIC_METRICS];

/** Same serialization is used when constructing and when independently checking the next model input. */
export function conversationAssistantText(output: DiagnosisTurn): string {
  return output.followUpQuestion && !output.studentFacingText.includes(output.followUpQuestion)
    ? `${output.studentFacingText}\n${output.followUpQuestion}` : output.studentFacingText;
}
export function isConversationTerminal(output: DiagnosisTurn): boolean {
  return output.action === "FINISH_REPORT" || output.action === "MARK_INCONCLUSIVE";
}
export function advanceConversationContext(sample: ConversationCase, previous: DiagnosisContext, output: DiagnosisTurn, previousTurnIndex: number, trustPolicyVersion?:'M8.1'): DiagnosisContext {
  const reply = sample.studentReplies[previousTurnIndex];
  if (!reply) throw new Error("NO_SCRIPTED_REPLY_FOR_NEXT_TURN");
  const assistance=trustPolicyVersion?reviewAssistance({studentFacingText:conversationAssistantText(output),findings:output.findings,declaredHintLevel:output.hintLevel,requestedAction:previous.requestedAction,subject:previous.subject,questionText:previous.questionText}):undefined;
  return evaluationContextSchema.parse({
    ...previous,
    messages: [...previous.messages, { id: conversationAssistantId(sample.id, previousTurnIndex), role: "ASSISTANT", content: conversationAssistantText(output),...(assistance?{assistance}:{}) }, { id: reply.id, role: "USER", content: reply.content }],
    findings: output.findings, turnCount: previous.turnCount + 1, hintLevel: trustPolicyVersion?Math.max(previous.hintLevel,assistance?.effectiveLevel??output.hintLevel):output.hintLevel, requestedAction: "REPLY",
  });
}
function metric(values: Array<number | null>): ConversationMetric {
  const known = values.filter((value): value is number => value !== null);
  return { value: known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null, denominator: known.length, missingCount: values.length - known.length };
}
function setScores(actual: string[], expected: string[][]) {
  const a = new Set(actual);
  return expected.map(set => {
    const b = new Set(set), overlap = [...a].filter(id => b.has(id)).length;
    return { exact: Number(a.size === b.size && overlap === b.size), f1: a.size + b.size ? 2 * overlap / (a.size + b.size) : 1 };
  }).sort((a, b) => b.f1 - a.f1 || b.exact - a.exact)[0];
}
function percentile(values: number[], fraction: number) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
}

/** Pure offline scorer. Gold/ratings never enter a model input and no text-match surrogate claims semantic correctness. */
export function scoreConversationEvaluation(datasetValue: unknown, runValue: unknown, annotationsValue?: unknown, reviewsValue?: unknown) {
  const dataset = conversationDatasetSchema.parse(datasetValue), run = conversationRunSchema.parse(runValue);
  const annotations = annotationsValue === undefined ? null : conversationAnnotationSetSchema.parse(annotationsValue);
  const reviews = reviewsValue === undefined ? null : conversationOutputReviewSetSchema.parse(reviewsValue);
  const datasetHash = hashValue(dataset);
  if (run.datasetId !== dataset.datasetId || run.datasetVersion !== dataset.version || run.datasetHash !== datasetHash) throw new Error("RUN_DATASET_MISMATCH");
  if (annotations && (annotations.datasetId !== dataset.datasetId || annotations.datasetVersion !== dataset.version || annotations.datasetHash !== datasetHash)) throw new Error("ANNOTATION_DATASET_MISMATCH");
  if (annotations?.annotations.some(annotation => !dataset.cases.some(sample => sample.id === annotation.caseId))) throw new Error("ANNOTATION_UNKNOWN_CASE");
  if (reviews && reviews.runId !== run.runId) throw new Error("OUTPUT_REVIEW_RUN_MISMATCH");
  if (reviews?.reviews.some(review => !run.caseIds.includes(review.caseId))) throw new Error("OUTPUT_REVIEW_UNKNOWN_CASE");
  if (run.caseIds.some(id => !dataset.cases.some(sample => sample.id === id))) throw new Error("RUN_UNKNOWN_CASE");
  if (run.mode === "SIMULATED" && run.caseIds.some(id => dataset.cases.find(sample => sample.id === id)?.split === "BLIND") && run.purpose !== "BLIND_AUDIT") throw new Error("BLIND_SIMULATION_REQUIRES_AUDIT_PURPOSE");

  // Validate every sidecar label, including cases not selected in this run.
  for (const annotation of annotations?.annotations ?? []) {
    const sample = dataset.cases.find(item => item.id === annotation.caseId)!;
    if (annotation.inputHash !== conversationCaseInputHash(sample)) throw new Error("ANNOTATION_INPUT_MISMATCH");
    if (annotation.expected.trueWrongStepIdSets?.some(set => set.some(id => !sample.initialContext.steps.some(step => step.id === id)))) throw new Error("ANNOTATION_UNKNOWN_STEP");
  }

  const rows = run.caseIds.map(caseId => {
    const sample = dataset.cases.find(item => item.id === caseId)!;
    const inputHash = conversationCaseInputHash(sample), record = run.records.find(item => item.caseId === caseId);
    const annotation = annotations?.annotations.find(item => item.caseId === caseId), review = reviews?.reviews.find(item => item.caseId === caseId);
    if (record && record.inputHash !== inputHash || review && review.inputHash !== inputHash) throw new Error("CASE_INPUT_MISMATCH");
    const scriptTurnCapacity = sample.studentReplies.length + 1;
    if (record?.turns.some(turn => turn.turnIndex >= scriptTurnCapacity)) throw new Error("UNPLANNED_CONVERSATION_TURN");
    const transcript: ConversationRecord = record ?? { caseId, inputHash, turns: [] };
    const transcriptHash = conversationTranscriptHash(transcript);
    if (review && review.transcriptHash !== transcriptHash) throw new Error("OUTPUT_REVIEW_TRANSCRIPT_MISMATCH");
    let expectedContext: DiagnosisContext | null = sample.initialContext;
    const turns: Array<{ turnIndex: number; status: "VALIDATED_OUTPUT" | "FAILED"; errorCode: string | null; structureValidity: number; evidenceScopeValidity: number; contextContinuation: number; output: DiagnosisTurn | null }> = [];
    for (let turnIndex = 0; turnIndex < scriptTurnCapacity; turnIndex++) {
      const actual = record?.turns.find(turn => turn.turnIndex === turnIndex);
      const structure = actual?.status === "SUCCESS" && diagnosisTurnSchema.safeParse(actual.output).success ? 1 : 0;
      const continuation: number = actual && expectedContext && actual.contextHash === hashValue(actual.context) && actual.contextHash === hashValue(expectedContext) ? 1 : 0;
      let output: DiagnosisTurn | null = null;
      let errorCode = actual?.errorCode ?? (actual ? null : "MISSING_TURN_RECORD");
      if (actual?.status === "SUCCESS") {
        // Audit the immutable historical output. Server guards may normalize a new
        // response, but must not rewrite what a historical student/model actually saw.
        try { validateDiagnosisTurn(actual.output, actual.context); output = diagnosisTurnSchema.parse(actual.output); }
        catch { errorCode = "INVALID_OR_UNSCOPED_OUTPUT"; }
      }
      if (!continuation && actual) errorCode = "CONTEXT_CONTINUATION_MISMATCH";
      const validated: boolean = Boolean(output && continuation);
      turns.push({ turnIndex, status: validated ? "VALIDATED_OUTPUT" : "FAILED", errorCode, structureValidity: structure, evidenceScopeValidity: Number(output !== null), contextContinuation: Number(continuation), output });
      if (validated && isConversationTerminal(output!)) {
        if (record?.turns.some(turn => turn.turnIndex > turnIndex)) throw new Error("RECORD_AFTER_TERMINAL");
        break;
      }
      // A broken/missing previous turn cannot silently establish a fresh, unverified history.
      expectedContext = validated && expectedContext && turnIndex < scriptTurnCapacity - 1 ? advanceConversationContext(sample, expectedContext, output!, turnIndex,run.trustPolicyVersion) : null;
    }
    const complete = turns.every(turn => turn.status === "VALIDATED_OUTPUT"), finalOutput = complete ? turns.at(-1)!.output : null;
    const scores = Object.fromEntries(allMetrics.map(key => [key, null])) as Record<MetricName, number | null>;
    for (const key of ["structureValidity", "evidenceScopeValidity", "contextContinuation"] as const) scores[key] = turns.reduce((sum, turn) => sum + turn[key], 0) / turns.length;
    const expected = annotation?.expected;
    if (expected?.trueWrongStepIdSets) {
      const value = finalOutput ? setScores(finalOutput.referencedStepIds, expected.trueWrongStepIdSets) : { exact: 0, f1: 0 };
      scores.finalStepSetExact = value.exact; scores.finalStepSetF1 = value.f1;
    }
    if (expected?.allowedCategories !== null && expected?.allowedCategories !== undefined) {
      const active = finalOutput?.findings.filter(finding => !["REFUTED", "UNRESOLVED"].includes(finding.status)) ?? [];
      scores.finalCategoriesAllowed = Number(Boolean(finalOutput && (expected.allowedCategories.length ? active.length > 0 && active.every(finding => expected.allowedCategories!.includes(finding.category)) : active.length === 0)));
    }
    if (expected?.requiresAbstention !== null && expected?.requiresAbstention !== undefined) scores.abstentionProtocol = Number(Boolean(finalOutput && (expected.requiresAbstention
      ? ["MARK_INCONCLUSIVE", "REQUEST_INPUT_CORRECTION"].includes(finalOutput.action) && finalOutput.findings.every(finding => !["SUPPORTED", "VERIFIED"].includes(finding.status))
      : !["MARK_INCONCLUSIVE", "REQUEST_INPUT_CORRECTION"].includes(finalOutput.action))));
    if (expected?.requiresCounterevidenceCorrection) scores.counterevidenceCitation = Number(Boolean(finalOutput && finalOutput.findings.some(finding => finding.contradictingEvidence.some(evidence => evidence.kind === "STUDENT_REPLY" && sample.studentReplies.some(reply => reply.id === evidence.sourceId)))));
    const teacherGold = Boolean(annotation?.provenance === "TEACHER_REVIEWED" && isApprovedReview(annotation.review, conversationGoldReviewPayload(annotation)));
    const outputReviewApproved = Boolean(review && isApprovedReview(review.review, conversationOutputReviewPayload(review)));
    const applicable: Record<ConversationRubricMetric, boolean> = {
      trueWrongStepIdentification: expected?.trueWrongStepIdSets != null,
      factHypothesisSeparation: Boolean(expected), followUpEffectiveness: Boolean(expected && turns.some(turn => turn.status === "VALIDATED_OUTPUT" && turn.output?.action === "ASK_ONE_QUESTION")),
      counterevidenceCorrection: expected?.requiresCounterevidenceCorrection === true,
      noPrematureAnswerLeakage: expected?.forbidPrematureAnswer === true,
      appropriateAbstention: expected?.requiresAbstention != null, suggestionSpecificity: Boolean(expected),
    };
    for (const key of CONVERSATION_RUBRIC_METRICS) {
      if (review && !applicable[key] && review.ratings[key] !== null) throw new Error("RUBRIC_RATING_NOT_APPLICABLE");
      // Operational failure is zero on a known applicable teacher target; missing labels/ratings remain null.
      if (teacherGold && applicable[key]) scores[key] = !complete ? 0 : outputReviewApproved && review ? review.ratings[key] === null ? null : review.ratings[key] / 2 : null;
    }
    const formalCohort = dataset.provenance !== "AUTHOR_CREATED_PROVISIONAL" && sample.reviewStatus === "TEACHER_REVIEWED" && sample.split === "BLIND" && teacherGold;
    return {
      caseId, subject: sample.subject, gradeBand: sample.gradeBand, scenarioType: sample.scenarioType, split: sample.split,
      inputHash, transcriptHash, status: complete ? "VALIDATED_CONVERSATION" as const : "FAILED" as const,
      annotation: annotation?.provenance ?? "UNANNOTATED", teacherGold, outputReviewApproved, formalCohort, scores,
      scriptTurnCapacity, notScheduledAfterTerminal: scriptTurnCapacity - turns.length,
      turns: turns.map(({ output: _output, ...turn }) => { void _output; return turn; }),
    };
  });
  const aggregate = (selected: typeof rows, names: readonly MetricName[]) => Object.fromEntries(names.map(key => [key, metric(selected.map(row => row.scores[key]))]));
  const expectedTurns = rows.reduce((sum, row) => sum + row.turns.length, 0), invocations = run.records.flatMap(record => record.turns.map(turn => turn.invocation));
  const latency = invocations.flatMap(invocation => invocation.latencyMs === null ? [] : [invocation.latencyMs]);
  const knownCosts = invocations.filter(invocation => invocation.estimatedCostCny !== null);
  const formalRows = rows.filter(row => row.formalCohort);
  const formalPermitted = run.mode === "LIVE_API" && run.purpose === "FINAL_EVALUATION";
  return {
    schemaVersion: "1.0", runId: run.runId, mode: run.mode, purpose: run.purpose, datasetId: dataset.datasetId, datasetHash,
    disclaimer: "结构/证据作用域/上下文连续性独立于教育错因与追问质量。候选标签及Mock只检验工程流程，不证明教学效果。人工量表0/1/2归一化；失败会话在适用教师目标计0；缺标签/未审核评分为null。结合失败率、各指标分母与审核覆盖率阅读。",
    reliability: { scheduledConversations: rows.length, recordedConversations: run.records.length, validatedConversations: rows.filter(row => row.status === "VALIDATED_CONVERSATION").length, failedConversations: rows.filter(row => row.status === "FAILED").length, scriptTurnCapacity: rows.reduce((sum, row) => sum + row.scriptTurnCapacity, 0), notScheduledAfterTerminal: rows.reduce((sum, row) => sum + row.notScheduledAfterTerminal, 0), scheduledTurns: expectedTurns, recordedTurns: invocations.length, validatedTurns: rows.reduce((sum, row) => sum + row.turns.filter(turn => turn.status === "VALIDATED_OUTPUT").length, 0), failedTurns: rows.reduce((sum, row) => sum + row.turns.filter(turn => turn.status === "FAILED").length, 0) },
    engineeringDiagnostics: aggregate(rows, CONVERSATION_ENGINEERING_METRICS),
    formalQuality: formalPermitted && formalRows.length ? { caseCount: formalRows.length, reviewedOutputCount: formalRows.filter(row => row.outputReviewApproved).length, failedConversations: formalRows.filter(row => row.status === "FAILED").length, metrics: aggregate(formalRows, CONVERSATION_RUBRIC_METRICS) } : null,
    coverage: { provisionalCases: rows.filter(row => row.annotation === "AUTHOR_PROVISIONAL").length, unannotatedCases: rows.filter(row => row.annotation === "UNANNOTATED").length, teacherGoldCases: rows.filter(row => row.teacherGold).length, approvedOutputReviews: rows.filter(row => row.outputReviewApproved).length, formalCohortCases: formalRows.length, finalQualityPermitted: formalPermitted },
    latency: { knownCount: latency.length, unknownCount: expectedTurns - latency.length, p50Ms: percentile(latency, .5), p95Ms: percentile(latency, .95), maxMs: latency.length ? Math.max(...latency) : null },
    usage: { inputTokens: invocations.length === expectedTurns && invocations.every(value => value.inputTokens !== null) ? invocations.reduce((sum, value) => sum + (value.inputTokens ?? 0), 0) : null, outputTokens: invocations.length === expectedTurns && invocations.every(value => value.outputTokens !== null) ? invocations.reduce((sum, value) => sum + (value.outputTokens ?? 0), 0) : null },
    cost: { currency: "CNY", estimatedTotal: knownCosts.length === expectedTurns ? knownCosts.reduce((sum, value) => sum + (value.estimatedCostCny ?? 0), 0) : null, knownPartialEstimate: knownCosts.length ? knownCosts.reduce((sum, value) => sum + (value.estimatedCostCny ?? 0), 0) : null, unknownCount: expectedTurns - knownCosts.length, billingVerified: false },
    rows,
  };
}
