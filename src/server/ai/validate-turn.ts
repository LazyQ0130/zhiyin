import type { DiagnosisContext } from "./gateway";
import { diagnosisTurnSchema, type DiagnosisTurn, type Evidence } from "./schemas/diagnosis";
import { isDemoQuadratic, verifyQuadratic } from "../domain/math-verifier";

export function deterministicToolResults(input: DiagnosisContext): Array<{ id: string; text: string }> {
  if (input.subject !== "MATH" || !isDemoQuadratic(input.questionText)) return [];
  const check = verifyQuadratic(1, -5, 6);
  return [{ id: "rule:quadratic-v1", text: `a=1,b=-5,c=6; −4ac=${check.negativeFourAC}; Δ=${check.discriminant}; roots=${check.roots.join(",")}` }];
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
  for (const finding of turn.findings) {
    finding.supportingEvidence.forEach(checkEvidence);
    finding.contradictingEvidence.forEach(checkEvidence);
    if (finding.status === "VERIFIED" && (input.turnCount === 0 || !finding.supportingEvidence.some(e => e.kind === "TOOL_RESULT"))) {
      throw new Error("UNSUPPORTED_VERIFICATION");
    }
  }
  if (turn.action === "FINISH_REPORT" && input.turnCount === 0) throw new Error("FOLLOWUP_REQUIRED");
  if (turn.action === "FINISH_REPORT" && (!turn.studentFacingText.includes("已确认") || !turn.studentFacingText.includes("待确认"))) throw new Error("REPORT_MISSING_UNCERTAINTY");
  if (turn.action === "GIVE_HINT" && input.requestedAction !== "HINT") throw new Error("UNREQUESTED_HINT");
  if (input.turnCount >= 6 && !["FINISH_REPORT", "MARK_INCONCLUSIVE"].includes(turn.action)) throw new Error("TURN_LIMIT_REACHED");
  return turn;
}
