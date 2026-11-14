import { expect, test } from "@playwright/test";

const adminPassword = "e2e administrator password";
const updatedAt = "2026-11-13T08:00:00.000Z";

/** One Controller-shaped job list; the e2e Controller never creates a job, so the ops tail needs a row to exist. */
function jobList() {
  return {
    jobs: [{
      taskId: "66666666-6666-4666-8666-666666666666",
      nodeId: "11111111-1111-4111-8111-111111111111",
      nodeName: "edge-a",
      url: "https://cdn.example.com/artifacts/app-1.0.0.tar.gz",
      host: "cdn.example.com",
      status: "succeeded",
      createdAt: updatedAt,
      updatedAt,
      expiresAt: "2026-11-13T08:15:00.000Z",
      bytesReceived: 4096,
      totalBytes: 4096,
      bytesPerSecond: 1024,
      segmented: false,
      partsDone: 0,
      partsTotal: 0,
      segmentCount: 1,
      segmentSources: 1,
      parts: [],
      resumedBytes: 0,
      hit: true,
      viaEgress: false,
      originBytes: 0,
      sizeBytes: 4096,
      digest: "a".repeat(64),
      failureReason: null,
      retryable: false,
      attempt: 0,
    }],
    traffic: { monthStart: "2026-11-01T00:00:00.000Z", quotaBytes: 0, nodes: [] },
    collectedAt: updatedAt,
  };
}

function meshPlan() {
  return {
    revision: 3,
    overlayCidr: "100.64.0.0/10",
    listenPort: 51820,
    updatedAt,
    warnings: [],
    nodes: [
      {
        nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-a", status: "ready",
        overlayAddress: "100.64.12.4", publicKey: null, configuredRevision: 3,
        handshake: { collectedAt: updatedAt, ageSeconds: 12, peerCount: 1, activePeerCount: 1 },
        firewallEnforced: true, dataPlanePort: 18_080, interfaceUp: true,
      },
      {
        nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", status: "ready",
        overlayAddress: "100.64.12.5", publicKey: null, configuredRevision: 3,
        handshake: { collectedAt: updatedAt, ageSeconds: 20, peerCount: 1, activePeerCount: 1 },
        firewallEnforced: true, dataPlanePort: 18_080, interfaceUp: true,
      },
    ],
  };
}

function cachePlan() {
  const stats = {
    collectedAt: updatedAt, capacityBytes: 5 * 1024 ** 3, usedBytes: 1024 ** 3, entryCount: 12,
    hits: 30, misses: 10, evictions: 2, diskFreeBytes: 8 * 1024 ** 3,
  };
  return {
    updatedAt,
    warnings: [],
    nodes: [
      { nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-a", status: "ready", stats },
      { nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", status: "ready", stats },
    ],
  };
}

async function settle(page: import("@playwright/test").Page) {
  // Wait for the column geometry to stop moving rather than for a fixed delay: the route
  // transition animates widths, and a mid-transition sample is what would fake a pass or fail.
  await page.waitForFunction(() => {
    const header = document.querySelector<HTMLElement>("table.module-table thead th:last-child");
    if (header === null) return false;
    // Keying on the label as well keeps a previous page's sample from matching this one.
    const sample = `${(header.textContent ?? "").trim()}:${Math.round(header.getBoundingClientRect().width)}`;
    const store = globalThis as typeof globalThis & { __lastColumnSample?: string };
    const stable = store.__lastColumnSample === sample;
    store.__lastColumnSample = sample;
    return stable;
  }, null, { timeout: 10_000 });
}

type Measured = { label: string; tail: string | null; declared: string; last: number; first: number; wrapScrolls: boolean };

/** Measures the table whose trailing header is `lastLabel`: a page can hold several tables. */
async function measureLastColumn(page: import("@playwright/test").Page, lastLabel: string): Promise<Measured | null> {
  return page.evaluate((label) => {
    const table = Array.from(document.querySelectorAll("table.module-table")).find((candidate) => {
      const headers = candidate.querySelectorAll("thead th");
      return (headers[headers.length - 1]?.textContent ?? "").trim() === label;
    });
    if (!(table instanceof HTMLTableElement)) return null;
    const headers = table.querySelectorAll("thead th");
    const last = headers[headers.length - 1];
    const first = headers[0];
    if (last === undefined || first === undefined) return null;
    const wrap = table.closest(".module-table-wrap");
    return {
      label: (last.textContent ?? "").trim(),
      tail: table.getAttribute("data-tail"),
      declared: table.style.getPropertyValue("--tail-column-width"),
      last: Math.round(last.getBoundingClientRect().width),
      first: Math.round(first.getBoundingClientRect().width),
      wrapScrolls: wrap instanceof HTMLElement && wrap.scrollWidth > wrap.clientWidth,
    };
  }, lastLabel);
}

test("an action column keeps its tight width while a data column keeps an even share", async ({ page, isMobile }, testInfo) => {
  test.skip(Boolean(isMobile), "column widths are a desktop table contract; mobile renders cards instead");
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  // The empty fixture has no mesh nodes at all, so both pages are fed here to get real rows.
  await page.route("**/api/network/mesh", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(meshPlan()) }));
  await page.route("**/api/network/cache", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cachePlan()) }));
  await page.route("**/api/network/cache/downloads*", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(jobList()) });
  });

  await page.goto("/#hosts-mesh");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill(adminPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/#hosts-mesh$/);
  await expect(page.getByText("edge-a").first()).toBeVisible();
  await settle(page);

  // 组网拓扑 ends on 配置版本, a value column: the action width squeezes it out.
  const mesh = await measureLastColumn(page, "配置版本");
  expect(mesh).not.toBeNull();
  expect(mesh!.label).toBe("配置版本");
  expect(mesh!.tail, "a data tail declares no control semantics").toBeNull();
  expect(mesh!.last, "a data tail must not be pinned to the action width").toBeGreaterThan(90);
  expect(mesh!.last).toBeLessThanOrEqual(mesh!.first);
  expect(mesh!.wrapScrolls, "the table must still fit its column track").toBe(false);
  await page.locator("table.module-table").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mesh-table.png"), fullPage: false });

  await page.goto("/#hosts-cache");
  await expect(page).toHaveURL(/#hosts-cache$/);
  await expect(page.getByText("edge-a").first()).toBeVisible();
  await settle(page);
  // 共享缓存 ends on 采集时间, the second data tail the blanket rule used to squeeze.
  const cache = await measureLastColumn(page, "采集时间");
  expect(cache).not.toBeNull();
  expect(cache!.label).toBe("采集时间");
  expect(cache!.tail, "a data tail declares no control semantics").toBeNull();
  expect(cache!.last, "a data tail must not be pinned to the action width").toBeGreaterThan(90);
  expect(cache!.wrapScrolls, "the table must still fit its column track").toBe(false);
  await page.locator("table.module-table").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("cache-table.png"), fullPage: false });

  await page.goto("/#databases-instances");
  await expect(page).toHaveURL(/#databases-instances$/);
  await expect(page.locator("table.module-table").first()).toBeVisible();
  await settle(page);
  // 实例列表 ends on 操作: a control tail falls back to the 80px floor when it declares 64px.
  const instances = await measureLastColumn(page, "操作");
  expect(instances).not.toBeNull();
  expect(instances!.label).toBe("操作");
  expect(instances!.tail).toBe("control");
  expect(instances!.declared).toBe("64px");
  expect(instances!.last, "a 64px declaration keeps the 80px action floor").toBe(80);

  // 下载任务 ends on a 96px control tail: a declaration above the floor is honoured, not flattened to 80px.
  await page.goto("/#hosts-downloads");
  await expect(page).toHaveURL(/#hosts-downloads$/);
  await expect(page.getByText("cdn.example.com").first()).toBeVisible();
  await settle(page);
  const jobs = await measureLastColumn(page, "操作");
  expect(jobs).not.toBeNull();
  expect(jobs!.tail).toBe("control");
  expect(jobs!.declared).toBe("96px");
  expect(jobs!.last, "a 96px declaration must not be forced back to the 80px floor").toBe(96);

  const viewport = await page.evaluate(() => ({
    inner: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  expect(viewport.body).toBeLessThanOrEqual(viewport.inner);
  expect(viewport.root).toBeLessThanOrEqual(viewport.inner);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("table-columns.png"), fullPage: true });
});

// The same two pages on a phone: the table becomes cards, so the only contract left is no overflow.
test("the mesh and cache pages do not overflow a phone viewport", async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, "phones only");
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.route("**/api/network/mesh", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(meshPlan()) }));
  await page.route("**/api/network/cache", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cachePlan()) }));

  await page.goto("/#hosts-mesh");
  await page.getByRole("textbox", { name: "用户名" }).fill("e2e-admin");
  await page.getByRole("textbox", { name: "密码" }).fill(adminPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/#hosts-mesh$/);
  await expect(page.getByText("edge-a").filter({ visible: true }).first()).toBeVisible();
  await settle(page);

  for (const hash of ["hosts-mesh", "hosts-cache"]) {
    await page.goto(`/#${hash}`);
    await expect(page).toHaveURL(new RegExp(`#${hash}$`));
    await expect(page.getByText("edge-a").filter({ visible: true }).first()).toBeVisible();
    await settle(page);
    const overflow = await page.evaluate(() => ({ root: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
    expect(overflow.root).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`${hash}-phone.png`), fullPage: true });
    await page.locator(".module-card-list").first().screenshot({ path: testInfo.outputPath(`${hash}-cards.png`) });
  }
  expect(consoleErrors).toEqual([]);
});
