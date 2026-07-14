import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "test-results",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  retries: process.env.CI ? 2 : 0,
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "corepack pnpm --filter @symphony/web build && corepack pnpm --filter @symphony/web exec vite preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  workers: process.env.CI ? 1 : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
