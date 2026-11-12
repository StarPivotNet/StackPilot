import type { SystemdServicesPayload } from "@stackpilot/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSystemdServices } from "../api/systemdApi";
import { SystemdPage } from "../pages/SystemdPage";

vi.mock("../api/systemdApi", () => ({ fetchSystemdServices: vi.fn() }));
const time = "2026-07-15T01:02:03.000Z";
const services: SystemdServicesPayload["services"] = [{ id: "11111111-1111-4111-8111-111111111111:nginx.service", nodeId: "11111111-1111-4111-8111-111111111111", host: "prod-real-01", platform: "linux", sourceCollectedAt: time, freshness: "current", unit: "nginx.service", description: "A real web server", loadState: "loaded", activeState: "active", subState: "running", memoryCurrentBytes: 1048576, restartCount: 2, stateChangedAt: time, journal: [] }, { id: "22222222-2222-4222-8222-222222222222:failed.service", nodeId: "22222222-2222-4222-8222-222222222222", host: "prod-real-02", platform: "linux", sourceCollectedAt: time, freshness: "current", unit: "failed.service", description: "Failed worker", loadState: "loaded", activeState: "failed", subState: "failed", memoryCurrentBytes: null, restartCount: 4, stateChangedAt: time, journal: [] }];
const payload: SystemdServicesPayload = { collectedAt: time, collectionStatus: "complete", warnings: [], services };

describe("systemd service page", () => {
  beforeEach(() => { vi.mocked(fetchSystemdServices).mockReset(); vi.mocked(fetchSystemdServices).mockResolvedValue(payload); });
  afterEach(() => vi.useRealTimers());
  it.each([
    ["systemd", "systemd 服务"],
    ["systemd-active", "Active 服务"],
    ["systemd-failed", "Failed 服务"],
  ] as const)("shows the CloudPulse heading and navigation on %s", async (page, title) => {
    const { container } = render(<SystemdPage page={page} notify={vi.fn()} />);
    await screen.findByText(/采集时间/);
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
  });
  it("renders real read-only rows and opens a complete portaled drawer", async () => {
    const user = userEvent.setup(); render(<SystemdPage page="systemd" notify={vi.fn()} canOperate />); const table = await screen.findByRole("table");
    expect(within(table).getByText("A real web server")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: /启动服务|停止服务|重启服务|标记服务/ })).not.toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "查看服务 nginx.service 日志" }));
    const drawer = screen.getByRole("dialog", { name: "nginx.service" }); expect(drawer.parentElement).toBe(document.body); expect(within(drawer).getByText("prod-real-01", { selector: "dd" })).toBeInTheDocument();
  });
  it("keeps failed page filtering on backend records", async () => {
    render(<SystemdPage page="systemd-failed" notify={vi.fn()} />); const table = await screen.findByRole("table");
    expect(within(table).getByText("failed.service")).toBeInTheDocument(); expect(within(table).queryByText("nginx.service")).not.toBeInTheDocument();
  });
  it("paginates large inventories and marks transitional states as warnings", async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ ...services[0]!, id: `11111111-1111-4111-8111-111111111111:unit-${index}.service`, unit: `unit-${index}.service`, activeState: index === 0 ? "activating" as const : "active" as const }));
    vi.mocked(fetchSystemdServices).mockResolvedValueOnce({ ...payload, services: many });
    render(<SystemdPage page="systemd" notify={vi.fn()} />);
    expect(await screen.findByText("第 1 / 2 页 · 共 101 条")).toBeInTheDocument();
    expect(screen.getAllByText("启动中").length).toBeGreaterThan(0); expect(screen.getAllByText("启动中")[0]?.closest(".systemd-status")).toHaveClass("orange");
  });
  it("polls after 10 seconds while preserving filters, selected identity and last successful data", async () => {
    vi.useFakeTimers();
    const updated = { ...services[0]!, description: "Updated real service", activeState: "failed" as const, subState: "failed", journal: [{ cursor: "updated-cursor", timestamp: time, priority: 3, identifier: "nginx", pid: "52", message: "updated journal" }] };
    vi.mocked(fetchSystemdServices).mockResolvedValueOnce({ ...payload, collectedAt: "2026-07-15T01:02:13.000Z", services: [updated] }).mockRejectedValueOnce(new Error("background unavailable")).mockResolvedValueOnce({ ...payload, collectedAt: "2026-07-15T01:02:33.000Z", services: [] });
    render(<SystemdPage page="systemd" notify={vi.fn()} initialPayload={payload} />);
    const search = screen.getByPlaceholderText("搜索服务、说明或主机"); fireEvent.change(search, { target: { value: "nginx" } });
    fireEvent.click(screen.getByRole("button", { name: "查看服务 nginx.service 日志" })); expect(screen.getByRole("dialog", { name: "nginx.service" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchSystemdServices).toHaveBeenCalledTimes(1); expect(search).toHaveValue("nginx"); expect(within(screen.getByRole("dialog", { name: "nginx.service" })).getByRole("log")).toHaveTextContent("updated journal");
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchSystemdServices).toHaveBeenCalledTimes(2); expect(screen.getByText(/后台刷新失败，保留上次数据：background unavailable/)).toBeInTheDocument(); expect(screen.getByRole("dialog", { name: "nginx.service" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole("dialog", { name: "nginx.service" })).not.toBeInTheDocument();
  });
  it("pauses polling while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers(); let hidden = true; const descriptor = Object.getOwnPropertyDescriptor(document, "hidden"); Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try { render(<SystemdPage page="systemd" notify={vi.fn()} initialPayload={payload} />); await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); }); expect(fetchSystemdServices).not.toHaveBeenCalled(); hidden = false; await act(async () => { fireEvent(document, new Event("visibilitychange")); await Promise.resolve(); await Promise.resolve(); }); expect(fetchSystemdServices).toHaveBeenCalledTimes(1); }
    finally { if (descriptor) Object.defineProperty(document, "hidden", descriptor); }
  });
  it("never overlaps a slow systemd poll", async () => {
    vi.useFakeTimers(); let resolveSlow: ((value: SystemdServicesPayload) => void) | undefined;
    vi.mocked(fetchSystemdServices).mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; })).mockResolvedValue(payload);
    render(<SystemdPage page="systemd" notify={vi.fn()} initialPayload={payload} />);
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); }); expect(fetchSystemdServices).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); }); expect(fetchSystemdServices).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSlow?.(payload); await Promise.resolve(); await Promise.resolve(); }); await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); }); expect(fetchSystemdServices).toHaveBeenCalledTimes(2);
  });
});
