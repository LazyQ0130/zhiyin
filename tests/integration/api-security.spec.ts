import { test, expect, type APIRequestContext } from "@playwright/test";
import sharp from "sharp";
import type { DashboardDTO, ListDTO, PracticeDTO, SessionDTO, SubmissionDTO } from "../../src/lib/contracts";
import { allKeys, baseURL, exampleProcess, exampleQuestion, expectError, inviteCode, key, makeAttempt, makeContext, makeDiagnosis, makePractice, readData, register, testPassword, writeHeaders } from "./helpers";

test.describe("PostgreSQL-backed API safety and learning evidence", () => {
  let owner: APIRequestContext;
  let stranger: APIRequestContext;
  test.beforeAll(async () => {
    owner = await makeContext();
    stranger = await makeContext();
    await register(owner, "owner");
    await register(stranger, "stranger");
  });
  test.afterAll(async () => { await owner?.dispose(); await stranger?.dispose(); });

  test("A01 new user has genuine empty statistics and no password fields", async () => {
    const dashboard = await readData<DashboardDTO>(await owner.get("/api/v1/dashboard"));
    expect(dashboard.stats).toEqual({ diagnoses: 0, pendingPractice: 0, completedPractice: 0 });
    expect(dashboard.recent).toEqual([]);
    expect(dashboard.focus).toBeNull();
    const me = await readData(await owner.get("/api/v1/me"));
    expect(allKeys(me)).not.toContain("passwordHash");
    expect(allKeys(me)).not.toContain("tokenHash");
  });

  test("A23 under-age users cannot register or access private data", async () => {
    for (const ageBand of ["UNDER_14", "AGE_14_17"]) {
      const anonymous = await makeContext();
      try {
        const response = await anonymous.post("/api/v1/auth/register", { data: { email: `qa-age-${key()}@example.test`, password: testPassword, inviteCode, ageBand, acceptTerms: true } });
        await expectError(response, "AGE_ACCESS_RESTRICTED", [403]);
        expect((await anonymous.get("/api/v1/me")).status()).toBe(401);
      } finally { await anonymous.dispose(); }
    }
  });

  test("CSRF rejects an authenticated cross-site write", async () => {
    const response = await owner.patch("/api/v1/me", { headers: { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" }, data: { displayName: "攻击者修改" } });
    expect(response.status()).toBe(403);
    const me = await readData<{ profile: { displayName: string } }>(await owner.get("/api/v1/me"));
    expect(me.profile.displayName).not.toBe("攻击者修改");
  });

  test("A02/A04 confirmation snapshots the student's corrected question", async () => {
    const problem = await readData<{ id: string }>(await owner.post("/api/v1/problems", { data: { questionText: "识别待修正：x² - 5x + 8 = 0", subject: "MATH", gradeBand: "HIGH_SCHOOL", imageIds: [] } }));
    const unconfirmed = await owner.post("/api/v1/attempts", { data: { problemId: problem.id, revisionId: "not-confirmed", rawProcess: exampleProcess, stuckReasons: [], notAttempted: false } });
    expect([400, 404, 409, 422]).toContain(unconfirmed.status());
    const revision = await readData<{ revisionId: string }>(await owner.post(`/api/v1/problems/${problem.id}/confirm`, { data: { questionText: exampleQuestion } }));
    const attempt = await readData<{ id: string }>(await owner.post("/api/v1/attempts", { data: { problemId: problem.id, revisionId: revision.revisionId, rawProcess: exampleProcess, stuckReasons: [], notAttempted: false } }));
    const session = await readData<SessionDTO>(await owner.post("/api/v1/diagnoses", { data: { attemptId: attempt.id }, headers: writeHeaders() }));
    expect(session.questionText).toBe(exampleQuestion);
    expect(session.steps.map((step) => step.text)).toEqual(exampleProcess.split("\n"));
    await readData(await owner.post(`/api/v1/problems/${problem.id}/confirm`, { data: { questionText: "后续修订：x² + 1 = 0" } }));
    const reloaded = await readData<SessionDTO>(await owner.get(`/api/v1/diagnoses/${session.id}`));
    expect(reloaded.questionText).toBe(exampleQuestion);
  });

  test("A05 answer without process produces a question, not a verified cause", async () => {
    const { session } = await makeDiagnosis(owner, { process: "", notAttempted: true });
    expect(["QUESTIONING", "NEEDS_INPUT", "INCONCLUSIVE"]).toContain(session.status);
    expect(session.messages.filter((message) => message.role === "ASSISTANT")).toHaveLength(1);
    expect(session.findings.every((finding) => finding.status !== "VERIFIED")).toBeTruthy();
    expect(session.messages.at(-1)?.content).toMatch(/过程|步骤|打算|思路|尝试/);
  });

  test("A06/A07 sign-error follow-up cites step 2 and records counterevidence", async () => {
    const { session } = await makeDiagnosis(owner);
    const secondStep = session.steps[1].id;
    expect(session.messages.at(-1)?.referencedStepIds).toContain(secondStep);
    expect(session.findings.every((finding) => finding.status !== "VERIFIED")).toBeTruthy();
    const updated = await readData<SessionDTO>(await owner.post(`/api/v1/diagnoses/${session.id}/turns`, { headers: writeHeaders(), data: { action: "REPLY", content: "我明白了，-4ac=-24，所以是1；上一行确实是我写错了，我知道判别式是 b²-4ac。" } }));
    expect(updated.findings.some((finding) => finding.status === "REFUTED" || finding.contradictingEvidence.length > 0)).toBeTruthy();
    expect(updated.messages.map((message) => message.content).join("\n")).not.toMatch(/已经完全掌握|长期掌握|基础薄弱/);
  });

  test("A09 concurrent duplicate diagnosis and turn requests persist once", async () => {
    const { attempt } = await makeAttempt(owner);
    const createKey = key();
    const responses = await Promise.all([0, 1].map(() => owner.post("/api/v1/diagnoses", { headers: writeHeaders(createKey), data: { attemptId: attempt.id } })));
    expect(responses.every((response) => response.ok() || response.status() === 409)).toBeTruthy();
    const successful = responses.find((response) => response.ok());
    expect(successful).toBeDefined();
    const first = await readData<SessionDTO>(successful!);
    const repeat = await readData<SessionDTO>(await owner.post("/api/v1/diagnoses", { headers: writeHeaders(createKey), data: { attemptId: attempt.id } }));
    expect(repeat.id).toBe(first.id);
    expect(repeat.messages).toHaveLength(first.messages.length);
    const turnKey = key();
    const content = "我先检查这一步，-4ac 的负号不能漏掉。";
    const turns = await Promise.all([0, 1].map(() => owner.post(`/api/v1/diagnoses/${first.id}/turns`, { headers: writeHeaders(turnKey), data: { action: "REPLY", content } })));
    expect(turns.every((response) => response.ok() || response.status() === 409)).toBeTruthy();
    const saved = await readData<SessionDTO>(await owner.get(`/api/v1/diagnoses/${first.id}`));
    expect(saved.messages.filter((message) => message.role === "USER" && message.content === content)).toHaveLength(1);
    expect(saved.messages).toHaveLength(first.messages.length + 2);
    await expectError(await owner.post(`/api/v1/diagnoses/${first.id}/turns`, { headers: writeHeaders(turnKey), data: { action: "REPLY", content: "换成不同内容" } }), "INVALID_INPUT", [409]);
  });

  test("A11/A12/A13/A14 answers stay private, hints stay non-independent and archives retain evidence", async () => {
    const { session, practice } = await makePractice(owner);
    expect(practice.sessionId).toBe(session.id);
    expect(practice.items.length).toBeGreaterThan(0);
    const keys = allKeys(practice);
    for (const forbidden of ["answerSpec", "answer", "correctAnswer", "expectedAnswer", "solution"]) expect(keys).not.toContain(forbidden);
    expect(practice.items.every((item) => item.hint === undefined)).toBeTruthy();
    const item = practice.items[0];
    await readData(await owner.post(`/api/v1/practice-items/${item.id}/hints`, { data: {} }));
    await expectError(await owner.post(`/api/v1/practice-items/${item.id}/submissions`, { headers: writeHeaders(), data: { answerText: "17", assistance: "INDEPENDENT" } }), "INVALID_INPUT", [400]);
    const submitted = await readData<SubmissionDTO>(await owner.post(`/api/v1/practice-items/${item.id}/submissions`, { headers: writeHeaders(), data: { answerText: "17" } }));
    expect(submitted.assistance).toBe("HINTED");
    expect(submitted.masteryState).not.toBe("PASSED_CURRENT_PROBE");
    expect(submitted.masteryState).not.toBe("RETENTION_SUPPORTED");
    if (practice.items[1]) {
      const unknown = await readData<SubmissionDTO>(await owner.post(`/api/v1/practice-items/${practice.items[1].id}/submissions`, { headers: writeHeaders(), data: { answerText: "我还无法判断，可能需要另外一种解法。" } }));
      expect(unknown.correctness).toBe("UNKNOWN");
      expect(unknown.masteryState).not.toBe("PASSED_CURRENT_PROBE");
    }
    const reloaded = await readData<PracticeDTO>(await owner.get(`/api/v1/practice-sets/${practice.id}`));
    expect(reloaded.items[0].submission?.assistance).toBe("HINTED");
    const records = await readData<ListDTO<SessionDTO>>(await owner.get("/api/v1/records"));
    expect(records.items.some((record) => record.id === session.id)).toBeTruthy();
    const detail = await readData<SessionDTO>(await owner.get(`/api/v1/diagnoses/${session.id}`));
    expect(detail.practiceSets.some((set) => set.id === practice.id)).toBeTruthy();
    expect(detail.steps).toHaveLength(3);
    expect(detail.messages.length).toBeGreaterThan(0);
    expect(detail.findings.some((finding) => finding.supportingEvidence.length > 0)).toBeTruthy();
  });

  test("A16 other accounts cannot read or mutate diagnosis, practice, problem or record", async () => {
    const { session, practice, problem } = await makePractice(owner);
    const requests = [
      () => stranger.get(`/api/v1/diagnoses/${session.id}`),
      () => stranger.get(`/api/v1/diagnoses/${session.id}/report`),
      () => stranger.post(`/api/v1/diagnoses/${session.id}/turns`, { headers: writeHeaders(), data: { content: "窥探", action: "REPLY" } }),
      () => stranger.post(`/api/v1/diagnoses/${session.id}/finish`, { data: {} }),
      () => stranger.get(`/api/v1/practice-sets/${practice.id}`),
      () => stranger.post(`/api/v1/practice-items/${practice.items[0].id}/hints`, { data: {} }),
      () => stranger.post(`/api/v1/practice-items/${practice.items[0].id}/submissions`, { headers: writeHeaders(), data: { answerText: "17" } }),
      () => stranger.post(`/api/v1/problems/${problem.id}/confirm`, { data: { questionText: "恶意修改" } }),
      () => stranger.delete(`/api/v1/records/${session.id}`, { data: { confirmation: "DELETE" } }),
    ];
    for (const execute of requests) {
      const response = await execute();
      expect([403, 404], await response.text()).toContain(response.status());
      expect(await response.text()).not.toContain(exampleQuestion);
    }
    expect((await owner.get(`/api/v1/diagnoses/${session.id}`)).ok()).toBeTruthy();
  });

  test("A15 only the newly created owned record is removed from ordinary queries", async () => {
    const { session } = await makeDiagnosis(owner);
    const matching = await readData<ListDTO<SessionDTO>>(await owner.get(`/api/v1/records?subject=MATH&status=${session.status}`));
    expect(matching.items.some((record) => record.id === session.id)).toBeTruthy();
    const otherSubject = await readData<ListDTO<SessionDTO>>(await owner.get("/api/v1/records?subject=CHINESE"));
    expect(otherSubject.items.some((record) => record.id === session.id)).toBeFalsy();
    const past = await readData<ListDTO<SessionDTO>>(await owner.get("/api/v1/records?to=2020-01-01"));
    expect(past.items.some((record) => record.id === session.id)).toBeFalsy();
    await readData(await owner.delete(`/api/v1/records/${session.id}`, { data: { confirmation: "DELETE" } }));
    const records = await readData<ListDTO<SessionDTO>>(await owner.get("/api/v1/records"));
    expect(records.items.some((record) => record.id === session.id)).toBeFalsy();
    expect((await owner.get(`/api/v1/diagnoses/${session.id}`)).status()).toBe(404);
  });

  test("A22 uploads reject SVG, forged MIME and files over 10 MiB", async () => {
    const samples = [
      { name: "script.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), code: "UNSUPPORTED_FILE" },
      { name: "pretend.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>"), code: "UNSUPPORTED_FILE" },
      { name: "too-large.png", mimeType: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0), code: "FILE_TOO_LARGE" },
    ];
    for (const { code, ...file } of samples) {
      const response = await owner.post("/api/v1/uploads", { multipart: { file } });
      await expectError(response, code);
    }
  });

  test("A03/A16 accepted images remain private and blank OCR is never invented", async () => {
    const buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#f5f5f5" } }).png().toBuffer();
    const upload = await readData<{ id: string; mimeType: string; size: number }>(await owner.post("/api/v1/uploads", {
      multipart: { file: { name: "blank-question.png", mimeType: "image/png", buffer } },
    }));
    expect(upload.size).toBeGreaterThan(0);
    const image = await owner.get(`/api/v1/uploads/${upload.id}`);
    expect(image.ok()).toBeTruthy();
    expect(image.headers()["content-type"]).toMatch(/^image\//);
    expect([403, 404]).toContain((await stranger.get(`/api/v1/uploads/${upload.id}`)).status());
    const stolenImage = await stranger.post("/api/v1/problems", { data: { questionText: exampleQuestion, subject: "MATH", gradeBand: "HIGH_SCHOOL", imageIds: [upload.id] } });
    expect([403, 404]).toContain(stolenImage.status());
    const problem = await readData<{ id: string }>(await owner.post("/api/v1/problems", { data: { questionText: "", subject: "MATH", gradeBand: "HIGH_SCHOOL", imageIds: [upload.id] } }));
    const recognition = await readData<{ questionText: string; warning: string; isDemo: boolean }>(await owner.post(`/api/v1/problems/${problem.id}/recognize`, { data: {} }));
    expect(recognition.questionText).toBe("");
    expect(recognition.isDemo).toBe(true);
    expect(recognition.warning).toMatch(/手动|无法看清|重新上传/);
  });

  test("logout revokes the active server session", async () => {
    const temporary = await makeContext();
    try {
      await register(temporary, "logout");
      const state = await temporary.storageState();
      const replay = await makeContext();
      try {
        await readData(await temporary.post("/api/v1/auth/logout", { data: {} }));
        const cookie = state.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
        const response = await replay.get("/api/v1/me", { headers: { Cookie: cookie, Origin: baseURL } });
        expect(response.status()).toBe(401);
      } finally { await replay.dispose(); }
    } finally { await temporary.dispose(); }
  });
});
