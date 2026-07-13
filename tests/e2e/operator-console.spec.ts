import { expect, test } from "@playwright/test";

const state = {
  dispatch_enabled: true,
  mutations_enabled: true,
  service_run: {
    id: "run-browser",
    service_version: "1.2.3",
    started_at: "2026-07-13T10:00:00Z",
    status: "ready",
  },
  version: "service-run:run-browser:ready",
};

const events = {
  has_more: false,
  items: [
    {
      attempt_id: null,
      change_class: null,
      compute_profile: null,
      cost_usd: null,
      cursor: 1,
      event_name: "issue.observed",
      id: "event-browser",
      payload: { title: "<script>window.hostile = true</script>" },
      reason_code: "tracker.refresh",
      result: "recorded",
      service_run_id: "run-browser",
      timestamp: "2026-07-13T10:01:00Z",
      work_ref: { issue_id: "issue-1" },
    },
  ],
  next_cursor: 1,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/login", async (route) => {
    await route.fulfill({
      json: {
        csrf_token: "csrf-browser",
        expires_at: "2026-07-13T11:00:00Z",
        operator: {
          auth_subject: "local:admin",
          capabilities: ["operator.read", "config.write"],
          operator_id: "operator-browser",
        },
      },
    });
  });
  await page.route("**/api/v1/state", async (route) => {
    await route.fulfill({ json: state });
  });
  await page.route("**/api/v1/events?*", async (route) => {
    await route.fulfill({ json: events });
  });
  await page.route("**/api/v1/config/overrides/*", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe("csrf-browser");
    expect(route.request().postDataJSON()).toMatchObject({
      expected_version: 0,
      reason: "Browser verification",
    });
    await route.fulfill({ json: { result: "accepted", version: 1 } });
  });
});

test("operates the protected console without executing hostile content", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/operations");
  await page.getByLabel("Password").fill("browser-only-password");
  await page.getByRole("button", { name: "Enter control room" }).click();

  await expect(page.getByText("READY", { exact: true })).toBeVisible();
  await expect(page.getByText("Dispatch enabled", { exact: true })).toBeVisible();
  await expect(page.getByText("Resource unavailable", { exact: true })).toBeVisible();
  await expect(
    page.getByText("<script>window.hostile = true</script>", { exact: false }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "hostile"))).toBeUndefined();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings and controls" })).toBeVisible();
  await page.getByLabel("Reason").fill("Browser verification");
  await page.getByRole("button", { name: "Apply durable override" }).click();
  await expect(page.getByText("Committed override version 1", { exact: false })).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.getByRole("link", { exact: true, name: "Operations" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: "History" })).toBeVisible();
  await expect(page.getByRole("link", { exact: true, name: "Settings" })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
