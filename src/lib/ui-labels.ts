export const gradeLabels: Record<string, string> = { PRIMARY: "小学", MIDDLE_SCHOOL: "初中", HIGH_SCHOOL: "高中", UNIVERSITY: "大学", OTHER: "其他" };
export const subjectLabels: Record<string, string> = { MATH: "数学", CHINESE: "语文", ENGLISH: "英语", PHYSICS: "物理", CHEMISTRY: "化学", BIOLOGY: "生物", OTHER: "其他学科" };
export const statusLabels: Record<string, string> = {
  DRAFT: "草稿", INPUT_CONFIRMED: "已确认题目", ANALYZING: "分析中", QUESTIONING: "诊断中", EVALUATING: "正在核对", REPORT_READY: "报告已生成", NEEDS_INPUT: "需补充信息", INCONCLUSIVE: "待确认", FAILED_RETRYABLE: "可重试", CANCELED: "已结束",
  HYPOTHESIS: "初步判断", SUPPORTED: "有证据支持", VERIFIED: "错因经验证", REFUTED: "已被反证", UNRESOLVED: "待确认",
  NOT_STARTED: "待训练", IN_PROGRESS: "验证中", PENDING_REVIEW: "等待确认", COMPLETED: "本次训练完成", NOT_EVALUATED: "尚未验证", NEEDS_PRACTICE: "仍需练习", PASSED_CURRENT_PROBE: "本次验证通过", PENDING_DELAYED_RETEST: "待延迟复测", SUPPORTED_RETENTION: "复测有支持证据", RETENTION_SUPPORTED: "复测有支持证据", NOT_ENOUGH_EVIDENCE: "证据仍不足",
  CORRECT: "本题正确", INCORRECT: "还需检查", UNKNOWN: "等待确认", INDEPENDENT: "独立作答", HINTED: "使用过提示", SOLUTION_VIEWED: "查看过解法", DETERMINISTIC: "规则核验", REVIEWED: "审核核验", AI_PROVISIONAL: "AI 初步评估", UNAVAILABLE: "暂无法核验",
  BASIC: "基础验证", VARIATION: "同类变式", VARIANT: "同类变式", TRANSFER: "迁移验证", EXECUTION: "运算与推理", KNOWLEDGE: "概念与规则", READING: "题意理解", APPLICATION: "知识应用", PLANNING: "解题规划", EXPRESSION: "表达与自检", UNDETERMINED: "原因待确认", OTHER: "其他",
};
export function label(value: string) { return statusLabels[value] ?? value; }
export function dateText(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
