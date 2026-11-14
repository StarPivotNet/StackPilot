import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMonitoringRecord, NetworkCacheDownloadJob, NetworkCacheDownloadJobListResponse, NetworkEgressPlanResponse } from "@stackpilot/contracts";
import { createDownload, fetchDownloadJobs, fetchEgressPlan, retryDownload } from "../api/cacheApi";
import { fetchHosts } from "../api/hostsApi";
import { reauthenticate } from "../api/identityApi";
import { toDownloadJobView, toDownloadJobsView } from "../features/network/downloadJobsModel";
import { toEgressView } from "../features/network/egressModel";
import { DownloadJobsPage } from "../pages/DownloadJobsPage";

vi.mock("../api/cacheApi", () => ({ fetchDownloadJobs: vi.fn(), fetchEgressPlan: vi.fn(), retryDownload: vi.fn(), createDownload: vi.fn() }));
vi.mock("../api/hostsApi", () => ({ fetchHosts: vi.fn() }));
vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));

const MIB = 1024 ** 2;
const collectedAt = "2026-11-13T08:00:00.000Z";
const TASK = "11111111-1111-4111-8111-111111111111";
const NODE = "22222222-2222-4222-8222-222222222222";
const OTHER = "77777777-7777-4777-8777-777777777777";

function job(overrides: Partial<NetworkCacheDownloadJob> = {}): NetworkCacheDownloadJob {
  return {
    taskId: TASK, nodeId: NODE, nodeName: "edge-a", url: "https://example.com/app.tar.gz", host: "example.com",
    status: "running", createdAt: collectedAt, updatedAt: collectedAt, expiresAt: collectedAt,
    bytesReceived: 2 * MIB, totalBytes: 8 * MIB, bytesPerSecond: 1024 * 1024,
    segmented: true, partsDone: 1, partsTotal: 2, segmentCount: 2, segmentSources: 2, resumedBytes: 0, parts: [],
    hit: null, viaEgress: null, originBytes: null, sizeBytes: null, digest: null,
    failureReason: null, retryable: false, attempt: 1,
    ...overrides,
  };
}

const traffic = (overrides: Partial<NetworkCacheDownloadJobListResponse["traffic"]> = {}): NetworkCacheDownloadJobListResponse["traffic"] => ({
  monthStart: "2026-11-01T00:00:00.000Z", quotaBytes: 0, nodes: [], ...overrides,
});

const list = (jobs: NetworkCacheDownloadJob[], trafficPayload = traffic()): NetworkCacheDownloadJobListResponse => ({ collectedAt, jobs, traffic: trafficPayload });

const egressPlan = (overrides: Partial<NetworkEgressPlanResponse> = {}): NetworkEgressPlanResponse => ({
  updatedAt: collectedAt, nodes: [], warnings: [], ...overrides,
});

function host(): HostMonitoringRecord {
  return {
    id: NODE, source: "agent", name: "edge-a", platform: "linux", address: "198.18.0.1",
    environment: "生产", owner: "平台团队", connectionStatus: "online", healthStatus: "healthy",
    telemetryFreshness: "current", telemetryCollectedAt: collectedAt, lastSeenAt: collectedAt,
    cpuPercent: 10, memory: { totalBytes: 2 * MIB, usedBytes: MIB, percent: 50 },
    disk: { totalBytes: 2 * MIB, usedBytes: MIB, percent: 50, volumes: [] },
    uptimeSeconds: 600, backup: { status: "healthy", latestAt: collectedAt, detail: "备份正常" },
    services: [], version: "v1.0.0", latency: null, updateStatus: null,
  };
}

describe("download job view model", () => {
  it("renders progress, rate and route from the Agent's own counters", () => {
    const view = toDownloadJobView(job());
    expect(view.statusLabel).toBe("传输中");
    expect(view.live).toBe(true);
    expect(view.progressLabel).toBe("2.0 MB / 8.0 MB");
    expect(view.percent).toBe(25);
    expect(view.rateLabel).toBe("1.0 MB/s");
    // A running job has not reported a hit yet, so it is neither a hit nor a miss.
    expect(view.routeLabel).toBe("等待结果");
    expect(view.partsLabel).toBe("1 / 2 片");
    expect(view.attemptLabel).toBe("第 1 次尝试");
  });

  it("gives each part its own rate and says when one is done", () => {
    const view = toDownloadJobView(job({
      parts: [
        { index: 0, sourceNodeId: NODE, bytes: 2 * MIB, totalBytes: 4 * MIB, bytesPerSecond: 512 * 1024 },
        { index: 1, sourceNodeId: NODE, bytes: 4 * MIB, totalBytes: 4 * MIB, bytesPerSecond: 0 },
        { index: 2, sourceNodeId: NODE, bytes: 0, totalBytes: 4 * MIB, bytesPerSecond: null },
      ],
    }));
    expect(view.parts.map((part) => part.label)).toEqual(["片 1", "片 2", "片 3"]);
    expect(view.parts[0].rateLabel).toBe("512 KB/s");
    // A complete part keeps its last sampled rate forever, which is not a speed it still has.
    expect(view.parts[1].rateLabel).toBe("已完成");
    // One sample is not a rate, and no sample is not zero.
    expect(view.parts[2].rateLabel).toBe("等待速率");
  });

  it("does not invent a percentage when the origin never declared a size", () => {
    const view = toDownloadJobView(job({ totalBytes: null, bytesPerSecond: null }));
    expect(view.progressLabel).toBe("2.0 MB / 未知大小");
    expect(view.percent).toBeNull();
    expect(view.rateLabel).toBe("等待速率");
  });

  it("maps known failure codes to Chinese and leaves an unknown code readable", () => {
    const failed = toDownloadJobView(job({ status: "failed", failureReason: "CACHE_SEGMENT_PART_FAILED", retryable: true }));
    expect(failed.failureLabel).toBe("分片重试后仍失败");
    expect(failed.retryable).toBe(true);
    expect(toDownloadJobView(job({ status: "failed", failureReason: "SOMETHING_NEW" })).failureLabel).toBe("SOMETHING_NEW");
    expect(toDownloadJobView(job({ status: "succeeded", hit: true })).failureLabel).toBeNull();
  });

  it("names a transfer that stopped making progress instead of showing its code", () => {
    const stalled = toDownloadJobView(job({ status: "failed", failureReason: "CACHE_TRANSFER_STALLED", retryable: true }));
    expect(stalled.failureLabel).toBe("传输停滞（长时间无进展）");
  });

  it("separates a segmented hit from an egress hop and a direct fill", () => {
    expect(toDownloadJobView(job({ status: "succeeded", hit: true, segmented: false, segmentCount: 0 })).routeLabel).toBe("缓存命中");
    expect(toDownloadJobView(job({ status: "succeeded", hit: false, viaEgress: true, segmented: false, segmentCount: 0 })).routeLabel).toBe("经出口节点");
    expect(toDownloadJobView(job({ status: "succeeded", hit: false, viaEgress: false, segmented: false, segmentCount: 0 })).routeLabel).toBe("直接回源");
    expect(toDownloadJobView(job({ status: "succeeded", hit: false, segmented: true })).routeLabel).toBe("分片 2 路");
  });

  it("shows no rate for a finished job that carried no bytes", () => {
    // A cache hit divides a real object size by a millisecond if you let it; there is nothing to show.
    expect(toDownloadJobView(job({ status: "succeeded", hit: true, bytesPerSecond: null })).rateLabel).toBe("—");
    expect(toDownloadJobView(job({ bytesPerSecond: null })).rateLabel).toBe("等待速率");
  });

  it("sums the month's traffic per node and says why a node stopped accelerating", () => {
    const view = toDownloadJobsView(list([], traffic({ quotaBytes: 4 * MIB, nodes: [
      { nodeId: "a", nodeName: "edge-a", receivedBytes: 3 * MIB, originBytes: 0, servedBytes: 0, degraded: false },
      { nodeId: "b", nodeName: "edge-b", receivedBytes: 0, originBytes: 0, servedBytes: 5 * MIB, degraded: true },
    ] })));
    expect(view.traffic.monthLabel).toBe("2026-11 计费月");
    expect(view.traffic.quotaLabel).toBe("每节点上限 4.0 MB");
    expect(view.traffic.headlineLabel).toBe("2 个节点本月下行 3.0 MB");
    expect(view.traffic.servedLabel).toBe("5.0 MB");
    expect(view.traffic.degradedCount).toBe(1);
    expect(view.traffic.degradedLabel).toContain("edge-b");
    expect(view.traffic.rows.find((row) => row.nodeId === "b")?.statusLabel).toBe("已停用加速");
    expect(view.traffic.rows.find((row) => row.nodeId === "a")?.statusLabel).toBe("额度内");
  });

  it("records traffic without claiming a limit when no quota is configured", () => {
    const view = toDownloadJobsView(list([], traffic({ nodes: [
      { nodeId: "a", nodeName: null, receivedBytes: MIB, originBytes: MIB, servedBytes: 0, degraded: false },
    ] })));
    expect(view.traffic.quotaLabel).toBe("未设月度上限");
    expect(view.traffic.degradedLabel).toBeNull();
    expect(view.traffic.rows[0].statusLabel).toBe("仅计量");
    // A node the Controller cannot name is still listed, never dropped from the meter.
    expect(view.traffic.rows[0].nodeName).toBe("未知节点");
    expect(toDownloadJobsView(list([])).traffic.headlineLabel).toBe("本月还没有节点流量");
  });

  it("counts what the operator has to act on", () => {
    const view = toDownloadJobsView(list([
      job(),
      job({ taskId: "33333333-3333-4333-8333-333333333333", status: "succeeded", hit: false, segmented: false, segmentCount: 0 }),
      job({ taskId: "44444444-4444-4444-8444-444444444444", status: "failed", failureReason: "CACHE_ORIGIN_ERROR", retryable: true }),
      job({ taskId: "55555555-5555-4555-8555-555555555555", status: "queued", segmentCount: 0, segmented: false }),
    ]));
    expect(view.runningCount).toBe(2);
    expect(view.failedCount).toBe(1);
    expect(view.succeededCount).toBe(1);
    expect(view.segmentedCount).toBe(2);
    expect(view.collectedLabel).toContain("2026");
  });
});

describe("egress quality view model", () => {
  it("picks the node's best measured source and says what it could not measure", () => {
    const view = toEgressView(egressPlan({ nodes: [
      { nodeId: NODE, nodeName: "edge-a", status: "ready", disabledReason: null, overlayAddress: "100.64.0.5", dataPlanePort: 18080, samples: [
        { host: "origin.example.test", ttfbMs: 1203, bytesPerSecond: 216 * 1024, collectedAt, ageSeconds: 120 },
        { host: "asset.example.test", ttfbMs: 90, bytesPerSecond: 4 * MIB, collectedAt, ageSeconds: 30 },
      ] },
      { nodeId: OTHER, nodeName: "edge-b", status: "pending", disabledReason: null, overlayAddress: null, dataPlanePort: null, samples: [] },
      { nodeId: "88888888-8888-4888-8888-888888888888", nodeName: "edge-c", status: "offline", disabledReason: null, overlayAddress: "100.64.0.6", dataPlanePort: 18080, samples: [
        { host: "origin.example.test", ttfbMs: 40, bytesPerSecond: 8 * MIB, collectedAt, ageSeconds: 5 },
      ] },
    ] }));
    // A node that is offline with a fresh sample is not an egress, however good the sample looks.
    expect(view.headlineLabel).toBe("1 / 3 个节点可作出口");
    expect(view.readyCount).toBe(1);
    expect(view.nodes[2].statusLabel).toBe("已离线");
    expect(view.freshestLabel).toBe("5 秒前");
    expect(view.nodes[0].statusLabel).toBe("可作出口");
    expect(view.nodes[0].addressLabel).toBe("100.64.0.5:18080");
    // The best source, not the first one: 4 MB/s at 90 ms beats 216 KB/s at 1.2 s.
    expect(view.nodes[0].rateLabel).toBe("4.0 MB/s");
    expect(view.nodes[0].ttfbLabel).toBe("90 ms");
    expect(view.nodes[0].sampleLabel).toBe("2 个源 · 30 秒前");
    // A node without a sample has no rate, and an unassigned node has no address to offer.
    expect(view.nodes[1].statusLabel).toBe("待探测");
    expect(view.nodes[1].rateLabel).toBe("未测出");
    expect(view.nodes[1].ttfbLabel).toBe("未测出");
    expect(view.nodes[1].sampleLabel).toBe("无样本");
    expect(view.nodes[1].addressLabel).toBe("未分配");
    expect(view.warnings).toEqual([]);
  });

  it("does not call a node that routing never considers「已停用」", () => {
    const view = toEgressView(egressPlan({ nodes: [
      { nodeId: OTHER, nodeName: "edge-b", status: "disabled", disabledReason: "no-overlay", overlayAddress: null, dataPlanePort: null, samples: [] },
    ] }));
    // A node without an overlay assignment never ran; an operator did not switch it off.
    expect(view.nodes[0].statusLabel).toBe("未加入组网");
    expect(view.readyCount).toBe(0);
    expect(view.headlineLabel).toBe("0 / 1 个节点可作出口");
  });

  it("names the piece each disabled node is missing instead of one vague word", () => {
    const reasons = [
      { nodeId: NODE, disabledReason: "revoked", label: "节点已撤销" },
      { nodeId: OTHER, disabledReason: "no-overlay", label: "未加入组网" },
      { nodeId: "88888888-8888-4888-8888-888888888888", disabledReason: "not-allowed", label: "未授予出口" },
      { nodeId: "99999999-9999-4999-8999-999999999999", disabledReason: "not-declared", label: "未声明出口" },
    ] as const;
    const view = toEgressView(egressPlan({ nodes: reasons.map((reason) => ({
      nodeId: reason.nodeId, nodeName: `edge-${reason.disabledReason}`, status: "disabled" as const,
      disabledReason: reason.disabledReason, overlayAddress: null, dataPlanePort: null, samples: [],
    })) }));
    expect(view.nodes.map((node) => node.statusLabel)).toEqual(reasons.map((reason) => reason.label));
    // None of them is an egress, so the count that decides routing stays at zero.
    expect(view.readyCount).toBe(0);
    // A payload without the reason keeps the old word rather than guessing a cause.
    const legacy = toEgressView(egressPlan({ nodes: [
      { nodeId: NODE, nodeName: "edge-a", status: "disabled", disabledReason: null, overlayAddress: null, dataPlanePort: null, samples: [] },
    ] }));
    expect(legacy.nodes[0].statusLabel).toBe("不参与选路");
  });

  it("explains an empty quality table instead of drawing zero throughput", () => {
    const empty = toEgressView(egressPlan({
      warnings: ["未配置探测源（STACKPILOT_EGRESS_PROBE_TARGETS），出口质量表为空，所有下载都会本地直取"],
    }));
    expect(empty.headlineLabel).toBe("还没有节点上报出口样本");
    expect(empty.readyCount).toBe(0);
    expect(empty.freshestLabel).toBe("无样本");
    // The panel repeats the Controller's own reason instead of writing a second explanation.
    expect(empty.warnings[0]).toContain("STACKPILOT_EGRESS_PROBE_TARGETS");

    const stale = toEgressView(egressPlan({
      nodes: [
        { nodeId: NODE, nodeName: "edge-a", status: "stale", disabledReason: null, overlayAddress: "100.64.0.5", dataPlanePort: 18080, samples: [
          { host: "origin.example.test", ttfbMs: 400, bytesPerSecond: 0, collectedAt, ageSeconds: 5400 },
        ] },
      ],
      warnings: ["edge-a 最近一轮探测失败"],
    }));
    expect(stale.nodes[0].statusLabel).toBe("样本过期");
    // The age comes from the Controller's own clock, never from the browser's.
    expect(stale.nodes[0].sampleLabel).toBe("1 个源 · 2 小时前");
    // Zero measured bytes per second is a measurement; no measurement is "未测出".
    expect(stale.nodes[0].rateLabel).toBe("0 B/s");
    expect(stale.warnings).toEqual(["edge-a 最近一轮探测失败"]);
  });
});

describe("download jobs page", () => {
  beforeEach(() => {
    vi.mocked(fetchDownloadJobs).mockReset();
    vi.mocked(fetchEgressPlan).mockReset();
    vi.mocked(retryDownload).mockReset();
    vi.mocked(createDownload).mockReset();
    vi.mocked(reauthenticate).mockReset();
    vi.mocked(fetchHosts).mockReset();
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt, hosts: [] });
    vi.mocked(fetchEgressPlan).mockResolvedValue(egressPlan());
  });

  it("renders the queue with the backend's collection time", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([job({
      parts: [
        { index: 0, sourceNodeId: NODE, bytes: MIB, totalBytes: 4 * MIB, bytesPerSecond: 512 * 1024 },
        { index: 1, sourceNodeId: NODE, bytes: 4 * MIB, totalBytes: 4 * MIB, bytesPerSecond: 0 },
      ],
    })]));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    expect(await screen.findByRole("heading", { name: "下载任务" })).toBeTruthy();
    expect(screen.getAllByText("example.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2.0 MB / 8.0 MB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.0 MB/s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("传输中").length).toBeGreaterThan(0);
    // Each part gets its own line in the route cell: a per-part rate, not just the job total.
    expect(screen.getAllByText(/^片 1 512 KB\/s$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^片 2 已完成$/).length).toBeGreaterThan(0);
    expect(screen.getByText(/后端采集于/)).toBeTruthy();
    expect(fetchDownloadJobs).toHaveBeenCalledTimes(1);
    // The form needs task creation; a read-only account never sees it.
    expect(screen.queryByRole("heading", { name: "拉取构件" })).toBeNull();
  });

  it("never presents part rates for a job that already stopped", async () => {
    // The Controller decides live-ness; a stale parts array must not become a rate line on its own.
    const finished = job({ status: "succeeded", parts: [
      { index: 0, sourceNodeId: NODE, bytes: 4 * MIB, totalBytes: 4 * MIB, bytesPerSecond: 1024 * 1024 },
    ] });
    expect(toDownloadJobView(finished).parts.length).toBe(1);
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([finished]));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    expect(await screen.findByRole("heading", { name: "下载任务" })).toBeTruthy();
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^片 1/)).toBeNull();
  });

  it("offers a retry only for a finished failure and refreshes after it", async () => {
    vi.mocked(fetchDownloadJobs)
      .mockResolvedValueOnce(list([job({ status: "failed", failureReason: "CACHE_ORIGIN_ERROR", retryable: true })]))
      .mockResolvedValueOnce(list([job({ status: "queued", segmentCount: 0, segmented: false })]));
    vi.mocked(retryDownload).mockResolvedValue({ taskId: "66666666-6666-4666-8666-666666666666", nodeId: NODE, selection: null, segments: null });
    render(<DownloadJobsPage canCreate={false} canRetry canReadNodes />);
    // The table renders a desktop row and a mobile card for the same job.
    const [button] = await screen.findAllByRole("button", { name: "重试" });
    expect(screen.getAllByText("源站拒绝请求").length).toBeGreaterThan(0);
    button.click();
    await waitFor(() => expect(retryDownload).toHaveBeenCalledWith(TASK));
    await waitFor(() => expect(fetchDownloadJobs).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText("排队中")).length).toBeGreaterThan(0);
  });

  it("shows the month's traffic and why a node stopped accelerating", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([job()], traffic({ quotaBytes: 4 * MIB, nodes: [
      { nodeId: NODE, nodeName: "edge-a", receivedBytes: 5 * MIB, originBytes: MIB, servedBytes: 2 * MIB, degraded: true },
    ] })));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    expect(await screen.findByRole("heading", { name: "1 个节点本月下行 5.0 MB" })).toBeTruthy();
    expect(screen.getByText("每节点上限 4.0 MB")).toBeTruthy();
    expect(screen.getAllByText("已停用加速").length).toBeGreaterThan(0);
    expect(screen.getByText(/edge-a 本月已用超过上限/)).toBeTruthy();
    expect(screen.getAllByText("1.0 MB").length).toBeGreaterThan(0);
  });

  it("shows the egress quality table the routing decision reads", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchEgressPlan).mockResolvedValue(egressPlan({
      nodes: [
        { nodeId: NODE, nodeName: "edge-a", status: "ready", disabledReason: null, overlayAddress: "100.64.0.5", dataPlanePort: 18080, samples: [
          { host: "origin.example.test", ttfbMs: 1203, bytesPerSecond: 216 * 1024, collectedAt, ageSeconds: 120 },
        ] },
      ],
      warnings: ["edge-b 最近一轮探测失败"],
    }));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    expect(await screen.findByRole("heading", { name: "1 / 1 个节点可作出口" })).toBeTruthy();
    expect(screen.getAllByText("可作出口").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100.64.0.5:18080").length).toBeGreaterThan(0);
    expect(screen.getAllByText("216 KB/s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.2 s").length).toBeGreaterThan(0);
    expect(screen.getByText("edge-b 最近一轮探测失败")).toBeTruthy();
    // The table is read from the Controller's memory; it must not start a probe round itself.
    expect(fetchEgressPlan).toHaveBeenCalledTimes(1);
  });

  it("says why the quality table is missing when its read fails", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchEgressPlan).mockRejectedValue(new Error("出口探测服务不可用"));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    expect(await screen.findByText(/出口质量表读取失败：出口探测服务不可用/)).toBeTruthy();
  });

  it("keeps the last quality table and says the refresh failed", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchEgressPlan)
      .mockResolvedValueOnce(egressPlan({ nodes: [
        { nodeId: NODE, nodeName: "edge-a", status: "ready", disabledReason: null, overlayAddress: "100.64.0.5", dataPlanePort: 18080, samples: [
          { host: "origin.example.test", ttfbMs: 120, bytesPerSecond: MIB, collectedAt, ageSeconds: 30 },
        ] },
      ] }))
      .mockRejectedValueOnce(new Error("出口探测服务不可用"));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "1 / 1 个节点可作出口" })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    // The last good table stays on screen; the failure is named instead of silently freezing it.
    expect(screen.getByRole("heading", { name: "1 / 1 个节点可作出口" })).toBeTruthy();
    expect(screen.getByText(/最近一次刷新失败，展示上次成功数据/)).toBeTruthy();
    vi.useRealTimers();
  });

  it("does not poll the quality table for an account that cannot read nodes", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes={false} />);
    expect(await screen.findByRole("heading", { name: "下载任务" })).toBeTruthy();
    expect(await screen.findByText(/出口质量表需要节点读取权限/)).toBeTruthy();
    // A 403 every ten seconds behind a card that never renders is worse than not asking.
    expect(fetchEgressPlan).not.toHaveBeenCalled();
  });

  it("keeps a failed load retryable and never claims an empty queue", async () => {
    vi.mocked(fetchDownloadJobs).mockRejectedValue(new Error("当前账号没有任务读取权限"));
    render(<DownloadJobsPage canCreate={false} canRetry={false} canReadNodes />);
    expect(await screen.findByText("当前账号没有任务读取权限")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText("还没有下载任务")).toBeNull();
  });

  it("shows the honest empty state when the Controller has no jobs", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    render(<DownloadJobsPage canCreate canRetry canReadNodes />);
    expect(await screen.findByText("还没有下载任务")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "拉取构件" })).toBeTruthy();
  });

  it("carries an optional SHA-256, normalized, and clears it after the request", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt, hosts: [host()] });
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "reauth-proof", expiresAt: collectedAt });
    vi.mocked(createDownload).mockResolvedValue({ taskId: TASK, nodeId: NODE, selection: null, segments: null });
    render(<DownloadJobsPage canCreate canRetry canReadNodes />);
    await screen.findByRole("option", { name: "edge-a" });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/releases/app.tar.gz"), { target: { value: "https://example.com/app.tar.gz" } });
    fireEvent.change(screen.getByLabelText("接收节点"), { target: { value: NODE } });
    // The helper explains the field instead of becoming its name, and it has to stay attached as a description.
    expect(screen.getByRole("textbox", { name: "SHA-256 摘要（可选）" })).toHaveAccessibleDescription(/留空则不校验/);
    fireEvent.change(screen.getByPlaceholderText("64 位十六进制"), { target: { value: "A".repeat(64) } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "开始拉取" }));
    await waitFor(() => expect(createDownload).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(createDownload).mock.calls[0]!;
    // The Agent only accepts lowercase hex, so the panel normalizes rather than failing after reauthentication.
    expect(payload.digest).toBe("a".repeat(64));
    expect(payload.url).toBe("https://example.com/app.tar.gz");
    expect(screen.getByPlaceholderText("64 位十六进制")).toHaveValue("");
  });

  it("leaves the digest out when the operator does not have one", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt, hosts: [host()] });
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "reauth-proof", expiresAt: collectedAt });
    vi.mocked(createDownload).mockResolvedValue({ taskId: TASK, nodeId: NODE, selection: null, segments: null });
    render(<DownloadJobsPage canCreate canRetry canReadNodes />);
    await screen.findByRole("option", { name: "edge-a" });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/releases/app.tar.gz"), { target: { value: "https://example.com/app.tar.gz" } });
    fireEvent.change(screen.getByLabelText("接收节点"), { target: { value: NODE } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "开始拉取" }));
    await waitFor(() => expect(createDownload).toHaveBeenCalledTimes(1));
    const [payload] = vi.mocked(createDownload).mock.calls[0]!;
    expect("digest" in payload).toBe(false);
  });

  it.each([
    ["63 位", "a".repeat(63)],
    ["65 位", "a".repeat(65)],
    ["非十六进制", "g".repeat(64)],
  ])("refuses a malformed SHA-256 (%s) before spending the password", async (_label, value) => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt, hosts: [host()] });
    render(<DownloadJobsPage canCreate canRetry canReadNodes />);
    await screen.findByRole("option", { name: "edge-a" });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/releases/app.tar.gz"), { target: { value: "https://example.com/app.tar.gz" } });
    fireEvent.change(screen.getByLabelText("接收节点"), { target: { value: NODE } });
    fireEvent.change(screen.getByPlaceholderText("64 位十六进制"), { target: { value } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "开始拉取" }));
    expect(await screen.findByText("SHA-256 摘要需要 64 位十六进制字符，或留空")).toBeTruthy();
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(createDownload).not.toHaveBeenCalled();
  });

  it("keeps the digest when the request itself fails", async () => {
    vi.mocked(fetchDownloadJobs).mockResolvedValue(list([]));
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt, hosts: [host()] });
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "reauth-proof", expiresAt: collectedAt });
    vi.mocked(createDownload).mockRejectedValue(new Error("节点当前不可用"));
    render(<DownloadJobsPage canCreate canRetry canReadNodes />);
    await screen.findByRole("option", { name: "edge-a" });
    fireEvent.change(screen.getByPlaceholderText("https://example.com/releases/app.tar.gz"), { target: { value: "https://example.com/app.tar.gz" } });
    fireEvent.change(screen.getByLabelText("接收节点"), { target: { value: NODE } });
    fireEvent.change(screen.getByPlaceholderText("64 位十六进制"), { target: { value: "b".repeat(64) } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "开始拉取" }));
    expect(await screen.findByText("节点当前不可用")).toBeTruthy();
    // Retrying must not require the operator to paste the same 64 characters again.
    expect(screen.getByPlaceholderText("64 位十六进制")).toHaveValue("b".repeat(64));
  });
});
