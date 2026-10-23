import { test, expect, type Page, type TestInfo } from "@playwright/test";
import type { SessionDTO } from "../../src/lib/contracts";
import { exampleProcess, exampleQuestion, inviteCode, key, readData, testPassword } from "../integration/helpers";

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await expect(page.locator("#main-content")).toBeVisible();
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await expect(page.locator(".error-state")).toHaveCount(0);
  const overflow = await page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(overflow.document, `${name}: content wider than ${overflow.width}px`).toBeLessThanOrEqual(overflow.width + 1);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: "disabled" });
}

test("A01/A02/A06/A08/A11/A12/A14/A17/A19/A20 complete visible learning loop", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  expect(inviteCode, "Set E2E_INVITE_CODE for the local closed test.").not.toBe("");
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto("/register");
  await page.getByLabel("称呼", { exact: true }).fill("独立验收学习者");
  await page.getByLabel("邮箱", { exact: true }).fill(`qa-ui-${key()}@example.test`);
  await page.getByLabel("密码", { exact: true }).fill(testPassword);
  await page.getByLabel("试测邀请码", { exact: true }).fill(inviteCode);
  await page.getByLabel("年龄范围", { exact: true }).selectOption("ADULT");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "创建学习空间" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole("button", { name: "进入学习首页", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByText(/演示模式|演示数据/).first()).toBeVisible();
  const visibleNavigation = page.locator("nav:visible");
  await expect(visibleNavigation.getByRole("link")).toHaveCount(6);
  await expect(page.getByText("你的学习档案，从这里开始", { exact: true })).toBeVisible();
  await capture(page, testInfo, "01-home-empty");

  await page.goto("/diagnose/new");
  await page.getByLabel("题目文字", { exact: true }).fill(exampleQuestion);
  await page.getByLabel("我的解题过程", { exact: true }).fill(exampleProcess);
  await page.getByRole("button", { name: "确认题目", exact: true }).click();
  await expect(page.getByText("题目已确认", { exact: true })).toBeVisible();
  await capture(page, testInfo, "02-diagnose-new-confirmed");
  await page.getByRole("button", { name: "开始学习诊断", exact: true }).click();
  await expect(page).not.toHaveURL(/\/diagnose\/new$/);
  await expect(page).toHaveURL(/\/diagnose\/[^/]+$/);
  const sessionId = page.url().split("/").at(-1)!;
  // The API remains a real server/DB check; no network response is mocked.
  const before = await readData<SessionDTO>(await page.request.get(`/api/v1/diagnoses/${sessionId}`));
  expect(before.messages.at(-1)?.referencedStepIds).toContain(before.steps[1].id);
  await page.reload();
  const afterReload = await readData<SessionDTO>(await page.request.get(`/api/v1/diagnoses/${sessionId}`));
  expect(afterReload.messages.map((message) => message.id)).toEqual(before.messages.map((message) => message.id));
  const reply = page.getByLabel("诊断回复", { exact: true });
  await expect(reply).toBeVisible();
  await capture(page, testInfo, "03-diagnosis-questioning");
  await reply.fill("-24");
  let submittedTurns = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/diagnoses/${sessionId}/turns`)) submittedTurns++;
  });
  await reply.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "负" }));
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", isComposing: true }));
  });
  expect(submittedTurns).toBe(0);
  await expect(reply).toHaveValue("-24");
  await reply.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "负" })));
  await reply.press("Shift+Enter");
  expect(submittedTurns).toBe(0);
  await expect(reply).toHaveValue(/\n/);
  await reply.press("Enter");
  await expect.poll(() => submittedTurns).toBe(1);
  await expect(page.getByText(/‘不理解负号规则’的假设受到反证|原判别式中的符号与规则计算不一致/).first()).toBeVisible();
  await page.getByRole("button", { name: /开始针对训练|开始训练|生成针对训练/ }).click();
  await expect(page).toHaveURL(/\/practice\/[^/]+$/);
  await page.getByLabel("我的计算过程", { exact: true }).fill("17");
  await capture(page, testInfo, "04-practice-before-submission");
  await page.getByRole("button", { name: "暂时不会，获取提示", exact: true }).click();
  await page.getByRole("button", { name: "提交并验证", exact: true }).click();
  await expect(page.getByText(/有提示|使用提示|已使用提示/).first()).toBeVisible();

  await page.goto("/records");
  await expect(page.locator(`a[href="/records/${sessionId}"]`)).toBeVisible();
  await capture(page, testInfo, "05-records");
  await page.locator(`a[href="/records/${sessionId}"]`).click();
  await expect(page.getByText(exampleQuestion, { exact: true }).first()).toBeVisible();
  await page.goto("/me");
  await expect(page.getByLabel("界面主题", { exact: true })).toBeVisible();
  await capture(page, testInfo, "06-me");
  expect(runtimeErrors).toEqual([]);
});
