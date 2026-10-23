import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

if (!process.env.M6_FAULT_OUTPUT || !process.env.M6_FAULT_NONCE || !process.env.E2E_BASE_URL?.startsWith('http://127.0.0.1:')) throw new Error('Use node scripts/m6/run-fault-tests.mjs; isolated local runner required.');
const folder = process.env.M6_FAULT_OUTPUT;
export default defineConfig({
  testDir: './tests/fault', fullyParallel: false, workers: 1, retries: 0, timeout: 60000,
  expect: { timeout: 10000 }, outputDir: resolve(folder, 'artifacts'),
  reporter: [['list'], ['json', { outputFile: resolve(folder, 'results.json') }]],
  use: { baseURL: process.env.E2E_BASE_URL, extraHTTPHeaders: { Origin: process.env.E2E_BASE_URL! }, browserName: 'chromium', viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', screenshot: 'only-on-failure', trace: 'off' },
});
