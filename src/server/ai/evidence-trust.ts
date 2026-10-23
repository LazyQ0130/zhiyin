import type { DiagnosisContext } from "./gateway";
import type { DiagnosisFinding, DiagnosisTurn, Evidence, FindingTrust } from "./schemas/diagnosis";
import { deriveMathStepRelations, evaluateBoundedArithmetic, parseQuadraticQuestion } from "../domain/math-evidence";

const CAUSAL = /误记|记错|忘记|记忆|不理解|不懂|不会|未理解|没有理解|不掌握|未掌握|掌握不足|基础.*(?:弱|牢|差)|概念|混淆|忽略|遗漏|审题|知识|粗心|笔误|疏忽|能力|习惯|策略|负号的含义|规则理解|公式.*(?:记忆|理解)|原因(?:是|为|在于)|misremember|misunderstand|does(?:n't| not) understand|do(?:n't| not) understand|lack(?:s|ing)? (?:understanding|knowledge|ability)|conceptual|careless|inattent|forgot|memory|knowledge gap/i;
const TENTATIVE = /可能|假设|尚不能|不能据此|需要.*(?:核实|验证)|仍需|待(?:确认|验证)|不确定|may|might|hypothes|uncertain|unconfirmed|need.*verif/i;
const OBSERVATION_UNCERTAINTY = "仅说明本次所引步骤或回答的表现，不能据此确认心理原因或长期能力。";
const CAUSE_UNCERTAINTY = "具体原因仍是待验证假设；工具核算只能核验运算事实，不能验证心理原因。";
const UNKNOWN_RELATION = "尚无足够证据确定此发现与其他发现的因果关系。";
const NEUTRAL_CAUSE = "现有证据仅支持所引步骤或回答中的表现；具体原因尚不能确定，需要进一步区分和验证。";
const UNKNOWN_ROOT: FindingTrust["rootCause"] = { role: "UNKNOWN", candidateRootId: null, relatedFindingKeys: [], upstreamStepIds: [] };

/** Historical rows without metadata are never retroactively promoted to verified causes. */
export function legacyFindingTrust(): FindingTrust {
  return { kind: "INCONCLUSIVE", uncertainties: ["历史记录未保存本版证据可信度信息；原状态不代表原因已经验证。"], verification: { state: "INCONCLUSIVE", basis: "NONE", evidence: [] }, rootCause: { ...UNKNOWN_ROOT, relatedFindingKeys: [], upstreamStepIds: [] } };
}

const unique = <T>(values: T[]) => [...new Set(values)];
const uniqueEvidence = (values: Evidence[]) => values.filter((evidence, index) => values.findIndex(other => other.kind === evidence.kind && other.sourceId === evidence.sourceId && other.excerpt === evidence.excerpt) === index);
const stepIds = (finding: DiagnosisFinding) => unique(finding.supportingEvidence.filter(e => e.kind === "STUDENT_STEP").map(e => e.sourceId));
function isCause(finding: DiagnosisFinding): boolean {
  return finding.trust?.kind === "HYPOTHESIS" || finding.trust?.uncertainties.includes(CAUSE_UNCERTAINTY) === true || ["KNOWLEDGE", "PLANNING", "APPLICATION"].includes(finding.category) || CAUSAL.test(finding.statement);
}

/** A known discriminant probe can contradict a sign-rule hypothesis, never establish a mental cause. */
function signProbeReply(input: DiagnosisContext): "CORRECT" | "INCORRECT" | null {
  const coefficients = parseQuadraticQuestion(input.questionText);
  const reply = input.messages.filter(message => message.role === "USER").at(-1)?.content;
  if (!coefficients || !reply || reply.length > 1200) return null;
  const text = reply.replace(/−/g, "-").replace(/\s/g, "");
  const numeric = evaluateBoundedArithmetic(text);
  const assigned = /-4ac=([+-]?\d+(?:\.\d+)?)/.exec(text);
  const value = assigned ? Number(assigned[1]) : numeric;
  if (value === null) return null;
  return value === -4 * coefficients.a * coefficients.c ? "CORRECT" : "INCORRECT";
}

/** Scoped references are checked before this function. All conclusions here remain conservative and idempotent. */
export function normalizeEvidenceTrust(turn: DiagnosisTurn, input: DiagnosisContext): DiagnosisTurn {
  const relations = deriveMathStepRelations(input);
  const relationByStep = new Map(relations.map(relation => [relation.stepId, relation]));
  const incomingKeys = new Set(turn.findings.map(finding => finding.findingKey));
  const omitted = input.findings.filter(finding => !incomingKeys.has(finding.findingKey) && finding.status !== "REFUTED" && (isCause(finding) || !finding.trust || ["HYPOTHESIS", "INCONCLUSIVE"].includes(finding.trust.kind)));
  if (turn.findings.length + omitted.length > 8) throw new Error("FINDING_CAPACITY_UNSAFE");
  const all = [...turn.findings, ...omitted.map(finding => ({ ...finding, status: "UNRESOLVED" as const, verificationNeeded: true, trust: undefined, statement: NEUTRAL_CAUSE }))];
  const latestReply = input.messages.filter(message => message.role === "USER").at(-1);
  const probeReply = signProbeReply(input);
  const precedingAssistant = input.messages.slice(0, latestReply ? input.messages.findIndex(message => message.id === latestReply.id) : 0).filter(message => message.role === "ASSISTANT").at(-1);
  // No recorded preceding question is also unknown assistance, never proof of independence.
  const independentProbe = precedingAssistant?.assistance?.status === "CLEAR" && precedingAssistant.assistance.effectiveLevel === 0;
  const relationFor = (finding: DiagnosisFinding) => {
    const matching = stepIds(finding).map(id => relationByStep.get(id)).filter(value => value !== undefined);
    return matching.find(value => value.role !== "UNKNOWN") ?? matching[0];
  };
  let correctedOverclaim = false;
  const normalized = all.map((finding): DiagnosisFinding => {
    const cause = isCause(finding) || omitted.some(previous => previous.findingKey === finding.findingKey);
    const relation = relationFor(finding);
    const evidence = uniqueEvidence([...finding.supportingEvidence, ...finding.contradictingEvidence].filter(e => e.kind === "STUDENT_REPLY" && e.sourceId === latestReply?.id));
    const signHypothesis = cause && /负号|符号/.test(finding.statement) && /混淆|规则|理解/.test(finding.statement);
    let status = finding.status;
    let statement = finding.statement;
    let kind: FindingTrust["kind"] = cause ? "HYPOTHESIS" : "OBSERVATION";
    let state: FindingTrust["verification"]["state"] = "NOT_CHECKED";
    let basis: FindingTrust["verification"]["basis"] = "NONE";
    let verificationEvidence: Evidence[] = [];
    const uncertainties = new Set(finding.trust?.uncertainties ?? []);
    if (cause) {
      uncertainties.add(CAUSE_UNCERTAINTY);
      if (!TENTATIVE.test(statement) && status !== "REFUTED") { statement = NEUTRAL_CAUSE; correctedOverclaim = true; }
      if (status === "VERIFIED" || status === "SUPPORTED") {
        // An explicit follow-up can support a cause hypothesis, but never verify it.
        status = evidence.length ? "SUPPORTED" : "HYPOTHESIS";
        if (finding.status === "VERIFIED") correctedOverclaim = true;
      }
      if (evidence.length) {
        basis = "STUDENT_REPLY";
        verificationEvidence = evidence;
        if (signHypothesis && probeReply === "CORRECT") {
          status = independentProbe ? "REFUTED" : "UNRESOLVED";
          state = independentProbe ? "REFUTED" : "WEAKENED";
          statement = "后续局部核算与负号规则一致，原先的规则理解困难假设被削弱；仍不能据此确认其他具体原因。";
          if (!independentProbe) uncertainties.add("追问的帮助程度未知或存在提示；这次正确回答不能作为独立反证。");
        } else if (status === "REFUTED" && finding.contradictingEvidence.some(e => e.sourceId === latestReply?.id)) {
          state = "WEAKENED";
          uncertainties.add("反证削弱原假设；当前缺少可自动核验的语义规则，不能据此确定替代原因。");
        } else if (signHypothesis && probeReply === "INCORRECT" && status !== "REFUTED") {
          state = "SUPPORTED";
          status = "SUPPORTED";
        } else {
          state = finding.contradictingEvidence.some(e => e.sourceId === latestReply?.id) ? "WEAKENED" : "INCONCLUSIVE";
          if (status !== "REFUTED") status = "UNRESOLVED";
          uncertainties.add("后续回答已保留，但尚不足以自动判定其是否支持这一具体原因。");
        }
      } else if (status === "REFUTED") {
        // Retain historical counterevidence but do not make a new, unsupported verification claim.
        state = "WEAKENED";
        uncertainties.add("本轮没有新的反证回答；保留原反证记录供复核。");
      }
      if (status === "UNRESOLVED") { kind = "INCONCLUSIVE"; if (state !== "WEAKENED") state = "INCONCLUSIVE"; }
    } else {
      uncertainties.add(OBSERVATION_UNCERTAINTY);
      // Even an unrecognised paraphrase cannot smuggle a psychological claim through a mathematical observation.
      if (relation && ["INITIAL", "INDEPENDENT"].includes(relation.role)) statement = "所引步骤中的受限局部等式与确定性核算不一致；这只说明本次运算表现，具体原因仍待验证。";
      // Only a recognized mathematical inconsistency can keep an explicit VERIFIED declaration.
      const ruleEvidence = finding.supportingEvidence.filter(e => e.kind === "TOOL_RESULT");
      if (finding.status === "VERIFIED" && relation && ["INITIAL", "INDEPENDENT"].includes(relation.role) && ruleEvidence.length && input.turnCount > 0) {
        kind = "VERIFIED"; state = "VERIFIED"; basis = "DETERMINISTIC_RULE"; verificationEvidence = ruleEvidence;
        statement = "该步骤的局部等式与确定性核算不一致；本次只确认运算事实，具体原因仍待验证。";
      } else if (finding.status === "VERIFIED") {
        status = finding.supportingEvidence.length ? "SUPPORTED" : "UNRESOLVED";
        state = "INCONCLUSIVE"; correctedOverclaim = true;
      } else if (status === "SUPPORTED") state = "SUPPORTED";
      else if (status === "UNRESOLVED") { kind = "INCONCLUSIVE"; state = "INCONCLUSIVE"; }
    }
    if (!cause && !relation && (status === "SUPPORTED" || status === "VERIFIED" || !TENTATIVE.test(statement))) {
      status = "UNRESOLVED"; kind = "INCONCLUSIVE"; state = "INCONCLUSIVE";
      statement = "已保留所引步骤或回答；当前受限核验尚不足以确认这一具体判断，仍需复核。";
      uncertainties.add("引用存在不等于内容蕴含该判断；当前没有可自动核验的规则支持这一断言。");
    }
    if ((!finding.supportingEvidence.some(e => ["STUDENT_STEP", "STUDENT_REPLY"].includes(e.kind)) || relation?.role === "UNKNOWN") && status !== "REFUTED") {
      status = "UNRESOLVED"; kind = "INCONCLUSIVE"; state = "INCONCLUSIVE";
      statement = relation?.role === "UNKNOWN" ? "所引步骤在受限局部核算范围内自洽；现有证据不足以确认这里存在错误或具体原因。" : "当前缺少可定位的学生步骤或回答，无法据此确认错误或原因，请补充过程。";
      uncertainties.add(relation?.reason ?? "题干或工具结果不能代替学生实际提供的过程。");
      correctedOverclaim ||= finding.statement !== statement;
    }
    if (omitted.some(previous => previous.findingKey === finding.findingKey)) uncertainties.add("本轮未重新提供该原因假设的证据；保留历史线索并降为待确认，不能沿用先前确定程度。");
    if (!finding.supportingEvidence.length && status !== "REFUTED") { status = "UNRESOLVED"; kind = "INCONCLUSIVE"; state = "INCONCLUSIVE"; uncertainties.add("没有可定位的支持证据，不能确认错误或原因。"); }
    const trust: FindingTrust = { kind, uncertainties: [...uncertainties].slice(0, 12), verification: { state, basis, evidence: verificationEvidence }, rootCause: { ...UNKNOWN_ROOT, relatedFindingKeys: [], upstreamStepIds: [] } };
    if (!relation) trust.uncertainties = unique([...trust.uncertainties, UNKNOWN_RELATION]).slice(0, 12);
    const contradictingEvidence = signHypothesis && probeReply === "CORRECT" ? uniqueEvidence([...finding.contradictingEvidence, ...evidence]) : finding.contradictingEvidence;
    correctedOverclaim ||= status !== finding.status || statement !== finding.statement;
    return { ...finding, statement, status, verificationNeeded: kind !== "VERIFIED" && status !== "REFUTED", contradictingEvidence, trust };
  });
  // One shared candidate per observed initial step, even when multiple category hypotheses mention that step.
  const rootKeyByStep = new Map<string, string>();
  for (const relation of relations.filter(relation => ["INITIAL", "INDEPENDENT"].includes(relation.role))) {
    const candidates = [...normalized, ...input.findings.filter(previous => !normalized.some(current => current.findingKey === previous.findingKey))].filter(finding => stepIds(finding).includes(relation.stepId));
    const representative = candidates.find(finding => ["OBSERVATION", "VERIFIED"].includes(finding.trust?.kind ?? "INCONCLUSIVE")) ?? candidates[0];
    if (representative) rootKeyByStep.set(relation.stepId, representative.findingKey);
  }
  for (const relation of relations.filter(relation => relation.role === "PROPAGATED")) {
    const upstreamRoot = relation.upstreamStepIds.map(id => rootKeyByStep.get(id)).find(value => value !== undefined);
    if (upstreamRoot) rootKeyByStep.set(relation.stepId, upstreamRoot);
  }
  for (const finding of normalized) {
    const relation = relationFor(finding);
    if (!relation) continue;
    const candidateRootId = relation.role === "PROPAGATED" ? rootKeyByStep.get(relation.upstreamStepIds[0]) : rootKeyByStep.get(relation.stepId);
    // Missing root findings are not replaced by fabricated findings or invented IDs.
    if (!candidateRootId) { finding.trust!.uncertainties = unique([...finding.trust!.uncertainties, UNKNOWN_RELATION]).slice(0, 12); continue; }
    finding.trust!.rootCause = { role: relation.role, candidateRootId, relatedFindingKeys: relation.role === "PROPAGATED" && candidateRootId !== finding.findingKey ? [candidateRootId] : [], upstreamStepIds: relation.upstreamStepIds };
    if (relation.role === "PROPAGATED") {
      finding.trust!.uncertainties = unique([...finding.trust!.uncertainties, relation.reason]).slice(0, 12);
      finding.trust!.kind = "OBSERVATION";
      finding.trust!.verification.state = "NOT_CHECKED";
      finding.status = "HYPOTHESIS";
      finding.verificationNeeded = true;
      finding.statement = "这一后续步骤沿用了前步的错误中间量，局部算术与该中间量自洽；现有证据不支持把它另列为独立错因。";
      correctedOverclaim ||= turn.findings.some(original => original.findingKey === finding.findingKey && original.statement !== finding.statement);
    }
  }
  let studentFacingText = turn.studentFacingText;
  if (correctedOverclaim && turn.action !== "ASK_ONE_QUESTION" && turn.action !== "GIVE_HINT") studentFacingText = "已确认：已记录本次提交的步骤与回答。待确认：当前证据不足以确认具体原因，相关判断仅作为待验证假设；后续步骤还需区分前错传播与独立错误。";
  else if (CAUSAL.test(studentFacingText) && !TENTATIVE.test(studentFacingText)) {
    studentFacingText = turn.action === "ASK_ONE_QUESTION" ? (turn.followUpQuestion ?? "请补充你当时的计算过程。") : "已确认：已记录本次提交的步骤与回答。待确认：现有证据不足以确认具体原因，仍需进一步核实。";
    if (CAUSAL.test(studentFacingText) && !TENTATIVE.test(studentFacingText)) throw new Error("UNSAFE_CAUSAL_QUESTION");
  }
  return { ...turn, findings: normalized, studentFacingText };
}

/** A root group is an error-location candidate, never a verified psychological cause. */
export function summarizeRootCauses(findings: DiagnosisFinding[]) {
  const candidateRoots: Array<{ candidateRootId: string; findingKeys: string[]; stepIds: string[] }> = [];
  for (const finding of findings) {
    const relation = finding.trust?.rootCause;
    if (!relation?.candidateRootId || relation.role === "UNKNOWN") continue;
    let group = candidateRoots.find(root => root.candidateRootId === relation.candidateRootId);
    if (!group) { group = { candidateRootId: relation.candidateRootId, findingKeys: [], stepIds: [] }; candidateRoots.push(group); }
    group.findingKeys.push(finding.findingKey);
    group.stepIds = unique([...group.stepIds, ...stepIds(finding)]);
  }
  return { candidateRoots, propagatedFindingKeys: findings.filter(finding => finding.trust?.rootCause.role === "PROPAGATED").map(finding => finding.findingKey), unknownFindingKeys: findings.filter(finding => !finding.trust || finding.trust.rootCause.role === "UNKNOWN").map(finding => finding.findingKey) };
}
