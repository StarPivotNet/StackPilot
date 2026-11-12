import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDatabaseDetail, fetchDatabases } from "../api/databasesApi";
import type { DatabaseInstanceDetail, DatabaseInstanceRecord, DatabaseInstancesPayload } from "../api/databasesApi";
import { DatabasesPage } from "../pages/DatabasesPage";
import type { Notify, SetPage } from "../types/app";

vi.mock("../api/databasesApi", () => ({ fetchDatabases: vi.fn(), fetchDatabaseDetail: vi.fn() }));

const collectedAt = "2026-07-14T00:00:00.000Z";
function database(overrides: Partial<DatabaseInstanceRecord> = {}): DatabaseInstanceRecord {
  return {
    id: `database-${"a".repeat(32)}`, nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "db-node-01",
    name: "postgresql-16-main", engine: "postgresql", version: null, host: "db-node-01", address: "10.0.0.8", port: null,
    status: "running", source: "systemd:postgresql@16-main.service", managed: false, historicalSlowQueriesAvailable: false,
    latencyMs: null, storageBytes: null,
    activeConnections: null, maxConnections: null, slowQueryCount: null, backupStatus: "unavailable", lastBackupAt: null,
    accessMode: "unknown", owner: null, region: null, autoBackup: null, remoteAccess: null, volumes: [],
    collectedAt, freshness: "current", ...overrides,
  };
}
function payload(instances: DatabaseInstanceRecord[], overrides: Partial<DatabaseInstancesPayload> = {}): DatabaseInstancesPayload {
  return { collectedAt, collectionStatus: "complete", warnings: [], instances, ...overrides };
}
function detail(instance = database(), overrides: Partial<DatabaseInstanceDetail> = {}): DatabaseInstanceDetail { return { instance, sessions: [], recentQueries: [], ...overrides }; }

describe("database instances live page", () => {
  const setPage = vi.fn() as unknown as SetPage; const notify = vi.fn() as unknown as Notify;
  beforeEach(() => { vi.mocked(fetchDatabases).mockReset(); vi.mocked(fetchDatabaseDetail).mockReset(); vi.mocked(fetchDatabases).mockResolvedValue(payload([database()])); vi.mocked(fetchDatabaseDetail).mockResolvedValue(detail()); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

  it.each([
    ["databases", "数据库管理"],
    ["databases-instances", "实例列表"],
  ] as const)("shows the CloudPulse heading and summary from %s", async (page, title) => {
    const { container } = render(<DatabasesPage page={page} setPage={setPage} notify={notify} permissions={["databases:install"]} />);

    expect((await screen.findAllByTitle("postgresql-16-main")).length).toBeGreaterThan(0);

    expect(container.querySelector(".module-page-databases > .page-head h1:not(.sr-only)")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(screen.queryByText("数据库实例")).not.toBeInTheDocument();
    expect(screen.getByText(/后端采集于/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建数据库实例" })).toBeInTheDocument();
  });

  it("loads backend data without exposing mock write actions", async () => {
    const { container } = render(<DatabasesPage page="databases-instances" setPage={setPage} notify={notify} />);
    expect((await screen.findAllByTitle("postgresql-16-main")).length).toBeGreaterThan(0);
    expect(container.firstElementChild).toHaveClass("module-page-databases-instances", "module-page-databases");
    expect(screen.getByText(/后端采集于/)).toBeInTheDocument();
    expect(screen.getByLabelText("备份成功率 待采集")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /创建数据库|立即备份|设为只读|清空慢查询|刷新/ })).not.toBeInTheDocument();
    expect(screen.queryByText("prod-postgres-01")).not.toBeInTheDocument();
    expect(screen.getByText("等待采集")).toBeInTheDocument();
    expect(screen.queryByText("连接正常")).not.toBeInTheDocument();
  });

  it("treats stale running snapshots as expired alerts", async () => {
    vi.mocked(fetchDatabases).mockResolvedValue(payload([database({ freshness: "stale" })], { collectionStatus: "partial" }));
    const { container } = render(<DatabasesPage page="databases" setPage={setPage} notify={notify} />);
    expect((await screen.findAllByText("数据已过期")).length).toBeGreaterThan(0);
    expect(container.querySelector(".module-metrics article:nth-child(4)")).toHaveTextContent("告警1");
    fireEvent.click(screen.getByRole("combobox", { name: "状态 全部" }));
    fireEvent.click(screen.getByRole("option", { name: "正常" }));
    expect(screen.getAllByText("没有匹配的真实数据库实例，系统将继续自动采集")).toHaveLength(2);
  });

  it("shows initial errors and retries without falling back to fixtures", async () => {
    vi.mocked(fetchDatabases).mockRejectedValueOnce(new Error("数据库采集不可用")).mockResolvedValueOnce(payload([database()]));
    render(<DatabasesPage page="databases" setPage={setPage} notify={notify} />);
    expect(await screen.findByText("数据库采集不可用")).toBeInTheDocument();
    expect(screen.getAllByText("实时采集失败，未显示示例数据库")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect((await screen.findAllByTitle("postgresql-16-main")).length).toBeGreaterThan(0);
  });

  it("polls every ten seconds, keeps filters and updates an open stable detail", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchDatabases)
      .mockResolvedValueOnce(payload([database(), database({ id: `database-${"b".repeat(32)}`, name: "mysql" })]))
      .mockResolvedValueOnce(payload([database({ source: "systemd:refreshed.service", port: 5432 }), database({ id: `database-${"b".repeat(32)}`, name: "mysql" })], { collectedAt: "2026-07-14T00:00:10.000Z" }))
      .mockRejectedValueOnce(new Error("瞬时失败"));
    vi.mocked(fetchDatabaseDetail).mockResolvedValue(detail(database({ port: 5432, source: "systemd:refreshed.service" })));
    render(<DatabasesPage page="databases" setPage={setPage} notify={notify} />);
    await act(async () => undefined);
    const search = screen.getByPlaceholderText("搜索数据库、主机、节点或权限");
    fireEvent.change(search, { target: { value: "postgresql" } });
    fireEvent.click(screen.getAllByRole("button", { name: "查看 postgresql-16-main 详情" })[0]!);
    const drawer = screen.getByRole("dialog", { name: "数据库详情" });
    expect(document.querySelector(".module-main")).toHaveAttribute("inert");
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchDatabases).toHaveBeenCalledTimes(2); expect(search).toHaveValue("postgresql");
    expect(within(drawer).getByText("systemd:refreshed.service")).toBeInTheDocument();
    expect(within(drawer).getByText("10.0.0.8:5432")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchDatabases).toHaveBeenCalledTimes(3); expect(within(drawer).getByText("systemd:refreshed.service")).toBeInTheDocument();
  });

  it("closes stale details when a refreshed stable id disappears", async () => {
    vi.useFakeTimers(); vi.mocked(fetchDatabases).mockResolvedValueOnce(payload([database()])).mockResolvedValueOnce(payload([], { collectedAt: "2026-07-14T00:00:10.000Z" }));
    render(<DatabasesPage page="databases" setPage={setPage} notify={notify} />); await act(async () => undefined);
    fireEvent.click(screen.getAllByRole("button", { name: "查看 postgresql-16-main 详情" })[0]!);
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.queryByRole("dialog", { name: "数据库详情" })).not.toBeInTheDocument();
    expect(screen.getAllByText("没有匹配的真实数据库实例，系统将继续自动采集")).toHaveLength(2);
  });

  it("paginates large inventories without rendering every row twice", async () => {
    const instances = Array.from({ length: 101 }, (_, index) => database({
      id: `database-${index.toString(16).padStart(32, "0")}`,
      name: `database-${index}`,
    }));
    vi.mocked(fetchDatabases).mockResolvedValue(payload(instances));
    render(<DatabasesPage page="databases" setPage={setPage} notify={notify} />);
    expect((await screen.findAllByTitle("database-0"))).toHaveLength(2);
    expect(screen.queryByTitle("database-100")).not.toBeInTheDocument();
    expect(screen.getByText("第 1 / 2 页 · 共 101 条")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getAllByTitle("database-100")).toHaveLength(2);
    expect(screen.queryByTitle("database-0")).not.toBeInTheDocument();
  });

  it("does not reopen a replacement instance with the same name after the selected stable id disappears", async () => {
    vi.useFakeTimers();
    const originalUrl = window.location.href;
    window.history.replaceState(null, "", "/?dbFocus=postgresql-16-main#databases");
    vi.mocked(fetchDatabases).mockResolvedValueOnce(payload([database()])).mockResolvedValue(payload([database({ id: `database-${"b".repeat(32)}` })]));
    try {
      render(<DatabasesPage page="databases" setPage={setPage} notify={notify} />);
      await act(async () => undefined);
      expect(screen.getByRole("dialog", { name: "数据库详情" })).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
      expect(screen.queryByRole("dialog", { name: "数据库详情" })).not.toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
      expect(screen.queryByRole("dialog", { name: "数据库详情" })).not.toBeInTheDocument();
    } finally { window.history.replaceState(null, "", originalUrl); }
  });
});
