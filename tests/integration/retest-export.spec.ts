import { test, expect, type APIRequestContext } from "@playwright/test";
import type { MeDTO, PracticeDTO, SubmissionDTO } from "../../src/lib/contracts";
import { allKeys, expectError, key, makeContext, makePractice, readData, register, testPassword, writeHeaders } from "./helpers";

test.describe("Retest, complete export and optional preferences", () => {
  let owner: APIRequestContext;
  let stranger: APIRequestContext;
  test.beforeAll(async () => {
    owner = await makeContext(); stranger = await makeContext();
    for (const [client, email, suffix] of [
      [owner, process.env.QA_EXISTING_OWNER_EMAIL, "retest-owner"],
      [stranger, process.env.QA_EXISTING_STRANGER_EMAIL, "retest-stranger"],
    ] as const) {
      if (email) await readData(await client.post("/api/v1/auth/login", { data: { email, password: testPassword } }));
      else await register(client, suffix);
    }
  });
  test.afterAll(async () => { await owner?.dispose(); await stranger?.dispose(); });

  test("finished training creates new private retest questions once and rejects unfinished sets", async () => {
    const { practice } = await makePractice(owner);
    await expectError(await owner.post(`/api/v1/practice-sets/${practice.id}/retest`, { data: {}, headers: writeHeaders() }), "INVALID_STATE_TRANSITION", [409]);
    for (const [index, answerText] of ["17", "9", "4"].entries()) {
      const result = await readData<SubmissionDTO>(await owner.post(`/api/v1/practice-items/${practice.items[index].id}/submissions`, { data: { answerText }, headers: writeHeaders() }));
      expect(result.correctness).toBe("CORRECT");
      expect(result.assistance).toBe("INDEPENDENT");
      expect(result.masteryState).not.toBe("RETENTION_SUPPORTED");
    }
    const idempotencyKey = key();
    const retest = await readData<PracticeDTO>(await owner.post(`/api/v1/practice-sets/${practice.id}/retest`, { data: {}, headers: writeHeaders(idempotencyKey) }));
    expect(retest.retestOfId).toBe(practice.id);
    expect(retest.items).toHaveLength(3);
    expect(retest.items.every((item) => !practice.items.some((old) => old.questionText === item.questionText))).toBeTruthy();
    expect(allKeys(retest)).not.toContain("answerSpec");
    const repeated = await readData<PracticeDTO>(await owner.post(`/api/v1/practice-sets/${practice.id}/retest`, { data: {}, headers: writeHeaders(idempotencyKey) }));
    expect(repeated.id).toBe(retest.id);
    const unauthorized = await stranger.post(`/api/v1/practice-sets/${practice.id}/retest`, { data: {}, headers: writeHeaders() });
    expect([403, 404]).toContain(unauthorized.status());
  });

  test("full export includes owned practice submissions and excludes answer specifications", async () => {
    const { session, practice } = await makePractice(owner);
    await readData(await owner.post(`/api/v1/practice-items/${practice.items[0].id}/submissions`, { data: { answerText: "17" }, headers: writeHeaders() }));
    const exported = await readData<{ records: Array<{ id: string; practiceEvidence: PracticeDTO[] }> }>(await owner.post("/api/v1/me/export", { data: {} }));
    const record = exported.records.find((entry) => entry.id === session.id);
    expect(record).toBeDefined();
    const saved = record!.practiceEvidence.find((entry) => entry.id === practice.id);
    expect(saved?.items[0].submission?.answerText).toBe("17");
    expect(allKeys(exported)).not.toContain("answerSpec");
    expect(allKeys(exported)).not.toContain("passwordHash");
    const foreign = await readData<{ records: Array<{ id: string }> }>(await stranger.post("/api/v1/me/export", { data: {} }));
    expect(foreign.records.some((entry) => entry.id === session.id)).toBeFalsy();
  });

  test("onboarding accepts an empty optional subject preference", async () => {
    const me = await readData<MeDTO>(await owner.patch("/api/v1/me", { data: { preferredSubjects: [], onboarded: true } }));
    expect(me.profile.preferredSubjects).toEqual([]);
    expect(me.profile.onboarded).toBe(true);
  });
});
