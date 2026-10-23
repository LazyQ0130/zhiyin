import { randomUUID } from "node:crypto";
import { expect, request, type APIRequestContext, type APIResponse } from "@playwright/test";
import type { PracticeDTO, ProblemDTO, SessionDTO } from "../../src/lib/contracts";

export const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
export const testPassword = "Local-QA-only-8!long";
export const inviteCode = process.env.E2E_INVITE_CODE ?? "";
export const exampleQuestion = "解一元二次方程 x² - 5x + 6 = 0。";
export const exampleProcess = "a=1,b=-5,c=6\nΔ=25+24=49\nx=(5±7)/2";

export function key() { return randomUUID(); }
export function writeHeaders(idempotencyKey = key()) {
  return { Origin: baseURL, "Idempotency-Key": idempotencyKey };
}
export async function readData<T>(response: APIResponse): Promise<T> {
  const body = await response.json();
  expect(response.ok(), `${response.status()} ${JSON.stringify(body)}`).toBeTruthy();
  expect(body.requestId).toEqual(expect.any(String));
  expect(body.error).toBeUndefined();
  return body.data as T;
}
export async function expectError(response: APIResponse, code: string, statuses = [400, 403, 409, 413, 415, 422]) {
  expect(statuses).toContain(response.status());
  const body = await response.json();
  expect(body.error?.code).toBe(code);
  expect(body.requestId).toEqual(expect.any(String));
  return body;
}
export async function makeContext() {
  return request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
}
export async function register(client: APIRequestContext, suffix = "api") {
  expect(inviteCode, "Set E2E_INVITE_CODE to the local test invitation; do not use a production service.").not.toBe("");
  const email = `qa-${suffix}-${key()}@example.test`;
  const response = await client.post("/api/v1/auth/register", {
    data: { email, password: testPassword, inviteCode, ageBand: "ADULT", acceptTerms: true, displayName: "验收学习者" },
  });
  await readData(response);
  return { email, password: testPassword };
}
export async function makeAttempt(client: APIRequestContext, options: { question?: string; process?: string; notAttempted?: boolean; imageIds?: string[] } = {}) {
  const problem = await readData<ProblemDTO>(await client.post("/api/v1/problems", {
    data: { questionText: options.question ?? exampleQuestion, subject: "MATH", gradeBand: "HIGH_SCHOOL", imageIds: options.imageIds ?? [] },
  }));
  const revision = await readData<{ revisionId: string; problemId: string }>(await client.post(`/api/v1/problems/${problem.id}/confirm`, {
    data: { questionText: options.question ?? exampleQuestion },
  }));
  const attempt = await readData<{ id: string }>(await client.post("/api/v1/attempts", {
    data: { problemId: problem.id, revisionId: revision.revisionId, rawProcess: options.process ?? exampleProcess, stuckReasons: ["MY_ANSWER_LOOKS_WRONG"], notAttempted: options.notAttempted ?? false },
  }));
  return { problem, revision, attempt };
}
export async function makeDiagnosis(client: APIRequestContext, options: Parameters<typeof makeAttempt>[1] = {}) {
  const input = await makeAttempt(client, options);
  const session = await readData<SessionDTO>(await client.post("/api/v1/diagnoses", { data: { attemptId: input.attempt.id }, headers: writeHeaders() }));
  return { ...input, session };
}
export async function makePractice(client: APIRequestContext) {
  const input = await makeDiagnosis(client);
  await readData<SessionDTO>(await client.post(`/api/v1/diagnoses/${input.session.id}/finish`, { data: {}, headers: writeHeaders() }));
  const practice = await readData<PracticeDTO>(await client.post("/api/v1/practice-sets", { data: { sessionId: input.session.id }, headers: writeHeaders() }));
  return { ...input, practice };
}
export function allKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) => [name, ...allKeys(child)]);
}
