import "server-only";
import type { DiagnosisFinding, DiagnosisTurn, FindingCategory, RecognitionResult } from "./schemas/diagnosis";
import type { PracticeBankItem } from "../domain/practice-bank";
import { AliyunGateway } from "./providers/aliyun";
import { MockGateway } from "./providers/mock";

export interface DiagnosisContext {
  questionId: string;
  questionText: string;
  subject: string;
  gradeBand: string;
  steps: Array<{ id: string; text: string }>;
  messages: Array<{ id: string; role: "USER" | "ASSISTANT"; content: string }>;
  findings: DiagnosisFinding[];
  turnCount: number;
  hintLevel: 0 | 1 | 2 | 3;
  requestedAction?: "REPLY" | "HINT" | "FINISH";
}
export interface ImageRecognitionInput {
  images: Array<{ dataUrl: string }>;
}
export interface PracticeDraftInput { category: FindingCategory; count?: number }
export interface PracticeDraftResult { items: PracticeBankItem[]; source: "ORIGINAL_RULE_CHECKED"; warning: string }
export interface ModelInvocation {
  provider: "mock" | "aliyun";
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  attempts: number;
  status: "SUCCESS" | "ERROR";
  errorClass?: string;
  costEstimate: number | null;
}
export interface ModelGateway {
  readonly mode: "mock" | "live";
  lastInvocation: ModelInvocation | null;
  recognizeQuestion(input: ImageRecognitionInput): Promise<RecognitionResult>;
  createDiagnosisTurn(input: DiagnosisContext): Promise<DiagnosisTurn>;
  draftPracticeItems(input: PracticeDraftInput): Promise<PracticeDraftResult>;
}
export class GatewayError extends Error {
  constructor(public readonly code: "AI_UNAVAILABLE" | "AI_TIMEOUT" | "AI_INVALID_OUTPUT" | "AI_NOT_CONFIGURED" | "AI_RATE_LIMITED", message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Create one instance per request: invocation metadata is never shared across users. */
export function createGateway(): ModelGateway {
  const mode = process.env.AI_MODE ?? "mock";
  if (mode === "mock") {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_IN_PRODUCTION !== "true") {
      throw new GatewayError("AI_NOT_CONFIGURED", "生产环境未启用真实模型。请配置模型后重试。");
    }
    return new MockGateway();
  }
  if (mode !== "live") throw new GatewayError("AI_NOT_CONFIGURED", "模型模式配置不正确。");
  return new AliyunGateway({
    apiKey: process.env.ALIYUN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "",
    baseUrl: process.env.ALIYUN_BASE_URL ?? process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: process.env.AI_DEFAULT_MODEL ?? process.env.AI_PRIMARY_MODEL ?? "qwen3.8-flash",
  });
}
export type { DiagnosisTurn, DiagnosisFinding, RecognitionResult } from "./schemas/diagnosis";
