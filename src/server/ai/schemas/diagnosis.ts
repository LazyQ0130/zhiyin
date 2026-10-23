import { z } from "zod";

export const TAXONOMY = ["READING", "KNOWLEDGE", "APPLICATION", "PLANNING", "EXECUTION", "EXPRESSION", "OTHER", "UNDETERMINED"] as const;
export const findingStateSchema = z.enum(["HYPOTHESIS", "SUPPORTED", "VERIFIED", "REFUTED", "UNRESOLVED"]);
export const evidenceSchema = z.strictObject({
  kind: z.enum(["STUDENT_STEP", "STUDENT_REPLY", "TOOL_RESULT", "QUESTION_TEXT"]),
  sourceId: z.string().min(1).max(160),
  excerpt: z.string().max(2000).optional(),
});
/** Additive 1.0 metadata. Status remains the legacy workflow state, not a measure of causal certainty. */
export const findingTrustSchema = z.strictObject({
  kind: z.enum(["OBSERVATION", "HYPOTHESIS", "VERIFIED", "INCONCLUSIVE"]),
  uncertainties: z.array(z.string().min(1).max(240)).max(12),
  verification: z.strictObject({
    state: z.enum(["NOT_CHECKED", "SUPPORTED", "WEAKENED", "REFUTED", "VERIFIED", "INCONCLUSIVE"]),
    basis: z.enum(["NONE", "STUDENT_REPLY", "DETERMINISTIC_RULE"]),
    evidence: z.array(evidenceSchema).max(12),
  }),
  rootCause: z.strictObject({
    role: z.enum(["INITIAL", "PROPAGATED", "INDEPENDENT", "UNKNOWN"]),
    candidateRootId: z.string().min(1).max(100).nullable(),
    relatedFindingKeys: z.array(z.string().min(1).max(100)).max(8),
    upstreamStepIds: z.array(z.string().min(1).max(160)).max(40),
  }),
});
export type FindingTrust = z.infer<typeof findingTrustSchema>;
export const findingSchema = z.strictObject({
  findingKey: z.string().min(1).max(100),
  category: z.enum(TAXONOMY),
  statement: z.string().min(1).max(1000),
  status: findingStateSchema,
  supportingEvidence: z.array(evidenceSchema).max(12),
  contradictingEvidence: z.array(evidenceSchema).max(12),
  verificationNeeded: z.boolean(),
  trust: findingTrustSchema.optional(),
}).superRefine((finding, ctx) => {
  if (["SUPPORTED", "VERIFIED"].includes(finding.status) && !finding.supportingEvidence.length) {
    ctx.addIssue({code: "custom", message: "有支持/已验证发现必须有支持证据"});
  }
  if (finding.status === "REFUTED" && !finding.contradictingEvidence.length) {
    ctx.addIssue({code: "custom", message: "被反证否定的发现必须有反证"});
  }
  if (finding.status === "VERIFIED" && finding.verificationNeeded) {
    ctx.addIssue({code: "custom", message: "待验证发现不能标记已验证"});
  }
});
export const diagnosisTurnSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  action: z.enum(["ASK_ONE_QUESTION", "REQUEST_INPUT_CORRECTION", "GIVE_HINT", "FINISH_REPORT", "MARK_INCONCLUSIVE"]),
  studentFacingText: z.string().min(1).max(3000),
  referencedStepIds: z.array(z.string().min(1).max(160)).max(40),
  findings: z.array(findingSchema).max(8),
  followUpQuestion: z.string().min(1).max(600).nullable(),
  hintLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  safetyFlags: z.array(z.string().min(1).max(100)).max(12),
}).superRefine((turn, ctx) => {
  if (turn.action === "ASK_ONE_QUESTION") {
    if (!turn.followUpQuestion || (turn.followUpQuestion.match(/[?？]/g)?.length ?? 0) > 1) {
      ctx.addIssue({code: "custom", message: "追问必须只包含一个主要问题"});
    }
    if (turn.hintLevel !== 0) ctx.addIssue({code: "custom", message: "追问不应伪装成独立解答提示"});
  } else if (turn.followUpQuestion !== null) {
    ctx.addIssue({code: "custom", message: "仅追问回合设置 followUpQuestion"});
  }
  if (turn.action === "GIVE_HINT" && turn.hintLevel === 0) ctx.addIssue({code: "custom", message: "提示必须记录非零提示等级"});
  const userText = [turn.studentFacingText, turn.followUpQuestion ?? "", ...turn.findings.map(f => f.statement)].join("\n");
  if (/<\/?(?:script|iframe|object|embed|img|svg|style|a|div|p)(?:\s|>)/i.test(userText)) {
    ctx.addIssue({code: "custom", message: "模型回复不能包含原始 HTML"});
  }
  if (/完全掌握|长期掌握|智力低|你很笨|你基础差/.test(userText)) {
    ctx.addIssue({code: "custom", message: "禁止无证据的长期能力判断"});
  }
});
export type DiagnosisTurn = z.infer<typeof diagnosisTurnSchema>;
export type DiagnosisFinding = z.infer<typeof findingSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type FindingCategory = typeof TAXONOMY[number];

export const recognitionResultSchema = z.strictObject({
  text: z.string().max(12000),
  needsCorrection: z.boolean(),
  warning: z.string().max(1000),
  isDemo: z.boolean(),
});
export type RecognitionResult = z.infer<typeof recognitionResultSchema>;
