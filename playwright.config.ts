import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
// A fresh directory per run preserves previous evidence and avoids bulk cleanup.
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const evidenceRoot = `docs/reports/QA-evidence/${runId}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: `${evidenceRoot}/artifacts`,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${evidenceRoot}/html`, open: "never" }],
    ["json", { outputFile: `${evidenceRoot}/results.json` }],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
  projects: [
    { name: "api", testMatch: "integration/**/*.spec.ts" },
    ...([375, 768, 1440] as const).flatMap((width) =>
      (["light", "dark"] as const).map((colorScheme) => ({
        name: `chromium-${width}-${colorScheme}`,
        testMatch: "e2e/**/*.spec.ts",
        use: {
          viewport: { width, height: width === 375 ? 812 : 1024 },
          colorScheme,
          reducedMotion: "reduce" as const,
        },
      })),
    ),
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: `${baseURL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
