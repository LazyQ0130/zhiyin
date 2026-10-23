import { createHash } from "node:crypto";
import { diagnosisTurnSchema } from "../server/ai/schemas/diagnosis";
import { reviewAssistance } from "../server/domain/assistance-review";
import { conversationAssistantId, conversationDatasetSchema, conversationRunSchema, type ConversationRecord } from "./conversation-schemas";
import { conversationAssistantText } from "./conversation-score";
import { scoreM8Evaluation } from "./m8-metrics";
import { m8ReviewDecisionSchema, type M8ReviewDecision } from "./m8-teacher-schemas";
import { buildM8TeacherPackets } from "./m8-teacher";
import { M9_CASE_MEASURES, m9SupplementalArtifactSchema, m9SupplementalDecisionSchema, m9SupplementalFormSchema, m9SupplementalPacketSchema, type M9CaseMeasure, type M9SupplementalArtifact, type M9SupplementalCase, type M9SupplementalDecision, type M9SupplementalForm, type M9SupplementalPacket } from "./m9-metrics-schemas";
import { hashValue } from "./schemas";

export const M9_MEASURE_SPECIFICATION = {
  conclusionCoverage: { unit: "CASE", eligibility: "教师判断本次输入及实际互动足以作出有边界的诊断结论（含正确/无错结论）", numeratorDefinition: "系统给出了该证据支持且覆盖主要现象的结论", direction: "HIGHER" },
  reasonableAbstention: { unit: "CASE", eligibility: "教师判断本次证据不足，需要保留结论/归因", numeratorDefinition: "系统合理弃答并说明证据边界或需要补充什么", direction: "HIGHER" },
  unreasonableAbstention: { unit: "CASE", eligibility: "教师判断本次证据足以作出有边界的诊断结论，与conclusionCoverage适用范围相同", numeratorDefinition: "系统无充分理由回避了能够支持的结论", direction: "LOWER" },
  erroneousCausalAttribution: { unit: "CASE", eligibility: "教师确认系统在本次实际输出中提出了一个或多个原因归因（观察定位不自动算归因）", numeratorDefinition: "至少一个原因归因不被本次证据支持或与证据矛盾", direction: "LOWER" },
  duplicateRoots: { unit: "CASE", eligibility: "教师确认存在至少两个需判断是否同源的错误/发现，且能够判断其关系", numeratorDefinition: "同一根因传播被重复计作独立根因", direction: "LOWER" },
  effectiveQuestioning: { unit: "CASE", eligibility: "实际提出至少一个追问且已观察对应学生回答；教师能够判断追问判别价值", numeratorDefinition: "本次所有主要追问有区分假设的价值，并实际利用回答调整判断，无答案暗示/无效重复", direction: "HIGHER" },
  usefulNextStepAdvice: { unit: "CASE", eligibility: "本次会话工程完整且教师能够判断下一步建议的适当性（含合理弃答案例）", numeratorDefinition: "系统给出与本次可见问题/证据缺口相符、可执行且不过早泄露答案的下一步建议", direction: "HIGHER" },
  hintMiss: { unit: "TURN", eligibility: "教师确认本回合实际帮助等级>0，且被比较通道等级已知", numeratorDefinition: "被比较通道报0级帮助", direction: "LOWER" },
  hintFalsePositive: { unit: "TURN", eligibility: "教师确认本回合实际帮助等级=0，且被比较通道等级已知", numeratorDefinition: "被比较通道报>0级帮助", direction: "LOWER" },
} as const;
const specificationHash = hashValue(M9_MEASURE_SPECIFICATION);
export const M9_SUPPLEMENTAL_RULES = [
  "M9只补充编码，不改M8八项0/1/2正式量表；当前材料PROVISIONAL，程序不得代填教育判断。",
  "A/B独立阅读原输入和实际会话，不查看作者标签、对方意见或未发生的预设回答。",
  "逐项独立判断applicable；未知填null，不适用填false。outcome仅在applicable=true且能判断时填写；所有已知判断须理由和原文证据。",
  "conclusionCoverage与unreasonableAbstention的适用性必须相同；有边界的正确/无错结论也算可诊断，原因未知不代表所有现象都不可诊断。",
  "逐回合人工判实际帮助0无/1方向/2关键知识/3答案或局部结果；必须读实际学生可见文本、问题和发现正文，不能照抄hintLevel或规则检测结果。等级未知填null。",
  "帮助漏报与误报分别以人工>0及人工=0为分母，未知不能当0。等级低估但仍>0另述，不纳入二元漏报。",
  "有效追问仅限实际追问并观察回答；缺回答/纯预设回答不补成有效，脚本互动不证明真实学生学习效果。",
  "已知编码引用UTF-16 sourceId/start/end/excerpt；帮助判断至少引用对应回合MODEL_OUTPUT的学生可见内容。",
  "实际教师签署来源由负责人核实，A/B原件和分歧保留；分歧须独立第三人签署并核实绑定仲裁载荷。程序hash和匿名标识不是现实身份认证。",
];

/** An initial/old USER message is not an answer to the current question. */
export function hasM9RecordedQuestionAndReply(record: Pick<ConversationRecord, "caseId" | "turns">) {
  const ordered = [...record.turns].sort((a, b) => a.turnIndex - b.turnIndex);
  return ordered.some((turn, index) => {
    const parsed = diagnosisTurnSchema.safeParse(turn.output), next = ordered[index + 1];
    if (!parsed.success || parsed.data.action !== "ASK_ONE_QUESTION" || !next || next.turnIndex !== turn.turnIndex + 1) return false;
    const before = turn.context.messages, after = next.context.messages;
    if (after.length !== before.length + 2 || hashValue(after.slice(0, before.length)) !== hashValue(before)) return false;
    const question = after[before.length], reply = after[before.length + 1];
    return question.role === "ASSISTANT" && question.id === conversationAssistantId(record.caseId, turn.turnIndex) && question.content === conversationAssistantText(parsed.data)
      && reply.role === "USER" && Boolean(reply.content.trim()) && !before.some(message => message.id === reply.id);
  });
}

export function buildM9SupplementalPackets(datasetValue: unknown, runValue: unknown): Record<"A" | "B", { packet: M9SupplementalPacket; form: M9SupplementalForm }> {
  const run = conversationRunSchema.parse(runValue);
  // Includes engineering continuity validation before distributing a recorded run.
  scoreM8Evaluation(datasetValue, run);
  const originals = buildM8TeacherPackets(datasetValue, run);
  const build = (slot: "A" | "B") => {
    const packet = m9SupplementalPacketSchema.parse({ schemaVersion: "M9.1", specificationHash, rules: M9_SUPPLEMENTAL_RULES, m8Packet: originals[slot].packet });
    const form = m9SupplementalFormSchema.parse({ schemaVersion: "M9.1", packetHash: hashValue(packet), packetId: packet.m8Packet.packetId, reviewerSlot: slot, reviewerPseudonym: null, reviewedAt: null, status: "DRAFT_UNSIGNED", signature: "", cases: packet.m8Packet.cases.map(row => ({
      caseId: row.caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash,
      codes: Object.fromEntries(M9_CASE_MEASURES.map(key => [key, { applicable: null, outcome: null, rationale: "", evidence: [] }])),
      helpTurns: (run.records.find(record => record.caseId === row.caseId)?.turns ?? []).filter(turn => turn.status === "SUCCESS").map(turn => ({ turnIndex: turn.turnIndex, actualHelpLevel: null, rationale: "", evidence: [] })),
    })) });
    return { packet, form };
  };
  return { A: build("A"), B: build("B") };
}

export function validateM9SupplementalForm(packetValue: unknown, formValue: unknown) {
  const packet = m9SupplementalPacketSchema.parse(packetValue), form = m9SupplementalFormSchema.parse(formValue);
  if (packet.specificationHash !== specificationHash || hashValue(packet.rules) !== hashValue(M9_SUPPLEMENTAL_RULES)) throw new Error("M9_SPECIFICATION_MISMATCH");
  if (form.packetHash !== hashValue(packet) || form.packetId !== packet.m8Packet.packetId || form.reviewerSlot !== packet.m8Packet.reviewerSlot) throw new Error("M9_PACKET_BINDING_MISMATCH");
  if (form.cases.length !== packet.m8Packet.cases.length) throw new Error("M9_FORM_COVERAGE_MISMATCH");
  for (const row of form.cases) {
    const sourceCase = packet.m8Packet.cases.find(sample => sample.caseId === row.caseId);
    if (!sourceCase || sourceCase.inputHash !== row.inputHash || sourceCase.transcriptHash !== row.transcriptHash) throw new Error("M9_CASE_BINDING_MISMATCH");
    const transcript = sourceCase.transcript as ConversationRecord, turns = transcript.turns;
    const successful = turns.filter(turn => turn.status === "SUCCESS").map(turn => turn.turnIndex);
    if (hashValue([...successful].sort()) !== hashValue(row.helpTurns.map(turn => turn.turnIndex).sort())) throw new Error("M9_HELP_TURN_COVERAGE_MISMATCH");
    const conclusion = row.codes.conclusionCoverage.applicable, abstention = row.codes.unreasonableAbstention.applicable;
    if (conclusion !== null && abstention !== null && conclusion !== abstention) throw new Error("M9_DIAGNOSABLE_ELIGIBILITY_MISMATCH");
    if (row.codes.effectiveQuestioning.applicable === true && !hasM9RecordedQuestionAndReply(transcript)) throw new Error("M9_ACTUAL_QUESTION_AND_REPLY_REQUIRED");
    for (const code of [...Object.values(row.codes), ...row.helpTurns]) for (const position of code.evidence) {
      const source = sourceCase.sources.find(source => source.sourceId === position.sourceId);
      if (!source || source.text.slice(position.start, position.end) !== position.excerpt || position.end > source.text.length) throw new Error("M9_EVIDENCE_POSITION_MISMATCH");
    }
    for (const turn of row.helpTurns) if (turn.actualHelpLevel !== null && !turn.evidence.some(position => position.sourceId === `m8-output-${row.caseId}-${turn.turnIndex}`)) throw new Error("M9_CURRENT_VISIBLE_OUTPUT_EVIDENCE_REQUIRED");
  }
  return { packet, form };
}

function originalRow(original: M9SupplementalArtifact, caseId: string) {
  const row = original.submission.cases.find(row => row.caseId === caseId);
  if (!row) throw new Error("M9_ORIGINAL_CASE_MISSING");
  return row;
}
export function compareM9SupplementalReviews(aValue: unknown, bValue: unknown) {
  const a = m9SupplementalArtifactSchema.parse(aValue), b = m9SupplementalArtifactSchema.parse(bValue);
  validateM9SupplementalForm(a.packet, a.submission); validateM9SupplementalForm(b.packet, b.submission);
  if (a.submission.reviewerSlot !== "A" || b.submission.reviewerSlot !== "B" || !a.submission.reviewerPseudonym || !b.submission.reviewerPseudonym || a.submission.reviewerPseudonym === b.submission.reviewerPseudonym) throw new Error("M9_INDEPENDENT_REVIEWERS_REQUIRED");
  if (a.signedSource.sourceHash === b.signedSource.sourceHash) throw new Error("M9_DISTINCT_SIGNED_ORIGINAL_SOURCES_REQUIRED");
  const pa = a.packet.m8Packet, pb = b.packet.m8Packet;
  if (pa.datasetId !== pb.datasetId || pa.datasetVersion !== pb.datasetVersion || pa.datasetHash !== pb.datasetHash || pa.runId !== pb.runId || hashValue(pa.cases) !== hashValue(pb.cases)) throw new Error("M9_ORIGINAL_PACKET_CONTENT_MISMATCH");
  return a.submission.cases.map(row => {
    const bRow = originalRow(b, row.caseId);
    return { caseId: row.caseId, agrees: hashValue(row) === hashValue(bRow), originalA: row, originalB: bRow, originalAHash: hashValue(row), originalBHash: hashValue(bRow) };
  });
}
export function m9SupplementalAdjudicationPayload(decision: M9SupplementalDecision) {
  return { schemaVersion: "M9.1", caseId: decision.caseId, inputHash: decision.inputHash, transcriptHash: decision.transcriptHash, originals: decision.originals.map(original => ({ reviewerPseudonym: original.submission.reviewerPseudonym, submissionHash: original.submissionHash, signedSourceHash: original.signedSource.sourceHash, codeHash: hashValue(originalRow(original, decision.caseId)) })), final: decision.final, reviewerPseudonym: decision.adjudication?.reviewerPseudonym ?? null, reason: decision.adjudication?.reason ?? null, reviewedAt: decision.adjudication?.reviewedAt ?? null };
}
export function createM9SupplementalDecision(aValue: unknown, bValue: unknown, caseId: string, third?: { reviewerPseudonym: string; reason: string }): M9SupplementalDecision {
  const a = m9SupplementalArtifactSchema.parse(aValue), b = m9SupplementalArtifactSchema.parse(bValue);
  const compared = compareM9SupplementalReviews(a, b).find(row => row.caseId === caseId);
  if (!compared) throw new Error("M9_DECISION_CASE_MISSING");
  const row = compared.originalA;
  if (third && [a.submission.reviewerPseudonym, b.submission.reviewerPseudonym].includes(third.reviewerPseudonym)) throw new Error("M9_THIRD_REVIEWER_MUST_BE_DISTINCT");
  if (!third && (!compared.agrees || a.humanAudit.state !== "HUMAN_VERIFIED" || b.humanAudit.state !== "HUMAN_VERIFIED")) throw new Error("M9_AGREEMENT_REQUIRES_IDENTICAL_HUMAN_AUDITED_ORIGINALS");
  return m9SupplementalDecisionSchema.parse({ schemaVersion: "M9.1", caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash, state: third ? "DRAFT_ADJUDICATION" : "AGREED", originals: [a, b], final: third ? null : row, adjudication: third ? { ...third, reviewedAt: null, signature: "", signedSourceHash: null, signedSourceByteLength: null, humanAudit: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, adjudicationPayloadHash: null, actualTeacherAndSignatureConfirmed: false } : null });
}
export function isM9HumanVerifiedSupplementalDecision(value: unknown): value is M9SupplementalDecision {
  const parsed = m9SupplementalDecisionSchema.safeParse(value);
  if (!parsed.success) return false;
  const decision = parsed.data;
  try {
    const comparison = compareM9SupplementalReviews(...decision.originals).find(row => row.caseId === decision.caseId);
    if (!comparison || !decision.final || decision.final.caseId !== decision.caseId || decision.final.inputHash !== decision.inputHash || decision.final.transcriptHash !== decision.transcriptHash || decision.originals.some(original => original.humanAudit.state !== "HUMAN_VERIFIED")) return false;
    const a = decision.originals[0];
    validateM9SupplementalForm(a.packet, { ...a.submission, cases: a.submission.cases.map(row => row.caseId === decision.caseId ? decision.final : row) });
    if (decision.state === "AGREED") return decision.adjudication === null && comparison.agrees && hashValue(decision.final) === comparison.originalAHash;
    const third = decision.adjudication;
    return decision.state === "ADJUDICATED" && Boolean(third && !decision.originals.some(original => original.submission.reviewerPseudonym === third.reviewerPseudonym || original.signedSource.sourceHash === third.signedSourceHash) && third.reason.trim() && third.reviewedAt && third.signedSourceHash && third.signedSourceByteLength && third.humanAudit === "HUMAN_VERIFIED" && third.verifierPseudonym && third.verifiedAt && third.actualTeacherAndSignatureConfirmed && third.adjudicationPayloadHash === hashValue(m9SupplementalAdjudicationPayload(decision)));
  } catch { return false; }
}

export type M9ScoreOptions = { goldDecisions?: unknown[]; outputDecisions?: unknown[]; supplementalDecisions?: unknown[]; signedSourceBytes?: readonly Uint8Array[] };
type Cell = { applicable: boolean | null; outcome: boolean | null };
/** Finite-case completion bounds are not confidence intervals or accuracy claims. */
export function aggregateM9Codes(cells: Cell[], executionExcludedCount = 0) {
  const eligible = cells.filter(cell => cell.applicable === true), known = eligible.filter(cell => cell.outcome !== null);
  const numerator = known.filter(cell => cell.outcome === true).length, denominator = known.length;
  const eligibilityUnknownCount = cells.filter(cell => cell.applicable === null).length, outcomeUnknownCount = eligible.length - known.length;
  const missingCount = eligibilityUnknownCount + outcomeUnknownCount, completionDenominator = denominator + missingCount;
  return { value: denominator ? numerator / denominator : null, numerator, denominator, candidateCount: cells.length, eligibleCount: eligible.length, notApplicableCount: cells.filter(cell => cell.applicable === false).length, eligibilityUnknownCount, outcomeUnknownCount, missingCount, executionExcludedCount,
    possibleEligibilityCount: { min: eligible.length, max: eligible.length + eligibilityUnknownCount },
    pendingCompletionBounds: completionDenominator ? { min: numerator / completionDenominator, max: (numerator + missingCount) / completionDenominator, interpretation: "仅当前候选集合全部缺失项均适用时的最坏/最好补全范围；不是置信区间、总体准确率或已测质量" } : null,
  };
}
export function aggregateM9HelpLevelDifferences(values: Array<{ actual: number | null; detected: number | null }>, executionExcludedCount = 0) {
  const known = values.filter((value): value is { actual: number; detected: number } => value.actual !== null && value.detected !== null);
  const rate = (predicate: (actual: number, detected: number) => boolean) => aggregateM9Codes(values.map(value => ({ applicable: value.actual === null ? null : true, outcome: value.actual !== null && value.detected !== null ? predicate(value.actual, value.detected) : null })), executionExcludedCount);
  return { unit: "TURN", denominatorDefinition: "人工实际等级与被比较通道等级均已知的回合；包括双方均>0的等级差异", underclassification: rate((actual, detected) => detected < actual), overclassification: rate((actual, detected) => detected > actual), exactLevelAgreement: rate((actual, detected) => detected === actual),
    teacherKnownCount: values.filter(value => value.actual !== null).length, channelUnknownCount: values.filter(value => value.detected === null).length,
    levelCounts: Array.from({ length: 4 }, (_, actual) => Array.from({ length: 4 }, (_, detected) => known.filter(value => value.actual === actual && value.detected === detected).length)),
    interpretation: "levelCounts行=人工实际0..3，列=通道0..3；二元帮助均为正不代表等级判对。没有人工编码时所有率保持null。",
  };
}
function sourceBytesPresent(decision: M8ReviewDecision | M9SupplementalDecision | undefined, bytes: readonly Uint8Array[]) {
  if (!decision) return false;
  const sources = decision.originals.map(original => ({ hash: original.signedSource.sourceHash, length: original.signedSource.byteLength }));
  if (decision.adjudication) sources.push({ hash: decision.adjudication.signedSourceHash ?? "", length: decision.adjudication.signedSourceByteLength ?? -1 });
  return sources.every(source => bytes.some(value => value.length === source.length && createHash("sha256").update(value).digest("hex") === source.hash));
}

/** Offline only. No author annotations, M8 numeric rubric thresholds, or taxonomy
 * become M9 educational labels. M8's formal rubric is returned unchanged. */
export function scoreM9Evaluation(datasetValue: unknown, runValue: unknown, options: M9ScoreOptions = {}) {
  const dataset = conversationDatasetSchema.parse(datasetValue), run = conversationRunSchema.parse(runValue);
  const m8 = scoreM8Evaluation(dataset, run, options);
  const gold = (options.goldDecisions ?? []).map(value => m8ReviewDecisionSchema.parse(value)), output = (options.outputDecisions ?? []).map(value => m8ReviewDecisionSchema.parse(value));
  const supplemental = (options.supplementalDecisions ?? []).map(value => m9SupplementalDecisionSchema.parse(value));
  if (new Set(supplemental.map(decision => decision.caseId)).size !== supplemental.length) throw new Error("M9_DUPLICATE_SUPPLEMENTAL_DECISION");
  const rebuilt = buildM8TeacherPackets(dataset, run).A.packet;
  for (const decision of supplemental) {
    const source = rebuilt.cases.find(row => row.caseId === decision.caseId);
    if (!source || decision.inputHash !== source.inputHash || decision.transcriptHash !== source.transcriptHash) throw new Error("M9_DECISION_BINDING_MISMATCH");
    compareM9SupplementalReviews(...decision.originals);
    for (const original of decision.originals) {
      const packet = original.packet.m8Packet;
      if (packet.datasetHash !== hashValue(dataset) || packet.datasetId !== dataset.datasetId || packet.datasetVersion !== dataset.version || packet.runId !== run.runId) throw new Error("M9_REVIEW_DATASET_RUN_MISMATCH");
      for (const row of packet.cases) if (hashValue(row) !== hashValue(rebuilt.cases.find(source => source.caseId === row.caseId))) throw new Error("M9_REVIEW_SOURCE_CONTENT_MISMATCH");
    }
  }
  const bytes = options.signedSourceBytes ?? [];
  const rows = m8.rows.map(row => {
    const decision = supplemental.find(decision => decision.caseId === row.caseId);
    const goldDecision = gold.find(decision => decision.caseId === row.caseId), outputDecision = output.find(decision => decision.caseId === row.caseId);
    const humanDecisionVerified = Boolean(decision && isM9HumanVerifiedSupplementalDecision(decision));
    const actualSignedSourceBytesAvailable = sourceBytesPresent(goldDecision, bytes) && sourceBytesPresent(outputDecision, bytes) && sourceBytesPresent(decision, bytes);
    const qualityCodesUsable = row.teacherGoldVerified && row.teacherOutputVerified && humanDecisionVerified && actualSignedSourceBytesAvailable && row.executionStatus === "VALIDATED_CONVERSATION";
    const record = run.records.find(record => record.caseId === row.caseId);
    return { ...row, answeredQuestionOpportunity: Boolean(record && hasM9RecordedQuestionAndReply(record)), humanDecisionVerified, actualSignedSourceBytesAvailable, qualityCodesUsable, supplementalDecisionHash: decision ? hashValue(decision) : null, codes: Object.fromEntries(M9_CASE_MEASURES.map(key => [key, qualityCodesUsable ? decision!.final!.codes[key] : { applicable: null, outcome: null, rationale: "", evidence: [] }])) as M9SupplementalCase["codes"], helpTurns: qualityCodesUsable ? decision!.final!.helpTurns : null };
  });
  const caseMetrics = (selected: typeof rows) => Object.fromEntries(M9_CASE_MEASURES.map(key => {
    const completed = selected.filter(row => row.executionStatus === "VALIDATED_CONVERSATION"), candidates = completed.filter(row => key !== "effectiveQuestioning" || row.answeredQuestionOpportunity);
    return [key, { ...M9_MEASURE_SPECIFICATION[key], ...aggregateM9Codes(candidates.map(row => row.codes[key]), selected.length - completed.length), structurallyExcludedCount: completed.length - candidates.length, source: "经M8输入/输出审核及M9补充编码双人/仲裁、原件字节核对的人工结论；无实际已回答追问是结构排除，不是人工不适用或质量0分" }];
  })) as Record<M9CaseMeasure, ReturnType<typeof aggregateM9Codes> & typeof M9_MEASURE_SPECIFICATION[M9CaseMeasure] & { structurallyExcludedCount: number; source: string }>;
  const turns = rows.flatMap(row => (run.records.find(record => record.caseId === row.caseId)?.turns ?? []).filter(turn => turn.status === "SUCCESS").map(turn => {
    const parsed = diagnosisTurnSchema.safeParse(turn.output), code = row.helpTurns?.find(code => code.turnIndex === turn.turnIndex);
    const guarded = parsed.success ? reviewAssistance({ studentFacingText: parsed.data.studentFacingText, followUpQuestion: parsed.data.followUpQuestion, findings: parsed.data.findings, declaredHintLevel: parsed.data.hintLevel, requestedAction: turn.context.requestedAction, subject: turn.context.subject, questionText: turn.context.questionText }) : null;
    return { caseId: row.caseId, turnIndex: turn.turnIndex, executionEligible: row.executionStatus === "VALIDATED_CONVERSATION" && parsed.success, actualHelpLevel: code?.actualHelpLevel ?? null, recordedOutputDeclaration: parsed.success ? parsed.data.hintLevel : null, m8GuardReplay: guarded?.effectiveLevel ?? null };
  }));
  function hintMetric(kind: "hintMiss" | "hintFalsePositive", channel: "recordedOutputDeclaration" | "m8GuardReplay", selectedCaseIds?: Set<string>) {
    const selected = turns.filter(turn => !selectedCaseIds || selectedCaseIds.has(turn.caseId));
    const valid = selected.filter(turn => turn.executionEligible);
    const cells = valid.map(turn => {
      const teacher = turn.actualHelpLevel, detected = turn[channel];
      const applicable = teacher === null ? null : kind === "hintMiss" ? teacher > 0 : teacher === 0;
      return { applicable, outcome: applicable === true && detected !== null ? kind === "hintMiss" ? detected === 0 : detected > 0 : null };
    });
    return { ...M9_MEASURE_SPECIFICATION[kind], channel: channel === "recordedOutputDeclaration" ? "RECORDED_OUTPUT_DECLARATION" : "M8_GUARD_REPLAY", ...aggregateM9Codes(cells, selected.length - valid.length), detectorUnknownCount: valid.filter(turn => turn[channel] === null).length, source: "人工逐回合actualHelpLevel与已保存hintLevel/离线M8内容复核比较；不是上游供应商未归一原始响应" };
  }
  const hintMetrics = (ids?: Set<string>) => {
    const selected = turns.filter(turn => !ids || ids.has(turn.caseId)), valid = selected.filter(turn => turn.executionEligible);
    return { hintMiss: { recordedOutputDeclaration: hintMetric("hintMiss", "recordedOutputDeclaration", ids), m8GuardReplay: hintMetric("hintMiss", "m8GuardReplay", ids) }, hintFalsePositive: { recordedOutputDeclaration: hintMetric("hintFalsePositive", "recordedOutputDeclaration", ids), m8GuardReplay: hintMetric("hintFalsePositive", "m8GuardReplay", ids) },
      hintLevelDifferences: { recordedOutputDeclaration: aggregateM9HelpLevelDifferences(valid.map(turn => ({ actual: turn.actualHelpLevel, detected: turn.recordedOutputDeclaration })), selected.length - valid.length), m8GuardReplay: aggregateM9HelpLevelDifferences(valid.map(turn => ({ actual: turn.actualHelpLevel, detected: turn.m8GuardReplay })), selected.length - valid.length) },
    };
  };
  const completed = rows.filter(row => row.executionStatus === "VALIDATED_CONVERSATION");
  const finals = completed.map(row => diagnosisTurnSchema.parse([...run.records.find(record => record.caseId === row.caseId)!.turns].sort((a, b) => a.turnIndex - b.turnIndex).at(-1)!.output));
  const descriptiveRate = (count: number) => ({ numerator: count, denominator: finals.length, value: finals.length ? count / finals.length : null, unit: "CASE", missingCount: rows.length - finals.length });
  const formalRows = rows.filter(row => row.formalEligible && row.qualityCodesUsable), formalIds = new Set(formalRows.map(row => row.caseId));
  return {
    schemaVersion: "M9.1", datasetId: dataset.datasetId, datasetHash: hashValue(dataset), runId: run.runId, runMode: run.mode, runPurpose: run.purpose,
    status: "REVIEW_PENDING_UNLESS_BOUND_HUMAN_CODES_AVAILABLE", specificationHash, interpretation: "八类独立有效性口径（帮助漏报/误报分列）；只描述本批有审核的输出，不是学生学习效果、总体准确率或发布证明。M8正式量表保持原样。",
    engineeringDescriptive: { interpretation: "保存输出的可计数发射/弃答与INCONCLUSIVE；没有教育适当性含义。不是上游原始响应与产品后处理的实验比较。", finalReportEmission: descriptiveRate(finals.filter(turn => turn.action === "FINISH_REPORT").length), finalFindingEmission: descriptiveRate(finals.filter(turn => turn.findings.length > 0).length), markInconclusiveEmission: descriptiveRate(finals.filter(turn => turn.action === "MARK_INCONCLUSIVE").length), inconclusiveFindingEmissionCount: finals.reduce((sum, turn) => sum + turn.findings.filter(finding => finding.trust?.kind === "INCONCLUSIVE").length, 0), recordedQuestionTurnCount: run.records.flatMap(record => record.turns).filter(turn => diagnosisTurnSchema.safeParse(turn.output).success && (turn.output as { action: string }).action === "ASK_ONE_QUESTION").length, operationalFailure: { numerator: rows.length - finals.length, denominator: rows.length, value: (rows.length - finals.length) / rows.length } },
    educationalQuality: { caseMetrics: caseMetrics(rows), ...hintMetrics() },
    formalQuality: formalRows.length ? { caseCount: formalRows.length, caseMetrics: caseMetrics(formalRows), ...hintMetrics(formalIds) } : null,
    coverage: { scheduledCases: rows.length, completedCases: completed.length, teacherGoldVerifiedCount: rows.filter(row => row.teacherGoldVerified).length, teacherOutputVerifiedCount: rows.filter(row => row.teacherOutputVerified).length, supplementalHumanVerifiedCount: rows.filter(row => row.humanDecisionVerified).length, allSourceBytesAvailableCount: rows.filter(row => row.actualSignedSourceBytesAvailable).length, qualityCodesUsableCount: rows.filter(row => row.qualityCodesUsable).length, reviewedHelpTurnCount: turns.filter(turn => turn.actualHelpLevel !== null).length, recordedSuccessfulTurnCount: turns.length, formalEligibleWithSupplementCount: formalRows.length },
    sourceAuditLimitation: "程序复用M8的完整原件/签署人工声明、双人一致或第三人仲裁绑定，并额外核对实际来源字节；仍不能认证现实教师身份、签名真伪或语义。单改boolean/status不能通过这些绑定。",
    m8, rows, helpTurnComparisons: turns,
  };
}
