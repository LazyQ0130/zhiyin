import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { aliyunEndpoint } from "../server/ai/configuration";
import type { DiagnosisContext } from "../server/ai/gateway";
import { DIAGNOSIS_PROMPT_VERSION, DIAGNOSIS_SYSTEM_PROMPT } from "../server/ai/prompts/diagnosis-v1";
import { deterministicToolResults } from "../server/ai/validate-turn";
import { conversationCaseInputHash, conversationDatasetSchema } from "./conversation-schemas";
import { QWEN_MAX_INPUT_TOKENS } from "./live-control";
import { M9_RULE_FILES } from "./m9-live-plan";
import { buildM8TeacherPackets, isM8HumanVerifiedDecision } from "./m8-teacher";
import { m8ReviewDecisionSchema } from "./m8-teacher-schemas";
import { evaluationContextSchema, hashValue } from "./schemas";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(z.string().trim().min(1).max(160)).min(1).max(3).refine(values => new Set(values).size === values.length, "M9_DUPLICATE_CASE_IDS");
const hashes = z.record(z.string(), sha);
const sourceHashesSchema = hashes.refine(value => Object.keys(value).length === M9_RULE_FILES.length && M9_RULE_FILES.every(file => file in value), "M9_EXACT_RULE_SOURCE_HASHES_REQUIRED");
export const M9_MULTI_LEDGER_DIRECTORY = path.resolve(".local/eval-authorizations");
export const M9_MULTI_PRICE_SOURCE = "https://help.aliyun.com/zh/model-studio/qwen3-8-flash";

/** Human-owned executable permission; there is deliberately no approval builder. */
export const m9MultiPermitSchema = z.strictObject({
  schemaVersion: z.literal("M9.MULTI.1"), authorizationId: z.uuid(), approved: z.literal(true), approvedBy: z.string().trim().min(1).max(160),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), datasetHash: sha, caseIds: ids,
  caseInputHashes: hashes, teacherGoldDecisionHashes: hashes,
  model: z.literal("qwen3.8-flash"), baseUrl: z.literal("https://dashscope.aliyuncs.com/compatible-mode/v1"), region: z.literal("cn-beijing"),
  promptVersion: z.literal(DIAGNOSIS_PROMPT_VERSION), trustPolicyVersion: z.literal("M8.1"), sourceHashes: sourceHashesSchema,
  maxTurnsPerSession: z.number().int().min(1).max(3), maxRequests: z.number().int().min(1).max(9), maxSpendCny: z.number().positive().max(8),
  maxCompletionTokens: z.number().int().min(128).max(2500), maxRequestBytes: z.number().int().min(512).max(200000), timeoutMs: z.number().int().min(1).max(25000),
  maxRetries: z.literal(0), concurrency: z.literal(1),
  pricing: z.strictObject({ currency: z.literal("CNY"), inputPerMillion: z.number().finite().min(0.8), outputPerMillion: z.number().finite().min(2.7),
    source: z.literal(M9_MULTI_PRICE_SOURCE), verifiedAt: z.iso.datetime(), region: z.literal("cn-beijing"),
    maximumModelInputTokens: z.literal(QWEN_MAX_INPUT_TOKENS), completionToleranceTokens: z.literal(10), discountAssumed: z.literal(false) }),
}).superRefine((permit, ctx) => {
  for (const field of ["caseInputHashes", "teacherGoldDecisionHashes"] as const) {
    if (Object.keys(permit[field]).length !== permit.caseIds.length || permit.caseIds.some(id => !(id in permit[field]))) ctx.addIssue({ code: "custom", path: [field], message: "M9_EXACT_CASE_HASH_BINDINGS_REQUIRED" });
  }
  if (permit.maxRequests < permit.caseIds.length || permit.maxRequests > permit.caseIds.length * permit.maxTurnsPerSession) ctx.addIssue({ code: "custom", path: ["maxRequests"], message: "M9_REQUEST_SESSION_LIMIT_MISMATCH" });
});
export type M9MultiPermit = z.infer<typeof m9MultiPermitSchema>;
export type M9MultiBinding = { dataset: unknown; caseIds: string[]; sourceHashes: Record<string, string>; teacherGoldDecisions: readonly unknown[]; signedSourceBytes: readonly Uint8Array[] };

function checkFreshness(permit: M9MultiPermit, now: Date): void {
  const issued = Date.parse(permit.issuedAt), expires = Date.parse(permit.expiresAt), time = now.getTime();
  if (!Number.isFinite(time) || issued > time || expires <= time || expires <= issued || expires - issued > 86400000) throw new Error("M9_PERMIT_EXPIRED_OR_INVALID_WINDOW");
  const priceAge = time - Date.parse(permit.pricing.verifiedAt);
  if (priceAge < 0 || priceAge > 7 * 86400000) throw new Error("M9_PRICING_NOT_RECENTLY_VERIFIED");
}

/** Reserve against the official whole-model input limit, with no token estimate or discounts. */
export function m9ReservedCostCny(permit: M9MultiPermit): number {
  return (QWEN_MAX_INPUT_TOKENS * permit.pricing.inputPerMillion + (permit.maxCompletionTokens + 10) * permit.pricing.outputPerMillion) / 1e6;
}

/** Missing or invalid usage stays unknown; it must never release the reservation. */
export function m9EstimateCostCny(inputTokens: number | null, outputTokens: number | null, permit: M9MultiPermit): number | null {
  if (inputTokens === null || outputTokens === null || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0 || inputTokens > QWEN_MAX_INPUT_TOKENS || outputTokens > permit.maxCompletionTokens + 10) return null;
  return (inputTokens * permit.pricing.inputPerMillion + outputTokens * permit.pricing.outputPerMillion) / 1e6;
}

export function authorizeM9MultiPermit(value: unknown, binding: M9MultiBinding, now = new Date()): M9MultiPermit {
  const permit = m9MultiPermitSchema.parse(value), dataset = conversationDatasetSchema.parse(binding.dataset);
  checkFreshness(permit, now);
  if (dataset.provenance !== "AUTHOR_CREATED_TEACHER_REVIEWED") throw new Error("M9_NEW_TEACHER_REVIEWED_DATASET_REQUIRED");
  if (permit.datasetHash !== hashValue(dataset) || hashValue(permit.caseIds) !== hashValue(binding.caseIds)) throw new Error("M9_PERMIT_DATASET_OR_SELECTION_MISMATCH");
  if (hashValue(permit.sourceHashes) !== hashValue(sourceHashesSchema.parse(binding.sourceHashes))) throw new Error("M9_RULE_SOURCES_CHANGED");
  if (m9ReservedCostCny(permit) * permit.maxRequests > permit.maxSpendCny) throw new Error("M9_PERMIT_BUDGET_TOO_LOW");
  const decisions = binding.teacherGoldDecisions.map(value => m8ReviewDecisionSchema.parse(value));
  if (decisions.length !== permit.caseIds.length || new Set(decisions.map(row => row.caseId)).size !== decisions.length) throw new Error("M9_EXACT_TEACHER_GOLD_DECISIONS_REQUIRED");
  const rebuilt = buildM8TeacherPackets(dataset).A.packet;
  const byteSources = new Set(binding.signedSourceBytes.map(bytes => `${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`));
  for (const caseId of permit.caseIds) {
    const sample = dataset.cases.find(sample => sample.id === caseId), decision = decisions.find(row => row.caseId === caseId);
    if (!sample || sample.split !== "DEBUG" || sample.reviewStatus !== "TEACHER_REVIEWED" || sample.source.kind !== "AUTHOR_CREATED") throw new Error("M9_REVIEWED_DEV_SELECTION_REQUIRED");
    if (conversationCaseInputHash(sample) !== permit.caseInputHashes[caseId]) throw new Error("M9_ORIGINAL_INPUT_HASH_CHANGED");
    if (!decision || hashValue(decision) !== permit.teacherGoldDecisionHashes[caseId] || decision.inputHash !== permit.caseInputHashes[caseId] || decision.reviewKind !== "INPUT_GOLD" || decision.transcriptHash !== null || !isM8HumanVerifiedDecision(decision)) throw new Error("M9_HUMAN_VERIFIED_INPUT_GOLD_REQUIRED");
    for (const original of decision.originals) {
      const packet = original.packet;
      if (packet.datasetId !== dataset.datasetId || packet.datasetVersion !== dataset.version || packet.datasetHash !== permit.datasetHash || packet.reviewKind !== "INPUT_GOLD" || packet.runId !== null || packet.sourceKind !== "AUTHOR_CREATED") throw new Error("M9_TEACHER_PACKET_DATASET_BINDING_MISMATCH");
      for (const row of packet.cases) if (hashValue(row) !== hashValue(rebuilt.cases.find(expected => expected.caseId === row.caseId) ?? null)) throw new Error("M9_TEACHER_PACKET_INPUT_CONTENT_MISMATCH");
      if (!byteSources.has(`${original.signedSource.byteLength}:${original.signedSource.sourceHash}`)) throw new Error("M9_SIGNED_SOURCE_BYTES_REQUIRED");
    }
    if (decision.adjudication) {
      const third = decision.adjudication;
      if (decision.originals.some(original => original.signedSource.sourceHash === third.signedSourceHash) || !byteSources.has(`${third.signedSourceByteLength}:${third.signedSourceHash}`)) throw new Error("M9_DISTINCT_ADJUDICATION_SOURCE_BYTES_REQUIRED");
    }
  }
  return permit;
}

/** Shared M7 filename namespace makes previously consumed IDs unusable in M9. */
export function consumeM9MultiPermit(permit: M9MultiPermit, runId: string, ledgerDirectory = M9_MULTI_LEDGER_DIRECTORY): void {
  m9MultiPermitSchema.parse(permit);
  if (!runId.trim()) throw new Error("M9_RUN_ID_REQUIRED");
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(path.join(ledgerDirectory, `${permit.authorizationId}.json`), JSON.stringify({ schemaVersion: "M9.MULTI.1", authorizationId: permit.authorizationId, permitHash: hashValue(permit), runId, consumedAt: new Date().toISOString(), reservedCny: m9ReservedCostCny(permit) * permit.maxRequests }), { flag: "wx", mode: 0o600, flush: true });
}

export type M9MultiRequestBoundary = {
  caseId: string; inputHash: string; turnIndex: number; requests: number;
  committedSpendCny: number; reservedSpendCny: number; contextHash: string; expectedContext: DiagnosisContext; expectedBodyHash: string; usageKnown: boolean;
};

/** Check immediately before fetch. Counters include every previous request, including failures. */
export function guardM9MultiRequest(url: string, init: RequestInit | undefined, permitValue: M9MultiPermit, state: M9MultiRequestBoundary, now = new Date()): void {
  const permit = m9MultiPermitSchema.parse(permitValue);
  checkFreshness(permit, now);
  if (state.usageKnown !== true) throw new Error("M9_UNKNOWN_USAGE_HALTS_EXECUTION");
  if (!permit.caseIds.includes(state.caseId) || permit.caseInputHashes[state.caseId] !== state.inputHash || !Number.isInteger(state.turnIndex) || state.turnIndex < 0 || state.turnIndex >= permit.maxTurnsPerSession) throw new Error("M9_REQUEST_CASE_OR_TURN_OUTSIDE_PERMISSION");
  if (!Number.isInteger(state.requests) || state.requests < 0 || state.requests >= permit.maxRequests || url !== aliyunEndpoint(permit.baseUrl) || init?.method !== "POST" || init.redirect !== "error") throw new Error("M9_REQUEST_OUTSIDE_PERMISSION");
  if (![state.committedSpendCny, state.reservedSpendCny].every(value => Number.isFinite(value) && value >= 0) || state.committedSpendCny + state.reservedSpendCny + m9ReservedCostCny(permit) > permit.maxSpendCny) throw new Error("M9_REQUEST_BUDGET_EXCEEDED");
  if (!sha.safeParse(state.contextHash).success || !sha.safeParse(state.expectedBodyHash).success || typeof init.body !== "string" || Buffer.byteLength(init.body, "utf8") > permit.maxRequestBytes || hashValue(init.body) !== state.expectedBodyHash) throw new Error("M9_REQUEST_BODY_HASH_OR_SIZE_MISMATCH");
  let body: Record<string, unknown>;
  try { body = JSON.parse(init.body); } catch { throw new Error("M9_REQUEST_PARAMETERS_OUTSIDE_PERMISSION"); }
  const expectedKeys = ["model", "messages", "stream", "enable_thinking", "response_format", "max_completion_tokens"];
  const messages = body?.messages as Array<{ role?: unknown; content?: unknown }> | undefined;
  if (!body || Object.keys(body).length !== expectedKeys.length || expectedKeys.some(key => !(key in body)) || body.model !== permit.model || body.max_completion_tokens !== permit.maxCompletionTokens || body.enable_thinking !== false || body.stream !== false || hashValue(body.response_format) !== hashValue({ type: "json_object" }) || !Array.isArray(messages) || messages.length !== 2 || hashValue(messages[0]) !== hashValue({ role: "system", content: DIAGNOSIS_SYSTEM_PROMPT }) || messages[1]?.role !== "user" || typeof messages[1]?.content !== "string") throw new Error("M9_REQUEST_PARAMETERS_OUTSIDE_PERMISSION");
  try {
    const envelope = JSON.parse(messages[1].content);
    if (!envelope || Object.keys(envelope).length !== 1 || !("untrustedStudentMaterial" in envelope)) throw new Error();
    const { maximumTurns, toolResults, ...context } = envelope.untrustedStudentMaterial;
    if (maximumTurns !== permit.maxTurnsPerSession || !Array.isArray(toolResults)) throw new Error();
    evaluationContextSchema.parse(context);
    evaluationContextSchema.parse(state.expectedContext);
    if (hashValue(state.expectedContext) !== state.contextHash) throw new Error();
    const data = { ...state.expectedContext, messages: state.expectedContext.messages.slice(-12), toolResults: deterministicToolResults(state.expectedContext), maximumTurns: permit.maxTurnsPerSession };
    const expectedBody = JSON.stringify({ model: permit.model, messages: [{ role: "system", content: DIAGNOSIS_SYSTEM_PROMPT }, { role: "user", content: JSON.stringify({ untrustedStudentMaterial: data }) }], stream: false, enable_thinking: false, response_format: { type: "json_object" }, max_completion_tokens: permit.maxCompletionTokens });
    if (hashValue(expectedBody) !== state.expectedBodyHash || init.body !== expectedBody) throw new Error();
  } catch { throw new Error("M9_REQUEST_CONTEXT_OUTSIDE_PERMISSION"); }
}
