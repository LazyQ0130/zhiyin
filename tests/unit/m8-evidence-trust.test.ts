import { describe, expect, it } from "vitest";
import type { DiagnosisContext } from "../../src/server/ai/gateway";
import { diagnosisTurnSchema, type DiagnosisFinding, type DiagnosisTurn, type FindingTrust } from "../../src/server/ai/schemas/diagnosis";
import { legacyFindingTrust, normalizeEvidenceTrust, summarizeRootCauses } from "../../src/server/ai/evidence-trust";
import { deterministicToolResults, validateDiagnosisTurn } from "../../src/server/ai/validate-turn";
import { deriveMathStepRelations, evaluateBoundedArithmetic } from "../../src/server/domain/math-evidence";
import { reviewAssistance } from "../../src/server/domain/assistance-review";
import { MockGateway } from "../../src/server/ai/providers/mock";

function context(overrides: Partial<DiagnosisContext> = {}): DiagnosisContext {
  return { questionId: "q", questionText: "解方程 x²-7x+10=0，并写出过程。", subject: "MATH", gradeBand: "HIGH_SCHOOL", steps: [{ id: "s1", text: "Δ=49+32=81" }, { id: "s2", text: "x=(7±9)/2，所以x=8或-1" }], messages: [], findings: [], turnCount: 0, hintLevel: 0, ...overrides };
}
function finding(overrides: Partial<DiagnosisFinding> = {}): DiagnosisFinding {
  return { findingKey: "cause", category: "KNOWLEDGE", statement: "学生误记了判别式公式。", status: "SUPPORTED", supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: "s1" }], contradictingEvidence: [], verificationNeeded: false, ...overrides };
}
function turn(findings: DiagnosisFinding[], overrides: Partial<DiagnosisTurn> = {}): DiagnosisTurn {
  return { schemaVersion: "1.0", action: "ASK_ONE_QUESTION", studentFacingText: "请说明你这一步的思路。", referencedStepIds: [], findings, followUpQuestion: "请说明你这一步的思路。", hintLevel: 0, safetyFlags: [], ...overrides };
}
function trust(root: Partial<FindingTrust["rootCause"]> = {}): FindingTrust {
  return { kind: "VERIFIED", uncertainties: [], verification: { state: "VERIFIED", basis: "DETERMINISTIC_RULE", evidence: [] }, rootCause: { role: "UNKNOWN", candidateRootId: null, relatedFindingKeys: [], upstreamStepIds: [], ...root } };
}
const observation = (key: string, step: string) => finding({ findingKey: key, category: "EXECUTION", statement: "该步骤出现运算差异，原因仍待确认。", status: "HYPOTHESIS", verificationNeeded: true, supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: step }] });

describe("M8 evidence trust server policy", () => {
  it("accepts legacy 1.0 but downgrades both certainty and an asserted psychological explanation", () => {
    const result = validateDiagnosisTurn(turn([finding()]), context());
    expect(result.schemaVersion).toBe("1.0");
    expect(result.findings[0]).toMatchObject({ status: "HYPOTHESIS", verificationNeeded: true, trust: { kind: "HYPOTHESIS" } });
    expect(result.findings[0].statement).not.toContain("误记了");
    expect(result.findings[0].statement).toContain("具体原因尚不能确定");
    expect(result.findings[0].trust?.uncertainties.length).toBeGreaterThan(0);
  });
  it("a deterministic tool verifies arithmetic rather than formula memory", () => {
    const input = context({ turnCount: 1 });
    const tool = deterministicToolResults(input)[0];
    const result = validateDiagnosisTurn(turn([finding({ status: "VERIFIED", trust: trust(), supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: "s1" }, { kind: "TOOL_RESULT", sourceId: tool.id }] })]), input);
    expect(result.findings[0].trust?.kind).toBe("HYPOTHESIS");
    expect(result.findings[0].status).toBe("HYPOTHESIS");
    expect(result.findings[0].verificationNeeded).toBe(true);
  });
  it("does not automatically upgrade even a rule-checked observation to VERIFIED", () => {
    const result = validateDiagnosisTurn(turn([observation("location", "s1")]), context({ turnCount: 1 }));
    expect(result.findings[0].trust?.kind).toBe("OBSERVATION");
    expect(result.findings[0].status).toBe("HYPOTHESIS");
  });
  it("an explicitly verified arithmetic observation has a narrow, neutral claim", () => {
    const input = context({ turnCount: 1 });
    const result = validateDiagnosisTurn(turn([finding({ ...observation("location", "s1"), status: "VERIFIED", verificationNeeded: false, supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: "s1" }, { kind: "TOOL_RESULT", sourceId: deterministicToolResults(input)[0].id }] })]), input);
    expect(result.findings[0].trust?.kind).toBe("VERIFIED");
    expect(result.findings[0].statement).toContain("只确认运算事实");
  });
  it("marks an omitted prior cause unresolved instead of allowing stale certainty to survive", () => {
    const input = context({ findings: [finding({ status: "VERIFIED", verificationNeeded: false })], turnCount: 1 });
    const result = validateDiagnosisTurn(turn([]), input);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ status: "UNRESOLVED", verificationNeeded: true, trust: { kind: "INCONCLUSIVE" } });
    expect(result.findings[0].statement).not.toContain("误记");
  });
  it("does not turn missing process or correct local arithmetic into a fabricated error", () => {
    const noProcess = validateDiagnosisTurn(turn([finding({ supportingEvidence: [{ kind: "QUESTION_TEXT", sourceId: "q" }] })]), context({ steps: [] }));
    expect(noProcess.findings[0].trust?.kind).toBe("INCONCLUSIVE");
    expect(noProcess.findings[0].statement).toContain("缺少");
    const correct = validateDiagnosisTurn(turn([observation("false-error", "s1")]), context({ steps: [{ id: "s1", text: "Δ=49-40=9" }] }));
    expect(correct.findings[0].status).toBe("UNRESOLVED");
    expect(correct.findings[0].statement).toContain("不足以确认这里存在错误");
  });
  it("does not blame a correct quadratic formula substitution, including after a student correction", () => {
    for (const steps of [[{ id: "s2", text: "x=(7±3)/2，所以x=5或2" }], [{ id: "s1", text: "Δ=49+32=81" }, { id: "s2", text: "x=(7±3)/2，所以x=5或2" }]]) {
      const result = validateDiagnosisTurn(turn([observation("false-error", "s2")]), context({ steps }));
      expect(result.findings[0].status).toBe("UNRESOLVED");
      expect(result.findings[0].trust?.rootCause.role).toBe("UNKNOWN");
      expect(result.findings[0].statement).toContain("不足以确认这里存在错误");
    }
  });
  it.each(["The student misremembered the formula.", "学生基础薄弱，所以必然不会这个公式。"])("neutralizes unsupported causal assertions in either language: %s", statement => {
    const result = validateDiagnosisTurn(turn([finding({ category: "OTHER", statement })]), context());
    expect(result.findings[0].status).toBe("HYPOTHESIS");
    expect(result.findings[0].trust?.kind).toBe("HYPOTHESIS");
    expect(result.findings[0].statement).toContain("具体原因尚不能确定");
  });
  it("unknown paraphrases cannot borrow arithmetic trust for an asserted mental state", () => {
    const result = validateDiagnosisTurn(turn([finding({ category: "OTHER", statement: "This conclusively establishes an internal processing defect." })]), context());
    expect(result.findings[0].statement).toContain("只说明本次运算表现");
    expect(result.findings[0].statement).not.toContain("processing defect");
  });
  it("does not infer a cause from an unrelated later reply", () => {
    const input = context({ turnCount: 1, messages: [{ id: "m", role: "USER", content: "我今天很累" }] });
    const result = validateDiagnosisTurn(turn([finding({ supportingEvidence: [{ kind: "STUDENT_STEP", sourceId: "s1" }, { kind: "STUDENT_REPLY", sourceId: "m" }] })]), input);
    expect(result.findings[0].trust?.verification.state).toBe("INCONCLUSIVE");
    expect(result.findings[0].status).toBe("UNRESOLVED");
  });
  it.each(["UNKNOWN", "ASSISTED", "CLEAR"])("correct reply %s revises the sign-rule hypothesis according to recorded help", async assistance => {
    const question = assistance === "ASSISTED" ? "−4×1×6 = −24，请核对。" : "请说明你这一步的思路。";
    const input = context({ questionText: "解方程 x²-5x+6=0。", steps: [{ id: "s1", text: "Δ=25+24=49" }], turnCount: 1, messages: [{ id: "a", role: "ASSISTANT", content: question, ...(assistance === "UNKNOWN" ? {} : { assistance: reviewAssistance({ studentFacingText: question, declaredHintLevel: 0 }) }) }, { id: "m", role: "USER", content: "-24" }] });
    const result = await new MockGateway().createDiagnosisTurn(input);
    const cause = result.findings.find(item => item.category === "KNOWLEDGE")!;
    expect(cause.status).toBe(assistance === "CLEAR" ? "REFUTED" : "UNRESOLVED");
    expect(cause.trust?.verification.state).toBe(assistance === "CLEAR" ? "REFUTED" : "WEAKENED");
    expect(result.findings.find(item => item.category === "EXECUTION")?.trust?.kind).toBe("OBSERVATION");
    expect(cause.contradictingEvidence.some(e => e.sourceId === "m")).toBe(true);
  });
  it("a second wrong sign calculation supports a hypothesis while preserving uncertainty", async () => {
    const result = await new MockGateway().createDiagnosisTurn(context({ questionText: "解方程 x²-5x+6=0。", steps: [{ id: "s1", text: "Δ=25+24=49" }], turnCount: 1, messages: [{ id: "m", role: "USER", content: "24" }] }));
    const cause = result.findings.find(item => item.category === "KNOWLEDGE")!;
    expect(cause.status).toBe("SUPPORTED");
    expect(cause.trust?.kind).toBe("HYPOTHESIS");
    expect(cause.trust?.verification.state).toBe("SUPPORTED");
    expect(cause.verificationNeeded).toBe(true);
  });
  it("legacy display fallback never retrospectively asserts verification", () => {
    expect(legacyFindingTrust()).toMatchObject({ kind: "INCONCLUSIVE", rootCause: { role: "UNKNOWN", candidateRootId: null } });
  });
  it("normalization remains exactly idempotent on initial, revised, propagated and stale turns", async () => {
    const scenarios = [context(), context({ findings: [finding()], turnCount: 1 })];
    for (const input of scenarios) {
      const first = validateDiagnosisTurn(turn([observation("initial", "s1"), observation("downstream", "s2")]), input);
      expect(validateDiagnosisTurn(first, input)).toEqual(first);
      expect(normalizeEvidenceTrust(first, input)).toEqual(first);
    }
    const input = context({ questionText: "解方程 x²-5x+6=0。", steps: [{ id: "s1", text: "Δ=25+24=49" }], turnCount: 1, messages: [{ id: "m", role: "USER", content: "-24" }] });
    const first = await new MockGateway().createDiagnosisTurn(input);
    expect(validateDiagnosisTurn(first, input)).toEqual(first);
  });
});

describe("M8 causal reference scope and arithmetic propagation", () => {
  it("keeps one candidate root for an initial error and locally self-consistent downstream roots", () => {
    const result = validateDiagnosisTurn(turn([observation("initial", "s1"), observation("downstream", "s2")]), context());
    expect(result.findings[0].trust?.rootCause).toMatchObject({ role: "INITIAL", candidateRootId: "initial" });
    expect(result.findings[1].trust?.rootCause).toMatchObject({ role: "PROPAGATED", candidateRootId: "initial", upstreamStepIds: ["s1"] });
    expect(result.findings[1].statement).toContain("不支持把它另列为独立错因");
    expect(summarizeRootCauses(result.findings).candidateRoots).toHaveLength(1);
  });
  it("supports another quadratic coefficient family and preserves independent downstream arithmetic errors", () => {
    const input = context({ questionText: "解方程 2x²-10x+8=0。", steps: [{ id: "s1", text: "Δ=100-36=64" }, { id: "s2", text: "x=(10±8)/4，所以x=4.5或0.5" }] });
    expect(deriveMathStepRelations(input).find(item => item.stepId === "s2")?.role).toBe("PROPAGATED");
    input.steps[1].text = "x=(10±8)/4，所以x=5或0.5";
    expect(deriveMathStepRelations(input).find(item => item.stepId === "s2")?.role).toBe("INDEPENDENT");
  });
  it("tracks named intermediate quantities through generic bounded arithmetic, with two independent roots", () => {
    const input = context({ questionText: "计算给定表达式", steps: [{ id: "s1", text: "u=2+3=6" }, { id: "s2", text: "v=u*2=12" }, { id: "s3", text: "w=7*2=15" }] });
    const result = validateDiagnosisTurn(turn([observation("first", "s1"), observation("derived", "s2"), observation("second", "s3")]), input);
    expect(result.findings.map(item => item.trust?.rootCause.role)).toEqual(["INITIAL", "PROPAGATED", "INDEPENDENT"]);
    expect(summarizeRootCauses(result.findings).candidateRoots).toHaveLength(2);
  });
  it("retains UNKNOWN when a model invents an unverified relation", () => {
    const input = context({ subject: "CHINESE", questionText: "说明观点", steps: [{ id: "s1", text: "观点一" }, { id: "s2", text: "观点二" }] });
    const result = validateDiagnosisTurn(turn([observation("one", "s1"), { ...observation("two", "s2"), trust: trust({ role: "PROPAGATED", candidateRootId: "one", relatedFindingKeys: ["one"], upstreamStepIds: ["s1"] }) }]), input);
    expect(result.findings[1].trust?.rootCause).toMatchObject({ role: "UNKNOWN", candidateRootId: null });
    expect(summarizeRootCauses(result.findings).candidateRoots).toHaveLength(0);
  });
  it("rejects foreign root/step references, cycles and duplicate finding keys", () => {
    for (const root of [{ candidateRootId: "foreign" }, { upstreamStepIds: ["foreign-step"] }, { relatedFindingKeys: ["foreign"] }]) {
      expect(() => validateDiagnosisTurn(turn([{ ...observation("one", "s1"), trust: trust(root) }]), context())).toThrow("INVALID_ROOT_CAUSE_REFERENCE");
    }
    expect(() => validateDiagnosisTurn(turn([{ ...observation("one", "s1"), trust: trust({ relatedFindingKeys: ["two"] }) }, { ...observation("two", "s2"), trust: trust({ relatedFindingKeys: ["one"] }) }]), context())).toThrow("CYCLIC_ROOT_CAUSE_REFERENCE");
    expect(() => validateDiagnosisTurn(turn([observation("same", "s1"), observation("same", "s2")]), context())).toThrow("DUPLICATE_FINDING_KEY");
  });
  it("checks trust verification excerpts using the same scoped evidence guard", () => {
    const metadata = trust(); metadata.verification.evidence = [{ kind: "STUDENT_STEP", sourceId: "s1", excerpt: "invented" }];
    expect(() => validateDiagnosisTurn(turn([{ ...observation("one", "s1"), trust: metadata }]), context())).toThrow("INVALID_EVIDENCE_REFERENCE");
  });
  it("bounds syntax, recursion, exponent and numeric growth without evaluating code", () => {
    expect(evaluateBoundedArithmetic("-(3^2)+sqrt(16)")).toBe(-5);
    expect(evaluateBoundedArithmetic("u*2", { u: 6 })).toBe(12);
    for (const source of ["process.exit(0)", "globalThis.secret", "2^10000000", "1/0", "9".repeat(300), "(".repeat(30) + "1" + ")".repeat(30)]) expect(evaluateBoundedArithmetic(source)).toBeNull();
    expect(deriveMathStepRelations(context({ steps: [{ id: "s1", text: "u=process.exit(0)" }] }))).toEqual([]);
  });
  it("keeps strict schema rules alongside the additive trust metadata", () => {
    expect(diagnosisTurnSchema.safeParse(turn([finding({ trust: { ...trust(), unexpected: true } as FindingTrust })])).success).toBe(false);
  });
});
