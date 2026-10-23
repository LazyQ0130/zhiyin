import { createHash } from "node:crypto";
import { conversationCaseInputHash, type ConversationDataset } from "../../src/evaluation/conversation-schemas";
import { M9_RULE_FILES } from "../../src/evaluation/m9-live-plan";
import { buildM8TeacherPackets, createM8AgreementDecision } from "../../src/evaluation/m8-teacher";
import { m8SignedSourceArtifactSchema, type M8SignedSourceArtifact } from "../../src/evaluation/m8-teacher-schemas";
import { m9MultiPermitSchema, type M9MultiBinding } from "../../src/evaluation/m9-multi-permit";
import { DIAGNOSIS_PROMPT_VERSION } from "../../src/server/ai/prompts/diagnosis-v1";
import { hashValue } from "../../src/evaluation/schemas";

export const M9_UNIT_NOW = new Date("2026-10-23T14:00:00.000Z");

/** In-memory software fixtures. No actual person, signature, review, permission,
 * signed original or network call exists; these flags exercise validation only. */
export function m9MultiUnitFixture(caseCount = 1) {
  const dataset: ConversationDataset = {
    schemaVersion: "1.0", datasetId: "UNIT_M9_NO_REAL_DATA", version: "UNIT_REVIEWED_2", provenance: "AUTHOR_CREATED_TEACHER_REVIEWED", description: "UNIT software fixture only; no humans reviewed anything",
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `UNIT_CASE_${index}`, familyId: `UNIT_FAMILY_${index}`, subject: "MATH", gradeBand: "GRADE_7_9", split: "DEBUG", reviewStatus: "TEACHER_REVIEWED", scenarioType: "calculation_error", tags: [],
      source: { kind: "AUTHOR_CREATED", reference: "UNIT_AUTHOR_CREATED", license: "UNIT_ONLY" },
      initialContext: { questionId: `UNIT_Q_${index}`, questionText: "计算2+3。", subject: "MATH", gradeBand: "GRADE_7_9", steps: [{ id: `UNIT_S_${index}`, text: "2+3=6" }], messages: [], findings: [], turnCount: 0, hintLevel: 0 },
      studentReplies: [{ id: `UNIT_REPLY_${index}`, content: "UNIT预设回答，不是已发生互动。" }, { id: `UNIT_REPLY_B_${index}`, content: "UNIT第二个预设回答。" }],
    })),
  };
  const packets = buildM8TeacherPackets(dataset);
  const signedSourceBytes = [Buffer.from("UNIT_SYNTHETIC_A_NO_REAL_SIGNATURE"), Buffer.from("UNIT_SYNTHETIC_B_NO_REAL_SIGNATURE")];
  const originals = (["A", "B"] as const).map((slot, index) => {
    const submission = { ...packets[slot].form, status: "SUBMITTED" as const, reviewerPseudonym: `UNIT_${slot}_NOT_A_PERSON`, reviewedAt: M9_UNIT_NOW.toISOString(), signature: "UNIT_NOT_A_SIGNATURE" };
    return m8SignedSourceArtifactSchema.parse({
      schemaVersion: "M8.1", packet: packets[slot].packet, submission, submissionHash: hashValue(submission),
      signedSource: { sourceHash: createHash("sha256").update(signedSourceBytes[index]).digest("hex"), byteLength: signedSourceBytes[index].length, mediaType: "UNIT_ONLY" },
      humanAudit: { state: "HUMAN_VERIFIED", verifierPseudonym: "UNIT_VERIFIER_NOT_A_PERSON", verifiedAt: M9_UNIT_NOW.toISOString(), boundSubmissionHash: hashValue(submission), actualTeacherAndSignatureConfirmed: true, auditNote: "UNIT simulated flags; no human audit happened" },
    });
  }) as [M8SignedSourceArtifact, M8SignedSourceArtifact];
  const teacherGoldDecisions = dataset.cases.map(sample => createM8AgreementDecision(...originals, sample.id));
  const sourceHashes = Object.fromEntries(M9_RULE_FILES.map(file => [file, hashValue(`UNIT:${file}`)]));
  const caseIds = dataset.cases.map(sample => sample.id);
  const binding: M9MultiBinding = { dataset, caseIds, sourceHashes, teacherGoldDecisions, signedSourceBytes };
  const permit = m9MultiPermitSchema.parse({
    schemaVersion: "M9.MULTI.1", authorizationId: "6aa83237-b96f-4977-9dd7-367208837d82", approved: true, approvedBy: "UNIT_NOT_OPERATOR_PERMISSION",
    issuedAt: "2026-10-23T13:00:00.000Z", expiresAt: "2026-10-23T15:00:00.000Z", datasetHash: hashValue(dataset), caseIds,
    caseInputHashes: Object.fromEntries(dataset.cases.map(sample => [sample.id, conversationCaseInputHash(sample)])), teacherGoldDecisionHashes: Object.fromEntries(teacherGoldDecisions.map(decision => [decision.caseId, hashValue(decision)])),
    model: "qwen3.8-flash", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", region: "cn-beijing", promptVersion: DIAGNOSIS_PROMPT_VERSION, trustPolicyVersion: "M8.1", sourceHashes,
    maxTurnsPerSession: 3, maxRequests: caseCount * 3, maxSpendCny: 8, maxCompletionTokens: 2500, maxRequestBytes: 200000, timeoutMs: 25000, maxRetries: 0, concurrency: 1,
    pricing: { currency: "CNY", inputPerMillion: 0.8, outputPerMillion: 2.7, source: "https://help.aliyun.com/zh/model-studio/qwen3-8-flash", verifiedAt: M9_UNIT_NOW.toISOString(), region: "cn-beijing", maximumModelInputTokens: 991808, completionToleranceTokens: 10, discountAssumed: false },
  });
  return { dataset, binding, permit, teacherGoldDecisions, originals, signedSourceBytes, sourceHashes };
}
