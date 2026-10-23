import "server-only";
import type { FindingCategory } from "../ai/schemas/diagnosis";
import type { AnswerSpec } from "./practice-evaluation";
import { verifyQuadratic } from "./math-verifier";

export interface PracticeBankItem {
  id: string;
  topic: string;
  tier: "BASIC" | "VARIANT" | "TRANSFER";
  questionText: string;
  answerSpec: AnswerSpec;
  hint: string;
  solution: string;
  incorrectExample: string;
  source: "ORIGINAL_RULE_CHECKED";
  reviewStatus: "RULE_CHECKED_NOT_TEACHER_REVIEWED";
  version: "1.0";
  coefficients: { a: number; b: number; c: number };
}

// Original engineering exercises. Rule checking is not a claim of teacher review.
const COEFFICIENTS = [[2,-3,-1],[1,-7,10],[3,4,1],[2,5,2],[1,-6,9],[4,-4,-3],[3,-2,-2],[5,1,-1],[2,-1,3],[1,0,-9],[3,6,3],[2,7,3],[4,0,1],[5,-6,1],[2,-8,6]] as const;
export const PRACTICE_BANK: readonly PracticeBankItem[] = COEFFICIENTS.map(([a,b,c], index) => {
  const tier = (["BASIC", "VARIANT", "TRANSFER"] as const)[index % 3];
  const { discriminant, negativeFourAC } = verifyQuadratic(a,b,c);
  const term = (coefficient: number, suffix: string) => `${coefficient < 0 ? "−" : "+"} ${Math.abs(coefficient)}${suffix}`;
  return {
    id: `discriminant-v1-${String(index + 1).padStart(2, "0")}`,
    topic: "一元二次方程 · 判别式与负号运算", tier,
    questionText: tier === "TRANSFER"
      ? `对于方程 ${a}x² ${term(b, "x")} ${term(c, "")} = 0，求判别式 Δ 的值。请只填写一个数值。`
      : `已知 a=${a}，b=${b}，c=${c}，求 b²−4ac 的值。请只填写一个数值。`,
    answerSpec: {type: "NUMBER", value: discriminant, tolerance: 0},
    hint: tier === "TRANSFER" ? "先从方程取出带正负号的 a、b、c，再将 b² 和 −4ac 分别计算。" : "先把 b² 和 −4ac 分开计算，再相加；c 的负号也要保留。",
    solution: `b²=(${b})²=${b*b}；−4ac=−4×${a}×(${c})=${negativeFourAC}；Δ=${b*b}+(${negativeFourAC})=${discriminant}。`,
    incorrectExample: `将 b²−4ac 错写为 b²+4ac，会得到 ${b*b+4*a*c}；这不是本题正确的公式代入。`,
    source: "ORIGINAL_RULE_CHECKED", reviewStatus: "RULE_CHECKED_NOT_TEACHER_REVIEWED", version: "1.0", coefficients: {a,b,c},
  };
});
export function selectPracticeItems(category: FindingCategory, count = 3): PracticeBankItem[] {
  if (!["EXECUTION", "KNOWLEDGE", "EXPRESSION"].includes(category)) return [];
  return PRACTICE_BANK.slice(0, Math.max(0, Math.min(15, Math.trunc(count)))).map(item => structuredClone(item));
}
export function toPublicPracticeItem(item: PracticeBankItem) {
  return { id: item.id, topic: item.topic, tier: item.tier, questionText: item.questionText, source: item.source, reviewStatus: item.reviewStatus, version: item.version };
}
