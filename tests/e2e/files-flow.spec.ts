import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const adminPassword = "e2e administrator password";
const fileBytes = Buffer.from("StackPilot real file backend E2E\n", "utf8");
const runtime = process.env.STACKPILOT_E2E_RUNTIME ? resolve(process.env.STACKPILOT_E2E_RUNTIME) : resolve("output", "e2e", "runtime");

async function login(page: Page) {
  await page.goto("/#files");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill(adminPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "文件", level: 1 })).not.toHaveClass(/sr-only/);
  await expect(page.locator(".module-page-files .page-head h1:not(.sr-only)")).toHaveCount(1);
}

async function openFilePage(page: Page, hash: string, heading: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByRole("heading", { name: heading, level: 1 })).not.toHaveClass(/sr-only/);
  await expect(page.locator(`${hash.replace("#", ".module-page-")} .page-head h1:not(.sr-only)`)).toHaveCount(1);
}

async function deleteToTrash(page: Page, name: string) {
  await page.getByRole("button", { name: `删除 ${name} 到回收站` }).click();
  const dialog = page.getByRole("dialog", { name: "移入回收站" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认移入" }).click();
  await expect(page.getByRole("button", { name: `删除 ${name} 到回收站` })).toHaveCount(0);
}

async function permanentlyDelete(page: Page, name: string) {
  await page.getByRole("button", { name: "永久删除" }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("alertdialog", { name: "永久删除文件" });
  const password = dialog.getByLabel("当前密码");
  await password.fill(adminPassword);
  await expect(password).toHaveValue(adminPassword);
  await dialog.getByRole("button", { name: "永久删除" }).click();
  await expect(page.getByText(name, { exact: true }).filter({ visible: true })).toHaveCount(0);
}

test("real file backend supports upload, rename, trash, restore, purge and polling", async ({ page }, testInfo) => {
  const suffix = testInfo.project.name.startsWith("mobile") ? "mobile" : "desktop";
  const folderName = `browser-e2e-${suffix}-folder`;
  const originalName = `browser-e2e-${suffix}.txt`;
  const renamedName = `browser-e2e-${suffix}-renamed.txt`;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const fileReads: number[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? "unknown";
    if (!/ERR_ABORTED|aborted/i.test(error)) failedRequests.push(`${request.method()} ${request.url()} (${error})`);
  });
  page.on("response", (response) => { if (response.request().method() === "GET" && new URL(response.url()).pathname === "/api/files") fileReads.push(Date.now()); });

  await login(page);
  await page.getByRole("button", { name: "创建文件夹" }).click();
  const createDialog = page.getByRole("dialog", { name: "创建文件夹" });
  await createDialog.getByLabel("文件夹名").fill(folderName);
  await createDialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByRole("button", { name: folderName, exact: true })).toBeVisible();

  await openFilePage(page, "#files-upload", "上传队列");
  await page.getByRole("button", { name: "添加上传" }).click();
  const uploadDialog = page.getByRole("dialog", { name: "添加上传" });
  await uploadDialog.locator("input[type=file]").setInputFiles({ name: originalName, mimeType: "text/plain", buffer: fileBytes });
  await uploadDialog.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByText(originalName, { exact: true }).filter({ visible: true }).first()).toBeVisible();

  const stored = await readFile(resolve(runtime, "files", originalName));
  expect(createHash("sha256").update(stored).digest("hex")).toBe(createHash("sha256").update(fileBytes).digest("hex"));

  await openFilePage(page, "#files", "文件");
  await page.getByRole("button", { name: `重命名 ${originalName}` }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名" });
  await renameDialog.getByLabel("新名称").fill(renamedName);
  await renameDialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(renamedName, { exact: true }).filter({ visible: true }).first()).toBeVisible();

  await deleteToTrash(page, renamedName);
  await openFilePage(page, "#files-trash", "回收站");
  await expect(page.getByText(renamedName, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "恢复" }).filter({ visible: true }).first().click();
  await expect(page.getByText(renamedName, { exact: true }).filter({ visible: true })).toHaveCount(0);

  await openFilePage(page, "#files", "文件");
  await expect(page.getByText(renamedName, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await deleteToTrash(page, renamedName);
  await openFilePage(page, "#files-trash", "回收站");
  await permanentlyDelete(page, renamedName);

  await openFilePage(page, "#files", "文件");
  await deleteToTrash(page, folderName);
  await openFilePage(page, "#files-trash", "回收站");
  await permanentlyDelete(page, folderName);

  await openFilePage(page, "#files", "文件");
  const readsBeforeWait = fileReads.length;
  await expect.poll(() => fileReads.length, { timeout: 15_000 }).toBeGreaterThan(readsBeforeWait);
  const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
  expect(overflow.document).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `output/playwright/files-${testInfo.project.name}.png`, fullPage: true });
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
