import { z } from "zod";
import { parseNumericAnswer } from "./math-verifier";

export const answerSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("NUMBER"), value: z.number().finite(), tolerance: z.number().nonnegative().max(0.001).default(0) }),
  z.strictObject({ type: z.literal("UNAVAILABLE") }),
]);
export type AnswerSpec = z.infer<typeof answerSpecSchema>;
export type Assistance = "INDEPENDENT" | "HINTED" | "SOLUTION_VIEWED" | "UNKNOWN";
export interface PracticeEvaluation {
  correctness: "CORRECT" | "INCORRECT" | "UNKNOWN";
  assistance: Assistance;
  independence: "INDEPENDENT" | "ASSISTED" | "UNKNOWN";
  independenceReasons: string[];
  evaluationMethod: "DETERMINISTIC" | "UNAVAILABLE";
  verifiedBy: "RULE" | "PENDING";
  masteryState: "NOT_ENOUGH_EVIDENCE" | "NEEDS_PRACTICE" | "PASSED_CURRENT_PROBE";
  feedback: string;
}
export function escalateAssistance(current: Assistance, requested: Assistance): Assistance {
  const rank: Assistance[] = ["INDEPENDENT", "HINTED", "SOLUTION_VIEWED"];
  // Unknown provenance cannot be turned into independence by a later zero.
  if (current === "UNKNOWN" || requested === "UNKNOWN") {
    if (current === "SOLUTION_VIEWED" || requested === "SOLUTION_VIEWED") return "SOLUTION_VIEWED";
    if (current === "HINTED" || requested === "HINTED") return "HINTED";
    return "UNKNOWN";
  }
  return rank[Math.max(rank.indexOf(current), rank.indexOf(requested))];
}
export function evaluatePractice(input: { answerText: string; answerSpec: AnswerSpec; assistance: Assistance; assistanceReasons?: readonly string[] }): PracticeEvaluation {
  const spec = answerSpecSchema.parse(input.answerSpec);
  const parsed = parseNumericAnswer(input.answerText);
  const base = { assistance: input.assistance,
    independence: input.assistance === "UNKNOWN" ? "UNKNOWN" as const : input.assistance === "INDEPENDENT" ? "INDEPENDENT" as const : "ASSISTED" as const,
    independenceReasons: [...(input.assistanceReasons ?? [input.assistance === "UNKNOWN" ? "PRACTICE_HELP_PROVENANCE_UNKNOWN" : input.assistance === "INDEPENDENT" ? "SERVER_RECORDED_NO_HELP" : "SERVER_RECORDED_HELP"])],
  };
  if (spec.type === "UNAVAILABLE" || parsed === null) return {
    ...base, correctness: "UNKNOWN", evaluationMethod: "UNAVAILABLE", verifiedBy: "PENDING", masteryState: "NOT_ENOUGH_EVIDENCE",
    feedback: "暂时无法可靠核验这份作答。数值题请填写一个数值；其他作答保留待确认，不计为通过。",
  };
  const correct = Math.abs(parsed - spec.value) <= spec.tolerance;
  return {
    ...base, correctness: correct ? "CORRECT" : "INCORRECT", evaluationMethod: "DETERMINISTIC", verifiedBy: "RULE",
    masteryState: correct && input.assistance === "INDEPENDENT" ? "PASSED_CURRENT_PROBE" : correct ? "NOT_ENOUGH_EVIDENCE" : "NEEDS_PRACTICE",
    feedback: correct
      ? input.assistance === "INDEPENDENT" ? "本题独立核验通过。这只说明本次作答，建议以后换一道新题复测。" : input.assistance === "UNKNOWN" ? "本题数值正确；帮助来源记录不足，独立性保留待确认，不计为独立通过。" : "本题数值正确；已记录使用帮助，因此不计为独立通过。"
      : "本题数值与规则核算结果不一致。可以先检查负号与平方，再做一道变式。",
  };
}
