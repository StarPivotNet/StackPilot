import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill("e2e administrator password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("region", { name: "实时工作台状态" })).toBeVisible();
}

test("site management stays contained across supported widths and completes a polling cycle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The viewport matrix is exercised once with Chromium.");
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await login(page);

  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    await page.goto("/#sites-create");
    await expect(page.getByText("Git 部署计划")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sites-create-${width}.png`), fullPage: true });
  }

  let siteResponses = 0;
  page.on("response", (response) => { if (new URL(response.url()).pathname === "/api/sites" && response.status() === 200) siteResponses += 1; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#sites-running");
  await expect(page.locator(".module-page-sites-running > .page-head")).toHaveCount(1);
  await expect(page.locator(".module-page-sites-running .module-view-context")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "运行中站点" })).not.toHaveClass(/sr-only/);
  await expect.poll(() => siteResponses, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(consoleErrors).toEqual([]);
});
