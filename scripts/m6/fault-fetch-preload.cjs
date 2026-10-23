/* Test-process-only transport. Never imported by production application code. */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads must be CommonJS. */
const fs = require('node:fs');
const path = require('node:path');

const controlPath = process.env.M6_FAULT_CONTROL;
const nonce = process.env.M6_FAULT_NONCE;
if (process.env.NODE_ENV !== 'development' || !nonce || nonce.length < 32 || !controlPath || !path.isAbsolute(controlPath)) {
  throw new Error('M6 fault preload requires an isolated development runner.');
}
const app = new URL(process.env.APP_URL || '');
if (app.hostname !== '127.0.0.1' || process.env.AI_MODE !== 'live' || process.env.ALIYUN_API_KEY !== 'UNIT_TEST_PLACEHOLDER_M6_NOT_A_CREDENTIAL') {
  throw new Error('M6 fault preload refuses non-loopback or real credentials.');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async function interceptedFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') return originalFetch(input, init);
  if (!['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(url.hostname) || !url.pathname.endsWith('/chat/completions')) {
    throw new Error('M6 test process blocks all external fetch requests.');
  }
  const config = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
  if (config.nonce !== nonce) throw new Error('M6 test control authentication failed.');
  const payload = JSON.parse(init.body);
  if (payload.model !== 'qwen3.8-flash' || payload.enable_thinking !== false || payload.stream !== false || payload.response_format?.type !== 'json_object' || !Number.isInteger(payload.max_completion_tokens) || 'max_tokens' in payload || init.redirect !== 'error') throw new Error('M6 serialized Aliyun request does not match the reviewed configuration.');
  fs.appendFileSync(process.env.M6_FAULT_TRANSPORT_LOG, JSON.stringify({ at: new Date().toISOString(), scenario: config.scenario, transport: 'synthetic-fetch', paidCalls: 0, model: payload.model, enableThinking: payload.enable_thinking, maxCompletionTokens: payload.max_completion_tokens, requestParametersVerified: true }) + '\n');
  if (config.scenario === 'timeout') return new Promise(() => {}); // Exercises the adapter's real timeout timer.
  if (config.scenario === 'connection-failure') throw new TypeError('Synthetic connection failure; no network used.');
  if (config.scenario === 'invalid-json') return Response.json({ choices: [{ message: { content: '{invalid JSON' }, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 3 } });
  if (config.scenario === 'invalid-schema') return Response.json({ choices: [{ message: { content: JSON.stringify({ schemaVersion: '1.0', action: 'FINISH_REPORT' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 19, completion_tokens: 5 } });
  if (config.scenario !== 'success') throw new Error('M6 scenario must be explicit; no real-network fallback exists.');
  const context = JSON.parse(payload.messages.at(-1).content).untrustedStudentMaterial;
  const initial = context.turnCount === 0;
  const turn = {
    schemaVersion: '1.0', action: initial ? 'ASK_ONE_QUESTION' : 'MARK_INCONCLUSIVE',
    studentFacingText: initial ? '工程故障恢复夹具：请说明第二步中负号如何处理？' : '工程故障恢复夹具：已确认本次输入已保存；待确认具体错因，当前证据不足。',
    referencedStepIds: initial && context.steps[1] ? [context.steps[1].id] : [], findings: [],
    followUpQuestion: initial ? '第二步中负号如何处理？' : null, hintLevel: 0,
    safetyFlags: ['SYNTHETIC_TRANSPORT_TEST_ONLY'],
  };
  return Response.json({ choices: [{ message: { content: JSON.stringify(turn) }, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 7 } });
};
