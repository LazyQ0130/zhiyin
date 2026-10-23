import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, type APIRequestContext } from '@playwright/test';
import type { SessionDTO } from '../../src/lib/contracts';
import { makeAttempt, readData, register, writeHeaders, key } from '../integration/helpers';

export const faults = ['timeout', 'invalid-json', 'invalid-schema', 'connection-failure'] as const;
export type Fault = typeof faults[number];
export const codes: Record<Fault, string> = { timeout: 'AI_TIMEOUT', 'invalid-json': 'AI_INVALID_OUTPUT', 'invalid-schema': 'AI_INVALID_OUTPUT', 'connection-failure': 'AI_UNAVAILABLE' };
export const reply = '故障注入测试：我认为 -4ac 应该是 -24，需要核对符号。';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, allowExitOnIdle: true });
export async function scenario(value: Fault | 'success') {
  await writeFile(process.env.M6_FAULT_CONTROL!, JSON.stringify({ nonce: process.env.M6_FAULT_NONCE, scenario: value }));
}
export async function session(client: APIRequestContext, id: string) {
  return readData<SessionDTO>(await client.get(`/api/v1/diagnoses/${id}`));
}
export async function fixture(client: APIRequestContext) {
  await scenario('success');
  await register(client, 'm6-fault');
  await readData(await client.patch('/api/v1/me', { data: { onboarded: true } }));
  const input = await makeAttempt(client);
  const created = await readData<SessionDTO>(await client.post('/api/v1/diagnoses', { data: { attemptId: input.attempt.id }, headers: writeHeaders() }));
  expect(created.status).toBe('QUESTIONING');
  expect(created.isDemo).toBe(false); // Live adapter exercised with synthetic transport, never Mock fallback.
  expect(created.messages[0].content).toContain('工程故障恢复夹具');
  return created;
}
export async function persisted(id: string) {
  const messages = await pool.query('SELECT "role", "operationKey", "content" FROM "DiagnosisMessage" WHERE "sessionId"=$1 ORDER BY "sequence"', [id]);
  const invocations = await pool.query('SELECT "provider","status","errorClass","inputTokens","outputTokens" FROM "ModelInvocation" WHERE "sessionId"=$1 ORDER BY "createdAt"', [id]);
  const mutations = await pool.query('SELECT "key","status" FROM "MutationKey" WHERE "scope"=$1', ['turn:' + id]);
  return { messages: messages.rows, invocations: invocations.rows, mutations: mutations.rows };
}
export async function assertFailed(id: string, operation: string | null, fault: Fault) {
  const rows = await persisted(id);
  const failed = rows.invocations.filter(row => row.status === 'ERROR');
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ provider: 'aliyun', errorClass: codes[fault] });
  if (fault === 'invalid-json') expect(failed[0]).toMatchObject({ inputTokens: 17, outputTokens: 3 });
  if (fault === 'invalid-schema') expect(failed[0]).toMatchObject({ inputTokens: 19, outputTokens: 5 });
  if (operation) {
    expect(rows.messages.filter(row => row.operationKey === operation && row.role === 'USER')).toHaveLength(1);
    expect(rows.messages.filter(row => row.operationKey === operation && row.role === 'ASSISTANT')).toHaveLength(0);
    expect(rows.mutations.find(row => row.key === operation)?.status).toBe('RETRYABLE');
  }
  return rows;
}
export async function evidence(name: string, data: Record<string, unknown>) {
  await writeFile(`${process.env.M6_FAULT_OUTPUT}/${name}-${randomUUID()}.json`, JSON.stringify({ testType: 'SYNTHETIC_TRANSPORT_REAL_HTTP_DB_UI', realAliyunVerified: false, paidCalls: 0, ...data }, null, 2));
}
export async function transportCount() {
  try { return (await readFile(process.env.M6_FAULT_TRANSPORT_LOG!, 'utf8')).trim().split('\n').filter(Boolean).length; } catch { return 0; }
}
export { key, readData, register, writeHeaders, makeAttempt };
