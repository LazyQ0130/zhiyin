import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { normalizeTypescript } from '../normalize-typescript.mjs';

config({ quiet: true });
if (process.env.NODE_ENV === 'production') throw new Error('Local synthetic fault tests refuse production.');
if (!process.env.DATABASE_URL) throw new Error('Configure the local PostgreSQL DATABASE_URL first.');
const dbURL = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(dbURL.hostname)) throw new Error('Fault tests require an explicitly local database.');
const port = await new Promise((resolvePort, reject) => {
  const socket = createServer(); socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolvePort(value)); });
});
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const folder = resolve('.local', 'm6-fault-' + runId);
await mkdir(folder, { recursive: true });
const nonce = randomBytes(24).toString('hex');
const control = resolve(folder, 'control.json');
await writeFile(control, JSON.stringify({ nonce, scenario: 'success' }));
const baseURL = `http://127.0.0.1:${port}`;
const common = {
  ...process.env, E2E_BASE_URL: baseURL, APP_URL: baseURL,
  M6_FAULT_CONTROL: control, M6_FAULT_NONCE: nonce, M6_FAULT_OUTPUT: folder,
  M6_FAULT_TRANSPORT_LOG: resolve(folder, 'transport.jsonl'),
  E2E_INVITE_CODE: randomBytes(20).toString('hex'), SESSION_SECRET: randomBytes(40).toString('hex'),
  PLAYWRIGHT_SKIP_BROWSER_GC: '1', PLAYWRIGHT_BROWSERS_PATH: resolve('.local/playwright'),
  RATE_LIMIT_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1', AI_REQUEST_TIMEOUT_MS: '100', AI_MAX_RETRIES: '0',
  ALIYUN_API_KEY: 'UNIT_TEST_PLACEHOLDER_M6_NOT_A_CREDENTIAL', DASHSCOPE_API_KEY: 'UNIT_TEST_PLACEHOLDER_M6_NOT_A_CREDENTIAL',
  ALIYUN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', AI_DEFAULT_MODEL: 'qwen3.8-flash',
  AI_MODE: 'live', ENABLE_SIGNUP: 'true',
};
common.INVITE_CODE = common.E2E_INVITE_CODE;
const preload = resolve('scripts/m6/fault-fetch-preload.cjs').replaceAll('\\', '/');
const serverLog = createWriteStream(resolve(folder, 'next-server.log'), { flags: 'wx' });
const server = spawn(process.execPath, ['--require', preload, 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...common, NODE_ENV: 'development', NEXT_DIST_DIR: '.local/m6-next-' + runId, NODE_OPTIONS: `--require "${preload}"` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(serverLog); server.stderr.pipe(serverLog);
let status = 1;
try {
  const deadline = Date.now() + 120000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Isolated Next server exited; inspect retained next-server.log.');
    try { if ((await fetch(baseURL + '/api/v1/health')).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 300));
  }
  if (!ready) throw new Error('Isolated Next readiness timeout.');
  console.log('M6 synthetic transport, real HTTP/PostgreSQL/UI. Paid calls: 0. Evidence: ' + folder);
  const tests = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.fault.config.ts', ...process.argv.slice(2)], { env: common, stdio: 'inherit' });
  status = await new Promise(done => tests.on('exit', code => done(code ?? 1)));
  await writeFile(resolve(folder, 'run-summary.json'), JSON.stringify({ executedAt: new Date().toISOString(), status, testType: 'SYNTHETIC_ALIYUN_TRANSPORT_REAL_HTTP_DB_UI', paidCalls: 0, realAliyunVerified: false, preservedData: true }, null, 2));
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill('SIGTERM');
  serverLog.end();
  normalizeTypescript();
}
process.exitCode = status;
