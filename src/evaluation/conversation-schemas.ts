import { z } from "zod";
import { TAXONOMY } from "../server/ai/schemas/diagnosis";
import { evaluationContextSchema, evaluationInvocationSchema, hashValue, isApprovedReview, reviewControlSchema } from "./schemas";

const id = z.string().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueIds = z.array(id).max(10000).refine(values => new Set(values).size === values.length, "重复标识");
export const CONVERSATION_SCENARIOS = ["correct", "calculation_error", "conceptual_error", "method_error", "multiple_errors", "insufficient_evidence", "student_counterevidence"] as const;
export const CONVERSATION_RUBRIC_METRICS = ["trueWrongStepIdentification", "factHypothesisSeparation", "followUpEffectiveness", "counterevidenceCorrection", "noPrematureAnswerLeakage", "appropriateAbstention", "suggestionSpecificity"] as const;

export const conversationCaseSchema = z.strictObject({
  id, familyId: id,
  subject: z.enum(["MATH", "CHINESE", "ENGLISH", "PHYSICS", "CHEMISTRY", "OTHER"]), gradeBand: id,
  split: z.enum(["DEBUG", "BLIND"]), reviewStatus: z.enum(["PROVISIONAL", "TEACHER_REVIEWED"]),
  scenarioType: z.enum(CONVERSATION_SCENARIOS),
  source: z.strictObject({ kind: z.enum(["AUTHOR_CREATED", "CONSENTED_ADULT"]), reference: z.string().min(1), license: z.string().min(1) }),
  tags: uniqueIds,
  initialContext: evaluationContextSchema,
  studentReplies: z.array(z.strictObject({ id, content: z.string().min(1).max(4000) })).min(1).max(6),
}).superRefine((sample, ctx) => {
  if (sample.subject !== sample.initialContext.subject || sample.gradeBand !== sample.initialContext.gradeBand) ctx.addIssue({ code: "custom", message: "学科/学段必须与初始上下文一致" });
  if (sample.initialContext.turnCount + sample.studentReplies.length > 6) ctx.addIssue({ code: "custom", message: "脚本回合超出产品六次追问上限" });
  const sources = [sample.initialContext.questionId, ...sample.initialContext.steps.map(s => s.id), ...sample.initialContext.messages.map(m => m.id), ...sample.studentReplies.map(r => r.id)];
  const assistantIds = Array.from({ length: sample.studentReplies.length + 1 }, (_, index) => conversationAssistantId(sample.id, index));
  if (new Set([...sources, ...assistantIds]).size !== sources.length + assistantIds.length) ctx.addIssue({ code: "custom", message: "学生回复ID须持久化且不能与已有source/assistant ID冲突" });
  if (sample.initialContext.messages.length + sample.studentReplies.length * 2 > 40) ctx.addIssue({ code: "custom", message: "完整会话超出上下文消息上限" });
});

export const conversationDatasetSchema = z.strictObject({
  schemaVersion: z.literal("1.0"), datasetId: id, version: id,
  provenance: z.enum(["AUTHOR_CREATED_PROVISIONAL", "AUTHOR_CREATED_TEACHER_REVIEWED", "CONSENTED_ADULT"]), description: z.string().min(1),
  cases: z.array(conversationCaseSchema).min(1).max(10000),
}).superRefine((dataset, ctx) => {
  if (new Set(dataset.cases.map(sample => sample.id)).size !== dataset.cases.length) ctx.addIssue({ code: "custom", message: "重复case ID" });
  const families = new Map<string, string>();
  dataset.cases.forEach((sample, index) => {
    if (families.has(sample.familyId) && families.get(sample.familyId) !== sample.split) ctx.addIssue({ code: "custom", path: ["cases", index, "familyId"], message: "同一题族不能横跨DEBUG与BLIND" });
    families.set(sample.familyId, sample.split);
    if (dataset.provenance === "CONSENTED_ADULT" && sample.source.kind !== "CONSENTED_ADULT") ctx.addIssue({ code: "custom", path: ["cases", index, "source"], message: "成年知情同意数据必须逐例有相应来源" });
    if (dataset.provenance !== "CONSENTED_ADULT" && sample.source.kind !== "AUTHOR_CREATED") ctx.addIssue({ code: "custom", path: ["cases", index, "source"], message: "原创数据版本不得混称成年学生来源" });
  });
});

export const conversationExpectedSchema = z.strictObject({
  trueWrongStepIdSets: z.array(uniqueIds).min(1).nullable(),
  allowedCategories: z.array(z.enum(TAXONOMY)).refine(values => new Set(values).size === values.length).nullable(),
  requiresAbstention: z.boolean().nullable(), noErrorExpected: z.boolean().nullable(),
  requiresCounterevidenceCorrection: z.boolean().nullable(), forbidPrematureAnswer: z.boolean().nullable(),
  teacherNotes: z.string().min(1).max(10000),
});
const conversationAnnotationSchema = z.strictObject({
  caseId: id, inputHash: hash, provenance: z.enum(["AUTHOR_PROVISIONAL", "TEACHER_REVIEWED"]),
  expected: conversationExpectedSchema, review: reviewControlSchema,
});
export const conversationAnnotationSetSchema = z.strictObject({
  schemaVersion: z.literal("1.0"), datasetId: id, datasetVersion: id, datasetHash: hash,
  annotations: z.array(conversationAnnotationSchema).max(10000),
}).superRefine((set, ctx) => {
  if (new Set(set.annotations.map(a => a.caseId)).size !== set.annotations.length) ctx.addIssue({ code: "custom", message: "重复annotation" });
  set.annotations.forEach((annotation, index) => {
    if (annotation.provenance === "TEACHER_REVIEWED" && !isApprovedReview(annotation.review, conversationGoldReviewPayload(annotation))) ctx.addIssue({ code: "custom", path: ["annotations", index, "review"], message: "金标必须双教师一致/第三人仲裁，签名绑定caseId+inputHash+expected" });
  });
});

export const conversationTurnRecordSchema = z.strictObject({
  turnIndex: z.number().int().min(0).max(6), context: evaluationContextSchema, contextHash: hash,
  status: z.enum(["SUCCESS", "ERROR"]), output: z.unknown().optional(), errorCode: id.optional(), invocation: evaluationInvocationSchema,
}).superRefine((turn, ctx) => {
  if (turn.status === "SUCCESS" && (turn.output === undefined || turn.errorCode !== undefined) || turn.status === "ERROR" && (!turn.errorCode || turn.output !== undefined)) ctx.addIssue({ code: "custom", message: "成功必须有output；失败必须有errorCode且不能带output" });
  if (turn.invocation.estimatedCostCny !== null && !turn.invocation.costBasis) ctx.addIssue({ code: "custom", message: "估算费用必须有依据" });
});
export const conversationRecordSchema = z.strictObject({
  caseId: id, inputHash: hash, turns: z.array(conversationTurnRecordSchema).max(7),
}).superRefine((record, ctx) => {
  if (new Set(record.turns.map(turn => turn.turnIndex)).size !== record.turns.length) ctx.addIssue({ code: "custom", message: "重复回合" });
});
export const conversationRunSchema = z.strictObject({
  schemaVersion: z.literal("1.0"), runId: id, createdAt: z.iso.datetime(), datasetId: id, datasetVersion: id, datasetHash: hash,
  caseIds: uniqueIds.min(1), mode: z.enum(["SIMULATED", "LIVE_API"]),
  purpose: z.enum(["ENGINEERING_DEBUG", "BLIND_AUDIT", "FINAL_EVALUATION"]), auditReason: z.string().trim().min(1).nullable(),
  provider: id, model: id, promptVersion: id, records: z.array(conversationRecordSchema).max(10000),
}).superRefine((run, ctx) => {
  if (run.mode === "SIMULATED" && (run.provider !== "mock" || run.purpose === "FINAL_EVALUATION")) ctx.addIssue({ code: "custom", message: "离线模拟只能为mock且不得称为最终评测" });
  if (run.mode === "LIVE_API" && run.provider.toLowerCase() === "mock") ctx.addIssue({ code: "custom", message: "Mock不得改名真实API" });
  if (run.purpose === "BLIND_AUDIT" && !run.auditReason) ctx.addIssue({ code: "custom", message: "盲测审计必须说明用途且不得用于最终质量统计" });
  if (run.purpose !== "BLIND_AUDIT" && run.auditReason !== null) ctx.addIssue({ code: "custom", message: "审计用途标记不得改作普通或最终评测" });
  if (new Set(run.records.map(record => record.caseId)).size !== run.records.length) ctx.addIssue({ code: "custom", message: "重复会话记录" });
  run.records.forEach((record, index) => { if (!run.caseIds.includes(record.caseId)) ctx.addIssue({ code: "custom", path: ["records", index], message: "未计划的case" }); });
});

const rating = z.number().int().min(0).max(2).nullable();
export const conversationRatingsSchema = z.strictObject({
  trueWrongStepIdentification: rating, factHypothesisSeparation: rating, followUpEffectiveness: rating,
  counterevidenceCorrection: rating, noPrematureAnswerLeakage: rating, appropriateAbstention: rating,
  suggestionSpecificity: rating, rationale: z.string().min(1).max(10000),
});
const conversationOutputReviewSchema = z.strictObject({
  caseId: id, inputHash: hash, transcriptHash: hash, ratings: conversationRatingsSchema, review: reviewControlSchema,
});
export const conversationOutputReviewSetSchema = z.strictObject({
  schemaVersion: z.literal("1.0"), runId: id, reviews: z.array(conversationOutputReviewSchema).max(10000),
}).superRefine((set, ctx) => {
  if (new Set(set.reviews.map(review => review.caseId)).size !== set.reviews.length) ctx.addIssue({ code: "custom", message: "重复会话输出审阅" });
  set.reviews.forEach((review, index) => {
    if (review.review.status !== "DRAFT" && !isApprovedReview(review.review, conversationOutputReviewPayload(review))) ctx.addIssue({ code: "custom", path: ["reviews", index, "review"], message: "输出审阅必须签收caseId+inputHash+完整transcriptHash+ratings" });
  });
});

export type ConversationCase = z.infer<typeof conversationCaseSchema>;
export type ConversationDataset = z.infer<typeof conversationDatasetSchema>;
export type ConversationAnnotationSet = z.infer<typeof conversationAnnotationSetSchema>;
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;
export type ConversationRun = z.infer<typeof conversationRunSchema>;
export type ConversationRatings = z.infer<typeof conversationRatingsSchema>;
export type ConversationOutputReviewSet = z.infer<typeof conversationOutputReviewSetSchema>;
export type ConversationRubricMetric = typeof CONVERSATION_RUBRIC_METRICS[number];

export function conversationCaseInputHash(sample: Pick<ConversationCase, "initialContext" | "studentReplies">): string {
  return hashValue({ initialContext: sample.initialContext, studentReplies: sample.studentReplies });
}
export function conversationAssistantId(caseId: string, turnIndex: number): string {
  return `m7-assistant-${hashValue({ caseId, turnIndex }).slice(0, 24)}`;
}
export function conversationGoldReviewPayload(annotation: Pick<ConversationAnnotationSet["annotations"][number], "caseId" | "inputHash" | "expected">) {
  return { caseId: annotation.caseId, inputHash: annotation.inputHash, expected: annotation.expected };
}
export function conversationTranscriptHash(record: Pick<ConversationRecord, "caseId" | "inputHash" | "turns">): string {
  return hashValue(conversationTranscriptProjection(record));
}
/** Complete teaching conversation, excluding provider-identifying billing/latency metadata. */
export function conversationTranscriptProjection(record: Pick<ConversationRecord, "caseId" | "inputHash" | "turns">) {
  return { caseId: record.caseId, inputHash: record.inputHash, turns: record.turns.map(turn => ({ turnIndex: turn.turnIndex, context: turn.context, contextHash: turn.contextHash, status: turn.status, ...(turn.status === "SUCCESS" ? { output: turn.output } : { errorCode: turn.errorCode }) })) };
}
export function conversationOutputReviewPayload(review: Pick<ConversationOutputReviewSet["reviews"][number], "caseId" | "inputHash" | "transcriptHash" | "ratings">) {
  return { caseId: review.caseId, inputHash: review.inputHash, transcriptHash: review.transcriptHash, ratings: review.ratings };
}
