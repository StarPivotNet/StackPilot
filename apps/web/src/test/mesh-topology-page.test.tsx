import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMeshPlan } from "../api/meshApi";
import type { NetworkMeshPlanResponse } from "@stackpilot/contracts";
import { MeshTopologyPage } from "../pages/MeshTopologyPage";
import { meshHandshakeIssues, toMeshView } from "../features/network/model";

vi.mock("../api/meshApi", () => ({ fetchMeshPlan: vi.fn() }));

const updatedAt = "2026-11-13T08:00:00.000Z";

function node(overrides: Partial<NetworkMeshPlanResponse["nodes"][number]> = {}): NetworkMeshPlanResponse["nodes"][number] {
  return {
    nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-a", status: "ready",
    overlayAddress: "100.64.12.4", publicKey: null, configuredRevision: 3,
    handshake: { collectedAt: updatedAt, ageSeconds: 12, peerCount: 1, activePeerCount: 1 },
    firewallEnforced: true, dataPlanePort: 18_080, interfaceUp: true,
    ...overrides,
  };
}

function plan(overrides: Partial<NetworkMeshPlanResponse> = {}): NetworkMeshPlanResponse {
  return { revision: 3, overlayCidr: "100.64.0.0/10", listenPort: 51820, updatedAt, nodes: [node()], warnings: [], ...overrides };
}

describe("mesh topology view model", () => {
  it("labels statuses and reports a handshake older than the session timeout as an anomaly", () => {
    const view = toMeshView(plan({ nodes: [
      node(),
      node({ nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", handshake: { collectedAt: updatedAt, ageSeconds: 420, peerCount: 2, activePeerCount: 0 } }),
      node({ nodeId: "33333333-3333-4333-8333-333333333333", nodeName: "edge-c", status: "pending", overlayAddress: null, configuredRevision: null, handshake: null, firewallEnforced: null, dataPlanePort: null, interfaceUp: null }),
    ] }));
    expect(view.readyCount).toBe(2);
    expect(view.attentionCount).toBe(1);
    expect(view.nodes.map((item) => item.statusLabel)).toEqual(["已生效", "已生效", "待下发"]);
    expect(view.nodes[1].handshake.state).toBe("silent");
    expect(view.nodes[1].handshake.detail).toContain("180 秒没有握手");
    expect(view.nodes[2].handshake.state).toBe("unknown");
    expect(view.nodes[2].overlayAddress).toBe("未分配");
    expect(view.nodes[0].firewall.label).toBe("已生效");
    expect(view.nodes[0].firewall.port).toBe("TCP 18080");
    expect(view.nodes[2].firewall.label).toBe("未上报");
    expect(view.nodes[2].firewall.port).toBeNull();
    expect(meshHandshakeIssues(view)).toBe(1);
    expect(view.latestHandshake).toBe("12 秒前");
    expect(view.activePeerLinks).toBe(1);
  });

  it("a recorded revision on a down link reads as 接口未启用, not as 已生效", () => {
    const view = toMeshView(plan({ nodes: [node({ interfaceUp: false }), node({ nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", interfaceUp: null })] }));
    expect(view.nodes.map((item) => item.statusLabel)).toEqual(["接口未启用", "已生效"]);
    expect(view.nodes[0].statusTone).toBe("orange");
    expect(view.nodes[0].status).toBe("ready");
  });

  it("marks a link report older than five minutes as stale instead of healthy", () => {
    const view = toMeshView(plan({
      updatedAt: "2026-11-13T08:10:00.000Z",
      nodes: [node({ handshake: { collectedAt: "2026-11-13T08:00:00.000Z", ageSeconds: 5, peerCount: 1, activePeerCount: 1 } })],
    }));
    expect(view.nodes[0].handshake.state).toBe("stale");
    expect(view.nodes[0].handshake.detail).toContain("最近一次链路采集在");
    expect(meshHandshakeIssues(view)).toBe(1);
  });

  it("treats a peerless member as idle rather than broken", () => {
    const view = toMeshView(plan({ nodes: [node({ handshake: { collectedAt: updatedAt, ageSeconds: null, peerCount: 0, activePeerCount: 0 } })] }));
    expect(view.nodes[0].handshake.state).toBe("idle");
    expect(meshHandshakeIssues(view)).toBe(0);
  });
});

describe("mesh topology page", () => {
  beforeEach(() => vi.mocked(fetchMeshPlan).mockReset());

  it("renders the shared range, per-node handshake age and backend freshness", async () => {
    vi.mocked(fetchMeshPlan).mockResolvedValue(plan({ nodes: [
      node(),
      node({ nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", handshake: { collectedAt: updatedAt, ageSeconds: 420, peerCount: 2, activePeerCount: 0 } }),
    ], warnings: ["节点 edge-b 最近一次握手在 7 分钟前，链路可能已中断"] }));
    render(<MeshTopologyPage />);
    expect(await screen.findByRole("heading", { name: "组网拓扑" })).toBeTruthy();
    expect(await screen.findByText("100.64.0.0/10")).toBeTruthy();
    expect(screen.getAllByText("edge-b").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12 秒前").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7 分钟前").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(/180 秒没有握手/).length).toBeGreaterThan(0);
    expect(screen.getByText("节点 edge-b 最近一次握手在 7 分钟前，链路可能已中断")).toBeTruthy();
    expect(screen.getByText("1 个节点握手异常")).toBeTruthy();
    expect(screen.getByText(/后端采集于/)).toBeTruthy();
    expect(screen.getByText("UDP 51820")).toBeTruthy();
  });

  it("shows whether each node actually installed the overlay port whitelist", async () => {
    vi.mocked(fetchMeshPlan).mockResolvedValue(plan({ nodes: [
      node(),
      node({ nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", firewallEnforced: false, dataPlanePort: 18_080 }),
    ] }));
    render(<MeshTopologyPage />);
    expect(await screen.findByRole("heading", { name: "组网拓扑" })).toBeTruthy();
    expect(screen.getByText("端口白名单")).toBeTruthy();
    expect(screen.getAllByText("TCP 18080").length).toBeGreaterThan(0);
    expect(screen.getAllByText("未生效").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(/未能写入 nft 白名单/).length).toBeGreaterThan(0);
  });

  it("keeps the empty state honest when no node joined the mesh yet", async () => {
    vi.mocked(fetchMeshPlan).mockResolvedValue(plan({ revision: 0, nodes: [] }));
    render(<MeshTopologyPage />);
    expect(await screen.findByText("还没有节点加入组网")).toBeTruthy();
    expect(screen.getByText("链路正常")).toBeTruthy();
  });

  it("labels a rejected read and keeps the retry action", async () => {
    vi.mocked(fetchMeshPlan).mockRejectedValueOnce(new Error("当前账号没有节点读取权限")).mockResolvedValue(plan());
    render(<MeshTopologyPage />);
    expect(await screen.findByText("当前账号没有节点读取权限")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText("还没有节点加入组网")).toBeNull();
  });
});
