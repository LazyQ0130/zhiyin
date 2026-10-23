import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { conversationAnnotationSetSchema, conversationCaseInputHash, conversationDatasetSchema } from "../../src/evaluation/conversation-schemas";
import { hashValue } from "../../src/evaluation/schemas";

// Offline only: this checks the authored candidates and writes a new local audit.
// It never sends data to a provider and never turns provisional labels into gold.
const datasetDirectory = path.resolve("tests/evaluation/m7");
const files = ["math-candidates.inputs.json", "math-candidates.annotations.provisional.json", "math-checks.provisional.json", "teacher-reviewer-a.template.json", "teacher-reviewer-b.template.json", "debug.case-ids.json", "blind.case-ids.json"];
const requiredCounts = { correct: 6, calculation_error: 7, conceptual_error: 7, method_error: 6, multiple_errors: 6, insufficient_evidence: 4, student_counterevidence: 4 };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A small arithmetic parser: no eval, Function, shell, imports, or JS access. */
function evaluate(expression: string): number {
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z]+|[()+\-*/^]/g) ?? [];
  assert(tokens.join("") === expression.replace(/\s/g, ""), `非法核验表达式: ${expression}`);
  let cursor = 0;
  const peek = () => tokens[cursor];
  function primary(): number {
    const token = tokens[cursor++];
    assert(token !== undefined, `表达式不完整: ${expression}`);
    if (token === "(") { const value = additive(); assert(tokens[cursor++] === ")", "括号不匹配"); return value; }
    if (token === "pi") return Math.PI;
    if (/^[A-Za-z]+$/.test(token)) {
      const functions: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, sin: Math.sin, cos: Math.cos };
      assert(Object.hasOwn(functions, token) && tokens[cursor++] === "(", `不支持函数: ${token}`);
      const value = additive(); assert(tokens[cursor++] === ")", "函数括号不匹配"); return functions[token](value);
    }
    assert(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token), `非法数字: ${token}`);
    return Number(token);
  }
  function power(): number { const left = primary(); if (peek() === "^") { cursor++; return left ** unary(); } return left; }
  function unary(): number { if (peek() === "+") { cursor++; return unary(); } if (peek() === "-") { cursor++; return -unary(); } return power(); }
  function multiplicative(): number { let value = unary(); while (peek() === "*" || peek() === "/") { const op = tokens[cursor++]; const right = unary(); value = op === "*" ? value * right : value / right; } return value; }
  function additive(): number { let value = multiplicative(); while (peek() === "+" || peek() === "-") { const op = tokens[cursor++]; const right = multiplicative(); value = op === "+" ? value + right : value - right; } return value; }
  const result = additive();
  assert(cursor === tokens.length && Number.isFinite(result), `表达式未完整求值或非有限值: ${expression}`);
  return result;
}

type MathCheck = { expression: string; expected: number; tolerance: number };
type MathSolution = { caseId: string; correctAnswer: string; engineeringReviewStatus: string; engineeringReviewNotes: string; checks: MathCheck[] };
type MathChecks = { schemaVersion: string; datasetId: string; datasetVersion: string; datasetHash: string; reviewerRole: string; teacherReviewed: boolean; solutions: MathSolution[] };

async function main() {
  const options = process.argv.slice(2);
  assert(options.every(option => option === "--refresh-manifest"), "用法: tsx scripts/eval/m7-dataset.ts [--refresh-manifest]");
  // Parser sanity checks cover precedence, exponent associativity, unary sign and functions.
  for (const [expression, expected] of [["2+3*4", 14], ["-2^2", -4], ["(-2)^2", 4], ["2^3^2", 512], ["sqrt(9)+abs(-2)", 5]] as const) assert(evaluate(expression) === expected, `算术解析器自检失败: ${expression}`);
  let rejectedUnsafeExpression = false;
  try { evaluate("process.exit(0)"); } catch { rejectedUnsafeExpression = true; }
  assert(rejectedUnsafeExpression, "算术解析器必须拒绝非表达式文本");

  const rawEntries = await Promise.all(files.map(async name => [name, await readFile(path.join(datasetDirectory, name), "utf8")] as const));
  const raw = Object.fromEntries(rawEntries);
  const dataset = conversationDatasetSchema.parse(JSON.parse(raw[files[0]]));
  const annotations = conversationAnnotationSetSchema.parse(JSON.parse(raw[files[1]]));
  const math = JSON.parse(raw[files[2]]) as MathChecks;
  const datasetHash = hashValue(dataset);
  const caseById = new Map(dataset.cases.map(sample => [sample.id, sample]));
  assert(dataset.cases.length === 40 && caseById.size === 40, "必须有40条唯一案例");
  assert(dataset.provenance === "AUTHOR_CREATED_PROVISIONAL", "本候选集不得冒充教师审定数据");
  const scenarioCounts: Record<string, number> = {};
  const splitCounts = { DEBUG: 0, BLIND: 0 };
  const hashes = new Set<string>();
  const normalizedQuestions = new Set<string>();
  const sourceIds = new Set<string>();
  for (const sample of dataset.cases) {
    assert(sample.subject === "MATH" && sample.source.kind === "AUTHOR_CREATED" && sample.reviewStatus === "PROVISIONAL", `来源/审核状态错误: ${sample.id}`);
    assert(sample.initialContext.turnCount === 0 && sample.initialContext.messages.length === 0 && sample.initialContext.findings.length === 0, `候选输入不能预填模型发现: ${sample.id}`);
    assert(sample.studentReplies.length >= 2 && sample.studentReplies.length <= 3, `需2-3轮预设学生回答: ${sample.id}`);
    const inputHash = conversationCaseInputHash(sample);
    assert(!hashes.has(inputHash), `重复输入hash: ${sample.id}`); hashes.add(inputHash);
    const normalized = sample.initialContext.questionText.replace(/[\s，。、：:；;（）()]/g, "");
    assert(!normalizedQuestions.has(normalized), `规范化题面重复: ${sample.id}`); normalizedQuestions.add(normalized);
    for (const id of [sample.initialContext.questionId, ...sample.initialContext.steps.map(step => step.id), ...sample.studentReplies.map(reply => reply.id)]) {
      assert(!sourceIds.has(id), `跨案例source ID重复: ${id}`); sourceIds.add(id);
    }
    scenarioCounts[sample.scenarioType] = (scenarioCounts[sample.scenarioType] ?? 0) + 1;
    splitCounts[sample.split]++;
  }
  assert(hashValue(scenarioCounts) === hashValue(requiredCounts), "七类型数量与40例分层计划不一致");
  assert(splitCounts.DEBUG === 24 && splitCounts.BLIND === 16, "必须为DEBUG24/BLIND16");
  function binding(set: { datasetId: string; datasetVersion: string; datasetHash: string }, name: string) {
    assert(set.datasetId === dataset.datasetId && set.datasetVersion === dataset.version && set.datasetHash === datasetHash, `${name}输入绑定失效`);
  }
  binding(annotations, "provisional标注");
  assert(annotations.annotations.length === 40, "provisional标签必须覆盖全部40例");
  for (const annotation of annotations.annotations) {
    const sample = caseById.get(annotation.caseId);
    assert(sample && annotation.inputHash === conversationCaseInputHash(sample), `标注case/inputHash失配: ${annotation.caseId}`);
    assert(annotation.provenance === "AUTHOR_PROVISIONAL" && annotation.review.status === "DRAFT" && annotation.review.independentReviews.length === 0 && annotation.review.adjudication === undefined, `未审标签伪装为已审: ${annotation.caseId}`);
    const steps = new Set(sample.initialContext.steps.map(step => step.id));
    for (const set of annotation.expected.trueWrongStepIdSets ?? []) for (const step of set) assert(steps.has(step), `标注引用不存在的步骤: ${step}`);
  }
  for (const name of ["teacher-reviewer-a.template.json", "teacher-reviewer-b.template.json"]) {
    const template = conversationAnnotationSetSchema.parse(JSON.parse(raw[name])); binding(template, name);
    assert(template.annotations.length === 40, `双审模板覆盖不足: ${name}`);
    for (const annotation of template.annotations) {
      const sample = caseById.get(annotation.caseId); assert(sample && annotation.inputHash === conversationCaseInputHash(sample), `模板inputHash不匹配: ${name}`);
      assert(annotation.provenance === "AUTHOR_PROVISIONAL" && annotation.review.status === "DRAFT" && annotation.review.independentReviews.length === 0 && annotation.review.adjudication === undefined, `模板不能包含已审核签收: ${name}`);
      assert(Object.entries(annotation.expected).filter(([key]) => key !== "teacherNotes").every(([, value]) => value === null), `模板泄漏工程标签: ${name}/${annotation.caseId}`);
    }
  }
  const selected = new Set<string>(), selectedFamilies = new Map<string, string>();
  for (const split of ["DEBUG", "BLIND"] as const) {
    const list = JSON.parse(raw[`${split.toLowerCase()}.case-ids.json`]) as { datasetId: string; datasetVersion: string; datasetHash: string; split: string; caseIds: string[]; familyIds: string[] };
    binding(list, `${split}清单`); assert(list.split === split, "分割清单split错误");
    const expectedCases = dataset.cases.filter(sample => sample.split === split);
    assert(hashValue(list.caseIds) === hashValue(expectedCases.map(sample => sample.id)), `${split}案例清单不匹配`);
    assert(hashValue(list.familyIds) === hashValue([...new Set(expectedCases.map(sample => sample.familyId))]), `${split}题族清单不匹配`);
    for (const sample of expectedCases) {
      assert(!selected.has(sample.id), `分区案例重复: ${sample.id}`); selected.add(sample.id);
      assert(!selectedFamilies.has(sample.familyId) || selectedFamilies.get(sample.familyId) === split, `题族跨分区: ${sample.familyId}`); selectedFamilies.set(sample.familyId, split);
    }
  }
  assert(selected.size === 40, "分区未覆盖全部案例");
  binding(math, "数学核验");
  assert(math.schemaVersion === "1.0" && math.teacherReviewed === false && math.reviewerRole === "AUTHOR_ENGINEERING_SELF_REVIEW", "数学自检不能冒充教师审核");
  assert(math.solutions.length === 40 && new Set(math.solutions.map(solution => solution.caseId)).size === 40, "数学核验必须逐例覆盖40条");
  const mathResults = math.solutions.map(solution => {
    assert(caseById.has(solution.caseId) && solution.correctAnswer.length > 0 && solution.engineeringReviewNotes.length > 0 && solution.engineeringReviewStatus === "AUTHOR_ENGINEERING_CHECKED_PROVISIONAL", `数学自检元数据非法: ${solution.caseId}`);
    assert(solution.checks.length > 0, `数学表达式核验为空: ${solution.caseId}`);
    const checks = solution.checks.map(check => {
      assert(typeof check.expression === "string" && Number.isFinite(check.expected) && Number.isFinite(check.tolerance) && check.tolerance > 0 && check.tolerance <= 1e-6, `数学断言非法: ${solution.caseId}`);
      const actual = evaluate(check.expression);
      assert(Math.abs(actual - check.expected) <= check.tolerance, `数学核验失败 ${solution.caseId}: ${check.expression}=${actual}, expected=${check.expected}`);
      return { ...check, actual, passed: true };
    });
    return { caseId: solution.caseId, correctAnswer: solution.correctAnswer, checks };
  });
  const manifest = {
    schemaVersion: "1.0", datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash,
    provenance: "AUTHOR_CREATED_PROVISIONAL", teacherReviewedCount: 0,
    canonicalHashAlgorithm: "SHA-256 of recursively sorted-key canonical JSON; arrays retain order (hashValue)",
    fileHashAlgorithm: "SHA-256 of exact UTF-8 file bytes",
    fileHashes: Object.fromEntries(rawEntries.map(([name, contents]) => [name, createHash("sha256").update(contents, "utf8").digest("hex")])),
    splitCounts, scenarioCounts, familyCount: selectedFamilies.size,
    familyIsolationScope: "Declared family IDs and exact/normalized input checks; semantic near-duplicate separation additionally reviewed by the author, not a universal automated leakage guarantee.",
    caseBindings: dataset.cases.map(sample => ({ caseId: sample.id, familyId: sample.familyId, split: sample.split, inputHash: conversationCaseInputHash(sample) })),
  };
  const manifestPath = path.join(datasetDirectory, "hashmanifest.json");
  if (options.includes("--refresh-manifest")) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  else assert(hashValue(JSON.parse(await readFile(manifestPath, "utf8"))) === hashValue(manifest), "hashmanifest不匹配；确认变更并升版本后用--refresh-manifest更新");
  const output = path.resolve(".local/m7-dataset-validation", randomUUID());
  await mkdir(output, { recursive: true });
  const report = { status: "PASS", createdAt: new Date().toISOString(), datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash, cases: 40, splitCounts, scenarioCounts, uniqueInputHashCount: hashes.size, familyCount: selectedFamilies.size, mathCaseCount: mathResults.length, mathAssertionCount: mathResults.reduce((sum, result) => sum + result.checks.length, 0), mathResults, teacherReviewedCount: 0, teacherQualityMetrics: null, apiCalls: 0, modelBehaviorValidated: false, limitations: ["原创脚本候选，不是真实学生对话", "数学数值断言及作者工程审读不等于教师质量审核", "题族隔离和规范化去重不证明任何语义变式都被自动识别", "未调用模型，不验证实际追问、纠正反证或拒答行为"] };
  await writeFile(path.join(output, "validation.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: report.status, cases: report.cases, splitCounts, scenarioCounts, mathAssertionCount: report.mathAssertionCount, datasetHash, teacherQualityMetrics: null, output }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 2; });
