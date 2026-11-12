import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchScheduleJobs, createScheduleJob, deleteScheduleJob, runScheduleJob, updateScheduleJob } from "../api/scheduleApi";
import type { ScheduleJob, SchedulePayload } from "../api/scheduleApi";
import { SchedulePage } from "../pages/SchedulePage";
import { reauthenticate } from "../api/identityApi";

vi.mock("../api/scheduleApi", () => ({
  fetchScheduleJobs: vi.fn(),
  createScheduleJob: vi.fn(),
  deleteScheduleJob: vi.fn(),
  runScheduleJob: vi.fn(),
  updateScheduleJob: vi.fn(),
}));
vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));

const failedJob: ScheduleJob = {
  id: "job-failed",
  name: "nightly-backup",
  cron: "0 2 * * *",
  command: "/usr/local/bin/backup --all",
  enabled: true,
  nextRun: "明天 02:00",
  nextRunAt: "2026-07-16T02:00:00.000Z",
  lastRun: "今天 02:00",
  result: "失败" as const,
  lastExecution: {
    id: "11111111-1111-4111-8111-111111111111",
    commandDigest: "a".repeat(64),
    source: "cron" as const,
    startedAt: "2026-07-15T02:00:00.000Z",
    finishedAt: "2026-07-15T02:00:01.000Z",
    status: "失败" as const,
    exitCode: 17,
    durationMs: 1000,
    output: "partial output",
    error: "backup failed",
  },
};

const successfulJob: ScheduleJob = {
  ...failedJob,
  id: "job-success",
  name: "health-check",
  result: "成功" as const,
  lastExecution: { ...failedJob.lastExecution!, id: "22222222-2222-4222-8222-222222222222", status: "成功" as const, exitCode: 0, error: "" },
};

function payload(jobs = [failedJob, successfulJob]): SchedulePayload {
  return { jobs, scannedAt: "2026-07-15T02:00:00.000Z", writeEnabled: true };
}

describe("schedule failed page", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockReset();
    vi.mocked(createScheduleJob).mockReset();
    vi.mocked(deleteScheduleJob).mockReset();
    vi.mocked(runScheduleJob).mockReset();
    vi.mocked(updateScheduleJob).mockReset();
    vi.mocked(fetchScheduleJobs).mockReset();
    vi.mocked(reauthenticate).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["schedule", "定时任务"],
    ["schedule-enabled", "启用任务"],
    ["schedule-failed", "失败任务"],
    ["schedule-calendar", "执行日历"],
  ])("shows the CloudPulse heading and preserves freshness on %s", async (page, title) => {
    vi.mocked(fetchScheduleJobs).mockResolvedValue(payload());
    const { container } = render(<SchedulePage page={page} notify={notify} />);
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(container.querySelector(".module-freshness-note")).toHaveTextContent("最近采集");
  });

  it("keeps only failed jobs and refreshes silently every ten seconds", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchScheduleJobs)
      .mockResolvedValueOnce(payload())
      .mockResolvedValueOnce(payload([{ ...failedJob, name: "nightly-backup-updated" }]));

    render(<SchedulePage page="schedule-failed" notify={notify} />);
    await act(async () => undefined);
    expect(screen.getAllByText("nightly-backup")).toHaveLength(2);
    expect(screen.queryByText("health-check")).not.toBeInTheDocument();
    expect(screen.getByText(/最近采集：/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(fetchScheduleJobs).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("nightly-backup-updated")).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("shows a retryable initial error without replacing it with fixture rows", async () => {
    vi.mocked(fetchScheduleJobs)
      .mockRejectedValueOnce(new Error("crontab 暂不可用"))
      .mockResolvedValueOnce(payload([failedJob]));

    render(<SchedulePage page="schedule-failed" notify={notify} />);
    await act(async () => undefined);
    expect(screen.getByText("crontab 暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    expect(screen.queryByText("nightly-backup")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await act(async () => undefined);
    expect(screen.getAllByText("nightly-backup")).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith("crontab 暂不可用", "danger");
  });

  it("sorts the calendar by real next-run timestamps and retains execution details", async () => {
    vi.mocked(fetchScheduleJobs).mockResolvedValue(payload([
      { ...failedJob, id: "disabled", name: "disabled-job", enabled: false, nextRun: "停用", nextRunAt: "2026-07-16T00:30:00.000Z" },
      { ...failedJob, id: "later", name: "later-job", nextRunAt: "2026-07-16T04:00:00.000Z" },
      { ...failedJob, id: "earlier", name: "earlier-job", nextRunAt: "2026-07-16T01:00:00.000Z" },
      { ...failedJob, id: "invalid", name: "invalid-job", nextRun: "时间暂不可用", nextRunAt: "invalid-date" },
    ]));

    const { container } = render(<SchedulePage page="schedule-calendar" notify={notify} />);
    await act(async () => undefined);
    const calendar = container.querySelector(".schedule-calendar");
    expect(calendar).not.toBeNull();
    expect(within(calendar as HTMLElement).getAllByRole("button").map((item) => item.textContent)).toEqual([
      expect.stringContaining("earlier-job"),
      expect.stringContaining("later-job"),
      expect.stringContaining("disabled-job"),
      expect.stringContaining("invalid-job"),
    ]);
    expect(within(calendar as HTMLElement).getAllByText("已停用")).toHaveLength(2);
    expect(within(calendar as HTMLElement).getByText("时间暂不可用")).toBeInTheDocument();
    fireEvent.click(within(calendar as HTMLElement).getAllByRole("button")[0]);
    expect(within(screen.getByRole("dialog", { name: "任务详情" })).getByText("partial output")).toBeInTheDocument();
  });

  it("keeps details in a body-level drawer and separates modal and delete surfaces", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchScheduleJobs).mockResolvedValue(payload([failedJob]));
    render(<SchedulePage page="schedule-enabled" notify={notify} />);
    await act(async () => undefined);
    expect(screen.getAllByText("nightly-backup")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "nightly-backup" })[0]);
    const drawer = screen.getByRole("dialog", { name: "任务详情" });
    expect(drawer.parentElement).toBe(document.body);
    expect(drawer).toHaveClass("schedule-job-drawer");
    expect(drawer).not.toHaveClass("schedule-job-modal");
    expect(within(drawer).getByText("/usr/local/bin/backup --all")).toBeInTheDocument();
    expect(within(drawer).getByText("cron 自动调度")).toBeInTheDocument();
    expect(within(drawer).getByText("backup failed")).toBeInTheDocument();
    expect(within(drawer).getByText("partial output")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "关闭详情" }));
    act(() => vi.advanceTimersByTime(180));
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const deleteDialog = screen.getByRole("alertdialog", { name: "删除定时任务" });
    expect(deleteDialog.parentElement).toBe(document.body);
    expect(deleteDialog).toHaveClass("schedule-mutation-dialog");

    fireEvent.click(within(deleteDialog).getByRole("button", { name: "关闭确认弹窗" }));
    act(() => vi.advanceTimersByTime(180));
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    const modal = screen.getByRole("dialog", { name: "新建计划任务" });
    expect(modal).toHaveClass("schedule-job-modal");
    expect(modal).toHaveAttribute("data-motion-surface", "modal");
  });

  it("keeps the real schedule inventory read-only when the server capability is disabled", async () => {
    vi.mocked(fetchScheduleJobs).mockResolvedValue({ ...payload([failedJob]), writeEnabled: false });
    render(<SchedulePage page="schedule-enabled" notify={notify} permissions={["schedules:read", "schedules:write"]} />);
    await act(async () => undefined);

    expect(screen.getByText("当前为只读模式")).toBeInTheDocument();
    expect(screen.getByText("服务器未开启 crontab 写入与立即执行能力。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
  });

  it("hides mutations when the current user lacks schedule write permission", async () => {
    vi.mocked(fetchScheduleJobs).mockResolvedValue(payload([failedJob]));
    render(<SchedulePage page="schedule-enabled" notify={notify} permissions={["schedules:read"]} />);
    await act(async () => undefined);

    expect(screen.getByText("当前账号没有修改定时任务的权限。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行" })).not.toBeInTheDocument();
  });

  it("reauthenticates before a schedule mutation and passes the one-time proof", async () => {
    vi.mocked(fetchScheduleJobs).mockResolvedValue(payload([failedJob]));
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "proof-1", expiresAt: "2026-07-15T03:00:00.000Z" });
    vi.mocked(updateScheduleJob).mockResolvedValue({ job: { ...failedJob, enabled: false }, jobs: [{ ...failedJob, enabled: false }], message: "已停用", tone: "success" });
    render(<SchedulePage page="schedule-enabled" notify={notify} />);
    await act(async () => undefined);

    fireEvent.click(screen.getAllByRole("button", { name: "停用" })[0]);
    const dialog = screen.getByRole("alertdialog", { name: "确认停用定时任务" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认停用" }));
    await act(async () => undefined);

    expect(reauthenticate).toHaveBeenCalledWith("correct horse battery staple");
    expect(updateScheduleJob).toHaveBeenCalledWith(failedJob.id, { enabled: false }, "proof-1");
  });

  it("uses one stable idempotency key for an immediate execution confirmation", async () => {
    vi.mocked(fetchScheduleJobs).mockResolvedValue(payload([failedJob]));
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "proof-1", expiresAt: "2026-07-15T03:00:00.000Z" });
    vi.mocked(runScheduleJob).mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValue({ job: failedJob, jobs: [failedJob], message: "已执行", tone: "success" });
    render(<SchedulePage page="schedule-enabled" notify={notify} />);
    await act(async () => undefined);

    fireEvent.click(screen.getAllByRole("button", { name: "执行" })[0]);
    const dialog = screen.getByRole("alertdialog", { name: "确认立即执行" });
    const password = within(dialog).getByLabelText("当前密码");
    fireEvent.change(password, { target: { value: "correct horse battery staple" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await act(async () => undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await act(async () => undefined);

    const firstKey = vi.mocked(runScheduleJob).mock.calls[0]?.[2];
    expect(firstKey).toMatch(/^schedule-run:/);
    expect(vi.mocked(runScheduleJob).mock.calls[1]?.[2]).toBe(firstKey);
  });
});
