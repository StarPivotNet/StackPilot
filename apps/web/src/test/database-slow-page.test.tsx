import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSlowQueriesPage } from "../pages/DatabaseSlowQueriesPage";
import { fetchDatabaseSlowQueries } from "../api/databasesApi";

vi.mock("../api/databasesApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/databasesApi")>(),
  fetchDatabaseSlowQueries: vi.fn(),
}));

const initialPayload = {
  collectedAt: "2026-07-14T00:00:00.000Z", collectionStatus: "complete" as const, warnings: [], thresholdMs: 1_000,
  instances: [{ id: "postgres-orders", name: "orders", engine: "PostgreSQL 16.9", host: "Controller 本机", port: 5432, activeConnections: 4, slowQueryCount: 1, collectedAt: "2026-07-14T00:00:00.000Z" }],
  queries: [{ id: "query-1", instanceId: "postgres-orders", database: "orders", fingerprint: "pg-123", sql: "SELECT * FROM users WHERE id = ?", durationMs: 31_250, calls: null, p95Ms: null, rowsExamined: null, risk: "high" as const, state: "active" as const, owner: "reporter", startedAt: "2026-07-13T23:59:28.750Z", lastSeenAt: "2026-07-14T00:00:00.000Z", sessionId: "91", waitEvent: null }],
};

describe("database slow queries page", () => {
  beforeEach(() => { vi.mocked(fetchDatabaseSlowQueries).mockReset(); vi.mocked(fetchDatabaseSlowQueries).mockResolvedValue(initialPayload); });

  it("shows the CloudPulse heading and summary while retaining export", () => {
    const { container } = render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={initialPayload} />);

    expect(container.querySelector(".module-head h1:not(.sr-only)")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "慢查询" })).not.toHaveClass("sr-only");
    expect(screen.queryByText("慢查询中心")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeInTheDocument();
  });

  it("renders real collection freshness and no fake mutation actions", () => {
    render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={initialPayload} />);
    expect(screen.getByText(/数据来自节点采集快照/)).toBeInTheDocument();
    expect(screen.getAllByText("31.25 秒").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Explain|索引|终止|处理/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新采样" })).not.toBeInTheDocument();
  });

  it("states when historical slow queries are unavailable", () => {
    const payload = { ...initialPayload, instances: initialPayload.instances.map((instance) => ({ ...instance, historicalSlowQueriesAvailable: false })) };
    render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={payload} />);
    expect(screen.getByText("历史慢查询不可用，仅展示当前长查询")).toBeInTheDocument();
  });

  it("states when only part of the inventory lacks historical slow queries", () => {
    const payload = { ...initialPayload, instances: [
      { ...initialPayload.instances[0], historicalSlowQueriesAvailable: false },
      { ...initialPayload.instances[0], id: "mysql-orders", name: "orders-mysql", engine: "MySQL 8.4", port: 3306, historicalSlowQueriesAvailable: true },
    ] };
    render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={payload} />);
    expect(screen.getByText("部分实例历史慢查询不可用，仅展示其当前长查询")).toBeInTheDocument();
  });

  it("opens stable portal details and labels unavailable historical statistics", async () => {
    const user = userEvent.setup();
    render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={initialPayload} />);
    await user.click(screen.getAllByRole("button", { name: "查看慢查询 pg-123" })[0]);
    const drawer = screen.getByRole("dialog", { name: "慢查询详情" });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("reporter")).toBeInTheDocument();
    expect(within(drawer).getAllByText(/暂不可用/).length).toBeGreaterThan(0);
    expect(within(drawer).getByText("SELECT * FROM users WHERE id = ?")).toBeInTheDocument();
  });

  it("does not present an unavailable collector as a successful zero result", () => {
    render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={{ ...initialPayload, collectionStatus: "unavailable", warnings: ["PostgreSQL 慢查询统计暂不可用"], instances: [], queries: [] }} />);
    expect(screen.getAllByText("暂不可用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("慢查询统计暂不可用").length).toBeGreaterThan(0);
    expect(screen.queryByText("当前慢查询 0")).not.toBeInTheDocument();
  });

  it("loads a changed time range immediately", async () => {
    const user = userEvent.setup();
    render(<DatabaseSlowQueriesPage page="databases-slow" notify={vi.fn()} initialPayload={initialPayload} />);
    await user.click(screen.getByRole("combobox", { name: /范围/ }));
    await user.click(screen.getByRole("option", { name: "7d" }));
    await waitFor(() => expect(fetchDatabaseSlowQueries).toHaveBeenCalledWith("7d", expect.any(AbortSignal)));
  });
});
