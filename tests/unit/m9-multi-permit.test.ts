import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { authorizeM9MultiPermit, consumeM9MultiPermit, guardM9MultiRequest, m9EstimateCostCny, m9MultiPermitSchema, m9ReservedCostCny } from "../../src/evaluation/m9-multi-permit";
import { createM8AdjudicationDraft, isM8HumanVerifiedDecision, m8AdjudicationPayload } from "../../src/evaluation/m8-teacher";
import { buildM9LivePlan } from "../../src/evaluation/m9-live-plan";
import { livePermitSchema } from "../../src/evaluation/live-control";
import { DIAGNOSIS_SYSTEM_PROMPT } from "../../src/server/ai/prompts/diagnosis-v1";
import { hashValue } from "../../src/evaluation/schemas";
import { M9_UNIT_NOW, m9MultiUnitFixture } from "./m9-multi-fixture";

function authorize(fixture = m9MultiUnitFixture()) { return authorizeM9MultiPermit(fixture.permit, fixture.binding, M9_UNIT_NOW); }
function rebindDecision(fixture: ReturnType<typeof m9MultiUnitFixture>) {
  for (const decision of fixture.teacherGoldDecisions) fixture.permit.teacherGoldDecisionHashes[decision.caseId] = hashValue(decision);
}
function request(fixture = m9MultiUnitFixture()) {
  const context = fixture.dataset.cases[0].initialContext;
  const body = JSON.stringify({ model: fixture.permit.model, messages: [{ role: "system", content: DIAGNOSIS_SYSTEM_PROMPT }, { role: "user", content: JSON.stringify({ untrustedStudentMaterial: { ...context, messages: context.messages.slice(-12), toolResults: [], maximumTurns: fixture.permit.maxTurnsPerSession } }) }], stream: false, enable_thinking: false, response_format: { type: "json_object" }, max_completion_tokens: fixture.permit.maxCompletionTokens });
  return {
    url: `${fixture.permit.baseUrl}/chat/completions`, init: { method: "POST", redirect: "error", body } as RequestInit,
    state: { caseId: fixture.permit.caseIds[0], inputHash: fixture.permit.caseInputHashes[fixture.permit.caseIds[0]], turnIndex: 0, requests: 0, committedSpendCny: 0, reservedSpendCny: 0, contextHash: hashValue(context), expectedContext: context, expectedBodyHash: hashValue(body), usageKnown: true },
  };
}

describe("M9 multi-turn permit gates with in-memory UNIT-only review fixtures", () => {
  it("accepts the bound reviewed DEV fixture and reserves the full official input capacity for all nine requests", () => {
    const fixture = m9MultiUnitFixture(3), permit = authorize(fixture);
    expect(permit.schemaVersion).toBe("M9.MULTI.1");
    expect(m9ReservedCostCny(permit) * permit.maxRequests).toBeCloseTo(7.2020106, 7);
    expect(livePermitSchema.safeParse(permit).success).toBe(false);
  });
  it.each([undefined, null, {}, { schemaVersion: "M9.MULTI.1", approved: false }])("rejects missing, old or unapproved permission", value => {
    const fixture = m9MultiUnitFixture();
    expect(() => authorizeM9MultiPermit(value, fixture.binding, M9_UNIT_NOW)).toThrow();
  });
  it("cannot execute a PLAN_ONLY artifact, even if an approval property is added", () => {
    const fixture = m9MultiUnitFixture(), parent = JSON.parse(readFileSync("tests/evaluation/m7/math-candidates.inputs.json", "utf8"));
    const plan = buildM9LivePlan(parent, fixture.sourceHashes, M9_UNIT_NOW.toISOString(), M9_UNIT_NOW);
    expect(m9MultiPermitSchema.safeParse(plan).success).toBe(false);
    expect(m9MultiPermitSchema.safeParse({ ...plan, approved: true }).success).toBe(false);
    expect(m9MultiPermitSchema.safeParse({ ...fixture.permit, schemaVersion: "1.0" }).success).toBe(false);
  });
  it.each([
    ["maxTurnsPerSession", 4], ["maxRequests", 10], ["maxSpendCny", 8.01], ["maxCompletionTokens", 2501], ["maxCompletionTokens", 127],
    ["maxRequestBytes", 200001], ["timeoutMs", 25001], ["maxRetries", 1], ["concurrency", 2], ["model", "another-model"], ["region", "ap-southeast-1"],
    ["baseUrl", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"], ["promptVersion", "old-prompt"], ["trustPolicyVersion", "M7"],
  ])("rejects expanded or changed %s", (field, value) => {
    expect(m9MultiPermitSchema.safeParse({ ...m9MultiUnitFixture().permit, [field]: value }).success).toBe(false);
  });
  it("requires exact unique selection and exact case, gold and rule hash coverage", () => {
    const fixture = m9MultiUnitFixture();
    for (const value of [
      { ...fixture.permit, caseIds: [...fixture.permit.caseIds, ...fixture.permit.caseIds] },
      { ...fixture.permit, caseInputHashes: {} }, { ...fixture.permit, teacherGoldDecisionHashes: { ...fixture.permit.teacherGoldDecisionHashes, extra: "a".repeat(64) } },
      { ...fixture.permit, sourceHashes: { ...fixture.permit.sourceHashes, extra: "a".repeat(64) } },
    ]) expect(m9MultiPermitSchema.safeParse(value).success).toBe(false);
    expect(() => authorizeM9MultiPermit(fixture.permit, { ...fixture.binding, caseIds: ["unknown"] }, M9_UNIT_NOW)).toThrow("M9_PERMIT_DATASET_OR_SELECTION_MISMATCH");
    expect(() => authorizeM9MultiPermit(fixture.permit, { ...fixture.binding, teacherGoldDecisions: [] }, M9_UNIT_NOW)).toThrow("M9_EXACT_TEACHER_GOLD_DECISIONS_REQUIRED");
  });
  it("rejects provisional datasets, provisional cases, BLIND cases, and original input drift", () => {
    for (const mutate of [
      (f: ReturnType<typeof m9MultiUnitFixture>) => { f.dataset.provenance = "AUTHOR_CREATED_PROVISIONAL"; },
      (f: ReturnType<typeof m9MultiUnitFixture>) => { f.dataset.cases[0].reviewStatus = "PROVISIONAL"; },
      (f: ReturnType<typeof m9MultiUnitFixture>) => { f.dataset.cases[0].split = "BLIND"; },
      (f: ReturnType<typeof m9MultiUnitFixture>) => { f.dataset.cases[0].studentReplies[0].content += "altered"; },
    ]) {
      const fixture = m9MultiUnitFixture(); mutate(fixture); fixture.permit.datasetHash = hashValue(fixture.dataset);
      expect(() => authorize(fixture)).toThrow();
    }
  });
  it("rejects dataset hash, source hash, or approved decision hash drift", () => {
    const fixture = m9MultiUnitFixture();
    fixture.permit.datasetHash = hashValue("UNIT_DIFFERENT_DATASET"); expect(() => authorize(fixture)).toThrow("M9_PERMIT_DATASET_OR_SELECTION_MISMATCH");
    fixture.permit.datasetHash = hashValue(fixture.dataset);
    fixture.permit.sourceHashes = { ...fixture.sourceHashes, [Object.keys(fixture.sourceHashes)[0]]: hashValue("UNIT_RULE_CHANGED") };
    expect(() => authorize(fixture)).toThrow("M9_RULE_SOURCES_CHANGED");
    fixture.permit.sourceHashes = fixture.sourceHashes; fixture.permit.teacherGoldDecisionHashes[fixture.permit.caseIds[0]] = hashValue("UNIT_OTHER_DECISION");
    expect(() => authorize(fixture)).toThrow("M9_HUMAN_VERIFIED_INPUT_GOLD_REQUIRED");
  });
  it("requires actual supplied bytes for both audited originals and never treats hashes as bytes", () => {
    const fixture = m9MultiUnitFixture();
    expect(() => authorizeM9MultiPermit(fixture.permit, { ...fixture.binding, signedSourceBytes: [] }, M9_UNIT_NOW)).toThrow("M9_SIGNED_SOURCE_BYTES_REQUIRED");
    expect(() => authorizeM9MultiPermit(fixture.permit, { ...fixture.binding, signedSourceBytes: fixture.signedSourceBytes.slice(0, 1) }, M9_UNIT_NOW)).toThrow("M9_SIGNED_SOURCE_BYTES_REQUIRED");
    const decision = fixture.teacherGoldDecisions[0]; decision.originals[0].humanAudit.state = "PENDING_HUMAN_AUDIT"; rebindDecision(fixture);
    expect(() => authorize(fixture)).toThrow("M9_HUMAN_VERIFIED_INPUT_GOLD_REQUIRED");
  });
  it.each(["datasetVersion", "sourceContent"])("reconstructs packet source binding instead of trusting the M8 audit flag: %s", change => {
    const fixture = m9MultiUnitFixture(), decision = fixture.teacherGoldDecisions[0];
    for (const original of decision.originals) {
      if (change === "datasetVersion") original.packet.datasetVersion = "UNIT_OLD_PROVISIONAL_VERSION";
      else { const source = original.packet.cases[0].sources[0]; source.text += " UNIT_CHANGED"; source.textHash = hashValue(source.text); }
      original.submission.packetHash = hashValue(original.packet); original.submissionHash = hashValue(original.submission); original.humanAudit.boundSubmissionHash = original.submissionHash;
    }
    rebindDecision(fixture);
    expect(isM8HumanVerifiedDecision(decision)).toBe(true);
    expect(() => authorize(fixture)).toThrow(change === "datasetVersion" ? "M9_TEACHER_PACKET_DATASET_BINDING_MISMATCH" : "M9_TEACHER_PACKET_INPUT_CONTENT_MISMATCH");
  });
  it("requires the separate adjudicator original bytes when teachers disagree", () => {
    const fixture = m9MultiUnitFixture(), [a, b] = fixture.originals;
    b.submission.cases[0].gold!.allowedCategories = ["EXECUTION"]; b.submissionHash = hashValue(b.submission); b.humanAudit.boundSubmissionHash = b.submissionHash;
    const decision = createM8AdjudicationDraft(a, b, fixture.permit.caseIds[0], "UNIT_THIRD_NOT_A_PERSON", "UNIT simulated disagreement");
    const thirdBytes = Buffer.from("UNIT_THIRD_NO_REAL_SIGNATURE"), third = decision.adjudication!;
    decision.state = "ADJUDICATED"; decision.final = structuredClone(a.submission.cases[0]);
    Object.assign(third, { reviewedAt: M9_UNIT_NOW.toISOString(), signature: "UNIT_NOT_A_SIGNATURE", signedSourceHash: createHash("sha256").update(thirdBytes).digest("hex"), signedSourceByteLength: thirdBytes.length, humanAudit: "HUMAN_VERIFIED", verifierPseudonym: "UNIT_NOT_A_VERIFIER", verifiedAt: M9_UNIT_NOW.toISOString(), actualTeacherAndSignatureConfirmed: true });
    third.adjudicationPayloadHash = hashValue(m8AdjudicationPayload(decision));
    fixture.teacherGoldDecisions[0] = decision; rebindDecision(fixture);
    expect(isM8HumanVerifiedDecision(decision)).toBe(true);
    expect(() => authorize(fixture)).toThrow("M9_DISTINCT_ADJUDICATION_SOURCE_BYTES_REQUIRED");
    fixture.signedSourceBytes.push(thirdBytes); expect(authorize(fixture).caseIds).toEqual(fixture.permit.caseIds);
  });
  it("requires recent official undiscounted pricing, a bounded approval window, and a full request reserve", () => {
    const fixture = m9MultiUnitFixture(3);
    for (const pricing of [{ ...fixture.permit.pricing, inputPerMillion: 0.79 }, { ...fixture.permit.pricing, outputPerMillion: 2.69 }, { ...fixture.permit.pricing, discountAssumed: true }, { ...fixture.permit.pricing, maximumModelInputTokens: 12000 }]) expect(m9MultiPermitSchema.safeParse({ ...fixture.permit, pricing }).success).toBe(false);
    fixture.permit.pricing.verifiedAt = "2026-10-15T14:00:00.000Z"; expect(() => authorize(fixture)).toThrow("M9_PRICING_NOT_RECENTLY_VERIFIED");
    fixture.permit.pricing.verifiedAt = M9_UNIT_NOW.toISOString(); fixture.permit.maxSpendCny = 7;
    expect(() => authorize(fixture)).toThrow("M9_PERMIT_BUDGET_TOO_LOW");
    fixture.permit.maxSpendCny = 8; fixture.permit.expiresAt = "2026-10-25T14:00:00.000Z";
    expect(() => authorize(fixture)).toThrow("M9_PERMIT_EXPIRED_OR_INVALID_WINDOW");
  });
  it("claims one shared M7/M9 authorization filename exclusively and preserves all evidence", () => {
    const fixture = m9MultiUnitFixture(), directory = mkdtempSync(path.join(os.tmpdir(), "m9-unit-permit-"));
    consumeM9MultiPermit(fixture.permit, "UNIT_RUN", directory);
    const filename = path.join(directory, `${fixture.permit.authorizationId}.json`), ledger = JSON.parse(readFileSync(filename, "utf8"));
    expect(ledger).toMatchObject({ schemaVersion: "M9.MULTI.1", authorizationId: fixture.permit.authorizationId, runId: "UNIT_RUN", permitHash: hashValue(fixture.permit) });
    expect(() => consumeM9MultiPermit(fixture.permit, "UNIT_REPLAY", directory)).toThrow();
    expect(readFileSync(filename, "utf8")).not.toContain("UNIT_REPLAY");
    const oldDirectory = mkdtempSync(path.join(os.tmpdir(), "m9-unit-old-m7-ledger-"));
    writeFileSync(path.join(oldDirectory, `${fixture.permit.authorizationId}.json`), JSON.stringify({ runId: "UNIT_CONSUMED_M7" }), { flag: "wx" });
    expect(() => consumeM9MultiPermit(fixture.permit, "UNIT_M9", oldDirectory)).toThrow();
  });
});

describe("M9 request boundary checks before any network call", () => {
  it("accepts only the exact independently prepared request body and private selection", () => {
    const fixture = m9MultiUnitFixture(), { url, init, state } = request(fixture), network = vi.fn();
    guardM9MultiRequest(url, init, fixture.permit, state, M9_UNIT_NOW); expect(network).not.toHaveBeenCalled();
    expect(() => guardM9MultiRequest(url, { ...init, body: `${init.body} ` }, fixture.permit, state, M9_UNIT_NOW)).toThrow("M9_REQUEST_BODY_HASH_OR_SIZE_MISMATCH");
  });
  it("rebuilds the body from the full expected context even when history is trimmed to twelve messages", () => {
    const fixture = m9MultiUnitFixture();
    fixture.dataset.cases[0].initialContext.messages = Array.from({ length: 16 }, (_, index) => ({ id: `UNIT_HISTORY_${index}`, role: index % 2 ? "ASSISTANT" : "USER", content: `UNIT ${index}` }));
    const { url, init, state } = request(fixture);
    expect(JSON.parse(JSON.parse(init.body as string).messages[1].content).untrustedStudentMaterial.messages).toHaveLength(12);
    expect(() => guardM9MultiRequest(url, init, fixture.permit, state, M9_UNIT_NOW)).not.toThrow();
    expect(() => guardM9MultiRequest(url, init, fixture.permit, { ...state, contextHash: hashValue("UNIT_DIFFERENT_CONTEXT") }, M9_UNIT_NOW)).toThrow("M9_REQUEST_CONTEXT_OUTSIDE_PERMISSION");
  });
  it("rejects a changed student payload even when its caller recomputes the supplied body hash", () => {
    const fixture = m9MultiUnitFixture(), { url, init, state } = request(fixture), parsed = JSON.parse(init.body as string);
    const content = JSON.parse(parsed.messages[1].content); content.untrustedStudentMaterial.questionText += " UNIT_CHANGED";
    parsed.messages[1].content = JSON.stringify(content); const body = JSON.stringify(parsed);
    expect(() => guardM9MultiRequest(url, { ...init, body }, fixture.permit, { ...state, expectedBodyHash: hashValue(body) }, M9_UNIT_NOW)).toThrow("M9_REQUEST_CONTEXT_OUTSIDE_PERMISSION");
  });
  it.each([
    { requests: 3 }, { requests: -1 }, { turnIndex: 3 }, { caseId: "BLIND_UNLICENSED" }, { inputHash: "b".repeat(64) },
    { committedSpendCny: 7.3 }, { reservedSpendCny: 7.3 }, { committedSpendCny: Number.NaN }, { usageKnown: false }, { contextHash: "unbound" },
  ])("rejects unsafe request count, turn, input, spend or usage: %j", changed => {
    const fixture = m9MultiUnitFixture(), { url, init, state } = request(fixture);
    expect(() => guardM9MultiRequest(url, init, fixture.permit, { ...state, ...changed }, M9_UNIT_NOW)).toThrow();
  });
  it("rechecks expiry, exact endpoint, redirect mode, body caps, and fixed model parameters", () => {
    const fixture = m9MultiUnitFixture(), { url, init, state } = request(fixture);
    expect(() => guardM9MultiRequest(url, init, fixture.permit, state, new Date("2026-10-23T15:00:00Z"))).toThrow("M9_PERMIT_EXPIRED_OR_INVALID_WINDOW");
    expect(() => guardM9MultiRequest(url + "?forward=1", init, fixture.permit, state, M9_UNIT_NOW)).toThrow("M9_REQUEST_OUTSIDE_PERMISSION");
    expect(() => guardM9MultiRequest(url, { ...init, redirect: "follow" }, fixture.permit, state, M9_UNIT_NOW)).toThrow("M9_REQUEST_OUTSIDE_PERMISSION");
    for (const change of [{ model: "other" }, { stream: true }, { enable_thinking: true }, { max_completion_tokens: 2600 }, { tools: [] }]) {
      const body = JSON.stringify({ ...JSON.parse(init.body as string), ...change });
      expect(() => guardM9MultiRequest(url, { ...init, body }, fixture.permit, { ...state, expectedBodyHash: hashValue(body) }, M9_UNIT_NOW)).toThrow("M9_REQUEST_PARAMETERS_OUTSIDE_PERMISSION");
    }
    const body = "x".repeat(200001);
    expect(() => guardM9MultiRequest(url, { ...init, body }, fixture.permit, { ...state, expectedBodyHash: hashValue(body) }, M9_UNIT_NOW)).toThrow("M9_REQUEST_BODY_HASH_OR_SIZE_MISMATCH");
  });
  it("never substitutes an estimate for unknown, out-of-capacity, or malformed token usage", () => {
    const { permit } = m9MultiUnitFixture();
    expect(m9EstimateCostCny(682, 503, permit)).toBeCloseTo(0.0019037, 8);
    for (const [input, output] of [[null, 503], [682, null], [-1, 1], [1.5, 2], [991809, 1], [2, 2511], [NaN, 1]]) expect(m9EstimateCostCny(input, output, permit)).toBeNull();
  });
});
