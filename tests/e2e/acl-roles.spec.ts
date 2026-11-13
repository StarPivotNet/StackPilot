import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill("e2e administrator password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("region", { name: "实时工作台状态" })).toBeVisible();
}

test("role layout keeps built-in permissions concise and responsive", async ({ page }, testInfo) => {
  await login(page);
  await page.goto("/#acl-roles");
  await page.getByRole("button", { name: /只读审计员/ }).click();
  await expect(page.getByText("内置角色由 Controller 管理，仅显示已授予权限。")).toBeVisible();

  const readonlyPermissions = page.locator(".permission-grid > button");
  await expect(readonlyPermissions).toHaveCount(9);
  await expect(readonlyPermissions.first()).toBeDisabled();
  await expect(page.getByRole("button", { name: /总览操作/ })).toHaveCount(0);

  const readonlyLayout = await page.evaluate(() => {
    const grid = document.querySelector(".permission-grid");
    const panel = document.querySelector(".acl-role-layout .panel-card:last-child");
    const rolePanel = document.querySelector(".acl-role-layout .panel-card:first-child");
    const metric = document.querySelector(".module-metrics article");
    const role = document.querySelector(".role-list button.active");
    const permission = document.querySelector(".permission-grid > button");
    const readonlyNote = document.querySelector(".acl-readonly-note");
    const panelRect = panel?.getBoundingClientRect();
    const rolePanelRect = rolePanel?.getBoundingClientRect();
    const roleRect = role?.getBoundingClientRect();
    const permissionRect = permission?.getBoundingClientRect();
    const readonlyNoteRect = readonlyNote?.getBoundingClientRect();
    return {
      overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : "",
      panelBorder: panel ? getComputedStyle(panel).borderWidth : "",
      panelShadow: panel ? getComputedStyle(panel).boxShadow : "",
      metricBackground: metric ? getComputedStyle(metric).backgroundColor : "",
      metricBorder: metric ? getComputedStyle(metric).borderWidth : "",
      roleBackground: role ? getComputedStyle(role).backgroundColor : "",
      roleBorder: role ? getComputedStyle(role).borderWidth : "",
      permissionBackground: permission ? getComputedStyle(permission).backgroundColor : "",
      permissionBorder: permission ? getComputedStyle(permission).borderWidth : "",
      roleLeftInset: roleRect && rolePanelRect ? roleRect.left - rolePanelRect.left : 0,
      roleRightInset: roleRect && rolePanelRect ? rolePanelRect.right - roleRect.right : 0,
      permissionLeftInset: permissionRect && panelRect ? permissionRect.left - panelRect.left : 0,
      readonlyLeftInset: readonlyNoteRect && panelRect ? readonlyNoteRect.left - panelRect.left : 0,
      readonlyRightInset: readonlyNoteRect && panelRect ? panelRect.right - readonlyNoteRect.right : 0,
    };
  });
  expect(readonlyLayout.overflow).toBeLessThanOrEqual(0);
  expect(readonlyLayout.columns).toBe(testInfo.project.name === "mobile-chromium" ? 1 : 2);
  expect(readonlyLayout.panelBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(readonlyLayout.panelBorder).toBe("0px");
  expect(readonlyLayout.panelShadow).not.toBe("none");
  expect(readonlyLayout.metricBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(readonlyLayout.metricBorder).toBe("0px");
  expect(readonlyLayout.roleBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(readonlyLayout.roleBorder).toBe("0px");
  expect(readonlyLayout.permissionBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(readonlyLayout.permissionBorder).toBe("0px");
  expect(readonlyLayout.roleLeftInset).toBeGreaterThanOrEqual(16);
  expect(readonlyLayout.roleRightInset).toBeGreaterThanOrEqual(16);
  expect(readonlyLayout.permissionLeftInset).toBeGreaterThanOrEqual(16);
  expect(readonlyLayout.readonlyLeftInset).toBeGreaterThanOrEqual(16);
  expect(readonlyLayout.readonlyRightInset).toBeGreaterThanOrEqual(16);

  await page.getByRole("button", { name: /管理员/ }).click();
  const administratorPermissions = page.locator(".permission-grid > button");
  await expect(administratorPermissions).toHaveCount(42);
  await expect(administratorPermissions.first()).toBeDisabled();

  await page.getByRole("button", { name: /只读审计员/ }).click();
  await page.screenshot({ path: testInfo.outputPath("acl-roles.png"), fullPage: true });
});

test("create-role dialog stays fully visible without decorative borders", async ({ page }) => {
  await login(page);
  await page.goto("/#acl-roles");
  await page.getByRole("button", { name: "创建角色" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const layout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
      border: getComputedStyle(element).borderWidth,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.border).toBe("0px");
});

test("ACL user and policy surfaces retain their visual hierarchy", async ({ page }) => {
  await login(page);
  await page.goto("/#acl");
  await expect(page.getByRole("heading", { name: "用户访问" })).toBeVisible();

  const unframedLayout = await page.evaluate(() => {
    const filter = document.querySelector(".module-filter-line");
    const summary = document.querySelector(".identity-summary");
    return {
      pageClass: document.querySelector(".module-page")?.className ?? "",
      filterBorder: filter ? getComputedStyle(filter).borderWidth : "",
      filterShadow: filter ? getComputedStyle(filter).boxShadow : "",
      summaryBorder: summary ? getComputedStyle(summary).borderWidth : "",
      summaryShadow: summary ? getComputedStyle(summary).boxShadow : "",
    };
  });
  expect(unframedLayout.pageClass).toContain("module-page-acl");
  expect(unframedLayout.filterBorder).toBe("0px");
  expect(unframedLayout.filterShadow).toBe("none");
  expect(unframedLayout.summaryBorder).toBe("0px");
  expect(unframedLayout.summaryShadow).toBe("none");

  const userSurface = await page.locator(".identity-user-row").first().evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    shadow: getComputedStyle(element).boxShadow,
  }));
  expect(userSurface.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(userSurface.shadow).not.toBe("none");

  await page.goto("/#acl-policies");
  await expect(page.locator(".acl-policy-detail-panel")).toBeVisible();
  const policySurface = await page.locator(".acl-policy-detail-panel").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    shadow: getComputedStyle(element).boxShadow,
  }));
  expect(policySurface.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(policySurface.shadow).not.toBe("none");
});
