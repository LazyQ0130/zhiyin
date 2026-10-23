/**
 * Conservative, local review of help actually exposed to a learner.
 * A detected level is a lower bound, not a complete semantic classification.
 * Unrecognised generated text is UNCERTAIN; a model's zero never clears it.
 */
export type AssistanceLevel = 0 | 1 | 2 | 3;
export interface AssistanceReview {
  status: "CLEAR" | "DETECTED" | "UNCERTAIN";
  declaredLevel: AssistanceLevel;
  minimumLevel: AssistanceLevel | null;
  effectiveLevel: AssistanceLevel | null;
  reasons: string[];
  reviewRequired: boolean;
  source: "SERVER_CONTENT_REVIEW_V1";
}
export interface AssistanceReviewInput {
  studentFacingText: string;
  followUpQuestion?: string | null;
  findings?: readonly (string | { statement?: string })[];
  declaredHintLevel: AssistanceLevel;
  requestedAction?: string;
  subject?: string;
  questionText?: string;
}

const SOURCE = "SERVER_CONTENT_REVIEW_V1" as const;
const NEW_QUESTION_NO_HELP = "NEW_RULE_CHECKED_QUESTION_NO_HELP_EXPOSED";

function normalize(text: string): string {
  return text.replace(/²/g, "^2").replace(/³/g, "^3").normalize("NFKC").toLowerCase()
    .replace(/[−–—]/g, "-").replace(/\\(?:delta|Delta)/gi, "δ")
    .replace(/\\(?:times|cdot)/g, "*").replace(/[×·]/g, "*")
    .replace(/\\(?:geq?|leq?)/g, match => match.includes("g") ? ">=" : "<=")
    .replace(/\\(?:\(|\)|\[|\])/g, "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

// Closed, whole-message allowlist. Adding arbitrary generated sentences here
// would turn a regex miss into a false claim of independence.
const NO_HELP_QUESTIONS = [
  /^(?:你当时是怎么想的|你这一步是怎么想的|请说明你这一步的思路|请用自己的话说明你的思路|你能说明这一步的思路吗|你能解释一下你的思路吗)[。?？]?$/,
  /^你原本打算怎样解这道题[，,]请写出第一步思路[。?？]?$/,
  /^(?:can you explain your reasoning|what was your reasoning|please explain your reasoning|how did you get this step)[.?]?$/,
];

const ANSWER_OR_RESULT = [
  /(?:正确答案|最终答案|答案|结果|两根|根分别|应填|应选|应该选|不妨选|选项为|可以填|可填|应当填)\s*(?:是|为|[:：=]|选)?\s*[-+\da-d一二三四五六七八九十负]/,
  /(?:所以|因此|故|也就是|换言之|当然|这意味着).{0,24}(?:符合|不符合|包括|不包括|应选|选择|填入|取值为)/,
  /(?:不就是|难道不是|会不会是|是否就是|不妨填|试着填)\s*["“']?\s*[-+\d一二三四五六七八九十负]/,
  /(?:这两个数|两个数|两个根).{0,12}(?:分别是|就是|是)\s*[\d一二三四五六七八九十负]/,
  /(?:the\s+)?(?:correct\s+|final\s+)?(?:answer|result|roots?|solution|option)\s*(?:is|are|would be|must be|[:=])\s*["']?\s*(?:[-+\d]|[a-d]\b|yes\b|no\b|true\b|false\b)/,
  /(?:choose|select|pick|fill in|enter)\s+(?:option\s+)?["']?\s*(?:[-+\d]|[a-d]\b)/,
  /(?:could|would|might|should)(?:n't| not)?\s+(?:the\s+)?(?:answer|result|solution)\s+be\s+[-+\d]/,
  /(?:δ|delta|discriminant|判别式|x(?:_?\d)?|y|答案|结果)\s*(?:=|equals?|is|等于|是|为)\s*[-+]?\s*\d+(?:\.\d+)?(?:\b|[。;,，；?？]|$)/,
  /[-+]?\d+(?:\.\d+)?\s*(?:[+*/-]\s*\(?[-+]?\d+(?:\.\d+)?\)?\s*)+\s*=\s*[-+]?\d+(?:\.\d+)?/,
  /(?:过去式|过去分词|正确形式|正确拼写)\s*(?:是|为|[:：])\s*[a-z]+/,
  /(?:past tense|past participle|correct form|correct spelling)\s+(?:of\s+[a-z]+\s+)?(?:is|would be)\s+[a-z]+/,
];
const KEY_KNOWLEDGE = [
  /(?:δ|判别式)\s*(?:=|是|为|公式[是为:：]*)\s*b\s*\^?2\s*-\s*4\s*\*?\s*a\s*\*?\s*c/,
  /b\s*\^?2\s*-\s*4\s*\*?\s*a\s*\*?\s*c/,
  /(?:x|解)\s*=\s*.{0,16}(?:±|\\pm|sqrt|√).{0,30}(?:2a|2\s*\*\s*a)/,
  /(?:[a-zδ][a-z_\d]*|\\[a-z]+)\s*=\s*(?:[-+]?\s*[a-zδ]|\\(?:frac|sqrt))[^。?？\n]{0,60}(?:[+*/^±]|\\(?:frac|sqrt))/,
  /(?:至少|至多|不小于|不大于).{0,22}(?:包括|包含|等于|大于等于|小于等于|>=|<=)/,
  /(?:at least|at most|no less than|no more than).{0,35}(?:includes? equality|includes? equal|equal to|>=|<=)/,
  /(?:负负得正|同号得正|异号得负|乘方先于|先乘除后加减|分配律|三角形内角和.{0,8}180)/,
  /(?:did|does|do)\s+(?:后|之后).{0,16}(?:动词原形|原形)/,
  /(?:after\s+(?:did|does|do).{0,25}(?:base form|infinitive)|negative times (?:a )?negative.{0,15}positive)/,
];
const DIRECTION = [
  /(?:先|请|试着|可以)?(?:检查|核对|关注|注意|留意|回看|回到|比较|考虑|尝试|拆开|分开计算|代入|画图|列式|设未知数)/,
  /\b(?:check|focus on|look at|revisit|compare|consider|try|substitute|draw|factor|isolate|differentiate)\b/,
];

export function reviewAssistance(input: AssistanceReviewInput): AssistanceReview {
  const texts = [...new Set([input.studentFacingText, input.followUpQuestion ?? "", ...(input.findings ?? []).map(f => typeof f === "string" ? f : f.statement ?? "")]
    .map(normalize).filter(Boolean))];
  const reasons: string[] = [];
  let minimum: AssistanceLevel | null = null;
  const detect = (level: AssistanceLevel, reason: string) => {
    minimum = Math.max(minimum ?? 0, level) as AssistanceLevel;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (input.requestedAction === "HINT" || input.requestedAction === "GIVE_HINT") detect(1, "EXPLICIT_HINT_REQUEST");
  for (const text of texts) {
    if (ANSWER_OR_RESULT.some(rule => rule.test(text))) detect(3, "CONTENT_ANSWER_OR_WORKED_RESULT");
    if (KEY_KNOWLEDGE.some(rule => rule.test(text))) detect(2, "CONTENT_FORMULA_OR_KEY_KNOWLEDGE");
    if (DIRECTION.some(rule => rule.test(text))) detect(1, "CONTENT_DIRECTIONAL_GUIDANCE");
  }
  // No inference of level zero from absence of a positive detector match.
  if (minimum === null && texts.length > 0 && texts.every(text => NO_HELP_QUESTIONS.some(rule => rule.test(text)))) {
    minimum = 0;
    reasons.push("KNOWN_NO_HELP_QUESTION");
  }
  const minimumLevel = minimum as AssistanceLevel | null;
  const effectiveLevel = minimumLevel === null
    ? input.declaredHintLevel > 0 ? input.declaredHintLevel : null
    : Math.max(input.declaredHintLevel, minimumLevel) as AssistanceLevel;
  const status = minimumLevel === null ? "UNCERTAIN" : minimumLevel > 0 || input.declaredHintLevel > 0 ? "DETECTED" : "CLEAR";
  if (input.declaredHintLevel > 0) reasons.push("MODEL_DECLARED_HELP");
  if (minimumLevel === null) reasons.push(texts.length ? "CONTENT_UNCLASSIFIED_REVIEW_REQUIRED" : "EMPTY_CONTENT_REVIEW_REQUIRED");
  if (minimumLevel !== null && minimumLevel > input.declaredHintLevel) reasons.push("MODEL_LEVEL_UNDERSPECIFIES_CONTENT");
  return {status, declaredLevel: input.declaredHintLevel, minimumLevel, effectiveLevel, reasons,
    reviewRequired: status === "UNCERTAIN" || (minimumLevel !== null && minimumLevel > input.declaredHintLevel), source: SOURCE};
}

/** Only for a fresh server-created rule-bank question whose help is still hidden. */
export function knownNoAssistance(): AssistanceReview {
  return {status: "CLEAR", declaredLevel: 0, minimumLevel: 0, effectiveLevel: 0, reasons: [NEW_QUESTION_NO_HELP], reviewRequired: false, source: SOURCE};
}

/** Treat missing/invalid historical records as unknown, never as an implicit zero. */
export function parseAssistanceReview(value: unknown): AssistanceReview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const isLevel = (n: unknown): n is AssistanceLevel => Number.isInteger(n) && typeof n === "number" && n >= 0 && n <= 3;
  if (v.source !== SOURCE || !["CLEAR", "DETECTED", "UNCERTAIN"].includes(String(v.status)) || !isLevel(v.declaredLevel)
    || !(v.minimumLevel === null || isLevel(v.minimumLevel)) || !(v.effectiveLevel === null || isLevel(v.effectiveLevel))
    || !Array.isArray(v.reasons) || !v.reasons.every(r => typeof r === "string") || typeof v.reviewRequired !== "boolean") return null;
  if (v.status === "CLEAR" && (v.declaredLevel !== 0 || v.minimumLevel !== 0 || v.effectiveLevel !== 0 || v.reviewRequired)) return null;
  if (v.status === "CLEAR" && !v.reasons.some(reason => reason === "KNOWN_NO_HELP_QUESTION" || reason === NEW_QUESTION_NO_HELP)) return null;
  if (v.status === "UNCERTAIN" && (v.minimumLevel !== null || !v.reviewRequired)) return null;
  if (v.status === "DETECTED" && (!isLevel(v.effectiveLevel) || v.effectiveLevel === 0)) return null;
  if (v.declaredLevel > 0 && (v.effectiveLevel === null || (v.effectiveLevel as number) < v.declaredLevel)) return null;
  if (isLevel(v.minimumLevel) && (v.effectiveLevel === null || (v.effectiveLevel as number) < Math.max(v.minimumLevel, v.declaredLevel))) return null;
  return {status: v.status as AssistanceReview["status"], declaredLevel: v.declaredLevel, minimumLevel: v.minimumLevel as AssistanceLevel | null,
    effectiveLevel: v.effectiveLevel as AssistanceLevel | null, reasons: [...v.reasons] as string[], reviewRequired: v.reviewRequired, source: SOURCE};
}

/** Preserve earlier exposure when another help event is recorded for the same item. */
export function mergeAssistanceReviews(previous: unknown, next: AssistanceReview): AssistanceReview {
  const before = parseAssistanceReview(previous);
  if (!before) return next;
  const declaredLevel = Math.max(before.declaredLevel, next.declaredLevel) as AssistanceLevel;
  const knownMinimums = [before.minimumLevel, next.minimumLevel].filter((level): level is AssistanceLevel => level !== null);
  const minimumLevel = knownMinimums.length ? Math.max(...knownMinimums) as AssistanceLevel : null;
  const knownEffective = [before.effectiveLevel, next.effectiveLevel].filter((level): level is AssistanceLevel => level !== null);
  const effectiveLevel = knownEffective.length ? Math.max(...knownEffective) as AssistanceLevel : null;
  const uncertain = before.status === "UNCERTAIN" || next.status === "UNCERTAIN";
  const status = (effectiveLevel ?? 0) > 0 ? "DETECTED" : uncertain ? "UNCERTAIN" : "CLEAR";
  return {status, declaredLevel, minimumLevel: uncertain && minimumLevel === 0 ? null : minimumLevel,
    effectiveLevel: uncertain && effectiveLevel === 0 ? null : effectiveLevel,
    reasons: [...new Set([...before.reasons, ...next.reasons])], reviewRequired: before.reviewRequired || next.reviewRequired, source: SOURCE};
}

export interface RecordedPracticeAssistance {
  assistance: "INDEPENDENT" | "HINTED" | "SOLUTION_VIEWED" | "UNKNOWN";
  independence: "INDEPENDENT" | "ASSISTED" | "UNKNOWN";
  reasons: string[];
  review: AssistanceReview | null;
}
export function recordedPracticeAssistance(input: {hintUsed: boolean; hintUsedAt?: Date | string | null; answerVisibility?: string; assistance?: unknown}): RecordedPracticeAssistance {
  const review = parseAssistanceReview(input.assistance);
  const reasons = [...(review?.reasons ?? [])];
  const level = Math.max(review?.minimumLevel ?? 0, review?.effectiveLevel ?? 0, review?.declaredLevel ?? 0);
  const revealed = ["REVEALED", "VISIBLE", "SHOWN", "SOLUTION_VIEWED"].includes(input.answerVisibility ?? "HIDDEN");
  if (revealed || level === 3) {
    reasons.push(revealed ? "PRACTICE_SOLUTION_EXPOSED" : "PRACTICE_ANSWER_CONTENT_EXPOSED");
    return {assistance: "SOLUTION_VIEWED", independence: "ASSISTED", reasons, review};
  }
  if (input.hintUsed || input.hintUsedAt != null || level > 0) {
    if (input.hintUsed) reasons.push("PRACTICE_HINT_EVENT_RECORDED");
    if (input.hintUsedAt != null) reasons.push("PRACTICE_HINT_TIMESTAMP_RECORDED");
    return {assistance: "HINTED", independence: "ASSISTED", reasons, review};
  }
  // A generic CLEAR0 from another question is not sufficient provenance here.
  if (review?.status === "CLEAR" && review.reasons.includes(NEW_QUESTION_NO_HELP)
    && (input.answerVisibility == null || input.answerVisibility === "HIDDEN")) {
    return {assistance: "INDEPENDENT", independence: "INDEPENDENT", reasons, review};
  }
  reasons.push("PRACTICE_HELP_PROVENANCE_UNKNOWN");
  return {assistance: "UNKNOWN", independence: "UNKNOWN", reasons, review};
}
