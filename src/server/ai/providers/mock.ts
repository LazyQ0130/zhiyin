import "server-only";
import type { DiagnosisContext, ImageRecognitionInput, ModelGateway, ModelInvocation, PracticeDraftInput, PracticeDraftResult } from "../gateway";
import type { DiagnosisFinding, DiagnosisTurn, Evidence, RecognitionResult } from "../schemas/diagnosis";
import { DIAGNOSIS_PROMPT_VERSION } from "../prompts/diagnosis-v1";
import { validateDiagnosisTurn } from "../validate-turn";
import { inspectDemoSteps, isDemoQuadratic, isDemoReading, normalizeMath, parseNumericAnswer } from "../../domain/math-verifier";
import { selectPracticeItems } from "../../domain/practice-bank";

export class MockGateway implements ModelGateway {
  readonly mode = "mock" as const;
  lastInvocation: ModelInvocation | null = null;

  async recognizeQuestion(_input: ImageRecognitionInput): Promise<RecognitionResult> {
    void _input;
    return { text: "", needsCorrection: true, warning: "演示模式不会识别图片，请参照原图手动输入并确认题目；无法看清时请重新上传。", isDemo: true };
  }

  async draftPracticeItems(input: PracticeDraftInput): Promise<PracticeDraftResult> {
    return {items: selectPracticeItems(input.category, input.count), source: "ORIGINAL_RULE_CHECKED", warning: "原创工程训练题已通过确定性计算检查，尚未经过教师审核；仅用于封闭试测。"};
  }

  async createDiagnosisTurn(input: DiagnosisContext): Promise<DiagnosisTurn> {
    const start = Date.now();
    const turn = validateDiagnosisTurn(this.decide(input), input);
    this.lastInvocation = { provider: "mock", model: "deterministic-demo-v1", promptVersion: DIAGNOSIS_PROMPT_VERSION, inputTokens: null, outputTokens: null, latencyMs: Date.now()-start, attempts: 1, status: "SUCCESS", costEstimate: null };
    return turn;
  }

  private decide(input: DiagnosisContext): DiagnosisTurn {
    const base: DiagnosisTurn = {schemaVersion: "1.0", action: "MARK_INCONCLUSIVE", studentFacingText: "", referencedStepIds: [], findings: [], followUpQuestion: null, hintLevel: input.hintLevel, safetyFlags: ["DEMO_MODE"]};
    const ask = (question: string, findings: DiagnosisFinding[] = [], references: string[] = []): DiagnosisTurn => ({...base, action: "ASK_ONE_QUESTION", studentFacingText: question, followUpQuestion: question, hintLevel: 0, findings, referencedStepIds: references});
    const latest = [...input.messages].reverse().find(m => m.role === "USER");
    const replyEvidence: Evidence[] = latest ? [{ kind: "STUDENT_REPLY", sourceId: latest.id, excerpt: latest.content.slice(0, 1000) }] : [];
    const mathCase = input.subject === "MATH" && isDemoQuadratic(input.questionText);
    const readingCase = input.subject === "CHINESE" && isDemoReading(input.questionText);
    if (!mathCase && !readingCase) return {...base, studentFacingText: "当前是演示模式，仅支持内置判别式案例与‘至少 12 周岁’语义案例。这道题超出已验证演示范围，现有信息保留为待确认。", safetyFlags: ["DEMO_MODE", "UNSUPPORTED_CASE"]};
    if (input.requestedAction === "FINISH" || input.turnCount >= 6) return {...base, studentFacingText: "本次诊断已结束。已记录你提交的步骤与回答；仍不足以确认的原因保留为待确认。可以从档案重新查看，或开始一个新的诊断。", findings: input.findings.map(f => ({...f, status: f.status === "HYPOTHESIS" ? "UNRESOLVED" : f.status, verificationNeeded: f.status !== "REFUTED"}))};
    if (!input.steps.length || input.steps.every(s => !s.text.trim())) return ask("你原本打算怎样解这道题？请写出第一步思路。".replace("？请", "，请"));

    if (readingCase) {
      const wrong = input.steps.find(s => /不符合|必须超过|不包括/.test(s.text));
      if (input.requestedAction === "HINT") return {...base, action: "GIVE_HINT", hintLevel: 1, studentFacingText: "关注‘至少’的边界，比较它与‘超过’的意思。已记录使用提示。", findings: input.findings};
      if (!wrong) return input.turnCount === 0 ? ask("你能用自己的话解释‘至少满 12 周岁’的边界吗？") : {...base, action: "FINISH_REPORT", studentFacingText: "已确认：没有在已提交的步骤中发现可确定的错误。待确认：尚不能据此判断其他阅读情境中的表现。"};
      const finding: DiagnosisFinding = {findingKey:"at-least-boundary", category:"READING", statement:"这一步将‘至少满 12 周岁’读成了‘超过 12 周岁’，可能遗漏等于的边界。", status:"HYPOTHESIS", supportingEvidence:[{kind:"STUDENT_STEP",sourceId:wrong.id,excerpt:wrong.text}],contradictingEvidence:[],verificationNeeded:true};
      if (input.turnCount === 0 || !latest) return ask("‘至少满 12 周岁’是否包括恰好满 12 周岁？", [finding], [wrong.id]);
      const corrected = !/不包括|不符合/.test(latest.content) && /包括|符合|等于/.test(latest.content);
      return {...base, action:"FINISH_REPORT", referencedStepIds:[wrong.id], findings:[{...finding,status:"SUPPORTED",contradictingEvidence:corrected ? replyEvidence : [], supportingEvidence:[...finding.supportingEvidence,...(corrected ? [] : replyEvidence)]}], studentFacingText: corrected ? "已确认：原步骤遗漏了‘至少’包含等于的边界；你的新回答修正了这一点。待确认：一次修正不能说明其他阅读情境都能独立处理。" : "已确认：原步骤把‘至少’和‘超过’混淆。待确认：还需通过新的边界判断题核实原因及独立表现。"};
    }
    const {wrongDiscriminant: wrong, correctDiscriminant, correctRoots} = inspectDemoSteps(input.steps);
    if (input.requestedAction === "HINT") return {...base, action: "GIVE_HINT", hintLevel: Math.min(3, input.hintLevel+1) as 1|2|3, studentFacingText: input.hintLevel < 1 ? "先只检查判别式里的 −4ac。把 a 和 c 连同符号代入，再计算正负号。已记录使用提示。" : "局部提示：−4×1×6 = −24，因此这一项是负数。请回到自己的步骤核对；本轮已记录辅助。", findings: input.findings, referencedStepIds: wrong ? [wrong.id] : []};
    if (!wrong) {
      if (correctDiscriminant && correctRoots) return input.turnCount === 0 ? ask("现有步骤与规则核算一致。你能说明将两根代回原方程后如何检查吗？", [], [correctRoots.id]) : {...base, action:"FINISH_REPORT", studentFacingText:"已确认：你提交的判别式及两根与确定性计算一致，没有发现这几步存在错误。待确认：这只支持本题作答，后续可用新题检验独立表现。", referencedStepIds:[correctDiscriminant.id,correctRoots.id]};
      return input.turnCount === 0 ? ask("目前还无法定位一个具体错误，你能写出计算判别式时的代入过程吗？") : {...base, studentFacingText:"现有过程还不足以定位可靠的错因。保留为待确认，没有把未提供的步骤当成错误。"};
    }
    const stepEvidence: Evidence = {kind:"STUDENT_STEP",sourceId:wrong.id,excerpt:wrong.text};
    const observation: DiagnosisFinding = {findingKey:"discriminant-sign",category:"EXECUTION",statement:"该步骤将判别式的 −4ac 项写成正数，与确定性计算不一致；原因仍需核实。",status:"HYPOTHESIS",supportingEvidence:[stepEvidence],contradictingEvidence:[],verificationNeeded:true};
    const misconception: DiagnosisFinding = {findingKey:"sign-rule-confusion",category:"KNOWLEDGE",statement:"可能混淆了 −4ac 中负号的含义，需要一次单独核算来核实。",status:"HYPOTHESIS",supportingEvidence:[stepEvidence],contradictingEvidence:[],verificationNeeded:true};
    if (input.turnCount === 0 || !latest) return ask("你第 2 类计算中出现了正号。已知 a=1、b=−5、c=6，−4ac 等于多少？".replace("第 2 类计算", `第 ${input.steps.indexOf(wrong)+1} 步`), [observation,misconception], [wrong.id]);
    const normalized = normalizeMath(latest.content);
    const corrected = parseNumericAnswer(latest.content) === -24 || /-4ac=-24|所以是1|判别式是1|δ=1/.test(normalized);
    const explicitlyWrong = parseNumericAnswer(latest.content) === 24 || /-4ac=\+?24/.test(normalized);
    if (!corrected && !explicitlyWrong) return {...base, studentFacingText:"已记录原步骤中的符号差异，但你的回答尚不足以区分笔误、计算失误或规则理解问题。结论保留为待确认。", referencedStepIds:[wrong.id], findings:[{...observation,status:"UNRESOLVED"},{...misconception,status:"UNRESOLVED"}]};
    const ruleEvidence: Evidence = {kind:"TOOL_RESULT",sourceId:"rule:quadratic-v1",excerpt:"−4ac=-24; Δ=1"};
    return {...base, action:"FINISH_REPORT",referencedStepIds:[wrong.id], findings:[
      {...observation,status:"SUPPORTED",statement:corrected ? "原判别式步骤存在符号差异；后续核算已修正，更可能是本次执行失误，不能据此断言概念不理解。" : "原步骤和本次单独核算均将 −4ac 当成正数，支持负号处理存在困难，但仍需新题区分具体原因。",supportingEvidence:[stepEvidence,ruleEvidence,...replyEvidence]},
      {...misconception,status:corrected ? "REFUTED":"SUPPORTED",verificationNeeded:!corrected,contradictingEvidence:corrected ? replyEvidence:[],supportingEvidence:corrected ? [stepEvidence]:[stepEvidence,...replyEvidence]},
    ],studentFacingText:corrected ? "已确认：原判别式中的符号与规则计算不一致，你在追问中已修正。‘不理解负号规则’的假设受到反证。待确认：尚不能区分笔误和偶发运算失误；建议用新题检查独立表现。" : "已确认：原步骤及追问回答都出现了负号处理差异。待确认：还不能据此断言长期概念困难。可先做一组判别式变式，帮助定位和验证。"};
  }
}
