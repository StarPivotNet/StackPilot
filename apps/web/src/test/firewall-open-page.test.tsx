import type { FirewallOpenPortsPayload } from "@stackpilot/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFirewallOpenPorts } from "../api/firewallApi";
import { FirewallPage } from "../pages/FirewallPage";

vi.mock("../api/firewallApi", () => ({ fetchFirewallOpenPorts: vi.fn() }));
const time = "2026-07-15T06:00:00.000Z";
const payload: FirewallOpenPortsPayload = { collectedAt: time, collectionStatus: "complete", backend: "ss", warnings: [], ports: [
  { id: "port_aaaaaaaaaaaaaaaaaaaaaaaa", protocol: "TCP", port: 443, address: "0.0.0.0", source: "0.0.0.0/0", exposure: "public", host: "prod-controller" },
  { id: "port_bbbbbbbbbbbbbbbbbbbbbbbb", protocol: "TCP", port: 18787, address: "127.0.0.1", source: "仅本机", exposure: "loopback", host: "prod-controller" },
] };

describe("firewall open-port page", () => {
  beforeEach(() => vi.mocked(fetchFirewallOpenPorts).mockReset().mockResolvedValue(payload));
  afterEach(() => vi.useRealTimers());

  it("renders only real backend listeners and collection freshness", async () => {
    const { container } = render(<FirewallPage page="firewall-open" notify={vi.fn()} permissions={["firewall:read"]} />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("0.0.0.0:443")).toBeInTheDocument();
    expect(within(table).getByText("127.0.0.1:18787")).toBeInTheDocument();
    expect(screen.getByText(/监听不等于上游网络已经放行/)).toBeInTheDocument();
    expect(screen.queryByText("HTTPS 公网访问")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增规则|刷新|重新采集/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "开放端口" })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
  });

  it("keeps filters while silently polling every ten seconds", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchFirewallOpenPorts).mockResolvedValueOnce({ ...payload, collectedAt: "2026-07-15T06:00:10.000Z", ports: [payload.ports[0]!] });
    render(<FirewallPage page="firewall-open" notify={vi.fn()} permissions={["firewall:read"]} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const search = screen.getByPlaceholderText("搜索端口、地址或主机");
    fireEvent.change(search, { target: { value: "443" } });
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchFirewallOpenPorts).toHaveBeenCalledTimes(2);
    expect(search).toHaveValue("443");
    expect(screen.getAllByText("0.0.0.0:443").length).toBeGreaterThan(0);
  });

  it("shows an explicit permission boundary", () => {
    render(<FirewallPage page="firewall-open" notify={vi.fn()} permissions={[]} />);
    expect(screen.getByText(/没有 firewall:read 权限/)).toBeInTheDocument();
    expect(fetchFirewallOpenPorts).not.toHaveBeenCalled();
  });

  it("does not render a successful empty state while loading or after an initial failure", async () => {
    vi.mocked(fetchFirewallOpenPorts).mockReturnValueOnce(new Promise(() => undefined));
    const view = render(<FirewallPage page="firewall-open" notify={vi.fn()} permissions={["firewall:read"]} />);
    expect(screen.getAllByText("正在读取真实监听端口").length).toBeGreaterThan(0);
    expect(screen.getAllByText("暂不可用")).toHaveLength(3);
    expect(screen.queryByText("没有匹配的真实监听端口")).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(fetchFirewallOpenPorts).toHaveBeenCalledTimes(1);
    view.unmount();

    vi.mocked(fetchFirewallOpenPorts).mockRejectedValueOnce(new Error("监听探针暂不可用"));
    render(<FirewallPage page="firewall-open" notify={vi.fn()} permissions={["firewall:read"]} />);
    expect(await screen.findByText("监听探针暂不可用")).toBeInTheDocument();
    expect(screen.getAllByText("暂不可用")).toHaveLength(3);
    expect(screen.getAllByText("真实监听端口读取失败").length).toBeGreaterThan(0);
    expect(screen.queryByText("没有匹配的真实监听端口")).not.toBeInTheDocument();
  });

  it("groups more than three backend warnings", async () => {
    vi.mocked(fetchFirewallOpenPorts).mockResolvedValueOnce({ ...payload, warnings: ["提示一", "提示二", "提示三", "提示四"] });
    render(<FirewallPage page="firewall-open" notify={vi.fn()} permissions={["firewall:read"]} />);
    expect(await screen.findByText("提示一")).toBeInTheDocument();
    expect(screen.getByText("提示二")).toBeInTheDocument();
    expect(screen.getByText("另有 2 条监听端口提示")).toBeInTheDocument();
    expect(screen.queryByText("提示三")).not.toBeInTheDocument();
  });
});
