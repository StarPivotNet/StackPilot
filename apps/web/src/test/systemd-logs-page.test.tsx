import type { SystemdServicesPayload } from "@stackpilot/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSystemdServices } from "../api/systemdApi";
import { SystemdPage } from "../pages/SystemdPage";

vi.mock("../api/systemdApi", () => ({ fetchSystemdServices: vi.fn() }));
const collectedAt = "2026-07-15T01:02:03.000Z";
function payload(services: SystemdServicesPayload["services"] = []): SystemdServicesPayload { return { collectedAt, collectionStatus: "complete", warnings: [], services }; }
function service(overrides: Partial<SystemdServicesPayload["services"][number]> = {}): SystemdServicesPayload["services"][number] {
  return { id: "11111111-1111-4111-8111-111111111111:nginx.service", nodeId: "11111111-1111-4111-8111-111111111111", host: "prod-real-01", platform: "linux", sourceCollectedAt: collectedAt, freshness: "current", unit: "nginx.service", description: "A real web server", loadState: "loaded", activeState: "active", subState: "running", memoryCurrentBytes: 1048576, restartCount: 2, stateChangedAt: collectedAt, journal: [{ cursor: "cursor-1", timestamp: collectedAt, priority: 6, identifier: "nginx", pid: "42", message: "real backend journal line" }], ...overrides };
}

describe("systemd logs page", () => {
  beforeEach(() => { vi.mocked(fetchSystemdServices).mockReset(); });

  it("shows the CloudPulse heading while retaining freshness", async () => {
    vi.mocked(fetchSystemdServices).mockResolvedValue(payload([service()]));
    const { container } = render(<SystemdPage page="systemd-logs" notify={vi.fn()} />);
    await screen.findByRole("log", { name: "nginx.service journal 摘要" });
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "服务日志" })).not.toHaveClass("sr-only");
    expect(screen.getAllByText(/采集时间/).length).toBeGreaterThan(0);
  });

  it("renders real backend journal and freshness without manual refresh or mutations", async () => {
    vi.mocked(fetchSystemdServices).mockResolvedValue(payload([service(), service({ id: "22222222-2222-4222-8222-222222222222:mysql.service", nodeId: "22222222-2222-4222-8222-222222222222", unit: "mysql.service", host: "prod-real-02", activeState: "failed", subState: "failed", journal: [] })]));
    render(<SystemdPage page="systemd-logs" notify={vi.fn()} />);
    expect(await screen.findByRole("log", { name: "nginx.service journal 摘要" })).toHaveTextContent("real backend journal line");
    expect(screen.getByText("prod-real-01")).toBeInTheDocument(); expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /刷新|启动服务|停止服务|重启服务/ })).not.toBeInTheDocument();
    expect(screen.queryByText("panel-se-01")).not.toBeInTheDocument(); expect(fetchSystemdServices).toHaveBeenCalledTimes(1);
  });

  it("opens complete service information in a body-level modal drawer and restores focus", async () => {
    const user = userEvent.setup(); vi.mocked(fetchSystemdServices).mockResolvedValue(payload([service()]));
    render(<SystemdPage page="systemd-logs" notify={vi.fn()} />);
    const trigger = await screen.findByRole("button", { name: "打开服务 nginx.service 日志详情" }); await user.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "服务日志详情" }); expect(drawer.parentElement).toBe(document.body); expect(drawer).toHaveClass("systemd-log-drawer");
    expect(within(drawer).getByText("prod-real-01", { selector: "dd" })).toHaveAttribute("title", "prod-real-01"); expect(within(drawer).getByText("1.0 MB")).toBeInTheDocument(); expect(within(drawer).getByRole("log")).toHaveTextContent("real backend journal line");
    fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog", { name: "服务日志详情" })).not.toBeInTheDocument()); expect(trigger).toHaveFocus();
  });

  it("shows an initial error with retry and an explicit real empty state", async () => {
    vi.mocked(fetchSystemdServices).mockRejectedValueOnce(new Error("systemd API unavailable")).mockResolvedValueOnce({ ...payload(), collectionStatus: "unavailable", warnings: ["agent awaiting snapshot"] });
    const user = userEvent.setup(); render(<SystemdPage page="systemd-logs" notify={vi.fn()} />);
    expect(await screen.findByText("systemd API unavailable")).toBeInTheDocument(); await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("systemd 数据暂不可用")).toBeInTheDocument(); expect(screen.getByText("agent awaiting snapshot")).toBeInTheDocument();
  });
});
