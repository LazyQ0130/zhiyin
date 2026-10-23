import { z } from "zod";
import { CONVERSATION_SCENARIOS, conversationCaseInputHash, conversationDatasetSchema } from "./conversation-schemas";
import { hashValue } from "./schemas";
import { buildM8TeacherPackets, renderM8TeacherPacket, validateM8TeacherForm } from "./m8-teacher";
import { m8EvidencePositionSchema, m8TeacherPacketSchema, type M8TeacherPacket } from "./m8-teacher-schemas";

export const M9_FROZEN_PARENT = {
  datasetId: "m7-math-author-created-candidates", version: "2026-10-23.2",
  datasetHash: "241f0a5821f7310d5a8073a48af83af31d8fb9b0369a23875a6e59c35a6b707e",
  manifestFileHash: "5c2c2df555033775eccad74aedba39752bc1e49a35c55bd2ce66717ee4623d36",
} as const;
export const M9_PILOT_CASE_IDS = ["m7-d01", "m7-d04", "m7-d05", "m7-d08", "m7-d09", "m7-d13", "m7-d16", "m7-d19", "m7-d22", "m7-d23"] as const;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(10000);
const actualMinutes = z.number().nonnegative().finite().nullable();
const effort = z.number().int().min(1).max(5).nullable();
const humanRef = z.string().trim().min(1).max(2000).nullable();
export const m9PilotUsabilitySchema = z.strictObject({
  schemaVersion: z.literal("M9.1"), purpose: z.literal("TEACHER_USABILITY_PILOT"),
  state: z.literal("UNSIGNED_SELF_REPORT"), packetId: z.string().min(1), packetHash: hash, reviewerSlot: z.enum(["A", "B"]),
  reviewerPseudonym: z.string().trim().min(1).max(160).nullable(),
  actualStartedAt: z.iso.datetime().nullable(), actualFinishedAt: z.iso.datetime().nullable(), actualMinutes,
  actualEffort1To5: effort, completedIndependently: z.boolean().nullable(),
  understoodInstructionsWithoutHelp: z.boolean().nullable(), overallNotes: text,
  cases: z.array(z.strictObject({
    caseId: z.string().min(1), inputHash: hash,
    independentInterpretation: text, observationEvidence: z.array(m8EvidencePositionSchema),
    usableWithoutClarification: z.boolean().nullable(), ambiguousEvidence: z.boolean().nullable(), ambiguityNotes: text,
    ambiguityEvidence: z.array(m8EvidencePositionSchema), actualMinutes, actualEffort1To5: effort,
    dissentNotes: text, requestsThirdPartyReview: z.boolean().nullable(),
    dissentRecordRef: humanRef, thirdPartyArbitrationRef: humanRef,
  }).superRefine((row, ctx) => {
    if (row.ambiguousEvidence === true && !row.ambiguityNotes.trim()) ctx.addIssue({ code: "custom", message: "歧义标记须说明歧义或缺失证据；缺失的原文不可编造引文" });
  })).length(10),
}).superRefine((form, ctx) => {
  if (new Set(form.cases.map(row => row.caseId)).size !== form.cases.length) ctx.addIssue({ code: "custom", message: "重复试标案例" });
  if (form.actualStartedAt && form.actualFinishedAt && Date.parse(form.actualFinishedAt) < Date.parse(form.actualStartedAt)) ctx.addIssue({ code: "custom", message: "实际结束时间不能早于开始时间" });
});
export type M9PilotUsability = z.infer<typeof m9PilotUsabilitySchema>;

/** The frozen author scenario is selection metadata, never a teacher answer. */
export function buildM9Pilot(parentValue: unknown) {
  const parent = conversationDatasetSchema.parse(parentValue);
  if (parent.datasetId !== M9_FROZEN_PARENT.datasetId || parent.version !== M9_FROZEN_PARENT.version || hashValue(parent) !== M9_FROZEN_PARENT.datasetHash) throw new Error("M9_FROZEN_PARENT_MISMATCH");
  const cases = M9_PILOT_CASE_IDS.map(caseId => {
    const sample = parent.cases.find(row => row.id === caseId);
    if (!sample || sample.split !== "DEBUG" || sample.reviewStatus !== "PROVISIONAL" || sample.source.kind !== "AUTHOR_CREATED") throw new Error("M9_DEV_PROVISIONAL_SELECTION_REQUIRED");
    return structuredClone(sample);
  });
  const scenarioCounts = Object.fromEntries(CONVERSATION_SCENARIOS.map(scenario => [scenario, cases.filter(sample => sample.scenarioType === scenario).length]));
  if (Object.values(scenarioCounts).some(count => count === 0)) throw new Error("M9_ALL_SEVEN_AUTHOR_SCENARIOS_REQUIRED");
  const dataset = conversationDatasetSchema.parse({
    schemaVersion: "1.0", datasetId: "m9-math-dev-teacher-usability-pilot", version: "2026-10-23.1",
    provenance: "AUTHOR_CREATED_PROVISIONAL", description: "M9 DEV-only 10-case teacher usability pilot; PENDING_HUMAN_REVIEW; never formal gold. M7 case objects and inputHash preserved.", cases,
  });
  const selection = cases.map(sample => ({ caseId: sample.id, inputHash: conversationCaseInputHash(sample), originalSplit: "DEBUG" as const, operationalSplit: "DEV" as const, authorScenarioType: sample.scenarioType }));
  return { dataset, selection, scenarioCounts, parentDatasetHash: hashValue(parent), childDatasetHash: hashValue(dataset) };
}

export function buildM9PilotUsability(packetValue: unknown): M9PilotUsability {
  const packet = m8TeacherPacketSchema.parse(packetValue);
  if (packet.reviewKind !== "INPUT_GOLD" || packet.cases.length !== 10) throw new Error("M9_TEN_INPUT_CASES_REQUIRED");
  return m9PilotUsabilitySchema.parse({
    schemaVersion: "M9.1", purpose: "TEACHER_USABILITY_PILOT", state: "UNSIGNED_SELF_REPORT",
    packetId: packet.packetId, packetHash: hashValue(packet), reviewerSlot: packet.reviewerSlot,
    reviewerPseudonym: null, actualStartedAt: null, actualFinishedAt: null, actualMinutes: null, actualEffort1To5: null,
    completedIndependently: null, understoodInstructionsWithoutHelp: null, overallNotes: "",
    cases: packet.cases.map(row => ({
      caseId: row.caseId, inputHash: row.inputHash, independentInterpretation: "", observationEvidence: [],
      usableWithoutClarification: null, ambiguousEvidence: null, ambiguityNotes: "", ambiguityEvidence: [],
      actualMinutes: null, actualEffort1To5: null, dissentNotes: "", requestsThirdPartyReview: null,
      dissentRecordRef: null, thirdPartyArbitrationRef: null,
    })),
  });
}

export function buildM9PilotPackets(parentValue: unknown) {
  const pilot = buildM9Pilot(parentValue), packets = buildM8TeacherPackets(pilot.dataset);
  return { ...pilot, reviewers: {
    A: { ...packets.A, usability: buildM9PilotUsability(packets.A.packet) },
    B: { ...packets.B, usability: buildM9PilotUsability(packets.B.packet) },
  } };
}

export function validateM9PilotPacket(datasetValue: unknown, packetValue: unknown, formValue: unknown, usabilityValue: unknown) {
  const dataset = conversationDatasetSchema.parse(datasetValue);
  if (dataset.provenance !== "AUTHOR_CREATED_PROVISIONAL" || dataset.cases.length !== 10 || dataset.cases.some(sample => sample.split !== "DEBUG" || sample.reviewStatus !== "PROVISIONAL")) throw new Error("M9_DEV_PROVISIONAL_SELECTION_REQUIRED");
  const { packet, form } = validateM8TeacherForm(packetValue, formValue);
  const expected = buildM8TeacherPackets(dataset)[packet.reviewerSlot].packet;
  if (hashValue({ ...packet, packetId: expected.packetId }) !== hashValue(expected)) throw new Error("M9_PACKET_CHILD_BINDING_MISMATCH");
  const usability = m9PilotUsabilitySchema.parse(usabilityValue);
  if (usability.packetId !== packet.packetId || usability.packetHash !== hashValue(packet) || usability.reviewerSlot !== packet.reviewerSlot) throw new Error("M9_USABILITY_PACKET_BINDING_MISMATCH");
  if (usability.cases.length !== packet.cases.length) throw new Error("M9_USABILITY_COVERAGE_MISMATCH");
  for (const row of usability.cases) {
    const sample = packet.cases.find(sample => sample.caseId === row.caseId);
    if (!sample || row.inputHash !== sample.inputHash) throw new Error("M9_USABILITY_CASE_BINDING_MISMATCH");
    for (const position of [...row.observationEvidence, ...row.ambiguityEvidence]) {
      const source = sample.sources.find(source => source.sourceId === position.sourceId);
      if (!source || position.end > source.text.length || source.text.slice(position.start, position.end) !== position.excerpt) throw new Error("M9_USABILITY_EVIDENCE_POSITION_MISMATCH");
    }
  }
  return { packet, form, usability, formalGold: false as const, humanVerificationPerformed: false as const };
}

export function renderM9PilotPacket(packet: M8TeacherPacket): string {
  return ["# M9 教师试标：10例 DEV 可用性材料", "",
    "状态：PROVISIONAL / PENDING_HUMAN_REVIEW。INPUT_GOLD 是复用表的技术名称，本次试标不是正式金标。",
    "先独立解题并写出自己的解释，再填写review.form.json；填写usability.form.json记录材料理解、歧义及实际耗时。",
    "不要查阅作者标签或其他教师意见。脚本学生回复不是已发生互动；本包没有模型输出。",
    "原文证据采用UTF-16下标[start,end)，不是UTF-8字节或汉字计数；例如A😀中长度为4，中位于[3,4)。",
    "耗时、难度、匿名身份、签署都由实际教师填写；程序留空。1=很轻松，5=非常费力。",
    "保留分歧原文；需要第三人时记录requestsThirdPartyReview。原意见和仲裁原件由负责人独立保管。",
    "", renderM8TeacherPacket(packet),
  ].join("\n");
}

export function renderM9PilotChecklist(): string {
  return ["# 试标可用性清单（全部由实际教师填写）", "",
    "- [ ] 能独立理解操作说明，并记录是否接受他人帮助。", "- [ ] 先自行解题、逐例写independentInterpretation，区分观察与原因假设。",
    "- [ ] 正确步骤不硬造错误；证据不足写未知，指出缺失证据。", "- [ ] 对歧义填写ambiguousEvidence和ambiguityNotes；现有原文附sourceId/start/end/excerpt，缺失原文不造引文。",
    "- [ ] 区分SCRIPTED_NOT_OBSERVED与实际互动；提示后正确不能自动表示独立掌握。",
    "- [ ] 填实际开始/结束时间、分钟数及1–5费力度；本工具不估算人工耗时。",
    "- [ ] 保留异议并说明是否请求第三人；dissentRecordRef/thirdPartyArbitrationRef仅在实际原件存在后填写。",
    "- [ ] 不查看另一位教师的表；签名只由实际教师签署，身份资料私下交负责人。", "",
    "UTF-16示例：A😀中，A=[0,1)，😀=[1,3)，中=[3,4)。JSON中的换行转义解析后算一个字符；不得按屏幕换行计数。",
    "本清单与JSON同义，实际填写以usability.form.json为准。返回本人的完整目录；原件不覆盖。",
  ].join("\n") + "\n";
}
