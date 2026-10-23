import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AliyunGateway } from '../../src/server/ai/providers/aliyun';
import { MockGateway } from '../../src/server/ai/providers/mock';
import type { DiagnosisContext } from '../../src/server/ai/gateway';

const input: DiagnosisContext = { questionId: 'q', questionText: '解 x²-5x+6=0。', subject: 'MATH', gradeBand: 'HIGH_SCHOOL', steps: [{ id: 's', text: 'Δ=25+24=49' }], messages: [], findings: [], turnCount: 0, hintLevel: 0 };
const fakeKey = 'SYNTHETIC_ONLY_NOT_A_CREDENTIAL.12345';
const noWait = async () => {};
async function successfulResponse(usage: unknown = { prompt_tokens: 11, completion_tokens: 13 }) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(await new MockGateway().createDiagnosisTurn(input)) } }], usage });
}

describe('M7 private response evidence with synthetic transport only', () => {
  it('retains safe non-2xx status, request ID, hash, usage and bounded response body', async () => {
    const rawBody = JSON.stringify({ request_id: 'body-request', error: { message: 'provider denied the request' }, usage: { prompt_tokens: 3, completion_tokens: 0 } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(rawBody, { status: 401, headers: { 'x-request-id': 'header-request' } }));
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl, maxRetries: 0 });
    await expect(gateway.createDiagnosisTurn(input)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(gateway.lastResponseEvidence).toEqual([{ attempt: 1, httpStatus: 401, providerRequestId: 'header-request', finishReason: null, responseSha256: createHash('sha256').update(rawBody).digest('hex'), redactedBody: rawBody, truncated: false, errorCode: 'AI_UNAVAILABLE' }]);
    expect(gateway.lastInvocation).toMatchObject({ inputTokens: 3, outputTokens: 0, status: 'ERROR' });
  });

  it('redacts exact configured keys and dotted provider-key shapes across body and metadata', async () => {
    const shapedKey = ['sk', 'ws', 'UNIT.TEST_ONLY_12345678901234567890'].join('-');
    const otherKey = ['sk', 'OTHER.TEST_ONLY_12345678901234567890'].join('-');
    const response = Response.json({ request_id: shapedKey, choices: [{ finish_reason: otherKey }], error: { message: `${fakeKey} ${shapedKey} ${otherKey}` } }, { status: 400, headers: { 'x-request-id': fakeKey } });
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl: async () => response, maxRetries: 0 });
    await expect(gateway.createDiagnosisTurn(input)).rejects.not.toThrow(fakeKey);
    const serialized = JSON.stringify(gateway.lastResponseEvidence);
    for (const key of [fakeKey, shapedKey, otherKey]) expect(serialized).not.toContain(key);
    expect(gateway.lastResponseEvidence[0]).toMatchObject({ providerRequestId: '[REDACTED]', finishReason: '[REDACTED]' });
    expect(gateway.lastResponseEvidence[0].redactedBody).toContain('[REDACTED]');
  });

  it('cancels oversized streams and keeps evidence below 16 KiB of UTF-8', async () => {
    const cancel = vi.fn();
    const rawBytes = new TextEncoder().encode('汉'.repeat(40_000));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(rawBytes); }, cancel });
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl: async () => new Response(stream), maxRetries: 0 });
    await expect(gateway.createDiagnosisTurn(input)).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(gateway.lastResponseEvidence[0].truncated).toBe(true);
    expect(Buffer.byteLength(gateway.lastResponseEvidence[0].redactedBody!, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(gateway.lastResponseEvidence[0].responseSha256).toBe(createHash('sha256').update(rawBytes.subarray(0, 100_000)).digest('hex'));
  });

  it('keeps an aggregate unknown when any retried attempt omits its usage', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'temporary' }, { status: 500 })).mockResolvedValueOnce(await successfulResponse());
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl, sleep: noWait });
    await gateway.createDiagnosisTurn(input);
    expect(gateway.lastInvocation).toMatchObject({ status: 'SUCCESS', attempts: 2, inputTokens: null, outputTokens: null });
    expect(gateway.lastResponseEvidence.map(item => item.httpStatus)).toEqual([500, 200]);
  });

  it('tracks missing usage independently for input and output totals', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ usage: { prompt_tokens: 7 } }, { status: 500 })).mockResolvedValueOnce(await successfulResponse());
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl, sleep: noWait });
    await gateway.createDiagnosisTurn(input);
    expect(gateway.lastInvocation).toMatchObject({ inputTokens: 18, outputTokens: null, attempts: 2 });
  });

  it('retains truncated completion metadata and leaves absent usage unknown', async () => {
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl: async () => Response.json({ request_id: 'synthetic-id', choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), maxRetries: 0 });
    await expect(gateway.createDiagnosisTurn(input)).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' });
    expect(gateway.lastResponseEvidence[0]).toMatchObject({ providerRequestId: 'synthetic-id', finishReason: 'length', errorCode: 'AI_INVALID_OUTPUT' });
    expect(gateway.lastInvocation).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it('records a network failure without inventing a provider response', async () => {
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl: async () => { throw new Error(fakeKey); }, maxRetries: 0 });
    await expect(gateway.createDiagnosisTurn(input)).rejects.not.toThrow(fakeKey);
    expect(gateway.lastResponseEvidence[0]).toMatchObject({ httpStatus: null, providerRequestId: null, responseSha256: null, redactedBody: null, errorCode: 'AI_UNAVAILABLE' });
  });

  it('returns detached evidence and clears prior invocation evidence for a new call', async () => {
    const gateway = new AliyunGateway({ apiKey: fakeKey, fetchImpl: async () => successfulResponse(), maxRetries: 0 });
    await gateway.createDiagnosisTurn(input);
    const evidence = gateway.lastResponseEvidence;
    Object.assign(evidence[0], { redactedBody: 'attempted external mutation' });
    expect(gateway.lastResponseEvidence[0].redactedBody).not.toBe('attempted external mutation');
    await gateway.createDiagnosisTurn(input);
    expect(gateway.lastResponseEvidence).toHaveLength(1);
    expect(gateway.lastInvocation).toMatchObject({ attempts: 1, inputTokens: 11, outputTokens: 13 });
  });
});
