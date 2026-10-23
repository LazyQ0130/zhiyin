import { z } from "zod";
import { m8EvidencePositionSchema, m8ReviewDecisionSchema, m8SignedSourceArtifactSchema, m8TeacherPacketSchema } from "./m8-teacher-schemas";
import { hashValue } from "./schemas";

const id = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const M9_CASE_MEASURES = ["conclusionCoverage", "reasonableAbstention", "unreasonableAbstention", "erroneousCausalAttribution", "duplicateRoots", "effectiveQuestioning", "usefulNextStepAdvice"] as const;
export type M9CaseMeasure = typeof M9_CASE_MEASURES[number];

// Applicability is a separate educational judgment. Neither false nor unknown
// applicability may be silently turned into a negative outcome.
export const m9CaseCodeSchema = z.strictObject({
  applicable: z.boolean().nullable(), outcome: z.boolean().nullable(), rationale: z.string().max(10000), evidence: z.array(m8EvidencePositionSchema).max(30),
}).superRefine((code, ctx) => {
  if (code.applicable !== true && code.outcome !== null) ctx.addIssue({ code: "custom", message: "不适用/未知不得编码结果" });
  if ((code.applicable !== null || code.outcome !== null) && (!code.rationale.trim() || !code.evidence.length)) ctx.addIssue({ code: "custom", message: "适用性和结果须有独立人工理由及原文证据" });
});
const codes = z.strictObject({
  conclusionCoverage: m9CaseCodeSchema, reasonableAbstention: m9CaseCodeSchema, unreasonableAbstention: m9CaseCodeSchema,
  erroneousCausalAttribution: m9CaseCodeSchema, duplicateRoots: m9CaseCodeSchema, effectiveQuestioning: m9CaseCodeSchema, usefulNextStepAdvice: m9CaseCodeSchema,
});
export const m9SupplementalCaseSchema = z.strictObject({
  caseId: id, inputHash: hash, transcriptHash: hash,
  codes,
  helpTurns: z.array(z.strictObject({ turnIndex: z.number().int().nonnegative(), actualHelpLevel: z.number().int().min(0).max(3).nullable(), rationale: z.string().max(10000), evidence: z.array(m8EvidencePositionSchema).max(30) })).max(7),
}).superRefine((row, ctx) => {
  if (new Set(row.helpTurns.map(turn => turn.turnIndex)).size !== row.helpTurns.length) ctx.addIssue({ code: "custom", message: "重复帮助回合" });
  row.helpTurns.forEach((turn, index) => {
    if (turn.actualHelpLevel !== null && (!turn.rationale.trim() || !turn.evidence.length)) ctx.addIssue({ code: "custom", path: ["helpTurns", index], message: "实际帮助等级须由人工给出理由及本回合可见内容证据" });
  });
});
export const m9SupplementalPacketSchema = z.strictObject({
  schemaVersion: z.literal("M9.1"), specificationHash: hash, rules: z.array(z.string().min(1)).min(1),
  // Reuse M8's immutable, author-label-free input/transcript source projection.
  m8Packet: m8TeacherPacketSchema,
}).refine(packet => packet.m8Packet.reviewKind === "OUTPUT_RUBRIC", "补充表必须绑定实际会话输出包");
export const m9SupplementalFormSchema = z.strictObject({
  schemaVersion: z.literal("M9.1"), packetHash: hash, packetId: id, reviewerSlot: z.enum(["A", "B"]),
  reviewerPseudonym: id.nullable(), reviewedAt: z.iso.datetime().nullable(), status: z.enum(["DRAFT_UNSIGNED", "SUBMITTED"]), signature: z.string().max(10000),
  cases: z.array(m9SupplementalCaseSchema).min(1),
}).superRefine((form, ctx) => {
  if (new Set(form.cases.map(row => row.caseId)).size !== form.cases.length) ctx.addIssue({ code: "custom", message: "重复case" });
  if (form.status === "SUBMITTED" && (!form.reviewerPseudonym || !form.reviewedAt)) ctx.addIssue({ code: "custom", message: "提交须实际教师匿名标识与时间" });
});
export const m9SupplementalArtifactSchema = z.strictObject({
  schemaVersion: z.literal("M9.1"), packet: m9SupplementalPacketSchema, submission: m9SupplementalFormSchema, submissionHash: hash,
  signedSource: m8SignedSourceArtifactSchema.shape.signedSource,
  humanAudit: m8SignedSourceArtifactSchema.shape.humanAudit,
}).superRefine((artifact, ctx) => {
  if (artifact.submissionHash !== hashValue(artifact.submission) || artifact.submission.packetHash !== hashValue(artifact.packet) || artifact.submission.packetId !== artifact.packet.m8Packet.packetId || artifact.submission.reviewerSlot !== artifact.packet.m8Packet.reviewerSlot) ctx.addIssue({ code: "custom", message: "M9完整原始补充表/packet hash绑定不匹配" });
  const audit = artifact.humanAudit;
  if (audit.state === "HUMAN_VERIFIED" && (!audit.verifierPseudonym || !audit.verifiedAt || audit.boundSubmissionHash !== artifact.submissionHash || !audit.actualTeacherAndSignatureConfirmed || !audit.auditNote.trim() || artifact.submission.status !== "SUBMITTED")) ctx.addIssue({ code: "custom", message: "必须人工核实实际教师/签署原件并绑定完整补充表；布尔值不能解锁" });
});
export const m9SupplementalDecisionSchema = z.strictObject({
  schemaVersion: z.literal("M9.1"), caseId: id, inputHash: hash, transcriptHash: hash,
  state: z.enum(["DRAFT_ADJUDICATION", "AGREED", "ADJUDICATED"]), originals: z.tuple([m9SupplementalArtifactSchema, m9SupplementalArtifactSchema]),
  final: m9SupplementalCaseSchema.nullable(), adjudication: m8ReviewDecisionSchema.shape.adjudication,
});
export type M9SupplementalPacket = z.infer<typeof m9SupplementalPacketSchema>;
export type M9SupplementalForm = z.infer<typeof m9SupplementalFormSchema>;
export type M9SupplementalCase = z.infer<typeof m9SupplementalCaseSchema>;
export type M9SupplementalArtifact = z.infer<typeof m9SupplementalArtifactSchema>;
export type M9SupplementalDecision = z.infer<typeof m9SupplementalDecisionSchema>;
