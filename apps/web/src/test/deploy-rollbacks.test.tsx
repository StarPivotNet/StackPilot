import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSiteRollback, fetchSiteRollbacks } from "../api/deploymentsApi";
import type { SiteRollbackPayload, SiteRollbackRecord } from "../api/deploymentsApi";
import { reauthenticate } from "../api/identityApi";
import { DeployPage } from "../pages/DeployPage";

vi.mock("../api/deploymentsApi", () => ({ fetchSiteRollbacks: vi.fn(), createSiteRollback: vi.fn() }));
vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));

const collectedAt = "2026-07-15T01:00:00.000Z";

function rollback(overrides: Partial<SiteRollbackRecord> = {}): SiteRollbackRecord {
  return {
    id: "release-history-01",
    siteId: "site-api",
    nodeId: "node-sg-01",
    domain: "api.example.com",
    currentReleaseId: "release-current-01",
    targetReleaseId: "release-target-01",
    targetPlanId: "9ba8ef30-5737-4413-9afd-891e70b178fa",
    repositoryRef: "v2026.07.14",
    status: "available",
    requestedBy: null,
    reason: null,
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:05:00.000Z",
    progressPercent: 0,
    errorCode: null,
    siteVersion: 4,
    ...overrides,
  };
}

function payload(rows: SiteRollbackRecord[], at = collectedAt): SiteRollbackPayload {
  return { collectedAt: at, rollbacks: rows };
}

describe("deploy rollbacks live workspace", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    vi.mocked(fetchSiteRollbacks).mockReset();
    vi.mocked(createSiteRollback).mockReset();
    vi.mocked(reauthenticate).mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("renders only backend rollback fields and keeps execution behind sites:deploy", async () => {
    vi.mocked(fetchSiteRollbacks).mockResolvedValue(payload([rollback()]));
    const { container } = render(<DeployPage page="deploy-rollbacks" notify={notify} permissions={["sites:read"]} />);

    expect((await screen.findAllByText("api.example.com")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("v2026.07.14").length).toBeGreaterThan(0);
    expect(screen.getAllByText("可回滚").length).toBeGreaterThan(0);
    expect(screen.queryByText("生产")).not.toBeInTheDocument();
    expect(screen.queryByText("上一健康版本")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "执行" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "版本记录" })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(container.querySelector(".module-freshness-note")).toHaveTextContent("采集于");
  });

  it("submits one rollback after confirmation and one-time reauthentication", async () => {
    vi.mocked(fetchSiteRollbacks).mockResolvedValue(payload([rollback()]));
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "reauth-proof", expiresAt: "2026-07-15T01:05:00.000Z" });
    vi.mocked(createSiteRollback).mockResolvedValue({
      operationId: "055928d4-f64c-4f87-8bb3-961b7ea640a3", taskId: null, type: "rollback", nodeId: "node-sg-01",
      siteId: "site-api", planId: "9ba8ef30-5737-4413-9afd-891e70b178fa",
      rollback: { fromReleaseId: "release-current-01", targetReleaseId: "release-target-01", reason: "健康检查持续失败", requestedBy: "管理员" },
      status: "queued", stage: "rollback_queued", progressPercent: 0, result: null, errorCode: null,
      createdAt: collectedAt, updatedAt: collectedAt,
    });
    render(<DeployPage page="deploy-rollbacks" notify={notify} permissions={["sites:read", "sites:deploy"]} />);
    await screen.findAllByText("api.example.com");

    fireEvent.click(screen.getAllByRole("button", { name: "执行" })[0]);
    const dialog = screen.getByRole("alertdialog", { name: "确认执行站点回滚" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "健康检查持续失败" } });
    fireEvent.change(dialog.querySelector("input[type=password]")!, { target: { value: "current-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "执行回滚" }));

    await waitFor(() => expect(createSiteRollback).toHaveBeenCalledTimes(1));
    expect(reauthenticate).toHaveBeenCalledWith("current-password");
    expect(createSiteRollback).toHaveBeenCalledWith("site-api", expect.objectContaining({
      targetReleaseId: "release-target-01",
      expectedSiteVersion: 4,
      reason: "健康检查持续失败",
      idempotencyKey: expect.any(String),
    }), "reauth-proof");
    expect(notify).toHaveBeenCalledWith("api.example.com 回滚任务已提交", "success");
  });

  it("polls every ten seconds, preserves the filter and closes a stale stable-id drawer", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSiteRollbacks)
      .mockResolvedValueOnce(payload([rollback(), rollback({ id: "operation-02", targetReleaseId: "release-02", status: "succeeded", progressPercent: 100 })]))
      .mockResolvedValueOnce(payload([rollback({ repositoryRef: "v2026.07.14-hotfix" })], "2026-07-15T01:00:10.000Z"))
      .mockResolvedValueOnce(payload([], "2026-07-15T01:00:20.000Z"));
    render(<DeployPage page="deploy-rollbacks" notify={notify} permissions={["sites:read"]} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "可回滚" }));
    fireEvent.click(screen.getAllByRole("button", { name: "查看 api.example.com 回滚详情" })[0]);
    expect(screen.getByRole("dialog", { name: "api.example.com" })).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchSiteRollbacks).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "可回滚" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("dialog", { name: "api.example.com" })).getAllByText("v2026.07.14-hotfix").length).toBeGreaterThan(0);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.queryByRole("dialog", { name: "api.example.com" })).not.toBeInTheDocument();
  });

  it("pauses while hidden, refreshes when visible, and retains data after a background failure", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSiteRollbacks).mockResolvedValueOnce(payload([rollback()])).mockRejectedValueOnce(new Error("瞬时失败"));
    render(<DeployPage page="deploy-rollbacks" notify={notify} permissions={["sites:read"]} />);
    await act(async () => undefined);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(fetchSiteRollbacks).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    expect(fetchSiteRollbacks).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("api.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText("瞬时失败")).not.toBeInTheDocument();
  });

  it("shows a retryable initial error and does not fetch without sites:read", async () => {
    vi.mocked(fetchSiteRollbacks).mockRejectedValueOnce(new Error("回滚后端不可用")).mockResolvedValueOnce(payload([]));
    const { unmount } = render(<DeployPage page="deploy-rollbacks" notify={notify} permissions={["sites:read"]} />);
    expect(await screen.findByText("回滚后端不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetchSiteRollbacks).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("暂无匹配的回滚记录，系统将继续自动采集").length).toBeGreaterThan(0);
    unmount();

    vi.mocked(fetchSiteRollbacks).mockClear();
    render(<DeployPage page="deploy-rollbacks" notify={notify} permissions={[]} />);
    expect(screen.getByText("当前账号没有站点读取权限")).toBeInTheDocument();
    expect(fetchSiteRollbacks).not.toHaveBeenCalled();
  });
});
