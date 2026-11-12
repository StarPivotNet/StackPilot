import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHosts, type HostMonitoringRecord } from "../api/hostsApi";
import { formatTimestamp, toHostView } from "../features/hosts/viewModel";
import { HostsPage } from "../pages/HostsPage";

vi.mock("../api/hostsApi", () => ({ fetchHosts: vi.fn() }));

const longHostname = "edge-production-observability-node-with-a-very-long-hostname-01.internal.example";
const gib = 1024 ** 3;

function host(overrides: Partial<HostMonitoringRecord> = {}): HostMonitoringRecord {
  return {
    id: "node-1", source: "agent", name: longHostname, platform: "linux", address: "198.18.0.1",
    environment: "生产", owner: "平台团队", connectionStatus: "online", healthStatus: "healthy",
    telemetryFreshness: "current",
    telemetryCollectedAt: "2026-07-12T04:30:00.000Z", lastSeenAt: "2026-07-12T04:30:01.000Z", cpuPercent: 24,
    memory: { totalBytes: 100 * gib, usedBytes: 48 * gib, percent: 48 },
    disk: { totalBytes: 500 * gib, usedBytes: 400 * gib, percent: 80, volumes: [
      { label: "root", mountPath: "/", totalBytes: 200 * gib, usedBytes: 120 * gib, percent: 60 },
      { label: "data", mountPath: "/data", totalBytes: 300 * gib, usedBytes: 280 * gib, percent: 93 },
    ] },
    uptimeSeconds: 8 * 86_400, backup: { status: "healthy", latestAt: "2026-07-12T02:30:00.000Z", detail: "备份正常" },
    services: [{ name: "Controller", status: "running" }], version: "v1.0.0", latency: null, updateStatus: null,
    ...overrides,
  };
}

describe("hosts live monitoring page", () => {
  const notify = vi.fn();
  beforeEach(() => { notify.mockClear(); vi.mocked(fetchHosts).mockReset(); });
  afterEach(() => vi.useRealTimers());

  it("weights every detected disk by capacity rather than trusting a system-volume percentage", () => {
    const view = toHostView(host({ disk: { totalBytes: 100 * gib, usedBytes: 10 * gib, percent: 10, volumes: [
      { label: "system", mountPath: "/", totalBytes: 100 * gib, usedBytes: 10 * gib, percent: 10 },
      { label: "data", mountPath: "/data", totalBytes: 900 * gib, usedBytes: 810 * gib, percent: 90 },
    ] } }));
    expect(view.disk).toBe(82);
    expect(view.diskTotalBytes).toBe(1000 * gib);
    expect(view.diskUsedBytes).toBe(820 * gib);
    expect(view.diskVolumes).toHaveLength(2);
  });

  it("retains the selected stable host when a fresh snapshot reorders multiple nodes", async () => {
    vi.useFakeTimers();
    const other = host({ id: "node-2", name: "second-node", address: "198.18.0.2", owner: "第二组", cpuPercent: 21 });
    vi.mocked(fetchHosts)
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T04:30:00Z", hosts: [host(), other] })
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T04:30:10Z", hosts: [{ ...other, cpuPercent: 37 }, host()] });
    render(<HostsPage page="hosts" notify={notify} />);
    await act(async () => undefined);
    fireEvent.click(screen.getAllByRole("button", { name: "查看主机 second-node" })[0]);
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    const drawer = screen.getByRole("dialog", { name: "second-node" });
    expect(within(drawer).getByText("node-2")).toBeInTheDocument();
    expect(within(drawer).getByText("第二组")).toBeInTheDocument();
    expect(within(drawer).getByText("37%")).toBeInTheDocument();
    expect(within(drawer).queryByText(longHostname)).not.toBeInTheDocument();
  });

  it("shows the CloudPulse heading and summary from the hosts page", async () => {
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt: "2026-07-12T04:30:02.000Z", hosts: [host()] });
    const { container } = render(<HostsPage page="hosts" notify={notify} />);

    await screen.findAllByTitle(longHostname);

    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "主机", level: 1 })).not.toHaveClass("sr-only");
    expect(screen.queryByText("正在采集主机、服务与资源状态")).not.toBeInTheDocument();
  });

  it("shows a retryable initial error without fixture hosts", async () => {
    vi.mocked(fetchHosts).mockRejectedValue(new Error("Controller 暂不可用"));
    render(<HostsPage page="hosts" notify={notify} />);
    expect(await screen.findByText("Controller 暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getAllByText("实时采集失败，未显示示例主机")).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith("Controller 暂不可用", "danger");
  });

  it("polls silently, preserves selected ID, and retains data on a background failure", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchHosts)
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T04:30:00.000Z", hosts: [host()] })
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T04:30:10.000Z", hosts: [host({ cpuPercent: 31 })] })
      .mockRejectedValueOnce(new Error("瞬时失败"))
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T04:30:30.000Z", hosts: [] });
    render(<HostsPage page="hosts" notify={notify} />);
    await act(async () => undefined);
    fireEvent.click(screen.getAllByRole("button", { name: `查看主机 ${longHostname}` })[0]);
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchHosts).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("dialog", { name: longHostname })).getByText("31%")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByRole("dialog", { name: longHostname })).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.queryByRole("dialog", { name: longHostname })).not.toBeInTheDocument();
  });

  it("shows every disk volume and per-host collection time", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt: "2026-07-12T04:30:02.000Z", hosts: [host()] });
    render(<HostsPage page="hosts" notify={notify} />);
    await screen.findAllByTitle(longHostname);
    const diskTrigger = screen.getAllByRole("button", { name: "磁盘使用率 80%" })[0];
    fireEvent.mouseEnter(diskTrigger);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 420)); });
    const tooltip = screen.getAllByRole("tooltip")[0];
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveTextContent("root (/)");
    expect(tooltip).toHaveTextContent("60% · 已用 120.0 GB / 200.0 GB");
    expect(tooltip).toHaveTextContent("data (/data)");
    expect(tooltip).toHaveTextContent("93% · 已用 280.0 GB / 300.0 GB");
    await user.click(screen.getAllByRole("button", { name: `查看主机 ${longHostname}` })[0]);
    const drawer = screen.getByRole("dialog", { name: longHostname });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("最近在线")).toBeInTheDocument();
    expect(within(drawer).getByText("Controller")).toBeInTheDocument();
    expect(within(drawer).getByText("/data")).toBeInTheDocument();
    expect(within(drawer).getByText(/采集于/)).toBeInTheDocument();
  });

  it("labels old agents as awaiting telemetry without rendering fake zero bars", async () => {
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt: "2026-07-12T04:30:02.000Z", hosts: [host({
      connectionStatus: "online", healthStatus: "unknown", telemetryCollectedAt: null,
      telemetryFreshness: "awaiting",
      cpuPercent: null, memory: null, disk: null, uptimeSeconds: null, backup: null, services: [],
    })] });
    render(<HostsPage page="hosts" notify={notify} />);
    expect((await screen.findAllByText("在线 · 等待采集")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("等待采集").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("includes pending and awaiting agents in the default alert queue", async () => {
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt: "2026-07-12T04:30:02.000Z", hosts: [
      host({ id: "pending", name: "pending-node", connectionStatus: "pending", healthStatus: "unknown", telemetryFreshness: "awaiting", telemetryCollectedAt: null, cpuPercent: null, memory: null, disk: null }),
      host({ id: "legacy", name: "legacy-node", connectionStatus: "online", healthStatus: "unknown", telemetryFreshness: "awaiting", telemetryCollectedAt: null, cpuPercent: null, memory: null, disk: null }),
    ] });
    render(<HostsPage page="hosts-alert" notify={notify} />);
    expect(await screen.findAllByText("pending-node")).not.toHaveLength(0);
    expect(screen.getAllByText("legacy-node")).not.toHaveLength(0);
    expect(screen.getAllByText("待连接").length).toBeGreaterThan(0);
    expect(screen.getAllByText("在线 · 等待采集").length).toBeGreaterThan(0);
  });

  it("keeps production filtering scoped to the production environment", async () => {
    vi.mocked(fetchHosts).mockResolvedValue({ collectedAt: "2026-07-12T04:30:02.000Z", hosts: [host(), host({ id: "node-dev", name: "dev-node", environment: "开发", address: "198.18.0.2" })] });
    const { container } = render(<HostsPage page="hosts-prod" notify={notify} />);
    await screen.findAllByText(longHostname);
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "生产环境", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("生产运行视图")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索主机名、IP、服务或版本")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /健康/ })).toBeInTheDocument();
    expect(screen.getByText("生产主机")).toBeInTheDocument();
    expect(screen.queryByText("dev-node")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /环境/ })).toBeInTheDocument();
    expect(screen.getByLabelText("CPU 24%，内存 48%，磁盘 80%")).toBeInTheDocument();
    expect(screen.getAllByText(formatTimestamp("2026-07-12T04:30:00.000Z")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /刷新|重新采集|重新扫描/ })).not.toBeInTheDocument();
  });
});
