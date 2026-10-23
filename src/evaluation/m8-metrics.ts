import { scoreConversationEvaluation } from "./conversation-score";
import { conversationDatasetSchema, conversationRunSchema } from "./conversation-schemas";
import { hashValue } from "./schemas";
import { M8_SEMANTIC_DIMENSIONS, m8ReviewDecisionSchema, type M8ReviewDecision, type M8SemanticDimension } from "./m8-teacher-schemas";
import { buildM8TeacherPackets, isM8HumanVerifiedDecision, validateM8TeacherForm } from "./m8-teacher";

type M8Metric = { value: number | null; denominator: number; missingCount: number };
function aggregate(values: Array<number | null>): M8Metric {
  const known = values.filter((value): value is number => value !== null);
  return { value: known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null, denominator: known.length, missingCount: values.length - known.length };
}
type M8ScoreOptions = { goldDecisions?: unknown[]; outputDecisions?: unknown[] };

/** Engineering checks cannot assign these teacher semantic scores. No network calls. */
export function scoreM8Evaluation(datasetValue: unknown, runValue: unknown, options: M8ScoreOptions = {}) {
  const dataset = conversationDatasetSchema.parse(datasetValue), run = conversationRunSchema.parse(runValue);
  const engineering = scoreConversationEvaluation(dataset, run);
  function parseDecisions(values: unknown[], kind: M8ReviewDecision["reviewKind"]) {
    const decisions = values.map(value => m8ReviewDecisionSchema.parse(value));
    if (new Set(decisions.map(decision => decision.caseId)).size !== decisions.length) throw new Error("M8_DUPLICATE_REVIEW_DECISION");
    for (const decision of decisions) {
      const row = engineering.rows.find(row => row.caseId === decision.caseId);
      if (!row || decision.reviewKind !== kind || row.inputHash !== decision.inputHash || (kind === "OUTPUT_RUBRIC" ? row.transcriptHash !== decision.transcriptHash : decision.transcriptHash !== null)) throw new Error("M8_REVIEW_DECISION_BINDING_MISMATCH");
      // Rebuild a packet projection so invented evidence offsets cannot be scored.
      const packets = buildM8TeacherPackets(dataset, kind === "OUTPUT_RUBRIC" ? run : undefined);
      for (const original of decision.originals) {
        validateM8TeacherForm(original.packet, original.submission);
        if (original.packet.datasetHash !== hashValue(dataset) || original.packet.runId !== (kind === "OUTPUT_RUBRIC" ? run.runId : null)) throw new Error("M8_REVIEW_PACKET_DATASET_MISMATCH");
        const rebuilt = packets[original.submission.reviewerSlot].packet;
        for (const originalCase of original.packet.cases) {
          const rebuiltCase = rebuilt.cases.find(sample => sample.caseId === originalCase.caseId);
          if (!rebuiltCase || hashValue(rebuiltCase) !== hashValue(originalCase)) throw new Error("M8_REVIEW_SOURCE_CONTENT_MISMATCH");
        }
      }
      if (decision.final) {
        const packet = packets.A.packet;
        validateM8TeacherForm(packet, { ...packets.A.form, cases: packets.A.form.cases.map(row => row.caseId === decision.caseId ? decision.final : row) });
      }
    }
    return decisions;
  }
  const gold = parseDecisions(options.goldDecisions ?? [], "INPUT_GOLD"), output = parseDecisions(options.outputDecisions ?? [], "OUTPUT_RUBRIC");
  const rows = engineering.rows.map(row => {
    const goldDecision = gold.find(decision => decision.caseId === row.caseId), outputDecision = output.find(decision => decision.caseId === row.caseId);
    const teacherGoldVerified = Boolean(goldDecision && isM8HumanVerifiedDecision(goldDecision));
    const teacherOutputVerified = Boolean(outputDecision && isM8HumanVerifiedDecision(outputDecision));
    const scores = Object.fromEntries(M8_SEMANTIC_DIMENSIONS.map(dimension => [dimension, null])) as Record<M8SemanticDimension, number | null>;
    // Incomplete review and inapplicable content remain null, including execution
    // failures. Failure rates are explicit engineering outcomes, not semantic marks.
    const expected = goldDecision?.final?.gold;
    const applicable: Record<M8SemanticDimension, boolean> = {
      observationLocation: expected?.trueWrongStepIdSets != null, causalAttribution: expected?.allowedCategories != null,
      observationHypothesisSeparation: Boolean(expected && Object.entries(expected).some(([key, value]) => key !== "teacherNotes" && value !== null)),
      hintPollutionControl: expected?.forbidPrematureAnswer != null, rootCausePropagation: expected?.rootCauseRelations != null,
      counterevidenceCorrection: expected?.requiresCounterevidenceCorrection === true,
      discriminativeQuestioning: Boolean(expected && run.records.find(record => record.caseId === row.caseId)?.turns.some(turn => turn.status === "SUCCESS" && (turn.output as { action?: string })?.action === "ASK_ONE_QUESTION")),
      appropriateAbstention: expected?.requiresAbstention != null,
    };
    if (teacherGoldVerified && teacherOutputVerified && outputDecision?.final?.ratings && row.status === "VALIDATED_CONVERSATION") for (const dimension of M8_SEMANTIC_DIMENSIONS) {
      const score = outputDecision.final.ratings[dimension].score;
      if (score !== null && !applicable[dimension]) throw new Error("M8_RATING_NOT_APPLICABLE");
      scores[dimension] = score === null ? null : score / 2;
    }
    const sample = dataset.cases.find(sample => sample.id === row.caseId)!;
    const formalEligible = run.mode === "LIVE_API" && run.purpose === "FINAL_EVALUATION" && dataset.provenance !== "AUTHOR_CREATED_PROVISIONAL" && sample.reviewStatus === "TEACHER_REVIEWED" && sample.split === "BLIND" && teacherGoldVerified && teacherOutputVerified;
    return { caseId: row.caseId, split: sample.split === "DEBUG" ? "DEV" : "BLIND", inputHash: row.inputHash, transcriptHash: row.transcriptHash, executionStatus: row.status, teacherGoldVerified, teacherOutputVerified, formalEligible, applicable, scores };
  });
  const metrics = (selected: typeof rows) => Object.fromEntries(M8_SEMANTIC_DIMENSIONS.map(dimension => [dimension, aggregate(selected.map(row => row.scores[dimension]))]));
  const formalRows = rows.filter(row => row.formalEligible);
  return {
    schemaVersion: "M8.1", runId: run.runId, datasetId: dataset.datasetId, datasetHash: hashValue(dataset), status: dataset.provenance === "AUTHOR_CREATED_PROVISIONAL" ? "PROVISIONAL" : "AUDIT_REQUIRED",
    engineeringDiagnostics: engineering.engineeringDiagnostics, reliability: engineering.reliability,
    teacherSemanticRubric: { interpretation: "人工审阅诊断；不表示学生学习效果或总体教育准确率。未审/未知/不适用保持null。", metrics: metrics(rows) },
    formalQuality: formalRows.length ? { caseCount: formalRows.length, metrics: metrics(formalRows) } : null,
    coverage: { scheduledCases: rows.length, teacherGoldVerifiedCount: rows.filter(row => row.teacherGoldVerified).length, teacherOutputVerifiedCount: rows.filter(row => row.teacherOutputVerified).length, formalEligibleCount: formalRows.length, failedConversations: engineering.reliability.failedConversations },
    sourceAuditLimitation: "HUMAN_VERIFIED是人工确认声明；程序只检验来源字节hash/标签绑定，不认证教师身份、签字真伪或教育语义。",
    rows,
  };
}
