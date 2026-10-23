import { test, expect } from '@playwright/test';
import { assertFailed, codes, evidence, fixture, persisted, reply, scenario, session } from './helpers';

for (const fault of ['timeout', 'invalid-json', 'connection-failure'] as const) test(`UI ${fault}: safe error, refresh preservation and explicit retry`, async ({ page }, info) => {
  const initial = await fixture(page.request); const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto(`/diagnose/${initial.id}`);
  const textarea = page.getByLabel('诊断回复', { exact: true }); await expect(textarea).toBeVisible();
  await scenario(fault); await textarea.fill(reply);
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/diagnoses/${initial.id}/turns`));
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  const failedResponse = await submitted; expect(failedResponse.status()).toBe(503);
  expect((await failedResponse.json()).error.code).toBe(codes[fault]);
  const operation = failedResponse.request().headers()['idempotency-key'];
  await expect(page.locator('.error-state[role="alert"]')).toContainText('你的输入已保存');
  await expect(textarea).toHaveValue(reply); await assertFailed(initial.id, operation, fault);
  await page.screenshot({ path: info.outputPath('01-safe-error.png'), fullPage: true });
  await page.reload();
  await expect(page.getByRole('button', { name: '重试这轮分析', exact: true })).toBeVisible();
  await expect(page.getByTestId('diagnosis-messages').getByText(reply, { exact: true })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('02-refresh-preserved.png'), fullPage: true });
  await scenario('success');
  await page.getByRole('button', { name: '重试这轮分析', exact: true }).click();
  await expect(page.getByText('工程故障恢复夹具：已确认本次输入已保存；待确认具体错因，当前证据不足。', { exact: true })).toBeVisible();
  expect((await session(page.request, initial.id)).status).toBe('INCONCLUSIVE');
  const rows = await persisted(initial.id);
  expect(rows.messages.filter(row => row.operationKey === operation && row.role === 'USER')).toHaveLength(1);
  expect(rows.messages.filter(row => row.operationKey === operation && row.role === 'ASSISTANT')).toHaveLength(1);
  expect(rows.invocations).toHaveLength(3); expect(runtimeErrors).toEqual([]);
  await page.screenshot({ path: info.outputPath('03-recovered.png'), fullPage: true });
  await evidence('ui-' + fault, { fault, errorStatus: 503, refreshPreservedUserMessages: 1, explicitRetry: true, recoveredStatus: 'INCONCLUSIVE', browserRuntimeErrors: runtimeErrors.length });
});

test('UI same-page error retry reuses its original idempotency key', async ({ page }, info) => {
  const initial = await fixture(page.request); await page.goto(`/diagnose/${initial.id}`);
  const textarea = page.getByLabel('诊断回复', { exact: true }); await expect(textarea).toBeVisible();
  await scenario('invalid-schema'); await textarea.fill(reply);
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/diagnoses/${initial.id}/turns`)) requests.push(request.headers()['idempotency-key']); });
  await page.getByRole('button', { name: '发送回复', exact: true }).click(); await expect(page.locator('.error-state[role="alert"]')).toBeVisible();
  await scenario('success'); await page.locator('.error-state[role="alert"]').getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('工程故障恢复夹具：已确认本次输入已保存；待确认具体错因，当前证据不足。', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
  expect((await persisted(initial.id)).messages.filter(row => row.role === 'USER' && row.content === reply)).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('04-same-key-retry.png'), fullPage: true });
  await evidence('ui-same-key-retry', { failedScenario: 'invalid-schema', attempts: 2, sameIdempotencyKey: true, savedUserMessages: 1 });
});
