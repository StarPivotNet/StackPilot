import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { OverviewNode } from "@stackpilot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostTable, TaskTable } from "../features/overview/OverviewTables";
import { OverviewDiskUsage, OverviewUsageRing } from "../features/overview/OverviewUI";
import { useOverviewResource } from "../features/overview/useOverviewResource";

const gib = 1024 ** 3;
const node: OverviewNode = {
  id: "node-1", name: "long-production-node.internal.example", ip: "198.18.0.11", env: "生产", status: "健康", source: "agent",
  collectedAt: "2026-11-12T12:30:00.000Z", freshness: "current",
  availability: { cpu: true, memory: true, disk: true, latency: true, backup: true, update: true, services: true },
  latency: "12ms", latencyStatus: "健康", cpu: "24%", memory: "48%", disk: "20%", version: "test-v1", uptime: "8 天", backup: "已备份", backupStatus: "健康", update: "已是最新", owner: "测试团队", services: [],
  diskVolumes: [{ label: "root", mount: "/", totalBytes: 100 * gib, usedBytes: 20 * gib, percent: 20 }, { label: "data", mount: "/data", totalBytes: 900 * gib, usedBytes: 720 * gib, percent: 80 }],
};

afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

describe("Overview resource semantics", () => {
  it("announces a successful empty task collection without creating task rows", () => {
    const view = render(<TaskTable tasks={[]} />);
    expect(screen.getByRole("status", { name: "任务采集状态" })).toHaveTextContent("暂无任务，自动采集将继续运行");
    expect(view.container.querySelectorAll(".feed-status-icon")).toHaveLength(0);
  });
  it("weights every disk by capacity and exposes both volumes after 400ms keyboard focus", async () => {
    vi.useFakeTimers();
    const view = render(<OverviewDiskUsage node={node} />);
    expect(screen.getByRole("img", { name: "全部磁盘使用率 74%" })).toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText("查看全部磁盘明细"));
    await act(async () => { vi.advanceTimersByTime(399); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1); });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveTextContent("root · 20%");
    expect(tooltip).toHaveTextContent("data · 80%");
    expect(tooltip).toHaveTextContent("720 GiB / 900 GiB");
    fireEvent.blur(screen.getByLabelText("查看全部磁盘明细"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByLabelText("查看全部磁盘明细"));
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("labels unavailable values without drawing zero percent", () => {
    render(<OverviewUsageRing label="CPU" value="暂不可用" />);
    expect(screen.getByText("暂不可用")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps a detail by ID after reorder and permanently closes a removed identity", () => {
    const other = { ...node, id: "node-2", name: "other-node", ip: "198.18.0.12" };
    const view = render(<HostTable nodes={[node, other]} notify={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: `查看 ${node.name} 节点详情` })[0]);
    expect(screen.getByRole("dialog", { name: node.name }).parentElement).toBe(document.body);
    expect(screen.getByRole("dialog", { name: node.name }).querySelector(".drawer-close-button")).toHaveFocus();
    view.rerender(<HostTable nodes={[other]} allNodes={[other, { ...node, owner: "已更新负责人" }]} notify={vi.fn()} />);
    expect(within(screen.getByRole("dialog", { name: node.name })).getByText("已更新负责人")).toBeInTheDocument();
    view.rerender(<HostTable nodes={[other]} notify={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<HostTable nodes={[other, node]} notify={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Standalone Overview polling", () => {
  it("coalesces retry with a slow request, pauses hidden, and retains data after background failure", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const request = vi.fn<(_signal?: AbortSignal) => Promise<string>>().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockRejectedValueOnce(new Error("background unavailable")).mockResolvedValue("visible snapshot");
    const onError = vi.fn();
    function Probe() {
      const value = useOverviewResource(request, true, onError);
      return <><output>{value.data ?? "waiting"}</output><span>{value.error}</span><button type="button" onClick={() => void value.reload()}>retry</button></>;
    }
    const view = render(<Probe />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve("stable snapshot"); });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByText("stable snapshot")).toBeInTheDocument();
    expect(screen.queryByText("background unavailable")).not.toBeInTheDocument();
    expect(onError).not.toHaveBeenCalled();
    act(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByText("visible snapshot")).toBeInTheDocument();
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
