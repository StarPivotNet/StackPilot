import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewHealthPage } from "../pages/OverviewHealthPage";
import { OverviewRisksPage } from "../pages/OverviewRisksPage";
import { exportOverviewRisks, fetchOverviewHealth, fetchOverviewRisks } from "../api/overviewApi";
import type { OverviewRiskRecord } from "../api/overviewApi";

vi.mock("../api/overviewApi", () => ({
  fetchOverviewHealth: vi.fn(),
  fetchOverviewRisks: vi.fn(),
  exportOverviewRisks: vi.fn(),
}));

describe("overview health API states", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    vi.mocked(fetchOverviewHealth).mockReset();
  });

  it("announces loading while the API request is pending", () => {
    vi.mocked(fetchOverviewHealth).mockReturnValue(new Promise(() => undefined));
    render(<OverviewHealthPage notify={notify} />);
    expect(screen.getByRole("heading", { name: "正在采集节点状态" }).closest("section")).toHaveAttribute("role", "status");
    expect(screen.getAllByText("正在采集节点状态").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "集群状态" })).not.toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Agent 管理" })).toBeInTheDocument();
  });

  it("shows a retryable error without injecting fixture rows", async () => {
    vi.mocked(fetchOverviewHealth).mockRejectedValue(new Error("Controller 暂不可用"));
    render(<OverviewHealthPage notify={notify} />);
    expect(await screen.findByText("Controller 暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Controller 暂不可用");
    expect(screen.queryAllByRole("button", { name: /节点详情/ })).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith("Controller 暂不可用", "danger");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes silently every ten seconds without a manual refresh action", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchOverviewHealth)
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T12:30:00.000Z", lastRefresh: "12:30:00", nodes: [] })
      .mockResolvedValueOnce({ collectedAt: "2026-07-12T12:30:10.000Z", lastRefresh: "12:30:10", nodes: [] });

    render(<OverviewHealthPage notify={notify} />);
    await act(async () => undefined);

    expect(fetchOverviewHealth).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "刷新状态" })).not.toBeInTheDocument();
    expect(screen.queryByText(/监控 0 个节点的健康/)).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(9_999);
    });
    expect(fetchOverviewHealth).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(fetchOverviewHealth).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("opens the complete node detail drawer for a long hostname", async () => {
    const user = userEvent.setup();
    const hostname = "edge-production-observability-node-with-a-very-long-hostname-01.internal.example";
    vi.mocked(fetchOverviewHealth).mockResolvedValue({
      collectedAt: "2026-07-12T12:30:00.000Z", lastRefresh: "12:30:00",
      nodes: [{
        id: "node-1",
        name: hostname,
        ip: "198.18.0.1",
        env: "本机",
        status: "健康",
        source: "controller",
        collectedAt: "2026-07-12T12:30:00.000Z",
        freshness: "current",
        availability: { cpu: true, memory: true, disk: true, latency: true, backup: true, update: true, services: true },
        latency: "12ms",
        latencyStatus: "健康",
        cpu: "24%",
        memory: "48%",
        disk: "36%",
        version: "v1.0.0",
        uptime: "8 天",
        backup: "2 小时前",
        backupStatus: "健康",
        update: "已是最新",
        owner: "平台团队",
        services: [{ id: "service-1", name: "Controller", target: "local", status: "健康", detail: "运行中" }],
      }],
    });

    render(<OverviewHealthPage notify={notify} />);
    await screen.findByRole("button", { name: `查看 ${hostname} 节点详情` });
    expect(screen.getAllByText("健康").length).toBeGreaterThan(0);
    expect(screen.getByTitle(hostname)).toHaveTextContent(hostname);
    await user.click(screen.getByRole("button", { name: `查看 ${hostname} 节点详情` }));

    const drawer = screen.getByRole("dialog", { name: hostname });
    expect(drawer).toHaveClass("detail-drawer");
    expect(drawer).not.toHaveClass("health-node-modal");
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("运行时间")).toBeInTheDocument();
    expect(within(drawer).getByText("CPU")).toBeInTheDocument();
    expect(within(drawer).getByText("服务列表")).toBeInTheDocument();
    expect(drawer.querySelector(".node-service-list strong")).toHaveTextContent("Controller");
  });
});

const riskFixture: OverviewRiskRecord = {
  id: "risk-1",
  title: "证书即将过期",
  level: "高危",
  status: "待处理",
  target: "api.production.internal.example",
  owner: "平台团队",
  impact: "入口 TLS 连接可能中断",
  detected: "2 分钟前",
  suggestion: "更新证书\n验证入口连通性",
  evidence: [{ label: "剩余时间", value: "2 天" }],
  traceId: "risk-trace-1",
};

describe("overview risks API states", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    vi.mocked(fetchOverviewRisks).mockReset();
    vi.mocked(exportOverviewRisks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a retryable initial error without fixture risks", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchOverviewRisks)
      .mockRejectedValueOnce(new Error("风险采集暂不可用"))
      .mockResolvedValueOnce({ risks: [], scannedAt: "12:30:00" });

    render(<OverviewRisksPage notify={notify} />);

    expect(await screen.findByText("风险采集暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("风险采集暂不可用");
    expect(screen.queryAllByRole("button", { name: /详情/ })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("12:30:00", { selector: ".module-metrics strong" })).toBeInTheDocument();
    expect(screen.queryByText("风险采集暂不可用")).not.toBeInTheDocument();
  });

  it("keeps visible navigation while polling silently and preserving detail by stable id", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchOverviewRisks)
      .mockResolvedValueOnce({ risks: [riskFixture], scannedAt: "12:30:00" })
      .mockResolvedValueOnce({ risks: [{ ...riskFixture, impact: "更新后的入口影响" }], scannedAt: "12:30:10" });

    render(<OverviewRisksPage notify={notify} />);
    await act(async () => undefined);

    expect(screen.queryByRole("button", { name: "重新扫描" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "风险中心" })).not.toHaveClass("sr-only");
    const page = screen.getByRole("heading", { name: "风险中心" }).closest(".module-page-overview-risks");
    const metrics = page?.querySelector(".module-metrics");
    const listSection = page?.querySelector(".risk-list-section");
    const table = page?.querySelector(".module-table-wrap");
    const toolbar = screen.getByRole("toolbar", { name: "风险列表操作" });
    expect(page?.querySelector(".module-head-actions-only")).not.toBeInTheDocument();
    expect((metrics?.compareDocumentPosition(toolbar) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toolbar.compareDocumentPosition(table as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listSection).toContainElement(toolbar);
    expect(listSection).toContainElement(table as HTMLElement);
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "导出报告" }));
    expect(screen.queryByPlaceholderText("搜索风险、目标或 trace id")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: /详情/ })[0]);

    const dialog = screen.getByRole("dialog", { name: riskFixture.title });
    expect(dialog.parentElement).toBe(document.body);
    expect(within(dialog).getByText(riskFixture.impact)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(fetchOverviewRisks).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("dialog", { name: riskFixture.title })).getByText("更新后的入口影响")).toBeInTheDocument();
    expect(screen.getByText("12:30:10", { selector: ".module-metrics strong" })).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
  });
});
