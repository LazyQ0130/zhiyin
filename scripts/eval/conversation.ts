import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashValue } from "../../src/evaluation/schemas";
import {
  CONVERSATION_RUBRIC_METRICS, conversationAnnotationSetSchema, conversationCaseInputHash, conversationDatasetSchema,
  conversationOutputReviewSetSchema, conversationRunSchema, conversationTranscriptHash, conversationTranscriptProjection, type ConversationDataset, type ConversationRun,
} from "../../src/evaluation/conversation-schemas";
import { advanceConversationContext, isConversationTerminal, scoreConversationEvaluation } from "../../src/evaluation/conversation-score";
import type { DiagnosisTurn } from "../../src/server/ai/schemas/diagnosis";
import {DIAGNOSIS_PROMPT_VERSION} from '../../src/server/ai/prompts/diagnosis-v1';

// The only provider import below is MockGateway. No live gateway factory, environment key, or fetch is used.
if (!process.argv.includes("--conversation-offline-worker")) {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2), "--conversation-offline-worker"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const argv = process.argv.slice(2).filter(value => value !== "--conversation-offline-worker");
const command = argv.shift();
const positions: string[] = [], options = new Map<string, string>();
let out: string | null = null;
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(path.resolve(file), "utf8"));
async function directory() {
  if (out) return out;
  const label = ["validate", "plan", "simulate", "score", "prepare-teacher", "prepare-output-reviews"].includes(command ?? "") ? command : "invalid";
  out = path.resolve(".local", "m7-conversation", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await mkdir(out, { recursive: true });
  return out;
}
async function save(file: string, value: unknown) {
  const target = path.join(await directory(), file);
  await writeFile(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  return target;
}
function selected(dataset: ConversationDataset) {
  const split = options.get("--split") ?? "DEBUG", ids = options.get("--cases")?.split(",");
  if (!["DEBUG", "BLIND", "ALL"].includes(split)) throw new Error("INVALID_SPLIT");
  if (ids && (new Set(ids).size !== ids.length || ids.some(id => !dataset.cases.some(sample => sample.id === id)))) throw new Error("INVALID_CASE_SELECTION");
  const cases = ids ? dataset.cases.filter(sample => ids.includes(sample.id)) : dataset.cases.filter(sample => split === "ALL" || sample.split === split);
  if (!cases.length) throw new Error("NO_SELECTED_CASES");
  return cases;
}
function emptyRun(dataset: ConversationDataset, ids: string[], purpose: ConversationRun["purpose"] = "ENGINEERING_DEBUG", auditReason: string | null = null): ConversationRun {
  return { schemaVersion: "1.0", runId: randomUUID(), createdAt: new Date().toISOString(), datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash: hashValue(dataset), caseIds: ids, mode: "SIMULATED", purpose, auditReason, provider: "mock", model: "deterministic-demo-v1", promptVersion: DIAGNOSIS_PROMPT_VERSION,trustPolicyVersion:'M8.1', records: [] };
}
try {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value.startsWith("--")) {
      if (!["--split", "--cases", "--audit-blind"].includes(value) || !argv[index + 1] || argv[index + 1].startsWith("--") || options.has(value)) throw new Error("INVALID_CLI_OPTION");
      options.set(value, argv[++index]);
    } else positions.push(value);
  }
  if (!["validate", "plan", "simulate", "score", "prepare-teacher", "prepare-output-reviews"].includes(command ?? "")) throw new Error("COMMAND_REQUIRED_VALIDATE_PLAN_SIMULATE_SCORE_PREPARE_TEACHER_PREPARE_OUTPUT_REVIEWS");
  const dataset = conversationDatasetSchema.parse(await readJson(positions[0] ?? "tests/evaluation/m7/math-candidates.inputs.json"));
  if (command === "validate") {
    if (positions.length > 2 || options.size) throw new Error("INVALID_CLI_ARGUMENTS");
    const annotations = positions[1] ? conversationAnnotationSetSchema.parse(await readJson(positions[1])) : undefined;
    // A validation run has no provider calls and does not simulate a held-out case.
    const debugIds = dataset.cases.filter(sample => sample.split === "DEBUG").map(sample => sample.id);
    const validation = emptyRun(dataset, debugIds.length ? debugIds : dataset.cases.map(sample => sample.id), debugIds.length ? "ENGINEERING_DEBUG" : "BLIND_AUDIT", debugIds.length ? null : "SCHEMA_VALIDATION_ONLY_NO_MODEL_OUTPUT");
    scoreConversationEvaluation(dataset, validation, annotations);
    await save("validation.json", { status: "VALID", datasetId: dataset.datasetId, datasetHash: hashValue(dataset), cases: dataset.cases.length, debug: dataset.cases.filter(sample => sample.split === "DEBUG").length, blind: dataset.cases.filter(sample => sample.split === "BLIND").length, annotations: annotations?.annotations.length ?? 0, networkRequests: 0 });
    console.log(JSON.stringify({ status: "VALID", outputDirectory: out, cases: dataset.cases.length, networkRequests: 0 }));
  } else if (command === "plan" || command === "simulate") {
    if (positions.length > 1) throw new Error("INVALID_CLI_ARGUMENTS");
    const cases = selected(dataset), hasBlind = cases.some(sample => sample.split === "BLIND");
    const auditReason = options.get("--audit-blind")?.trim() ?? null;
    if (auditReason !== null && !auditReason) throw new Error("BLIND_AUDIT_REQUIRES_MEANINGFUL_REASON");
    if (command === "simulate" && hasBlind && !auditReason) throw new Error("BLIND_SIMULATION_BLOCKED_USE_EXPLICIT_AUDIT_REASON");
    const purpose = hasBlind || auditReason ? "BLIND_AUDIT" as const : "ENGINEERING_DEBUG" as const;
    const plan = { status: "NOT_RUN", mode: "PLAN_ONLY", purpose, datasetId: dataset.datasetId, datasetHash: hashValue(dataset), caseIds: cases.map(sample => sample.id), plannedConversations: cases.length, plannedTurns: cases.reduce((sum, sample) => sum + sample.studentReplies.length + 1, 0), networkRequests: 0, actualCostCny: 0, finalQualityPermitted: false, note: "离线入口只能Mock；BLIND仅显式审计用途，不能用于最终质量统计。" };
    await save("plan.json", plan);
    if (command === "plan") console.log(JSON.stringify({ ...plan, outputDirectory: out }));
    else {
      const { MockGateway } = await import("../../src/server/ai/providers/mock");
      const run = emptyRun(dataset, cases.map(sample => sample.id), purpose, auditReason);
      for (const sample of cases) {
        const record: ConversationRun["records"][number] = { caseId: sample.id, inputHash: conversationCaseInputHash(sample), turns: [] };
        run.records.push(record);
        let context = structuredClone(sample.initialContext);
        for (let turnIndex = 0; turnIndex <= sample.studentReplies.length; turnIndex++) {
          const gateway = new MockGateway();
          let output: unknown, errorCode: string | undefined;
          try { output = await gateway.createDiagnosisTurn(context); } catch { errorCode = "MOCK_SIMULATION_FAILURE"; }
          const invocation = gateway.lastInvocation;
          record.turns.push({ turnIndex, context: structuredClone(context), contextHash: hashValue(context), status: errorCode ? "ERROR" : "SUCCESS", ...(errorCode ? { errorCode } : { output }), invocation: { latencyMs: invocation?.latencyMs ?? null, inputTokens: null, outputTokens: null, attempts: invocation?.attempts ?? 1, estimatedCostCny: 0, costBasis: "本地Mock，无供应商调用；只计供应商API费用，不计CPU或总运行成本。" } });
          // Immutable checkpoint after every attempt; existing artifacts are never overwritten.
          await save(`checkpoint-${run.records.length}-${turnIndex}.json`, conversationRunSchema.parse(run));
          if (errorCode || isConversationTerminal(output as DiagnosisTurn)) break;
          if (turnIndex < sample.studentReplies.length) context = advanceConversationContext(sample, context, output as DiagnosisTurn, turnIndex,run.trustPolicyVersion);
        }
      }
      const validated = conversationRunSchema.parse(run), report = scoreConversationEvaluation(dataset, validated);
      const runPath = await save("run.json", validated); await save("score.json", report);
      await save("simulation-notice.json", { mode: "SIMULATED", provider: "mock", networkRequests: 0, actualCostCny: 0, finalQualityPermitted: false, blindAudit: hasBlind, auditReason, warning: "模拟工程结果；不是实模测试、教师质量分或真实学生效果。学生回复为固定脚本，需人工判断与实际追问是否衔接。" });
      console.log(JSON.stringify({ status: report.reliability.failedConversations ? "SIMULATED_WITH_FAILURES" : "SIMULATED", mode: "SIMULATED", runPath, outputDirectory: out, networkRequests: 0, actualCostCny: 0, formalQuality: report.formalQuality, reliability: report.reliability }));
      if (report.reliability.failedConversations) process.exitCode = 1;
    }
  } else if (command === "score") {
    if (!positions[1] || positions.length > 4 || options.size) throw new Error("SCORE_REQUIRES_INPUTS_RUN_OPTIONAL_LABELS_REVIEWS");
    const run = await readJson(positions[1]), annotations = positions[2] ? await readJson(positions[2]) : undefined, reviews = positions[3] ? await readJson(positions[3]) : undefined;
    const report = scoreConversationEvaluation(dataset, run, annotations, reviews);
    const reportPath = await save("score.json", report);
    console.log(JSON.stringify({ status: report.reliability.failedConversations ? "HAS_FAILURES" : "SCORED", reportPath, reliability: report.reliability, formalQuality: report.formalQuality, networkRequests: 0 }));
    if (report.reliability.failedConversations) process.exitCode = 1;
  } else if (command === "prepare-teacher") {
    if (positions.length > 1 || options.size) throw new Error("PREPARE_TEACHER_ACCEPTS_INPUTS_ONLY");
    const template = { schemaVersion: "1.0", datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash: hashValue(dataset), annotations: dataset.cases.map(sample => ({ caseId: sample.id, inputHash: conversationCaseInputHash(sample), provenance: "AUTHOR_PROVISIONAL", expected: { trueWrongStepIdSets: null, allowedCategories: null, requiresAbstention: null, noErrorExpected: null, requiresCounterevidenceCorrection: null, forbidPrematureAnswer: null, teacherNotes: "待教师独立阅读原始题目、步骤和会话脚本后填写；此占位内容不是金标。" }, review: { status: "DRAFT", independentReviews: [] } })) };
    conversationAnnotationSetSchema.parse(template);
    await save("reviewer-a.annotations.draft.json", template); await save("reviewer-b.annotations.draft.json", template);
    await save("teacher-input-packet.json", { schemaVersion: "1.0", datasetId: dataset.datasetId, datasetHash: hashValue(dataset), cases: dataset.cases.map(sample => ({ caseId: sample.id, inputHash: conversationCaseInputHash(sample), subject: sample.subject, gradeBand: sample.gradeBand, initialContext: sample.initialContext, studentReplies: sample.studentReplies })) });
    console.log(JSON.stringify({ status: "UNREVIEWED_TEACHER_PACKETS_PREPARED", outputDirectory: out, networkRequests: 0, teacherReviewed: false }));
  } else {
    if (!positions[1] || positions.length > 2 || options.size) throw new Error("PREPARE_OUTPUT_REVIEWS_REQUIRES_INPUTS_AND_RUN_ONLY");
    const run = conversationRunSchema.parse(await readJson(positions[1]));
    const report = scoreConversationEvaluation(dataset, run);
    const template = { schemaVersion: "1.0", runId: run.runId, reviews: report.rows.map(row => ({ caseId: row.caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash, ratings: { ...Object.fromEntries(CONVERSATION_RUBRIC_METRICS.map(key => [key, null])), rationale: "待教师独立按量表审阅完整会话；引用具体回合与学生证据，未审阅保留null。" }, review: { status: "DRAFT", independentReviews: [] } })) };
    conversationOutputReviewSetSchema.parse(template);
    await save("reviewer-a.output-reviews.draft.json", template); await save("reviewer-b.output-reviews.draft.json", template);
    await save("teacher-transcript-packet.json", { schemaVersion: "1.0", runId: run.runId, cases: report.rows.map(row => {
      const sample = dataset.cases.find(sample => sample.id === row.caseId)!;
      return { caseId: row.caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash, initialContext: sample.initialContext, studentReplies: sample.studentReplies, transcript: conversationTranscriptProjection(run.records.find(record => record.caseId === row.caseId) ?? { caseId: row.caseId, inputHash: row.inputHash, turns: [] }), scheduledTurns: row.turns.length, notScheduledAfterTerminal: row.notScheduledAfterTerminal };
    }) });
    // Recheck the exact payload included in the teacher packet, including unsuccessful attempts.
    for (const row of report.rows) if (row.transcriptHash !== conversationTranscriptHash(run.records.find(record => record.caseId === row.caseId) ?? { caseId: row.caseId, inputHash: row.inputHash, turns: [] })) throw new Error("TRANSCRIPT_PACKET_HASH_MISMATCH");
    console.log(JSON.stringify({ status: "UNREVIEWED_OUTPUT_PACKETS_PREPARED", outputDirectory: out, networkRequests: 0, formalQuality: null }));
  }
} catch (error) {
  const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "INVALID_CONFIG_OR_INPUT";
  await save("blocked.json", { status: "BLOCKED", reason, networkRequests: 0, actualCostCny: 0 });
  console.error(JSON.stringify({ status: "BLOCKED", reason, outputDirectory: out, networkRequests: 0 }));
  process.exitCode = 2;
}
