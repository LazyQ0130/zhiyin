import { randomUUID } from "node:crypto";
import { conversationCaseInputHash, conversationDatasetSchema, conversationRunSchema, conversationTranscriptHash, conversationTranscriptProjection } from "./conversation-schemas";
import { hashValue } from "./schemas";
import { M8_SEMANTIC_DIMENSIONS, m8CaseReviewPayload, m8ReviewDecisionSchema, m8SignedSourceArtifactSchema, m8TeacherFormSchema, m8TeacherPacketSchema, type M8ReviewDecision, type M8SignedSourceArtifact, type M8TeacherForm, type M8TeacherPacket } from "./m8-teacher-schemas";

export const M8_TEACHER_RULES = [
  "当前输入仍为PROVISIONAL；填写空表、程序校验、匿名ID和hash均不是现实教师审核或签名。",
  "请独立阅读题目、步骤及预设回复；先自行解题。预设回复不是实际学生互动，不据此推断长期掌握。",
  "原始步骤中的可观察错误与因果假设分别判断；读题/知识/策略/计算等原因需独立证据。正确步骤不硬造错误。",
  "根因和下游传播分开；同一根因传播不重复算多处独立错误，另有独立错误应保留，证据不够填UNKNOWN。",
  "学生在提示后答对不等于独立理解；自称抄写/录入失误是自述，不能自动推翻可见原步骤。",
  "有效反证须检验内容并撤回或降低被反驳假设。追问须有判别价值，信息不足时应指出边界。",
  "null表示未知或不适用；理由说明原因。所有已评分项须引用具体sourceId和UTF-16字符区间[start,end)。",
  "0=明确不满足；1=部分满足；2=本次证据充分满足。八项人工语义指标不得由JSON结构或关键词自动填分。",
  "请在此包内独立填写，不查看其他人的意见。签名位置留空直至实际教师签署；真实身份和签署原件只保存在私有目录。",
];
export const M8_RUBRIC_ANCHORS = {
  observationLocation: "定位可观察的原始错误/正确步骤，证据不足不强判。0=误判关键步骤；2=准确定位且结论有边界。",
  causalAttribution: "判断原因是否由区分性证据支持。0=凭单一错答断言知识/读题缺陷；2=原因力度与独立证据相称。",
  observationHypothesisSeparation: "0=混同观察和假设；2=清楚区分已见事实、候选原因、待核实内容。",
  hintPollutionControl: "0=把提示后改正当作独立理解或提前泄露答案；2=记录提示影响并保留独立作答机会。",
  rootCausePropagation: "0=重复归咎同一传播链或合并独立错误；2=有证据区分初始错、传播错、独立错和UNKNOWN。",
  counterevidenceCorrection: "0=忽视有效反证或信任未经核实的自述；2=理解反证并适度撤回/降低原假设。无反证填null。",
  discriminativeQuestioning: "0=无判别价值、重复或暗示答案；2=一个主要问题能区分假设并利用实际回答。无实际追问填null。",
  appropriateAbstention: "0=证据不足仍确定归因或无理由回避充分证据；2=合理补充/弃答并说明边界。",
};

/** Reads inputs and optional recorded teaching transcript only; never reads author labels. */
export function buildM8TeacherPackets(datasetValue: unknown, runValue?: unknown): Record<"A" | "B", { packet: M8TeacherPacket; form: M8TeacherForm }> {
  const dataset = conversationDatasetSchema.parse(datasetValue), datasetHash = hashValue(dataset);
  const run = runValue === undefined ? null : conversationRunSchema.parse(runValue);
  if (run && (run.datasetId !== dataset.datasetId || run.datasetVersion !== dataset.version || run.datasetHash !== datasetHash)) throw new Error("M8_RUN_DATASET_MISMATCH");
  if (run?.caseIds.some(caseId => !dataset.cases.some(sample => sample.id === caseId))) throw new Error("M8_UNKNOWN_RUN_CASE");
  const cases = dataset.cases.filter(sample => !run || run.caseIds.includes(sample.id)).map(sample => {
    const inputHash = conversationCaseInputHash(sample), record = run?.records.find(row => row.caseId === sample.id);
    if (record && record.inputHash !== inputHash) throw new Error("M8_TRANSCRIPT_INPUT_MISMATCH");
    const sources: M8TeacherPacket["cases"][number]["sources"] = [];
    function add(sourceId: string, kind: typeof sources[number]["kind"], text: string, exposure: typeof sources[number]["exposure"] = "ORIGINAL_INPUT") {
      const existing = sources.find(source => source.sourceId === sourceId);
      if (existing) { if (existing.text !== text || existing.kind !== kind) throw new Error("M8_SOURCE_ID_COLLISION"); return; }
      sources.push({ sourceId, kind, exposure, text, sequence: sources.length, textHash: hashValue(text) });
    }
    add(sample.initialContext.questionId, "QUESTION", sample.initialContext.questionText);
    sample.initialContext.steps.forEach(step => add(step.id, "STUDENT_STEP", step.text));
    sample.initialContext.messages.forEach(message => add(message.id, message.role === "USER" ? "STUDENT_REPLY" : "ASSISTANT_MESSAGE", message.content));
    if (!run) sample.studentReplies.forEach(reply => add(reply.id, "STUDENT_REPLY", reply.content, "SCRIPTED_NOT_OBSERVED"));
    if (record) record.turns.forEach(turn => {
      turn.context.messages.forEach(message => add(message.id, message.role === "USER" ? "STUDENT_REPLY" : "ASSISTANT_MESSAGE", message.content, "ACTUAL_TRANSCRIPT"));
      add(`m8-output-${sample.id}-${turn.turnIndex}`, turn.status === "SUCCESS" ? "MODEL_OUTPUT" : "EXECUTION_ERROR", turn.status === "SUCCESS" ? JSON.stringify(turn.output, null, 2) : turn.errorCode!, "ACTUAL_TRANSCRIPT");
    });
    const completeRecord = record ?? { caseId: sample.id, inputHash, turns: [] };
    return { caseId: sample.id, inputHash, transcriptHash: run ? conversationTranscriptHash(completeRecord) : null, subject: sample.subject, gradeBand: sample.gradeBand, sources, transcript: run ? conversationTranscriptProjection(completeRecord) : null };
  });
  const reviewKind = run ? "OUTPUT_RUBRIC" : "INPUT_GOLD";
  function build(reviewerSlot: "A" | "B") {
    const packet = m8TeacherPacketSchema.parse({ schemaVersion: "M8.1", packetId: `m8-${randomUUID()}`, reviewerSlot, reviewKind, datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash, runId: run?.runId ?? null, status: "PROVISIONAL", sourceKind: dataset.provenance === "CONSENTED_ADULT" ? "CONSENTED_ADULT" : "AUTHOR_CREATED", rules: M8_TEACHER_RULES, cases });
    const form = m8TeacherFormSchema.parse({ schemaVersion: "M8.1", packetId: packet.packetId, packetHash: hashValue(packet), reviewerSlot, reviewKind, reviewerPseudonym: null, reviewedAt: null, status: "DRAFT_UNSIGNED", signature: "", cases: cases.map(row => ({ caseId: row.caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash,
      gold: run ? null : { trueWrongStepIdSets: null, allowedCategories: null, requiresAbstention: null, noErrorExpected: null, requiresCounterevidenceCorrection: null, forbidPrematureAnswer: null, teacherNotes: "待独立教师填写；当前无教师标签。", rootCauseRelations: null },
      ratings: run ? Object.fromEntries(M8_SEMANTIC_DIMENSIONS.map(dimension => [dimension, { score: null, rationale: "", evidence: [] }])) : null,
    })) });
    return { packet, form };
  }
  return { A: build("A"), B: build("B") };
}

export function validateM8TeacherForm(packetValue: unknown, formValue: unknown) {
  const packet = m8TeacherPacketSchema.parse(packetValue), form = m8TeacherFormSchema.parse(formValue);
  if (form.packetId !== packet.packetId || form.packetHash !== hashValue(packet) || form.reviewerSlot !== packet.reviewerSlot || form.reviewKind !== packet.reviewKind) throw new Error("M8_PACKET_BINDING_MISMATCH");
  if (form.cases.length !== packet.cases.length) throw new Error("M8_REVIEW_COVERAGE_MISMATCH");
  for (const row of form.cases) {
    const sample = packet.cases.find(sample => sample.caseId === row.caseId);
    if (!sample || row.inputHash !== sample.inputHash || row.transcriptHash !== sample.transcriptHash) throw new Error("M8_REVIEW_CASE_BINDING_MISMATCH");
    const stepIds = new Set(sample.sources.filter(source => source.kind === "STUDENT_STEP").map(source => source.sourceId));
    for (const set of row.gold?.trueWrongStepIdSets ?? []) for (const stepId of set) if (!stepIds.has(stepId)) throw new Error("M8_UNKNOWN_GOLD_STEP");
    const positions = [...Object.values(row.ratings ?? {}).flatMap(rating => rating.evidence), ...(row.gold?.rootCauseRelations ?? []).flatMap(relation => {
      if (!stepIds.has(relation.stepId) || relation.upstreamStepIds.some(id => !stepIds.has(id)) || relation.candidateRootStepId !== null && !stepIds.has(relation.candidateRootStepId)) throw new Error("M8_UNKNOWN_ROOT_RELATION_STEP");
      return relation.evidence;
    })];
    for (const position of positions) {
      const source = sample.sources.find(source => source.sourceId === position.sourceId);
      if (!source || source.textHash !== hashValue(source.text) || source.text.slice(position.start, position.end) !== position.excerpt || position.end > source.text.length) throw new Error("M8_EVIDENCE_POSITION_MISMATCH");
    }
  }
  return { packet, form };
}

export function renderM8TeacherPacket(packet: M8TeacherPacket): string {
  const lines = [`# 独立教师审核包 ${packet.reviewerSlot}`, "", `状态：${packet.status}。包ID：${packet.packetId}。`, `输入版本：${packet.datasetVersion}；输入hash：${packet.datasetHash}。`, "", "## 审核规则", "", ...packet.rules.map(rule => `- ${rule}`)];
  if (packet.reviewKind === "OUTPUT_RUBRIC") lines.push("", "## 人工语义量表", "", ...Object.entries(M8_RUBRIC_ANCHORS).map(([key, anchor]) => `- ${key}：${anchor}`));
  for (const sample of packet.cases) {
    lines.push("", `## ${sample.caseId}`, "", `学科/学段：${sample.subject}/${sample.gradeBand}。inputHash：${sample.inputHash}。`, ...(sample.transcriptHash ? [`transcriptHash：${sample.transcriptHash}。`] : []));
    for (const source of sample.sources) lines.push("", `### ${source.sequence}. ${source.kind} / ${source.sourceId}`, "", `来源状态：${source.exposure}；字符范围：[0,${source.text.length})；textHash：${source.textHash}`, "", "```text", source.text.replace(/```/g, "` ` `"), "```");
    lines.push("", "独立判断/理由：________________", "证据位置 sourceId / start / end / excerpt：________________", "未知或不适用原因：________________");
  }
  lines.push("", "教师匿名标识：________________", "实际审阅时间：________________", "签名（仅实际教师签署）：________________", "", "请填写同目录review.form.json；真实签署原件与身份材料只在私有目录保管。");
  return lines.join("\n") + "\n";
}

function originalRow(artifact: M8SignedSourceArtifact, caseId: string) {
  const row = artifact.submission.cases.find(row => row.caseId === caseId);
  if (!row) throw new Error("M8_ORIGINAL_CASE_MISSING");
  return row;
}
export function compareM8IndependentReviews(aValue: unknown, bValue: unknown) {
  const a = m8SignedSourceArtifactSchema.parse(aValue), b = m8SignedSourceArtifactSchema.parse(bValue);
  validateM8TeacherForm(a.packet, a.submission); validateM8TeacherForm(b.packet, b.submission);
  if (a.signedSource.sourceHash === b.signedSource.sourceHash) throw new Error("M8_DISTINCT_SIGNED_ORIGINAL_SOURCES_REQUIRED");
  if (a.packet.datasetId !== b.packet.datasetId || a.packet.datasetVersion !== b.packet.datasetVersion || a.packet.datasetHash !== b.packet.datasetHash || a.packet.runId !== b.packet.runId || hashValue(a.packet.cases) !== hashValue(b.packet.cases)) throw new Error("M8_ORIGINAL_PACKET_CONTENT_MISMATCH");
  if (a.submission.reviewerSlot !== "A" || b.submission.reviewerSlot !== "B" || !a.submission.reviewerPseudonym || !b.submission.reviewerPseudonym || a.submission.reviewerPseudonym === b.submission.reviewerPseudonym || a.submission.reviewKind !== b.submission.reviewKind) throw new Error("M8_INDEPENDENT_REVIEWERS_REQUIRED");
  if (a.submission.cases.length !== b.submission.cases.length) throw new Error("M8_ORIGINAL_COVERAGE_MISMATCH");
  return a.submission.cases.map(rowA => {
    const rowB = originalRow(b, rowA.caseId);
    if (rowA.inputHash !== rowB.inputHash || rowA.transcriptHash !== rowB.transcriptHash) throw new Error("M8_ORIGINAL_BINDING_MISMATCH");
    const agrees = hashValue(m8CaseReviewPayload(rowA)) === hashValue(m8CaseReviewPayload(rowB));
    return { caseId: rowA.caseId, inputHash: rowA.inputHash, transcriptHash: rowA.transcriptHash, agrees, originalA: rowA, originalB: rowB, originalAHash: hashValue(m8CaseReviewPayload(rowA)), originalBHash: hashValue(m8CaseReviewPayload(rowB)), auditState: "PROVISIONAL" as const };
  });
}
export function createM8AdjudicationDraft(aValue: unknown, bValue: unknown, caseId: string, thirdPseudonym: string, reason: string): M8ReviewDecision {
  const a = m8SignedSourceArtifactSchema.parse(aValue), b = m8SignedSourceArtifactSchema.parse(bValue);
  const compared = compareM8IndependentReviews(a, b).find(row => row.caseId === caseId);
  if (!compared) throw new Error("M8_ADJUDICATION_CASE_MISSING");
  if ([a.submission.reviewerPseudonym, b.submission.reviewerPseudonym].includes(thirdPseudonym)) throw new Error("M8_THIRD_REVIEWER_MUST_BE_DISTINCT");
  return m8ReviewDecisionSchema.parse({ schemaVersion: "M8.1", reviewKind: a.submission.reviewKind, caseId, inputHash: compared.inputHash, transcriptHash: compared.transcriptHash, state: "DRAFT_ADJUDICATION", originals: [a, b], final: null, adjudication: { reviewerPseudonym: thirdPseudonym, reason, reviewedAt: null, signature: "", signedSourceHash: null, signedSourceByteLength: null, humanAudit: "PENDING_HUMAN_AUDIT", verifierPseudonym: null, verifiedAt: null, adjudicationPayloadHash: null, actualTeacherAndSignatureConfirmed: false } });
}
export function m8AdjudicationPayload(decision: M8ReviewDecision) {
  return { caseId: decision.caseId, inputHash: decision.inputHash, transcriptHash: decision.transcriptHash, reviewKind: decision.reviewKind, originals: decision.originals.map(original => ({ reviewerPseudonym: original.submission.reviewerPseudonym, submissionHash: original.submissionHash, signedSourceHash: original.signedSource.sourceHash, labelHash: hashValue(m8CaseReviewPayload(originalRow(original, decision.caseId))) })), final: decision.final, reviewerPseudonym: decision.adjudication?.reviewerPseudonym ?? null, reason: decision.adjudication?.reason ?? null, reviewedAt: decision.adjudication?.reviewedAt ?? null };
}
export function createM8AgreementDecision(aValue: unknown, bValue: unknown, caseId: string): M8ReviewDecision {
  const a = m8SignedSourceArtifactSchema.parse(aValue), b = m8SignedSourceArtifactSchema.parse(bValue);
  const comparison = compareM8IndependentReviews(a, b).find(row => row.caseId === caseId);
  if (!comparison?.agrees) throw new Error("M8_AGREEMENT_REQUIRES_IDENTICAL_ORIGINALS");
  if (a.humanAudit.state !== "HUMAN_VERIFIED" || b.humanAudit.state !== "HUMAN_VERIFIED") throw new Error("M8_AGREEMENT_REQUIRES_ACTUAL_HUMAN_SOURCE_AUDIT");
  return m8ReviewDecisionSchema.parse({ schemaVersion: "M8.1", reviewKind: a.submission.reviewKind, caseId, inputHash: comparison.inputHash, transcriptHash: comparison.transcriptHash, state: "AGREED", originals: [a, b], final: comparison.originalA, adjudication: null });
}
export function isM8HumanVerifiedDecision(value: unknown): value is M8ReviewDecision {
  const parsed = m8ReviewDecisionSchema.safeParse(value);
  if (!parsed.success) return false;
  const decision = parsed.data;
  try { compareM8IndependentReviews(...decision.originals); } catch { return false; }
  if (!decision.final || decision.final.caseId !== decision.caseId || decision.final.inputHash !== decision.inputHash || decision.final.transcriptHash !== decision.transcriptHash || decision.originals.some(original => original.humanAudit.state !== "HUMAN_VERIFIED" || original.submission.reviewKind !== decision.reviewKind)) return false;
  try { validateM8TeacherForm(decision.originals[0].packet, { ...decision.originals[0].submission, cases: decision.originals[0].submission.cases.map(row => row.caseId === decision.caseId ? decision.final : row) }); } catch { return false; }
  const finalHash = hashValue(m8CaseReviewPayload(decision.final));
  const originalHashes = decision.originals.map(original => hashValue(m8CaseReviewPayload(originalRow(original, decision.caseId))));
  if (decision.state === "AGREED") return decision.adjudication === null && originalHashes.every(hash => hash === finalHash);
  const adjudication = decision.adjudication;
  return decision.state === "ADJUDICATED" && Boolean(adjudication && !decision.originals.some(original => original.submission.reviewerPseudonym === adjudication.reviewerPseudonym) && adjudication.reviewedAt && adjudication.signedSourceHash && adjudication.signedSourceByteLength && adjudication.humanAudit === "HUMAN_VERIFIED" && adjudication.verifierPseudonym && adjudication.verifiedAt && adjudication.adjudicationPayloadHash === hashValue(m8AdjudicationPayload(decision)) && adjudication.actualTeacherAndSignatureConfirmed);
}
