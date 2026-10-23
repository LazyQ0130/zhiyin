import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { ListDTO, SessionSummary } from '../../src/lib/contracts';
import { assertFailed, codes, evidence, faults, fixture, key, makeAttempt, persisted, readData, register, reply, scenario, session, transportCount, writeHeaders } from './helpers';

test('Fault transport guard refuses production, public origin and real credentials; external fetch is blocked', async () => {
  const preload = resolve('scripts/m6/fault-fetch-preload.cjs');
  for (const override of [{ NODE_ENV: 'production' }, { APP_URL: 'https://example.com' }, { ALIYUN_API_KEY: 'non-placeholder-key' }] as const) {
    const child = spawnSync(process.execPath, ['--require', preload, '-e', 'process.exit(0)'], { env: { ...process.env, NODE_ENV: 'development', ...override }, encoding: 'utf8' });
    expect(child.status).not.toBe(0); expect(child.stderr).toMatch(/M6 fault preload/);
  }
  const blocked = spawnSync(process.execPath, ['--require', preload, '-e', "fetch('https://network-must-never-be-used.invalid').then(()=>process.exit(1),e=>process.exit(e.message.includes('blocks all external')?0:2))"], { env: { ...process.env, NODE_ENV: 'development' }, encoding: 'utf8' });
  expect(blocked.status).toBe(0);
  await evidence('transport-guards', { productionRefused: true, publicOriginRefused: true, realCredentialRefused: true, unexpectedExternalFetchBlocked: true });
});

for (const fault of faults) test(`HTTP ${fault}: 503, persisted input, controlled recovery and idempotent replay`, async ({ request }) => {
  const initial = await fixture(request);
  const operation = key();
  await scenario(fault);
  const response = await request.post(`/api/v1/diagnoses/${initial.id}/turns`, { data: { action: 'REPLY', content: reply }, headers: writeHeaders(operation) });
  expect(response.status()).toBe(503);
  const error = await response.json();
  expect(error.error.code).toBe(codes[fault]); expect(error.requestId).toEqual(expect.any(String));
  expect(JSON.stringify(error)).not.toMatch(/UNIT_TEST_PLACEHOLDER|stack|Synthetic connection|\{invalid JSON/);
  const failed = await session(request, initial.id);
  expect(failed.status).toBe('FAILED_RETRYABLE');
  expect(failed.messages.filter(row => row.role === 'USER' && row.content === reply)).toHaveLength(1);
  await assertFailed(initial.id, operation, fault);
  await scenario('success');
  const recovered = await readData(await request.post(`/api/v1/diagnoses/${initial.id}/turns`, { data: { action: 'RETRY', content: '' }, headers: writeHeaders() }));
  expect(recovered).toMatchObject({ id: initial.id, status: 'INCONCLUSIVE', isDemo: false });
  const stable = await persisted(initial.id);
  expect(stable.messages.filter(row => row.operationKey === operation && row.role === 'USER')).toHaveLength(1);
  expect(stable.messages.filter(row => row.operationKey === operation && row.role === 'ASSISTANT')).toHaveLength(1);
  expect(stable.invocations).toHaveLength(3);
  expect(stable.invocations.every(row => row.provider === 'aliyun')).toBe(true);
  const callsBeforeReplay = await transportCount();
  const replay = await readData(await request.post(`/api/v1/diagnoses/${initial.id}/turns`, { data: { action: 'REPLY', content: reply }, headers: writeHeaders(operation) }));
  expect(replay).toMatchObject({ id: initial.id, status: 'INCONCLUSIVE' });
  expect(await transportCount()).toBe(callsBeforeReplay);
  expect((await persisted(initial.id)).messages).toEqual(stable.messages);
  const conflict = await request.post(`/api/v1/diagnoses/${initial.id}/turns`, { data: { action: 'REPLY', content: '不同的内容' }, headers: writeHeaders(operation) });
  expect(conflict.status()).toBe(409);
  await evidence('http-' + fault, { fault, errorCode: error.error.code, httpStatus: response.status(), savedUserMessages: 1, recoveredStatus: 'INCONCLUSIVE', replayExtraTransportCalls: 0, failedInvocation: stable.invocations.find(row => row.status === 'ERROR') });
});

test('HTTP initial failure reuses the original diagnosis and creation key', async ({ request }) => {
  await scenario('timeout'); await register(request, 'm6-initial');
  const { attempt } = await makeAttempt(request); const operation = key();
  const first = await request.post('/api/v1/diagnoses', { data: { attemptId: attempt.id }, headers: writeHeaders(operation) });
  expect(first.status()).toBe(503); expect((await first.json()).error.code).toBe('AI_TIMEOUT');
  const list = await readData<ListDTO<SessionSummary>>(await request.get('/api/v1/diagnoses'));
  expect(list.items).toHaveLength(1); const id = list.items[0].id;
  expect((await session(request, id)).status).toBe('FAILED_RETRYABLE');
  await assertFailed(id, null, 'timeout'); await scenario('success');
  const recovered = await readData(await request.post('/api/v1/diagnoses', { data: { attemptId: attempt.id }, headers: writeHeaders(operation) }));
  expect(recovered).toMatchObject({ id, status: 'QUESTIONING' });
  const replay = await readData(await request.post('/api/v1/diagnoses', { data: { attemptId: attempt.id }, headers: writeHeaders(operation) }));
  expect(replay).toMatchObject({ id });
  expect((await readData<ListDTO<SessionSummary>>(await request.get('/api/v1/diagnoses'))).items).toHaveLength(1);
  expect((await persisted(id)).invocations).toHaveLength(2);
  await evidence('http-initial-recovery', { initialStatus: 503, savedDiagnoses: 1, recoveredStatus: 'QUESTIONING', duplicateCreateAddedSessions: 0 });
});

test('HTTP concurrent requests and forged fault headers cannot duplicate or control the upstream', async ({ request }) => {
  const initial = await fixture(request); const operation = key();
  await scenario('connection-failure');
  const failed = await request.post(`/api/v1/diagnoses/${initial.id}/turns`, { data: { action: 'REPLY', content: reply }, headers: { ...writeHeaders(operation), 'X-M6-Fault': 'success', 'X-AI-Fault': 'success' } });
  expect(failed.status()).toBe(503); expect((await failed.json()).error.code).toBe('AI_UNAVAILABLE');
  await assertFailed(initial.id, operation, 'connection-failure'); await scenario('success');
  const responses = await Promise.all([0, 1].map(() => request.post(`/api/v1/diagnoses/${initial.id}/turns`, { data: { action: 'REPLY', content: reply }, headers: writeHeaders(operation) })));
  expect(responses.every(response => response.ok() || response.status() === 409)).toBe(true);
  expect(responses.some(response => response.ok())).toBe(true);
  const rows = await persisted(initial.id);
  expect(rows.messages.filter(row => row.operationKey === operation && row.role === 'USER')).toHaveLength(1);
  expect(rows.messages.filter(row => row.operationKey === operation && row.role === 'ASSISTANT')).toHaveLength(1);
  expect(rows.invocations).toHaveLength(3);
  await evidence('http-concurrent', { statuses: responses.map(response => response.status()), savedUserMessages: 1, savedAssistantMessages: 1, headerFaultControl: false });
});
