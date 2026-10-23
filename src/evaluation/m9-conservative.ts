import { diagnosisTurnSchema, type DiagnosisTurn } from "../server/ai/schemas/diagnosis";
import { deriveMathStepRelations } from "../server/domain/math-evidence";
import { reviewAssistance } from "../server/domain/assistance-review";
import { conversationAssistantText, isConversationTerminal, scoreConversationEvaluation } from "./conversation-score";
import { conversationCaseInputHash, conversationDatasetSchema, conversationRunSchema, conversationTranscriptHash } from "./conversation-schemas";
import { buildM8TeacherPackets } from "./m8-teacher";
import { hashValue } from "./schemas";

const ACTIONS = ["ASK_ONE_QUESTION", "REQUEST_INPUT_CORRECTION", "GIVE_HINT", "FINISH_REPORT", "MARK_INCONCLUSIVE"] as const;
const KINDS = ["OBSERVATION", "HYPOTHESIS", "VERIFIED", "INCONCLUSIVE", "MISSING_TRUST"] as const;
const STATUSES = ["HYPOTHESIS", "SUPPORTED", "VERIFIED", "REFUTED", "UNRESOLVED"] as const;
const ROOT_ROLES = ["INITIAL", "PROPAGATED", "INDEPENDENT", "UNKNOWN", "MISSING_TRUST"] as const;
const VERIFICATION_STATES = ["NOT_CHECKED", "SUPPORTED", "WEAKENED", "REFUTED", "VERIFIED", "INCONCLUSIVE", "MISSING_TRUST"] as const;
const HELP_STATUSES = ["CLEAR", "DETECTED", "UNCERTAIN"] as const;
const zeroCounts = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map(key => [key, 0])) as Record<T, number>;
const sumCounts = <T extends string>(keys: readonly T[], rows: Record<T, number>[]) => Object.fromEntries(keys.map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)])) as Record<T, number>;

function findingCounts(outputs: DiagnosisTurn[]) {
  const kind = zeroCounts(KINDS), status = zeroCounts(STATUSES), rootRole = zeroCounts(ROOT_ROLES), verificationState = zeroCounts(VERIFICATION_STATES);
  for (const finding of outputs.flatMap(output => output.findings)) {
    kind[finding.trust?.kind ?? "MISSING_TRUST"]++;
    status[finding.status]++;
    rootRole[finding.trust?.rootCause.role ?? "MISSING_TRUST"]++;
    verificationState[finding.trust?.verification.state ?? "MISSING_TRUST"]++;
  }
  return { total: Object.values(status).reduce((sum, value) => sum + value, 0), kind, status, rootRole, verificationState };
}

/** Author-created counterexamples for teacher inspection; these are not false-positive labels. */
export function buildM9HelpProbes() {
  return [
    { id: "negated-formula", text: "我没有要求你用 b²−4ac；你当时是怎么想的？", concern: "公式出现在否定句中；请判断实际暴露及帮助力度，不能凭否定词或正则命中直接判误报。" },
    { id: "quoted-student-work", text: "你写的是“2+3=6”，请说明这一步的思路。", concern: "数值等式是在引用学生原作答且等式错误；请判断它是否构成新答案或已算结果的暴露。" },
    { id: "direction-without-answer", text: "请回看这一步的符号，你当时是怎么想的？", concern: "文本提供检查方向但没有给出答案；请判断1级帮助与独立性边界是否适当，无答案不等于无帮助。" },
  ].map(probe => ({ ...probe, provenance: "AUTHOR_SYNTHETIC_PROBE" as const, textHash: hashValue(probe.text),
    observedReview: reviewAssistance({ studentFacingText: probe.text, declaredHintLevel: 0 }),
    teacherVerdict: null, teacherRationale: "", state: "CANDIDATE_REQUIRES_TEACHER_REVIEW" as const }));
}

/**
 * Pure offline inspection of immutable author-created DEV Mock recordings.
 * The result counts observed engineering states; it never grades educational semantics.
 * No gateway, provider, prompt, permit, environment key, or network API is imported.
 */
export function auditM9Conservative(datasetValue: unknown, runValue: unknown) {
  const dataset = conversationDatasetSchema.parse(datasetValue), run = conversationRunSchema.parse(runValue);
  if (dataset.provenance !== "AUTHOR_CREATED_PROVISIONAL" || run.mode !== "SIMULATED" || run.provider !== "mock" || run.purpose !== "ENGINEERING_DEBUG" || run.trustPolicyVersion !== "M8.1") throw new Error("M9_AUTHOR_DEV_M8_MOCK_ONLY");
  const selected = run.caseIds.map(id => dataset.cases.find(sample => sample.id === id));
  if (selected.some(sample => !sample || sample.split !== "DEBUG" || sample.source.kind !== "AUTHOR_CREATED" || sample.reviewStatus !== "PROVISIONAL")) throw new Error("M9_DEV_ONLY_BLIND_OUTPUTS_FORBIDDEN");
  const engineering = scoreConversationEvaluation(dataset, run);
  // Do not silently analyse invalid recordings or normalize away original risks.
  if (engineering.reliability.failedConversations > 0) throw new Error("M9_REQUIRES_VALIDATED_RECORDED_CONVERSATIONS");
  const packets = buildM8TeacherPackets(dataset, run).A.packet;
  const rows = run.caseIds.map(caseId => {
    const sample = dataset.cases.find(sample => sample.id === caseId)!;
    const record = run.records.find(record => record.caseId === caseId)!;
    // The recording schema keys chronology by turnIndex and permits physical
    // array reordering. Inspect a sorted copy; retain original hash/source bytes.
    const orderedTurns = [...record.turns].sort((a, b) => a.turnIndex - b.turnIndex);
    const outputs = orderedTurns.map(turn => diagnosisTurnSchema.parse(turn.output));
    const final = outputs.at(-1)!;
    const action = zeroCounts(ACTIONS), helpStatus = zeroCounts(HELP_STATUSES);
    const help = orderedTurns.map((turn, index) => {
      const output = outputs[index];
      action[output.action]++;
      // Same content projection used by M8's recorded context continuation.
      const review = reviewAssistance({ studentFacingText: conversationAssistantText(output), findings: output.findings,
        declaredHintLevel: output.hintLevel, requestedAction: turn.context.requestedAction, subject: turn.context.subject, questionText: turn.context.questionText });
      helpStatus[review.status]++;
      const next = orderedTurns[index + 1];
      return { turnIndex: turn.turnIndex, observedOutputHash: hashValue(turn.output), review,
        persistedInNextContext: next?.context.messages.some(message => message.role === "ASSISTANT" && message.content === conversationAssistantText(output) && hashValue(message.assistance) === hashValue(review)) ?? false };
    });
    const scriptTurnCapacity = sample.studentReplies.length + 1;
    const earlyTerminal = isConversationTerminal(final) && record.turns.length < scriptTurnCapacity;
    const observedReplies = new Set(record.turns.flatMap(turn => turn.context.messages.filter(message => message.role === "USER").map(message => message.id)));
    const noStudentProcess = sample.initialContext.steps.every(step => !step.text.trim()) && !sample.initialContext.messages.some(message => message.role === "USER" && message.content.trim());
    const relations = deriveMathStepRelations(sample.initialContext);
    const selfConsistentSteps = relations.filter(relation => relation.role === "UNKNOWN").map(relation => relation.stepId);
    const supportScopeAbsent = outputs.some(output => output.safetyFlags.includes("UNSUPPORTED_CASE"));
    const arithmeticSelfConsistent = relations.length > 0 && relations.every(relation => relation.role === "UNKNOWN");
    const completeBoundedStepCoverage = relations.length === sample.initialContext.steps.filter(step => step.text.trim()).length;
    const earlyTerminalReviewCandidate = earlyTerminal && !supportScopeAbsent && !noStudentProcess && !(arithmeticSelfConsistent && completeBoundedStepCoverage);
    const finalCounts = findingCounts([final]);
    return { caseId, split: "DEV" as const, inputHash: conversationCaseInputHash(sample), transcriptHash: conversationTranscriptHash(record),
      scriptTurnCapacity, observedTurns: record.turns.length, finalAction: final.action, actionCounts: action,
      earlyTerminal, unscheduledTurnsAfterTerminal: earlyTerminal ? scriptTurnCapacity - record.turns.length : 0,
      observedScriptedReplies: sample.studentReplies.filter(reply => observedReplies.has(reply.id)).length,
      scriptedRepliesNotObserved: sample.studentReplies.filter(reply => !observedReplies.has(reply.id)).map(reply => reply.id),
      observedBoundarySignals: { supportScopeAbsent, noStudentProcess, arithmeticSelfConsistent, earlyTerminalReviewCandidate,
        interpretation: "可重叠的工程信号，不是合理/不合理弃答标签；有局部自洽等式不等于整题正确。" },
      arithmeticScope: { recognizedSteps: relations.length, completeBoundedStepCoverage, selfConsistentStepIds: selfConsistentSteps,
        unrecognizedStepIds: sample.initialContext.steps.filter(step => !relations.some(relation => relation.stepId === step.id)).map(step => step.id), relations },
      findingAppearances: findingCounts(outputs), finalFindings: finalCounts,
      finalUniqueCandidateRoots: new Set(final.findings.map(finding => finding.trust?.rootCause.candidateRootId).filter(Boolean)).size,
      helpStatusCounts: helpStatus, unknownHelpTurns: help.filter(turn => turn.review.status === "UNCERTAIN").length,
      zeroDeclaredUnknownHelpTurns: help.filter(turn => turn.review.status === "UNCERTAIN" && turn.review.declaredLevel === 0 && turn.review.effectiveLevel === null).length,
      helpReviews: help, teacherReviewState: "PENDING_ACTUAL_TEACHER_REVIEW" as const,
      reasonableAbstention: null, unreasonableAbstention: null, educationalQuality: null };
  });
  const totals = {
    scheduledCases: rows.length, observedTurns: rows.reduce((sum, row) => sum + row.observedTurns, 0), scriptTurnCapacity: rows.reduce((sum, row) => sum + row.scriptTurnCapacity, 0),
    actionCounts: sumCounts(ACTIONS, rows.map(row => row.actionCounts)),
    inconclusiveActionTurns: rows.reduce((sum, row) => sum + row.actionCounts.MARK_INCONCLUSIVE, 0),
    finalInconclusiveActionCases: rows.filter(row => row.finalAction === "MARK_INCONCLUSIVE").length,
    findingAppearances: { total: rows.reduce((sum, row) => sum + row.findingAppearances.total, 0), kind: sumCounts(KINDS, rows.map(row => row.findingAppearances.kind)), status: sumCounts(STATUSES, rows.map(row => row.findingAppearances.status)), rootRole: sumCounts(ROOT_ROLES, rows.map(row => row.findingAppearances.rootRole)), verificationState: sumCounts(VERIFICATION_STATES, rows.map(row => row.findingAppearances.verificationState)) },
    finalFindings: { total: rows.reduce((sum, row) => sum + row.finalFindings.total, 0), kind: sumCounts(KINDS, rows.map(row => row.finalFindings.kind)), status: sumCounts(STATUSES, rows.map(row => row.finalFindings.status)), rootRole: sumCounts(ROOT_ROLES, rows.map(row => row.finalFindings.rootRole)), verificationState: sumCounts(VERIFICATION_STATES, rows.map(row => row.finalFindings.verificationState)) },
    finalUniqueCandidateRootsWithinCases: rows.reduce((sum, row) => sum + row.finalUniqueCandidateRoots, 0),
    helpStatusCounts: sumCounts(HELP_STATUSES, rows.map(row => row.helpStatusCounts)),
    unknownHelpTurns: rows.reduce((sum, row) => sum + row.unknownHelpTurns, 0),
    unknownHelpPersistedInNextContextTurns: rows.reduce((sum, row) => sum + row.helpReviews.filter(turn => turn.review.status === "UNCERTAIN" && turn.persistedInNextContext).length, 0),
    unknownHelpRecomputedOnlyTurns: rows.reduce((sum, row) => sum + row.helpReviews.filter(turn => turn.review.status === "UNCERTAIN" && !turn.persistedInNextContext).length, 0),
    zeroDeclaredUnknownHelpTurns: rows.reduce((sum, row) => sum + row.zeroDeclaredUnknownHelpTurns, 0),
    earlyTerminalCases: rows.filter(row => row.earlyTerminal).length,
    unscheduledTurnsAfterTerminal: rows.reduce((sum, row) => sum + row.unscheduledTurnsAfterTerminal, 0),
    supportScopeAbsentCases: rows.filter(row => row.observedBoundarySignals.supportScopeAbsent).length,
    noStudentProcessCases: rows.filter(row => row.observedBoundarySignals.noStudentProcess).length,
    arithmeticSelfConsistentCases: rows.filter(row => row.observedBoundarySignals.arithmeticSelfConsistent).length,
    earlyTerminalReviewCandidateCases: rows.filter(row => row.observedBoundarySignals.earlyTerminalReviewCandidate).length,
  };
  const teacherQueue = rows.map(row => {
    const packetCase = packets.cases.find(sample => sample.caseId === row.caseId)!;
    const evidence = packetCase.sources.map(source => ({ sourceId: source.sourceId, textHash: source.textHash, start: 0, end: source.text.length }));
    return { caseId: row.caseId, inputHash: row.inputHash, transcriptHash: row.transcriptHash, state: "PENDING_ACTUAL_TEACHER_REVIEW" as const,
      sourceKind: "AUTHOR_CREATED_SYNTHETIC_DEV" as const, sources: packetCase.sources,
      questions: [
        { id: "abstention-boundary", topic: "appropriateAbstention", question: "只按本次实际可见输入与会话，是否应补充一个有判别价值的追问、继续核对或结束？请独立解释终止边界，勿把工程终态等同合理弃答。" },
        { id: "support-and-process", topic: "observationLocation", question: "请区分演示能力范围缺失、学生过程不足、受限局部算术自洽与其他不能判断的情况；局部自洽和规则未识别均不能证明整题正确。" },
        { id: "help-independence", topic: "hintPollutionControl", question: "逐轮帮助未知或已检测帮助是否与实际措辞相称？请检查是否提前给出方向、公式或结果，以及后续回答能否作为独立证据。没有发生的脚本回复不得作为证据。" },
        { id: "root-and-cause", topic: "rootCausePropagation", question: "请按实际证据独立标出观察、原因假设、起始错误、传播、独立错误与未知关系；同一候选根的多条发现不重复算成已验证心理原因。" },
        { id: "early-terminal", topic: "discriminativeQuestioning", question: "预设脚本容量尚有余量时的结束是否漏掉有价值的核实机会？容量剩余仅为排查线索；请判断实际追问和实际回答的衔接，不能利用未发生的预设回答推定本可诊断成功。" },
      ].map(question => ({ ...question, evidence, teacherAnswer: null, teacherRationale: "", teacherEvidence: [] })),
      warning: "作者生成的有方向问题队列，不是独立盲审金标或教师决定；正式审核沿用M8独立材料及实际来源签收。" };
  });
  return { schemaVersion: "M9.1", mode: "OFFLINE_DEV_CONSERVATIVE_AUDIT", datasetId: dataset.datasetId, datasetVersion: dataset.version, datasetHash: hashValue(dataset),
    runId: run.runId, runHash: hashValue(run), trustPolicyVersion: run.trustPolicyVersion,
    networkRequests: 0, newProviderCostCny: 0, teacherReviewedCases: 0, formalQuality: null,
    educationalAssessment: { reasonableAbstentionRate: null, unreasonableAbstentionRate: null, hintFalsePositiveRate: null, educationalAccuracy: null, reason: "无实际教师审核；只汇总工程状态、来源和待审问题。" },
    limitations: ["仅作者原创DEV Mock录制；不读取或生成BLIND输出，不运行新模型，不调整Prompt。", "ACTION/发现kind/旧status/verification.state分别统计，不互相视为教育判断。", "帮助复核为当前M8规则重算；终态没有下一轮上下文持久化，不能把重算误称新产品消息。", "根关系计数是录制标签的频数；受限算术的UNKNOWN不等于教师确认正确。", "原始录制只读保留；审查队列仅写入Git忽略的新.local目录，不能替代M8独立教师签收。"],
    totals, engineeringDiagnostics: engineering.engineeringDiagnostics, reliability: engineering.reliability, rows, helpProbes: buildM9HelpProbes(), teacherQueue };
}

export function renderM9ConservativeAudit(audit: ReturnType<typeof auditM9Conservative>) {
  const t = audit.totals;
  return ["# M9 DEV 保守策略离线审查", "", "仅为工程观察；实际教师审核0，教育语义、合理/不合理弃答率与提示误报率均未知。", "",
    `runId: ${audit.runId}`, `datasetHash: ${audit.datasetHash}`, `runHash: ${audit.runHash}`, "",
    `DEV会话 ${t.scheduledCases}；实际回合 ${t.observedTurns}；脚本容量 ${t.scriptTurnCapacity}；提前终态 ${t.earlyTerminalCases}；未调度 ${t.unscheduledTurnsAfterTerminal}。`,
    `MARK_INCONCLUSIVE回合 ${t.inconclusiveActionTurns}；终态为该action的会话 ${t.finalInconclusiveActionCases}。`,
    `发现出现次数kind: ${JSON.stringify(t.findingAppearances.kind)}；status: ${JSON.stringify(t.findingAppearances.status)}；verification.state: ${JSON.stringify(t.findingAppearances.verificationState)}；root role: ${JSON.stringify(t.findingAppearances.rootRole)}。`,
    `终态发现kind: ${JSON.stringify(t.finalFindings.kind)}；status: ${JSON.stringify(t.finalFindings.status)}；root role: ${JSON.stringify(t.finalFindings.rootRole)}；逐会话去重候选根 ${t.finalUniqueCandidateRootsWithinCases}。`,
    `帮助未知回合 ${t.unknownHelpTurns}；声明0且有效等级未知 ${t.zeroDeclaredUnknownHelpTurns}；其中下一轮上下文已保存 ${t.unknownHelpPersistedInNextContextTurns}、仅本次离线重算 ${t.unknownHelpRecomputedOnlyTurns}；帮助状态 ${JSON.stringify(t.helpStatusCounts)}。`,
    `范围缺失信号 ${t.supportScopeAbsentCases}；缺少学生过程信号 ${t.noStudentProcessCases}；已识别等式均局部自洽信号 ${t.arithmeticSelfConsistentCases}；排除上述信号后的提前终止候选 ${t.earlyTerminalReviewCandidateCases}。这些可重叠，不是合理性标签。`, "",
    "## 逐例工程观察", "", "|case|inputHash|transcriptHash|回合/容量|终态|范围缺失|缺过程|局部自洽|提前终止候选|", "|---|---|---|---|---|---|---|---|---|",
    ...audit.rows.map(row => `|${row.caseId}|${row.inputHash}|${row.transcriptHash}|${row.observedTurns}/${row.scriptTurnCapacity}|${row.finalAction}|${row.observedBoundarySignals.supportScopeAbsent}|${row.observedBoundarySignals.noStudentProcess}|${row.observedBoundarySignals.arithmeticSelfConsistent}|${row.observedBoundarySignals.earlyTerminalReviewCandidate}|`), "",
    "## 作者提示边界探针", "", ...audit.helpProbes.map(probe => `- ${probe.id}：${probe.observedReview.status}/${probe.observedReview.minimumLevel}；${probe.concern} 教师判断=null。`), "",
    "每例teacherQueue绑定完整inputHash/transcriptHash及来源textHash，问题答案和教师结论保持null。原文与队列只保存在本次.local目录。", "", ...audit.limitations.map(line => `- ${line}`), ""].join("\n");
}
