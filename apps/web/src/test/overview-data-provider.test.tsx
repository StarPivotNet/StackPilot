import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewSummaryPayload } from "@stackpilot/contracts";
import { fetchOverview, fetchOverviewHealth, fetchOverviewRisks, fetchOverviewTasks } from "../api/overviewApi";
import { OverviewDataProvider, useOverviewData } from "../features/overview/OverviewDataProvider";
import { OverviewHealthPage } from "../pages/OverviewHealthPage";
import { OverviewRisksPage } from "../pages/OverviewRisksPage";
import { OverviewTasksPage } from "../pages/OverviewTasksPage";
import { ResourceOverview } from "../features/overview/OverviewTables";

vi.mock("../api/overviewApi", () => ({
  checkOverviewUpdates: vi.fn(), exportOverviewRisks: vi.fn(), exportOverviewTasks: vi.fn(),
  fetchOverview: vi.fn(), fetchOverviewHealth: vi.fn(), fetchOverviewRisks: vi.fn(), fetchOverviewTasks: vi.fn(),
}));

function overviewFixture(name: string, collectedAt: string): OverviewSummaryPayload {
  return {
    cluster: { current: name, health: "健康", latency: "12ms", version: "v1.0.0", uptime: "1 天", lastBackup: "暂不可用", pendingUpdates: 0 },
    metrics: [], nodes: [], tasks: [], audits: [], risks: [], resources: {},
    taskPage: {
      title: "任务流", subtitle: "任务记录", searchPlaceholder: "搜索任务", filters: [], metrics: [],
      context: { eyebrow: "工作台 / 任务流", title: "任务流", chips: [] }, collectedAt,
    },
    collectedAt,
    lastRefresh: collectedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, reject, resolve };
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

function Probe({ replacement }: { replacement?: OverviewSummaryPayload }) {
  const { error, loading, overview, reload, replace } = useOverviewData();
  return (
    <div>
      <span data-testid="state">{loading ? "loading" : error ?? "ready"}</span>
      <span data-testid="node">{overview?.cluster.current ?? "empty"}</span>
      <button type="button" onClick={() => void reload()}>reload</button>
      {replacement && <button type="button" onClick={() => replace(replacement)}>replace</button>}
    </div>
  );
}

describe("OverviewDataProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchOverview).mockReset();
    vi.mocked(fetchOverviewHealth).mockReset();
    vi.mocked(fetchOverviewRisks).mockReset();
    vi.mocked(fetchOverviewTasks).mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("starts polling ten seconds after the initial request settles and never overlaps a slow request", async () => {
    const first = deferred<OverviewSummaryPayload>();
    vi.mocked(fetchOverview)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(overviewFixture("second", "2026-07-12T12:30:10.000Z"));

    render(<OverviewDataProvider><Probe /></OverviewDataProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(fetchOverview).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(fetchOverview).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(overviewFixture("first", "2026-07-12T12:30:00.000Z")); await first.promise; });
    expect(screen.getByTestId("node")).toHaveTextContent("first");

    await act(async () => { vi.advanceTimersByTime(9_999); });
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(fetchOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("node")).toHaveTextContent("second");
  });

  it("pauses while hidden and refreshes immediately after becoming visible", async () => {
    vi.mocked(fetchOverview)
      .mockResolvedValueOnce(overviewFixture("first", "2026-07-12T12:30:00.000Z"))
      .mockResolvedValueOnce(overviewFixture("visible", "2026-07-12T12:30:10.000Z"));

    render(<OverviewDataProvider><Probe /></OverviewDataProvider>);
    await act(async () => { await Promise.resolve(); });

    act(() => setDocumentHidden(true));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(fetchOverview).toHaveBeenCalledTimes(1);

    await act(async () => { setDocumentHidden(false); await Promise.resolve(); });
    expect(fetchOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("node")).toHaveTextContent("visible");
  });

  it("aborts the active request on unmount", async () => {
    const pending = deferred<OverviewSummaryPayload>();
    let signal: AbortSignal | undefined;
    vi.mocked(fetchOverview).mockImplementation((nextSignal) => { signal = nextSignal; return pending.promise; });

    const view = render(<OverviewDataProvider><Probe /></OverviewDataProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the last snapshot and suppresses background errors", async () => {
    vi.mocked(fetchOverview)
      .mockResolvedValueOnce(overviewFixture("stable", "2026-07-12T12:30:00.000Z"))
      .mockRejectedValueOnce(new Error("background unavailable"));

    render(<OverviewDataProvider><Probe /></OverviewDataProvider>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });

    expect(screen.getByTestId("node")).toHaveTextContent("stable");
    expect(screen.getByTestId("state")).toHaveTextContent("ready");
    expect(screen.queryByText("background unavailable")).not.toBeInTheDocument();
  });

  it("replace aborts and invalidates an older response", async () => {
    const pending = deferred<OverviewSummaryPayload>();
    let signal: AbortSignal | undefined;
    vi.mocked(fetchOverview).mockImplementation((nextSignal) => { signal = nextSignal; return pending.promise; });
    const replacement = overviewFixture("replacement", "2026-07-12T12:30:10.000Z");

    render(<OverviewDataProvider><Probe replacement={replacement} /></OverviewDataProvider>);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "replace" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByTestId("state")).toHaveTextContent("ready");
    expect(screen.getByTestId("node")).toHaveTextContent("replacement");

    await act(async () => { pending.resolve(overviewFixture("stale", "2026-07-12T12:30:00.000Z")); await pending.promise; });
    expect(screen.getByTestId("node")).toHaveTextContent("replacement");
  });

  it("feeds health, tasks and risks from one snapshot without page-level requests or notifications", async () => {
    const notify = vi.fn();
    vi.mocked(fetchOverview)
      .mockResolvedValueOnce(overviewFixture("shared", "2026-07-12T12:30:00.000Z"))
      .mockRejectedValueOnce(new Error("silent background failure"));

    render(
      <OverviewDataProvider>
        <OverviewHealthPage notify={notify} />
        <OverviewTasksPage notify={notify} setPage={vi.fn()} />
        <OverviewRisksPage notify={notify} />
      </OverviewDataProvider>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("heading", { name: "集群状态" })).not.toHaveClass("sr-only");
    expect(screen.getByRole("heading", { name: "任务流" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "风险中心" })).not.toHaveClass("sr-only");
    expect(fetchOverviewHealth).not.toHaveBeenCalled();
    expect(fetchOverviewTasks).not.toHaveBeenCalled();
    expect(fetchOverviewRisks).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchOverview).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("overview resource freshness", () => {
  it("labels stale resources and does not draw unavailable values as zero", () => {
    render(<ResourceOverview resources={[
      { label: "CPU 使用率", value: "72%", delta: "2 核心", values: [70, 72], collectedAt: "2026-07-12T12:30:00.000Z", freshness: "stale" },
      { label: "系统负载", value: "暂不可用", delta: "等待采集", values: [], collectedAt: "2026-07-12T12:30:00.000Z", freshness: "stale" },
    ]} />);
    expect(screen.getAllByText(/数据已过期/)).toHaveLength(2);
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getAllByText("暂不可用")).toHaveLength(2);
    expect(document.querySelectorAll("svg.spark")).toHaveLength(1);
  });
});
