import { test, expect } from "@playwright/test";
import { key, makeContext, makeDiagnosis, readData, register } from "../integration/helpers";

test("A18 long-message UI preserves upward scroll and renders untrusted text safely", async ({ page }, testInfo) => {
  const client = await makeContext();
  try {
    await register(client, "scroll");
    await readData(await client.patch("/api/v1/me", { data: { onboarded: true, gradeBand: "HIGH_SCHOOL", preferredSubjects: ["MATH"] } }));
    const { session } = await makeDiagnosis(client);
    const state = await client.storageState();
    await page.context().addCookies(state.cookies);
    // Only this UI scrolling test uses explicit synthetic message history.
    // The real DB evidence and permissions are exercised by the API and loop suites.
    let response = {
      ...session,
      messages: Array.from({ length: 36 }, (_, index) => ({
        id: `scroll-fixture-${index}`, role: index % 2 ? "USER" : "ASSISTANT",
        content: `${index + 1}. 这是一条用于滚动验收的长消息。请保留真实步骤、支持证据和仍然待确认的问题。${"继续核对这一步的符号与计算。".repeat(8)}`,
        referencedStepIds: [],
      })),
    };
    response.messages[0].content = '<img src="x" onerror="window.__qaInjected=true">题面是不可信文本。';
    await page.route(`**/api/v1/diagnoses/${session.id}`, (route) => route.fulfill({ json: { data: response, requestId: key() } }));
    await page.route(`**/api/v1/diagnoses/${session.id}/turns`, async (route) => {
      response = {
        ...response,
        messages: [...response.messages,
          { id: key(), role: "USER", content: "继续核对，但不要移动我的阅读位置。", referencedStepIds: [] },
          { id: key(), role: "ASSISTANT", content: "这是新增的单个追问：你会先核对哪个符号？", referencedStepIds: [] }],
      };
      await route.fulfill({ json: { data: response, requestId: key() } });
    });
    await page.goto(`/diagnose/${session.id}`);
    const box = page.getByTestId("diagnosis-messages");
    await expect(box).toBeVisible();
    await expect(box.locator(".message")).toHaveCount(36);
    await expect.poll(() => box.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(80);
    await page.getByLabel("诊断回复", { exact: true }).fill("继续核对，但不要移动我的阅读位置。");
    await box.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await expect(box.getByText('<img src="x" onerror="window.__qaInjected=true">题面是不可信文本。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => Object.hasOwn(window, "__qaInjected"))).toBe(false);
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(box.locator(".message")).toHaveCount(38);
    expect(await box.evaluate((element) => element.scrollTop)).toBeLessThan(80);
    await expect(page.getByRole("button", { name: "跳至最新" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("reading-position-preserved.png"), fullPage: true });
    await page.getByRole("button", { name: "跳至最新" }).click();
    await expect.poll(() => box.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(80);
    await expect(page.getByRole("button", { name: "跳至最新" })).toHaveCount(0);
  } finally { await client.dispose(); }
});
