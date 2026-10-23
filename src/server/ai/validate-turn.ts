import type { DiagnosisContext } from "./gateway";
import { diagnosisTurnSchema, type DiagnosisTurn, type Evidence } from "./schemas/diagnosis";
import { isDemoQuadratic, verifyQuadratic } from "../domain/math-verifier";
import { parseQuadraticQuestion } from "../domain/math-evidence";
import { normalizeEvidenceTrust } from "./evidence-trust";

export function deterministicToolResults(input: DiagnosisContext): Array<{ id: string; text: string }> {
  if (input.subject !== "MATH") return [];
  const coefficients = parseQuadraticQuestion(input.questionText);
  if (!coefficients) return [];
  const { a, b, c } = coefficients;
  const check = verifyQuadratic(a, b, c);
  return [{ id: isDemoQuadratic(input.questionText) ? "rule:quadratic-v1" : "rule:quadratic-bounded-v1", text: `a=${a},b=${b},c=${c}; −4ac=${check.negativeFourAC}; Δ=${check.discriminant}; roots=${check.roots.join(",")}` }];
}

/** Owners are checked by the calling service; this guard checks every reference within its scoped context. */
export function validateDiagnosisTurn(value: unknown, input: DiagnosisContext): DiagnosisTurn {
  const turn = diagnosisTurnSchema.parse(value);
  const steps = new Map(input.steps.map(s => [s.id, s.text]));
  const replies = new Map(input.messages.filter(m => m.role === "USER").map(m => [m.id, m.content]));
  const toolResults = new Map(deterministicToolResults(input).map(t => [t.id, t.text]));
  const sources = {STUDENT_STEP: steps, STUDENT_REPLY: replies, TOOL_RESULT: toolResults, QUESTION_TEXT: new Map([[input.questionId, input.questionText]])};
  if (turn.referencedStepIds.some(id => !steps.has(id))) throw new Error("INVALID_STEP_REFERENCE");
  const checkEvidence = (e: Evidence) => {
    const source = sources[e.kind].get(e.sourceId);
    if (source === undefined || (e.excerpt !== undefined && !source.includes(e.excerpt))) throw new Error("INVALID_EVIDENCE_REFERENCE");
  };
  const findingKeys = new Set([...input.findings, ...turn.findings].map(finding => finding.findingKey));
  if (new Set(turn.findings.map(finding => finding.findingKey)).size !== turn.findings.length) throw new Error("DUPLICATE_FINDING_KEY");
  const graph = new Map([...input.findings, ...turn.findings].map(finding => [finding.findingKey, finding.trust?.rootCause.relatedFindingKeys ?? []]));
  for (const finding of turn.findings) {
    finding.supportingEvidence.forEach(checkEvidence);
    finding.contradictingEvidence.forEach(checkEvidence);
    if (finding.trust) {
      finding.trust.verification.evidence.forEach(checkEvidence);
      const relation = finding.trust.rootCause;
      if (relation.upstreamStepIds.some(id => !steps.has(id)) || relation.relatedFindingKeys.some(key => !findingKeys.has(key)) || (relation.candidateRootId !== null && !findingKeys.has(relation.candidateRootId))) throw new Error("INVALID_ROOT_CAUSE_REFERENCE");
      if (relation.relatedFindingKeys.includes(finding.findingKey) || (relation.role === "PROPAGATED" && relation.candidateRootId === finding.findingKey)) throw new Error("CYCLIC_ROOT_CAUSE_REFERENCE");
      if (relation.candidateRootId && relation.candidateRootId !== finding.findingKey) graph.set(finding.findingKey, [...(graph.get(finding.findingKey) ?? []), relation.candidateRootId]);
    }
    if (finding.status === "VERIFIED" && (input.turnCount === 0 || !finding.supportingEvidence.some(e => e.kind === "TOOL_RESULT"))) {
      throw new Error("UNSUPPORTED_VERIFICATION");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("CYCLIC_ROOT_CAUSE_REFERENCE");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const parent of graph.get(key) ?? []) visit(parent);
    visiting.delete(key); visited.add(key);
  };
  findingKeys.forEach(visit);
  if (turn.action === "FINISH_REPORT" && input.turnCount === 0) throw new Error("FOLLOWUP_REQUIRED");
  if (turn.action === "FINISH_REPORT" && (!turn.studentFacingText.includes("已确认") || !turn.studentFacingText.includes("待确认"))) throw new Error("REPORT_MISSING_UNCERTAINTY");
  if (turn.action === "GIVE_HINT" && input.requestedAction !== "HINT") throw new Error("UNREQUESTED_HINT");
  if (input.turnCount >= 6 && !["FINISH_REPORT", "MARK_INCONCLUSIVE"].includes(turn.action)) throw new Error("TURN_LIMIT_REACHED");
  return diagnosisTurnSchema.parse(normalizeEvidenceTrust(turn, input));
}
