import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHosts, type HostMonitoringRecord } from "../api/hostsApi";
import { formatTimestamp } from "../features/hosts/viewModel";
import { HostsPage } from "../pages/HostsPage";

vi.mock("../api/hostsApi", () => ({ fetchHosts: vi.fn() }));

const longHostname = "edge-production-observability-node-with-a-very-long-hostname-01.internal.example";
const alertNode: HostMonitoringRecord = {
  id: "node-alert-1", source: "agent", name: longHostname, platform: "linux", address: "198.18.0.23",
  environment: "生产", owner: "平台团队", connectionStatus: "offline", healthStatus: "degraded",
  telemetryFreshness: "stale",
  telemetryCollectedAt: "2026-07-12T04:30:00.000Z", lastSeenAt: "2026-07-12T04:30:01.000Z", cpuPercent: 74,
  memory: { totalBytes: 1000, usedBytes: 830, percent: 83 },
  disk: { totalBytes: 1000, usedBytes: 680, percent: 68, volumes: [{ label: "data", mountPath: "/data", totalBytes: 1000, usedBytes: 680, percent: 68 }] },
  uptimeSeconds: 18 * 86_400, backup: { status: "degraded", latestAt: null, detail: "备份过期" },
  services: [{ name: "Controller", status: "stopped" }], version: "v0.2.0", latency: null, updateStatus: null,
};

describe("hosts alert page", () => {
  beforeEach(() => { vi.mocked(fetchHosts).mockReset(); vi.mocked(fetchHosts).mockResolvedValue({ hosts: [alertNode], collectedAt: "2026-07-12T04:30:02.000Z" }); });

  it("uses backend freshness and exposes offline state without manual collection actions", async () => {
    const { container } = render(<HostsPage page="hosts-alert" notify={vi.fn()} />);
    expect(await screen.findByText(`采集于 ${formatTimestamp("2026-07-12T04:30:02.000Z")}`)).toBeInTheDocument();
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(screen.queryByText("告警处置队列")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索主机名、IP、服务或版本")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.getByText("状态摘要")).toBeInTheDocument();
    expect(screen.getAllByText("离线").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /新增主机|刷新|重新采集|重新扫描/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "主机告警队列" })).toBeInTheDocument();
  });

  it("opens complete long-hostname details", async () => {
    const user = userEvent.setup();
    render(<HostsPage page="hosts-alert" notify={vi.fn()} />);
    await user.click((await screen.findAllByRole("button", { name: `查看主机 ${longHostname}` }))[0]);
    const drawer = screen.getByRole("dialog", { name: longHostname });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("运行时间")).toBeInTheDocument();
    expect(within(drawer).getByText("负责人")).toBeInTheDocument();
    expect(within(drawer).getByText("磁盘卷")).toBeInTheDocument();
    expect(within(drawer).getByText("服务实例")).toBeInTheDocument();
  });
});
