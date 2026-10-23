import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeSingleProtocol, SINGLE_PROTOCOL_CASE, SINGLE_PROTOCOL_DATASET } from '../../src/evaluation/single-protocol';

const now = new Date('2026-10-23T12:00:00Z');
const hash = 'a'.repeat(64);
const deniedPermit = { schemaVersion: '1.0', authorizationId: '5e37dcc1-f3db-4f3e-9fd5-be9c3d48bea3', approved: false, approvedBy: 'UNIT_TEST_ONLY_NEVER_AN_OPERATOR_APPROVAL', issuedAt: '2026-10-23T11:00:00Z', expiresAt: '2026-10-23T13:00:00Z', datasetHash: hash, caseIds: [SINGLE_PROTOCOL_CASE], model: 'qwen3.8-flash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', maxRequests: 1, maxSpendCny: 1, maxCompletionTokens: 2500, maxRequestBytes: 10000, pricing: { currency: 'CNY', inputPerMillion: 0.8, outputPerMillion: 2.7, source: 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash', verifiedAt: '2026-10-23T10:00:00Z', region: 'cn-beijing' } };
const authorize = (value: unknown) => authorizeSingleProtocol(value, SINGLE_PROTOCOL_DATASET, hash, [SINGLE_PROTOCOL_CASE], now);
afterEach(() => vi.unstubAllEnvs());

describe('M7 single protocol approval rejection without execution or network', () => {
  it.each([undefined, null, {}, deniedPermit])('rejects missing, malformed or unapproved permission', value => {
    vi.stubEnv('AI_MODE', 'live');
    vi.stubEnv('ALIYUN_API_KEY', 'SYNTHETIC_ONLY_NOT_A_CREDENTIAL');
    expect(() => authorize(value)).toThrow();
  });
  it('rejects a batch authorization even when the selected case count is one', () => {
    expect(() => authorize({ ...deniedPermit, approved: true, maxRequests: 2 })).toThrow('SINGLE_PROTOCOL_ONE_REQUEST_ONLY');
  });
  it.each([
    ['other-dataset', [SINGLE_PROTOCOL_CASE]],
    [SINGLE_PROTOCOL_DATASET, []],
    [SINGLE_PROTOCOL_DATASET, [SINGLE_PROTOCOL_CASE, 'second-case']],
    [SINGLE_PROTOCOL_DATASET, ['other-case']],
  ])('rejects selection drift before approval can be considered', (datasetId, caseIds) => {
    expect(() => authorizeSingleProtocol(deniedPermit, datasetId as string, hash, caseIds as string[], now)).toThrow('SINGLE_PROTOCOL_SELECTION_REQUIRED');
  });
  it('rejects an otherwise shaped permission whose dataset fingerprint has changed', () => {
    expect(() => authorize({ ...deniedPermit, approved: true, datasetHash: 'b'.repeat(64) })).toThrow('PERMIT_DATASET_OR_SELECTION_MISMATCH');
  });
});
