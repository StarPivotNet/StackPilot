import { expect, test } from "@playwright/test";

const adminPassword = "e2e administrator password";

test("download jobs page polls read-only, keeps the empty state honest and never overflows", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  let jobReads = 0;
  let writeRequests = 0;
  let egressReads = 0;
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/network/egress")) { if (request.method() === "GET") egressReads += 1; else writeRequests += 1; return; }
    if (!pathname.startsWith("/api/network/cache/downloads")) return;
    if (request.method() === "GET") jobReads += 1; else writeRequests += 1;
  });

  await page.goto("/#hosts-downloads");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill(adminPassword);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/#hosts-downloads$/);
  await expect(page.getByRole("heading", { name: "下载任务" }).first()).toBeVisible();
  // A fresh Controller has no jobs: say so instead of rendering a fake queue.
  await expect(page.getByText("还没有下载任务")).toBeVisible();
  await expect(page.getByText(/后端采集于/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "拉取构件" })).toBeVisible();
  // The submit needs a target, a node and a password before it can be pressed.
  await expect(page.getByRole("button", { name: "开始拉取" })).toBeDisabled();
  // The optional digest is what makes a panel job verifiable and resumable: the field and its
  // explanation both have to be on screen before an operator knows to fill it.
  const digestInput = page.getByPlaceholder("64 位十六进制");
  await expect(digestInput).toBeVisible();
  await expect(page.getByText(/填写后整包按此摘要校验/)).toBeVisible();
  await digestInput.fill("A".repeat(64));
  await expect(digestInput).toHaveValue("A".repeat(64));
  await digestInput.fill("");

  // The egress quality table is read-only too, and a Controller without probe targets says why it is empty.
  await expect(page.getByText("出口质量表", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "还没有节点上报出口样本" })).toBeVisible();
  await expect(page.getByText(/未配置探测源/)).toBeVisible();

  // One complete polling cycle, and no write request from the refresh loop.
  await expect.poll(() => jobReads, { timeout: 13_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => egressReads, { timeout: 13_000 }).toBeGreaterThanOrEqual(2);
  expect(writeRequests).toBe(0);

  const viewport = await page.evaluate(() => ({
    inner: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  expect(viewport.body).toBeLessThanOrEqual(viewport.inner);
  expect(viewport.root).toBeLessThanOrEqual(viewport.inner);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("download-jobs.png"), fullPage: true });
});

/** A Controller-shaped quality table: the e2e Controller never runs a probe round, so a filled table cannot be produced from the fixture. */
const egressFixture = {
  updatedAt: "2026-05-01T08:00:00.000Z",
  warnings: ["有 1 个节点已离线，不计入可作出口"],
  nodes: [
    {
      nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-hongkong-01", status: "ready", disabledReason: null,
      overlayAddress: "100.64.0.11", dataPlanePort: 18080,
      samples: [{ host: "registry.npmjs.org", ttfbMs: 180, bytesPerSecond: 2_400_000, collectedAt: "2026-05-01T07:59:18.000Z", ageSeconds: 42 }],
    },
    {
      nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-singapore-02", status: "stale", disabledReason: null,
      overlayAddress: "100.64.0.12", dataPlanePort: 18080,
      samples: [{ host: "registry.npmjs.org", ttfbMs: 940, bytesPerSecond: 120_000, collectedAt: "2026-05-01T07:40:00.000Z", ageSeconds: 1200 }],
    },
    {
      nodeId: "33333333-3333-4333-8333-333333333333", nodeName: "edge-frankfurt-03", status: "pending", disabledReason: null,
      overlayAddress: "100.64.0.13", dataPlanePort: 18080, samples: [],
    },
    {
      nodeId: "44444444-4444-4444-8444-444444444444", nodeName: "edge-tokyo-04-with-a-very-long-hostname-waiting-for-an-overlay-address", status: "disabled", disabledReason: "no-overlay",
      overlayAddress: null, dataPlanePort: null, samples: [],
    },
    {
      nodeId: "55555555-5555-4555-8555-555555555555", nodeName: "edge-hongkong-02", status: "offline", disabledReason: null,
      overlayAddress: "100.64.0.15", dataPlanePort: 18080,
      samples: [{ host: "registry.npmjs.org", ttfbMs: 210, bytesPerSecond: 1_800_000, collectedAt: "2026-05-01T07:59:48.000Z", ageSeconds: 12 }],
    },
  ],
};

test("the egress quality table renders measured samples without guessing or overflowing", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  let egressReads = 0;
  let writeRequests = 0;
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/network/egress")) { if (request.method() === "GET") egressReads += 1; else writeRequests += 1; return; }
    if (pathname.startsWith("/api/network/cache/downloads") && request.method() !== "GET") writeRequests += 1;
  });
  // Answering the read with a Controller-shaped payload keeps the polling loop real while the
  // rendering under test finally has rows: until here only the empty table had been seen in a browser.
  await page.route("**/api/network/egress*", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(egressFixture) });
  });

  await page.goto("/#hosts-downloads");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill(adminPassword);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/#hosts-downloads$/);
  const card = page.locator("section[aria-labelledby='download-egress-title']");
  // One ready node out of five: an offline node with fresh samples is still not a delegatable egress.
  await expect(card.getByRole("heading", { name: "1 / 5 个节点可作出口" })).toBeVisible();
  await expect(card).toContainText("可委派出口");
  await expect(card).toContainText("12 秒前");
  await expect(card).toContainText("有 1 个节点已离线，不计入可作出口");
  for (const label of ["可作出口", "样本过期", "待探测", "未加入组网", "已离线"]) await expect(card).toContainText(label);
  // A disabled node says which piece it is missing; the generic word must not come back either.
  await expect(card.getByText("不参与选路", { exact: true })).toHaveCount(0);
  // No sample is not a zero score, and no overlay assignment is not an address.
  for (const label of ["未测出", "未分配", "无样本"]) await expect(card).toContainText(label);
  // Every status is an icon plus its own words, so each chip carries one and none may be squeezed
  // out of its cell or past the card edge. The cell edge is checked on its own because the hosts
  // recipe clamps chips to `max-width: 100%`: a broken column can also show up as a chip overflowing
  // into the neighbour cell, which leaves `scrollWidth` equal to `clientWidth`.
  const chips = await card.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>(".mesh-chip")]
      .filter((chip) => chip.offsetParent !== null)
      .map((chip) => {
        const box = chip.getBoundingClientRect();
        const cell = chip.closest("td");
        const cellBox = cell?.getBoundingClientRect();
        const paddingRight = cell ? parseFloat(getComputedStyle(cell).paddingRight) : 0;
        return {
          text: chip.textContent ?? "",
          icon: chip.querySelector("svg") !== null,
          clipped: chip.scrollWidth > chip.clientWidth + 1,
          spill: cellBox ? Math.round((box.right - (cellBox.right - paddingRight)) * 100) / 100 : 0,
          past: Math.round(box.right - bounds.right),
        };
      });
  });
  expect(chips.length, JSON.stringify(chips)).toBeGreaterThanOrEqual(5);
  expect(chips.filter((chip) => !chip.icon), JSON.stringify(chips)).toEqual([]);
  expect(chips.filter((chip) => chip.clipped || chip.spill > 1), JSON.stringify(chips)).toEqual([]);
  expect(Math.max(...chips.map((chip) => chip.past)), JSON.stringify(chips)).toBeLessThanOrEqual(0);

  await expect.poll(() => egressReads, { timeout: 13_000 }).toBeGreaterThanOrEqual(2);
  expect(writeRequests).toBe(0);

  const viewport = await page.evaluate(() => ({
    inner: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  expect(viewport.body).toBeLessThanOrEqual(viewport.inner);
  expect(viewport.root).toBeLessThanOrEqual(viewport.inner);
  expect(consoleErrors).toEqual([]);
  // The page scrolls inside the shell, so a full-page capture would stop above the card: bring it into view first.
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath("egress-card.png") });
  await page.screenshot({ path: testInfo.outputPath("download-jobs-egress.png") });
});
