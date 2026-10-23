import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVERSATION_SCENARIOS, conversationCaseInputHash, type ConversationDataset } from "../../src/evaluation/conversation-schemas";
import { hashValue } from "../../src/evaluation/schemas";
import { buildM8TeacherPackets } from "../../src/evaluation/m8-teacher";
import { buildM9Pilot, buildM9PilotPackets, buildM9PilotUsability, M9_FROZEN_PARENT, M9_PILOT_CASE_IDS, renderM9PilotChecklist, renderM9PilotPacket, validateM9PilotPacket } from "../../src/evaluation/m9-pilot";

// Every fabricated record is explicitly UNIT_FIXTURE; no people, signatures,
// or human-review claims. Frozen M7 is author-created source, read-only below.
const frozenBytes = readFileSync(new URL("../evaluation/m7/math-candidates.inputs.json", import.meta.url), "utf8");
const frozenParent = () => JSON.parse(frozenBytes) as ConversationDataset;
function fixtureDataset(): ConversationDataset {
  return { schemaVersion: "1.0", datasetId: "UNIT_FIXTURE_M9_DEV", version: "UNIT_FIXTURE_1", provenance: "AUTHOR_CREATED_PROVISIONAL", description: "UNIT_FIXTURE_ONLY; no real student or teacher", cases: Array.from({ length: 10 }, (_, index) => ({
    id: `UNIT_FIXTURE_${index}`, familyId: `UNIT_FIXTURE_FAMILY_${index}`, subject: "MATH" as const, gradeBand: "GRADE_7_9",
    split: "DEBUG" as const, reviewStatus: "PROVISIONAL" as const, scenarioType: CONVERSATION_SCENARIOS[index % CONVERSATION_SCENARIOS.length],
    source: { kind: "AUTHOR_CREATED" as const, reference: "UNIT_FIXTURE_ONLY", license: "UNIT_FIXTURE_ONLY" }, tags: ["UNIT_FIXTURE_AUTHOR_LABEL_MUST_NOT_LEAK"],
    initialContext: { questionId: `UNIT_FIXTURE_Q_${index}`, questionText: "A😀中", subject: "MATH" as const, gradeBand: "GRADE_7_9", steps: [{ id: `UNIT_FIXTURE_S_${index}`, text: "UNIT_FIXTURE 2+3=6" }], messages: [], findings: [], turnCount: 0, hintLevel: 0 },
    studentReplies: [{ id: `UNIT_FIXTURE_R_${index}`, content: "UNIT_FIXTURE 预设回复，未真实发生。" }],
  })) };
}
function fixture() {
  const dataset = fixtureDataset(), packets = buildM8TeacherPackets(dataset);
  return { dataset, ...packets.A, usability: buildM9PilotUsability(packets.A.packet), other: packets.B };
}
function validate(value: ReturnType<typeof fixture>) { return validateM9PilotPacket(value.dataset, value.packet, value.form, value.usability); }

describe("M9 DEV teacher usability pilot", () => {
  it("selects exactly ten DEV cases, covers seven author scenarios, preserves every original input and parent", () => {
    const parent = frozenParent(), before = hashValue(parent), pilot = buildM9Pilot(parent);
    expect(pilot.selection.map(row => row.caseId)).toEqual(M9_PILOT_CASE_IDS);
    expect(pilot.dataset.datasetId).not.toBe(parent.datasetId);
    expect(pilot.dataset.version).not.toBe(parent.version);
    expect(pilot.parentDatasetHash).toBe(M9_FROZEN_PARENT.datasetHash);
    expect(pilot.childDatasetHash).not.toBe(pilot.parentDatasetHash);
    expect(pilot.scenarioCounts).toEqual({ correct: 2, calculation_error: 2, conceptual_error: 1, method_error: 1, multiple_errors: 1, insufficient_evidence: 1, student_counterevidence: 2 });
    for (const sample of pilot.dataset.cases) {
      const original = parent.cases.find(row => row.id === sample.id)!;
      expect(sample).toEqual(original); expect(sample).not.toBe(original);
      expect(sample.split).toBe("DEBUG");
      expect(conversationCaseInputHash(sample)).toBe(conversationCaseInputHash(original));
    }
    expect(hashValue(parent)).toBe(before);
    expect(readFileSync(new URL("../evaluation/m7/math-candidates.inputs.json", import.meta.url), "utf8")).toBe(frozenBytes);
    expect(pilot.dataset.provenance).toBe("AUTHOR_CREATED_PROVISIONAL");
  });

  it("refuses a changed frozen parent, including relabelling a BLIND source as DEV", () => {
    const changed = frozenParent(); changed.cases[0].initialContext.questionText += "UNIT_FIXTURE_TAMPER";
    expect(() => buildM9Pilot(changed)).toThrow("M9_FROZEN_PARENT_MISMATCH");
    const leaked = frozenParent(); leaked.cases.find(row => row.split === "BLIND")!.split = "DEBUG";
    expect(() => buildM9Pilot(leaked)).toThrow("M9_FROZEN_PARENT_MISMATCH");
    expect(() => buildM9Pilot(fixtureDataset())).toThrow("M9_FROZEN_PARENT_MISMATCH");
  });

  it("reuses independent M8 blank packets and excludes all author scenario labels", () => {
    const pilot = buildM9PilotPackets(frozenParent());
    expect(pilot.reviewers.A.packet.packetId).not.toBe(pilot.reviewers.B.packet.packetId);
    expect(hashValue(pilot.reviewers.A.packet.cases)).toBe(hashValue(pilot.reviewers.B.packet.cases));
    for (const slot of ["A", "B"] as const) {
      const reviewer = pilot.reviewers[slot], serialized = JSON.stringify(reviewer);
      for (const key of ["scenarioType", "authorScenarioType", "familyId", "tags", "allowedAnswer"]) expect(serialized).not.toContain(`"${key}"`);
      for (const label of CONVERSATION_SCENARIOS) expect(serialized).not.toContain(`"${label}"`);
      expect(reviewer.packet.status).toBe("PROVISIONAL"); expect(reviewer.form.status).toBe("DRAFT_UNSIGNED");
      expect(reviewer.form.signature).toBe(""); expect(reviewer.form.reviewerPseudonym).toBeNull(); expect(reviewer.form.reviewedAt).toBeNull();
      expect(reviewer.packet.cases).toHaveLength(10);
      reviewer.form.cases.forEach(row => { expect(row.gold?.trueWrongStepIdSets).toBeNull(); expect(row.gold?.rootCauseRelations).toBeNull(); expect(row.ratings).toBeNull(); });
      expect(validateM9PilotPacket(pilot.dataset, reviewer.packet, reviewer.form, reviewer.usability).formalGold).toBe(false);
      const readable = renderM9PilotPacket(reviewer.packet);
      expect(readable).toContain("PENDING_HUMAN_REVIEW"); expect(readable).toContain("SCRIPTED_NOT_OBSERVED"); expect(readable).toContain("UTF-16");
      expect(readable).not.toContain(pilot.reviewers[slot === "A" ? "B" : "A"].packet.packetId);
    }
  });

  it("leaves independence, ambiguity, timing, effort, dissent and arbitration to actual humans", () => {
    const value = fixture(), form = value.usability;
    for (const key of ["reviewerPseudonym", "actualStartedAt", "actualFinishedAt", "actualMinutes", "actualEffort1To5", "completedIndependently", "understoodInstructionsWithoutHelp"] as const) expect(form[key]).toBeNull();
    for (const row of form.cases) {
      expect(row.independentInterpretation).toBe(""); expect(row.observationEvidence).toEqual([]);
      for (const key of ["usableWithoutClarification", "ambiguousEvidence", "actualMinutes", "actualEffort1To5", "requestsThirdPartyReview", "dissentRecordRef", "thirdPartyArbitrationRef"] as const) expect(row[key]).toBeNull();
    }
    expect(validate(value).humanVerificationPerformed).toBe(false);
    expect(renderM9PilotChecklist()).toContain("dissentRecordRef/thirdPartyArbitrationRef");
  });

  it("enforces A/B separation and binds usability to the complete packet", () => {
    const value = fixture();
    expect(() => validateM9PilotPacket(value.dataset, value.packet, value.other.form, value.usability)).toThrow("M8_PACKET_BINDING_MISMATCH");
    value.usability.packetHash = "a".repeat(64);
    expect(() => validate(value)).toThrow("M9_USABILITY_PACKET_BINDING_MISMATCH");
  });

  it("validates UTF-16 source slices, including surrogate pairs, without converting codepoint offsets", () => {
    const value = fixture(), source = value.packet.cases[0].sources[0];
    value.usability.cases[0].observationEvidence = [{ sourceId: source.sourceId, start: 3, end: 4, excerpt: "中" }];
    expect(validate(value).usability.cases[0].observationEvidence[0].excerpt).toBe("中");
    value.usability.cases[0].observationEvidence[0].start = 2;
    expect(() => validate(value)).toThrow("M9_USABILITY_EVIDENCE_POSITION_MISMATCH");
  });

  it("rejects invented sources and out-of-range excerpts in ambiguity evidence", () => {
    const value = fixture();
    value.usability.cases[0].ambiguousEvidence = true; value.usability.cases[0].ambiguityNotes = "UNIT_FIXTURE 词义不明";
    value.usability.cases[0].ambiguityEvidence = [{ sourceId: "UNIT_FIXTURE_UNKNOWN", start: 0, end: 1, excerpt: "A" }];
    expect(() => validate(value)).toThrow("M9_USABILITY_EVIDENCE_POSITION_MISMATCH");
    value.usability.cases[0].ambiguityEvidence[0] = { sourceId: value.packet.cases[0].sources[0].sourceId, start: 0, end: 999, excerpt: "A" };
    expect(() => validate(value)).toThrow("M9_USABILITY_EVIDENCE_POSITION_MISMATCH");
  });

  it("rejects altered case hashes, duplicate cases and missing usability coverage", () => {
    const badHash = fixture(); badHash.usability.cases[0].inputHash = "b".repeat(64);
    expect(() => validate(badHash)).toThrow("M9_USABILITY_CASE_BINDING_MISMATCH");
    const duplicate = fixture(); duplicate.usability.cases[1] = structuredClone(duplicate.usability.cases[0]);
    expect(() => validate(duplicate)).toThrow("重复试标案例");
    const missing = fixture(); missing.usability.cases.pop(); expect(() => validate(missing)).toThrow();
  });

  it("rejects packet source tampering even when every local hash is rewritten to match", () => {
    const value = fixture(), source = value.packet.cases[0].sources[0];
    source.text += "UNIT_FIXTURE_TAMPER"; source.textHash = hashValue(source.text);
    value.form.packetHash = hashValue(value.packet); value.usability.packetHash = hashValue(value.packet);
    expect(() => validate(value)).toThrow("M9_PACKET_CHILD_BINDING_MISMATCH");
  });

  it("requires an ambiguity explanation, allows missing evidence without inventing an excerpt", () => {
    const value = fixture(); value.usability.cases[0].ambiguousEvidence = true;
    expect(() => validate(value)).toThrow("歧义标记须说明");
    value.usability.cases[0].ambiguityNotes = "UNIT_FIXTURE 缺失图像，无法定位不存在的原文。";
    expect(validate(value).usability.cases[0].ambiguityEvidence).toEqual([]);
  });

  it("checks human timing/effort input but never converts self-report to verified human review", () => {
    const value = fixture(); value.usability.actualStartedAt = "2026-10-23T02:00:00Z"; value.usability.actualFinishedAt = "2026-10-23T01:00:00Z";
    expect(() => validate(value)).toThrow("实际结束时间不能早于开始时间");
    value.usability.actualStartedAt = "2026-10-23T02:00:00.1Z"; value.usability.actualFinishedAt = "2026-10-23T02:00:00Z";
    expect(() => validate(value)).toThrow("实际结束时间不能早于开始时间");
    value.usability.actualFinishedAt = "2026-10-23T03:00:00Z"; value.usability.actualMinutes = -1;
    expect(() => validate(value)).toThrow(); value.usability.actualMinutes = 60; value.usability.actualEffort1To5 = 6;
    expect(() => validate(value)).toThrow(); value.usability.actualEffort1To5 = 3;
    const result = validate(value);
    expect(result.formalGold).toBe(false); expect(result.humanVerificationPerformed).toBe(false); expect(result.usability.state).toBe("UNSIGNED_SELF_REPORT");
    expect(result.form.signature).toBe(""); expect(result.form.reviewerPseudonym).toBeNull();
  });

  it("rejects BLIND or teacher-reviewed child datasets", () => {
    const blind = fixture(); blind.dataset.cases[0].split = "BLIND";
    expect(() => validate(blind)).toThrow("M9_DEV_PROVISIONAL_SELECTION_REQUIRED");
    const reviewed = fixture(); reviewed.dataset.cases[0].reviewStatus = "TEACHER_REVIEWED";
    expect(() => validate(reviewed)).toThrow("M9_DEV_PROVISIONAL_SELECTION_REQUIRED");
  });
});
