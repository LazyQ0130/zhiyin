export const DIAGNOSIS_STATES = ["DRAFT", "INPUT_CONFIRMED", "ANALYZING", "QUESTIONING", "EVALUATING", "REPORT_READY", "NEEDS_INPUT", "INCONCLUSIVE", "FAILED_RETRYABLE", "CANCELED"] as const;
export type DiagnosisState = typeof DIAGNOSIS_STATES[number];
const TRANSITIONS: Record<DiagnosisState, readonly DiagnosisState[]> = {
  DRAFT: ["INPUT_CONFIRMED", "CANCELED"],
  INPUT_CONFIRMED: ["ANALYZING", "CANCELED"],
  ANALYZING: ["QUESTIONING", "NEEDS_INPUT", "INCONCLUSIVE", "FAILED_RETRYABLE", "REPORT_READY", "CANCELED"],
  QUESTIONING: ["EVALUATING", "INCONCLUSIVE", "CANCELED"],
  EVALUATING: ["QUESTIONING", "REPORT_READY", "NEEDS_INPUT", "INCONCLUSIVE", "FAILED_RETRYABLE", "CANCELED"],
  NEEDS_INPUT: ["INPUT_CONFIRMED", "QUESTIONING", "INCONCLUSIVE", "CANCELED"],
  FAILED_RETRYABLE: ["ANALYZING", "EVALUATING", "INCONCLUSIVE", "CANCELED"],
  INCONCLUSIVE: [],
  REPORT_READY: [],
  CANCELED: [],
};
export function canTransition(from: DiagnosisState, to: DiagnosisState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
export function transitionDiagnosis(from: DiagnosisState, to: DiagnosisState): DiagnosisState {
  if (!canTransition(from, to)) throw new Error(`INVALID_DIAGNOSIS_TRANSITION:${from}:${to}`);
  return to;
}
export function stateForAction(action: string): DiagnosisState {
  switch (action) {
    case "ASK_ONE_QUESTION": case "GIVE_HINT": return "QUESTIONING";
    case "REQUEST_INPUT_CORRECTION": return "NEEDS_INPUT";
    case "FINISH_REPORT": return "REPORT_READY";
    case "MARK_INCONCLUSIVE": return "INCONCLUSIVE";
    default: throw new Error("INVALID_DIAGNOSIS_ACTION");
  }
}
