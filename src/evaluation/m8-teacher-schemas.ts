import { z } from "zod";
import { conversationExpectedSchema } from "./conversation-schemas";
import { hashValue } from "./schemas";

const id = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const M8_SEMANTIC_DIMENSIONS = ["observationLocation", "causalAttribution", "observationHypothesisSeparation", "hintPollutionControl", "rootCausePropagation", "counterevidenceCorrection", "discriminativeQuestioning", "appropriateAbstention"] as const;
export type M8SemanticDimension = typeof M8_SEMANTIC_DIMENSIONS[number];

export const m8EvidencePositionSchema = z.strictObject({
  sourceId: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), excerpt: z.string().min(1),
}).refine(position => position.end > position.start, "证据区间须非空；下标为UTF-16，左闭右开");
export const m8SourceSchema = z.strictObject({
  sourceId: id, kind: z.enum(["QUESTION", "STUDENT_STEP", "STUDENT_REPLY", "ASSISTANT_MESSAGE", "MODEL_OUTPUT", "EXECUTION_ERROR"]),
  exposure: z.enum(["ORIGINAL_INPUT", "SCRIPTED_NOT_OBSERVED", "ACTUAL_TRANSCRIPT"]), sequence: z.number().int().nonnegative(), text: z.string().min(1), textHash: hash,
});
export const m8GoldSchema = conversationExpectedSchema.extend({
  rootCauseRelations: z.array(z.strictObject({
    stepId: id, role: z.enum(["INITIAL", "PROPAGATED", "INDEPENDENT", "UNKNOWN"]), candidateRootStepId: id.nullable(),
    upstreamStepIds: z.array(id), rationale: z.string().min(1), evidence: z.array(m8EvidencePositionSchema).min(1),
  })).nullable(),
});
export const m8DimensionRatingSchema = z.strictObject({
  score: z.number().int().min(0).max(2).nullable(), rationale: z.string().max(10000), evidence: z.array(m8EvidencePositionSchema).max(30),
}).superRefine((rating, ctx) => {
  if (rating.score !== null && (!rating.rationale.trim() || rating.evidence.length === 0)) ctx.addIssue({ code: "custom", message: "人工评分须给出理由和可定位证据" });
});
export const m8RatingsSchema = z.strictObject({
  observationLocation: m8DimensionRatingSchema, causalAttribution: m8DimensionRatingSchema,
  observationHypothesisSeparation: m8DimensionRatingSchema, hintPollutionControl: m8DimensionRatingSchema,
  rootCausePropagation: m8DimensionRatingSchema, counterevidenceCorrection: m8DimensionRatingSchema,
  discriminativeQuestioning: m8DimensionRatingSchema, appropriateAbstention: m8DimensionRatingSchema,
});
export const m8TeacherCaseReviewSchema = z.strictObject({
  caseId: id, inputHash: hash, transcriptHash: hash.nullable(), gold: m8GoldSchema.nullable(), ratings: m8RatingsSchema.nullable(),
});
export const m8TeacherFormSchema = z.strictObject({
  schemaVersion: z.literal("M8.1"), packetId: id, packetHash: hash, reviewerSlot: z.enum(["A", "B"]),
  reviewKind: z.enum(["INPUT_GOLD", "OUTPUT_RUBRIC"]), reviewerPseudonym: id.nullable(), reviewedAt: z.iso.datetime().nullable(),
  status: z.enum(["DRAFT_UNSIGNED", "SUBMITTED"]), signature: z.string().max(10000), cases: z.array(m8TeacherCaseReviewSchema).min(1),
}).superRefine((form, ctx) => {
  if (new Set(form.cases.map(row => row.caseId)).size !== form.cases.length) ctx.addIssue({ code: "custom", message: "重复case" });
  if (form.status === "SUBMITTED" && (!form.reviewerPseudonym || !form.reviewedAt)) ctx.addIssue({ code: "custom", message: "提交须填写实际教师匿名标识和审阅时间" });
  form.cases.forEach((row, index) => {
    if (form.reviewKind === "INPUT_GOLD" ? row.gold === null || row.ratings !== null || row.transcriptHash !== null : row.gold !== null || row.ratings === null || row.transcriptHash === null) ctx.addIssue({ code: "custom", path: ["cases", index], message: "输入标签与会话量表必须分开审核" });
  });
});
export const m8TeacherPacketSchema = z.strictObject({
  schemaVersion: z.literal("M8.1"), packetId: id, reviewerSlot: z.enum(["A", "B"]), reviewKind: z.enum(["INPUT_GOLD", "OUTPUT_RUBRIC"]),
  datasetId: id, datasetVersion: id, datasetHash: hash, runId: id.nullable(), status: z.literal("PROVISIONAL"),
  sourceKind: z.enum(["AUTHOR_CREATED", "CONSENTED_ADULT"]), rules: z.array(z.string().min(1)),
  cases: z.array(z.strictObject({ caseId: id, inputHash: hash, transcriptHash: hash.nullable(), subject: id, gradeBand: id, sources: z.array(m8SourceSchema).min(1), transcript: z.unknown().nullable() })).min(1),
}).superRefine((packet, ctx) => {
  if (new Set(packet.cases.map(row => row.caseId)).size !== packet.cases.length) ctx.addIssue({ code: "custom", message: "重复packet case" });
  packet.cases.forEach((row, index) => {
    if (new Set(row.sources.map(source => source.sourceId)).size !== row.sources.length || row.sources.some((source, sourceIndex) => source.textHash !== hashValue(source.text) || source.sequence !== sourceIndex)) ctx.addIssue({ code: "custom", path: ["cases", index, "sources"], message: "证据source标识/顺序/文本hash不一致" });
    if (packet.reviewKind === "INPUT_GOLD" ? row.transcript !== null || row.transcriptHash !== null : row.transcript === null || row.transcriptHash !== hashValue(row.transcript)) ctx.addIssue({ code: "custom", path: ["cases", index, "transcript"], message: "完整会话hash或审核阶段不一致" });
  });
});
export type M8TeacherPacket = z.infer<typeof m8TeacherPacketSchema>;
export type M8TeacherForm = z.infer<typeof m8TeacherFormSchema>;
export type M8TeacherCaseReview = z.infer<typeof m8TeacherCaseReviewSchema>;

// A byte hash is not a signature. Only a separately completed human source audit
// can assert that an actual teacher signed the bound original document.
export const m8SignedSourceArtifactSchema = z.strictObject({
  schemaVersion: z.literal("M8.1"), packet: m8TeacherPacketSchema, submission: m8TeacherFormSchema, submissionHash: hash,
  signedSource: z.strictObject({ sourceHash: hash, byteLength: z.number().int().positive(), mediaType: id }),
  humanAudit: z.strictObject({ state: z.enum(["PENDING_HUMAN_AUDIT", "HUMAN_VERIFIED"]), verifierPseudonym: id.nullable(), verifiedAt: z.iso.datetime().nullable(), boundSubmissionHash: hash.nullable(), actualTeacherAndSignatureConfirmed: z.boolean(), auditNote: z.string().max(10000) }),
}).superRefine((artifact, ctx) => {
  if (artifact.submissionHash !== hashValue(artifact.submission)) ctx.addIssue({ code: "custom", message: "原始审阅内容hash不匹配" });
  if (artifact.submission.packetHash !== hashValue(artifact.packet) || artifact.submission.packetId !== artifact.packet.packetId || artifact.submission.reviewerSlot !== artifact.packet.reviewerSlot || artifact.submission.reviewKind !== artifact.packet.reviewKind) ctx.addIssue({ code: "custom", message: "完整原始packet绑定不匹配" });
  if (artifact.humanAudit.state === "HUMAN_VERIFIED" && (!artifact.humanAudit.verifierPseudonym || !artifact.humanAudit.verifiedAt || artifact.humanAudit.boundSubmissionHash !== artifact.submissionHash || !artifact.humanAudit.actualTeacherAndSignatureConfirmed || !artifact.humanAudit.auditNote.trim() || artifact.submission.status !== "SUBMITTED")) ctx.addIssue({ code: "custom", message: "实际签署来源必须由人工核实并绑定完整原始审阅；程序不能认证身份" });
});
export type M8SignedSourceArtifact = z.infer<typeof m8SignedSourceArtifactSchema>;

export const m8ReviewDecisionSchema = z.strictObject({
  schemaVersion: z.literal("M8.1"), reviewKind: z.enum(["INPUT_GOLD", "OUTPUT_RUBRIC"]), caseId: id, inputHash: hash, transcriptHash: hash.nullable(),
  state: z.enum(["DRAFT_ADJUDICATION", "AGREED", "ADJUDICATED"]), originals: z.tuple([m8SignedSourceArtifactSchema, m8SignedSourceArtifactSchema]),
  final: m8TeacherCaseReviewSchema.nullable(),
  adjudication: z.strictObject({ reviewerPseudonym: id, reason: z.string().trim().min(1), reviewedAt: z.iso.datetime().nullable(), signature: z.string(), signedSourceHash: hash.nullable(), signedSourceByteLength: z.number().int().positive().nullable(), humanAudit: z.enum(["PENDING_HUMAN_AUDIT", "HUMAN_VERIFIED"]), verifierPseudonym: id.nullable(), verifiedAt: z.iso.datetime().nullable(), adjudicationPayloadHash: hash.nullable(), actualTeacherAndSignatureConfirmed: z.boolean() }).nullable(),
});
export type M8ReviewDecision = z.infer<typeof m8ReviewDecisionSchema>;
export function m8CaseReviewPayload(row: M8TeacherCaseReview) { return { caseId: row.caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash, gold: row.gold, ratings: row.ratings }; }
