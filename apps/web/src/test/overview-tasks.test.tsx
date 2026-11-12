import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportOverviewTasks, fetchOverviewTasks } from "../api/overviewApi";
import { OverviewTasksPage } from "../pages/OverviewTasksPage";

vi.mock("../api/overviewApi", () => ({
  exportOverviewTasks: vi.fn(),
  fetchOverviewTasks: vi.fn(),
}));

const task = {
  id: "task-1",
  type: "计划任务",
  title: "备份数据库",
  target: "edge-production-observability-node.internal.example",
  status: "成功" as const,
  priority: "高" as const,
  operator: "平台团队",
  queuedAt: "12:30:00",
  duration: "18 秒",
  source: "系统计划",
  actionLabel: "再次运行",
  collectedAt: "2026/7/12 12:30:10",
  logs: ["开始备份", "备份完成"],
};

const payload = {
  tasks: [task],
  page: {
    title: "任务流",
    subtitle: "整台设备任务信号由后端实时采集",
    searchPlaceholder: "搜索任务",
    filters: [
      { id: "all", label: "全部", statuses: [] },
      { id: "success", label: "成功", statuses: ["成功" as const] },
    ],
    metrics: [{ label: "任务总数", value: "1", icon: "calendar" as const, tone: "blue" }],
    context: { eyebrow: "工作台 / 设备任务", title: "任务流", chips: ["设备采集 1 条"] },
    collectedAt: "2026/7/12 12:30:10",
  },
};

describe("overview tasks workbench", () => {
  const notify = vi.fn();
  const setPage = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    setPage.mockClear();
    vi.mocked(fetchOverviewTasks).mockReset();
    vi.mocked(exportOverviewTasks).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows backend freshness and keeps refresh automatic", async () => {
    vi.mocked(fetchOverviewTasks).mockResolvedValue(payload);

    const { container } = render(<OverviewTasksPage notify={notify} setPage={setPage} />);

    expect(await screen.findByText("备份数据库")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "任务流" })).not.toHaveClass("sr-only");
    expect(screen.queryByText("整台设备任务信号由后端实时采集")).not.toBeInTheDocument();
    expect(screen.queryByText("工作台 / 设备任务")).not.toBeInTheDocument();
    expect(screen.queryByText("设备采集 1 条")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "全部" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "成功" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索任务")).not.toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(container.querySelector(".module-filter-line")).not.toBeInTheDocument();
    expect(screen.getByText("采集于 2026/07/12 12:30:10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建计划任务" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /刷新|重新采集/ })).not.toBeInTheDocument();
    expect(screen.getByText("成功", { selector: ".task-row-result > strong" })).toBeInTheDocument();
  });

  it("preserves an open task by stable id across polling", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchOverviewTasks)
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ ...payload, tasks: [{ ...task, duration: "19 秒" }], page: { ...payload.page, collectedAt: "2026/7/12 12:30:20" } });

    render(<OverviewTasksPage notify={notify} setPage={setPage} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    expect(screen.getByRole("dialog", { name: "备份数据库" })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(screen.getByText("备份数据库", { selector: ".task-row-primary > strong" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "备份数据库" })).getByText("19 秒")).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
  });

  it("offers retry after an initial load failure", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchOverviewTasks).mockRejectedValueOnce(new Error("Controller 暂不可用")).mockResolvedValueOnce(payload);

    render(<OverviewTasksPage notify={notify} setPage={setPage} />);

    expect(await screen.findByText("Controller 暂不可用")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("备份数据库")).toBeInTheDocument();
  });
});
