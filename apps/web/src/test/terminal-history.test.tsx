import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RemoteTaskListResponseSchema, type AgentNodeRecord, type RemoteTaskRecord } from "@stackpilot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentNodes, listRemoteTasks } from "../api/agentApi";
import { TerminalHistoryPage } from "../pages/TerminalHistoryPage";

vi.mock("../api/agentApi", () => ({ listAgentNodes: vi.fn(), listRemoteTasks: vi.fn() }));
const now = "2026-07-14T00:40:00.000Z";
const node: AgentNodeRecord = {
  nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-production-node-with-a-very-long-hostname.internal.example",
  status: "online", agentVersion: "0.2.0", protocolVersion: "1.0", platform: "linux",
  declaredCapabilities: ["system.summary.read", "service.status.read"], allowedCapabilities: ["system.summary.read", "service.status.read"],
  enrolledAt: "2026-07-13T00:00:00.000Z", lastSeenAt: now, revokedAt: null,
};
const task: RemoteTaskRecord = {
  protocolVersion: "1.0", taskId: "22222222-2222-4222-8222-222222222222", type: "service.status.read", targetNodeId: node.nodeId,
  parameters: { serviceName: "nginx.service" }, createdAt: "2026-07-14T00:39:58.000Z", expiresAt: "2026-07-14T00:41:58.000Z",
  idempotencyKey: "terminal-history-test", requester: "user:administrator", traceId: "33333333-3333-4333-8333-333333333333",
  requiredCapability: "service.status.read", attempt: 1, maxAttempts: 3, status: "succeeded", updatedAt: now,
  result: { message: "nginx.service active (running)", truncated: false }, errorCode: null, retryable: true, nextAttemptAt: null,
};

describe("terminal live history page", () => {
  const notify = vi.fn();
  beforeEach(() => {
    notify.mockClear(); vi.mocked(listRemoteTasks).mockReset(); vi.mocked(listAgentNodes).mockReset();
    vi.mocked(listAgentNodes).mockResolvedValue({ nodes: [node] });
  });
  afterEach(() => vi.useRealTimers());

  it("shows the CloudPulse heading while retaining freshness", async () => {
    vi.mocked(listRemoteTasks).mockResolvedValue({ tasks: [task], collectedAt: now });
    const { container } = render(<TerminalHistoryPage notify={notify} />);
    await screen.findByText("读取服务状态 · nginx.service");
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "执行历史" })).not.toHaveClass("sr-only");
    expect(screen.getByText(/后端采集于/)).toBeInTheDocument();
  });

  it("renders Controller task records and opens details by stable task id", async () => {
    const user = userEvent.setup();
    vi.mocked(listRemoteTasks).mockResolvedValue({ tasks: [task], collectedAt: now });
    render(<TerminalHistoryPage notify={notify} />);
    expect(await screen.findByText("读取服务状态 · nginx.service")).toBeInTheDocument();
    expect(screen.getByText(node.nodeName)).toHaveAttribute("title", node.nodeName);
    expect(screen.getByText("nginx.service active (running)")).toBeInTheDocument();
    expect(screen.getByText(`${task.requester} · 总历时 2.0s`)).toBeInTheDocument();
    expect(screen.queryByText("systemctl restart nginx")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重跑|固定/ })).not.toBeInTheDocument();
    const detailLabel = `从操作区查看任务详情 读取服务状态 · nginx.service，节点 ${node.nodeName}，任务 ${task.taskId}`;
    const copyLabel = `复制任务 ID ${task.taskId}，读取服务状态 · nginx.service，节点 ${node.nodeName}`;
    expect(screen.getByRole("button", { name: detailLabel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copyLabel })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: detailLabel }));
    const drawer = screen.getByRole("dialog", { name: "读取服务状态 · nginx.service" });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("总历时 2.0s")).toBeInTheDocument();
    expect(within(drawer).getByText(task.traceId)).toBeInTheDocument();
    expect(within(drawer).getByText("service.status.read")).toBeInTheDocument();
  });

  it("shows an initial retryable error and a real empty state without fixtures", async () => {
    vi.mocked(listRemoteTasks).mockRejectedValueOnce(new Error("Controller 暂不可用")).mockResolvedValueOnce({ tasks: [], collectedAt: now });
    const user = userEvent.setup();
    render(<TerminalHistoryPage notify={notify} />);
    expect(await screen.findByText("Controller 暂不可用")).toBeInTheDocument();
    expect(screen.getByText("真实执行历史加载失败，未显示示例数据")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("尚无受控任务记录，系统将继续自动采集")).toBeInTheDocument();
    expect(screen.queryByText("Controller 暂不可用")).not.toBeInTheDocument();
  });

  it("accepts an older Controller response without a collection timestamp", async () => {
    const response = RemoteTaskListResponseSchema.parse({ tasks: [task] });
    expect(response.collectedAt).toBeUndefined();
    vi.mocked(listRemoteTasks).mockResolvedValue(response);
    render(<TerminalHistoryPage notify={notify} />);
    expect(await screen.findByText("等待后端时间")).toBeInTheDocument();
  });

  it("polls every ten seconds silently and preserves an open detail by stable id", async () => {
    vi.useFakeTimers();
    vi.mocked(listRemoteTasks)
      .mockResolvedValueOnce({ tasks: [task], collectedAt: now })
      .mockResolvedValueOnce({ tasks: [{ ...task, result: { message: "nginx.service inactive", truncated: false }, updatedAt: "2026-07-14T00:40:10.000Z" }], collectedAt: "2026-07-14T00:40:10.000Z" });
    render(<TerminalHistoryPage notify={notify} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: `查看任务详情 读取服务状态 · nginx.service，节点 ${node.nodeName}，任务 ${task.taskId}` }));
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(listRemoteTasks).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("dialog", { name: "读取服务状态 · nginx.service" })).getByText("nginx.service inactive")).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
  });
});
