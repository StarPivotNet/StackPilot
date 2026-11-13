import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkCachePlanResponse } from "@stackpilot/contracts";
import { fetchCachePlan } from "../api/cacheApi";
import { toCacheView } from "../features/network/cacheModel";
import { MeshCachePage } from "../pages/MeshCachePage";

vi.mock("../api/cacheApi", () => ({ fetchCachePlan: vi.fn() }));

const GIB = 1024 ** 3;
const updatedAt = "2026-11-13T08:00:00.000Z";

function stats(overrides: Partial<NonNullable<NetworkCachePlanResponse["nodes"][number]["stats"]>> = {}): NonNullable<NetworkCachePlanResponse["nodes"][number]["stats"]> {
  return {
    collectedAt: updatedAt, capacityBytes: 5 * GIB, usedBytes: GIB, entryCount: 12,
    hits: 30, misses: 10, evictions: 2, diskFreeBytes: 8 * GIB, ...overrides,
  };
}

function node(overrides: Partial<NetworkCachePlanResponse["nodes"][number]> = {}): NetworkCachePlanResponse["nodes"][number] {
  return { nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-a", status: "ready", stats: stats(), ...overrides };
}

function plan(overrides: Partial<NetworkCachePlanResponse> = {}): NetworkCachePlanResponse {
  return { updatedAt, nodes: [node()], warnings: [], ...overrides };
}

describe("cache view model", () => {
  it("labels every reporting state and keeps an unreported node out of the totals", () => {
    const view = toCacheView(plan({ nodes: [
      node(),
      node({ nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", status: "stale", stats: null }),
      node({ nodeId: "33333333-3333-4333-8333-333333333333", nodeName: "edge-c", status: "disabled", stats: null }),
    ] }));
    expect(view.nodes.map((item) => item.statusLabel)).toEqual(["就绪", "指标过期", "未授权"]);
    expect(view.reportingCount).toBe(1);
    expect(view.readyCount).toBe(1);
    // An unauthorised node is listed for the operator but is not part of the cache pool.
    expect(view.participantCount).toBe(2);
    expect(view.usedBytes).toBe(GIB);
    expect(view.capacityBytes).toBe(5 * GIB);
    expect(view.usageLabel).toBe("1.0 GB / 5.0 GB");
    expect(view.nodes[1].usageLabel).toBe("等待上报");
    expect(view.nodes[1].collectedLabel).toBe("未上报");
    expect(view.nodes[2].hitRateLabel).toBe("等待上报");
  });

  it("reports the aggregate hit rate and refuses to call an empty counter 0%", () => {
    const withSamples = toCacheView(plan());
    expect(withSamples.hitRateLabel).toBe("75%");
    expect(withSamples.hitLabel).toBe("30 次命中 / 10 次回源");
    expect(withSamples.entryCount).toBe(12);
    expect(withSamples.evictions).toBe(2);
    const empty = toCacheView(plan({ nodes: [node({ stats: stats({ hits: 0, misses: 0 }) })] }));
    expect(empty.hitRateLabel).toBe("暂无样本");
    expect(empty.hitLabel).toBe("0 次命中 / 0 次回源");
    const unreported = toCacheView(plan({ nodes: [node({ status: "pending", stats: null })] }));
    expect(unreported.hitRateLabel).toBe("等待上报");
    expect(unreported.usageLabel).toBe("等待首个节点上报");
  });

  it("shows an unavailable disk as unknown rather than as zero free space", () => {
    const view = toCacheView(plan({ nodes: [node({ stats: stats({ diskFreeBytes: null }) })] }));
    expect(view.nodes[0].diskFreeLabel).toBe("未知");
    expect(view.nodes[0].usageLabel).toBe("1.0 GB / 5.0 GB");
    expect(view.nodes[0].evictionLabel).toBe("2 条");
  });
});

describe("shared cache page", () => {
  beforeEach(() => vi.mocked(fetchCachePlan).mockReset());

  it("renders the pool totals, per-node hit rate and backend freshness", async () => {
    vi.mocked(fetchCachePlan).mockResolvedValue(plan({
      nodes: [
        node(),
        node({ nodeId: "22222222-2222-4222-8222-222222222222", nodeName: "edge-b", status: "stale", stats: null }),
      ],
      warnings: ["节点 edge-b 的缓存指标已过期（10 分钟前采集），该节点可能离线"],
    }));
    render(<MeshCachePage />);
    expect(await screen.findByRole("heading", { name: "共享缓存" })).toBeTruthy();
    expect(screen.getAllByText("1.0 GB / 5.0 GB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("30 次命中 / 10 次回源").length).toBeGreaterThan(0);
    expect(screen.getAllByText("edge-b").length).toBeGreaterThan(0);
    expect(screen.getByText("节点 edge-b 的缓存指标已过期（10 分钟前采集），该节点可能离线")).toBeTruthy();
    expect(screen.getByText("1 / 2 个节点已上报")).toBeTruthy();
    expect(screen.getByText(/后端采集于/)).toBeTruthy();
  });

  it("keeps the empty state honest when no node advertises the cache", async () => {
    vi.mocked(fetchCachePlan).mockResolvedValue(plan({ nodes: [] }));
    render(<MeshCachePage />);
    expect(await screen.findByText("还没有节点启用共享缓存")).toBeTruthy();
    expect(screen.getAllByText("等待首个节点上报").length).toBeGreaterThan(0);
  });

  it("labels a rejected read and keeps the retry action", async () => {
    vi.mocked(fetchCachePlan).mockRejectedValueOnce(new Error("当前账号没有节点读取权限")).mockResolvedValue(plan());
    render(<MeshCachePage />);
    expect(await screen.findByText("当前账号没有节点读取权限")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText("还没有节点启用共享缓存")).toBeNull();
  });
});
