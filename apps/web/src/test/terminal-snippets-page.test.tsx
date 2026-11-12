import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeTerminalSnippet, fetchTerminalSnippetNodes, fetchTerminalSnippets, fetchTerminalSnippetTasks,
  updateTerminalSnippetFavorite,
} from "../api/terminalApi";
import { reauthenticate } from "../api/identityApi";
import { TerminalPage } from "../pages/TerminalPage";

vi.mock("../api/terminalApi", () => ({
  createTerminalTask: vi.fn(), executeTerminalSnippet: vi.fn(), fetchTerminalHosts: vi.fn(), fetchTerminalNodes: vi.fn(),
  fetchTerminalSnippets: vi.fn(), fetchTerminalSnippetNodes: vi.fn(), fetchTerminalSnippetTasks: vi.fn(),
  fetchTerminalTasks: vi.fn(), updateTerminalSnippetFavorite: vi.fn(),
}));
vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));

const collectedAt = "2026-07-14T00:00:00.000Z";
const snippets = [
  { id: "system-resource-summary", version: 1, title: "系统资源概览", command: "df -h && uptime", category: "资源", risk: "read" as const, description: "通过 Agent 采集资源", favorite: false, lastUsedAt: null, executable: true, requiredCapability: "system.summary.read" as const },
  { id: "clear-temporary-cache", version: 1, title: "清理临时缓存", command: "rm -rf /tmp/cache/*", category: "文件", risk: "danger" as const, description: "危险命令禁止执行", favorite: false, lastUsedAt: null, executable: false, requiredCapability: null },
];
const node = { nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "agent-sg-01", status: "online" as const, agentVersion: "0.2.0", protocolVersion: "1.0" as const, platform: "linux" as const, declaredCapabilities: ["system.summary.read" as const], allowedCapabilities: ["system.summary.read" as const], enrolledAt: collectedAt, lastSeenAt: collectedAt, revokedAt: null };
const task = { protocolVersion: "1.0" as const, taskId: "22222222-2222-4222-8222-222222222222", type: "system.summary.read" as const, targetNodeId: node.nodeId, parameters: { includeLoad: true }, createdAt: collectedAt, expiresAt: "2026-07-14T00:02:00.000Z", idempotencyKey: "terminal:system-resource-summary-test", requester: "user:test", traceId: "33333333-3333-4333-8333-333333333333", requiredCapability: "system.summary.read" as const, attempt: 0, maxAttempts: 3, status: "queued" as const, updatedAt: collectedAt, result: null, errorCode: null, retryable: true, nextAttemptAt: null };
const permissions = ["terminal:read", "terminal:execute"] as const;

describe("terminal snippets real backend page", () => {
  beforeEach(() => {
    vi.mocked(fetchTerminalSnippets).mockReset().mockResolvedValue({ snippets, collectedAt });
    vi.mocked(fetchTerminalSnippetNodes).mockReset().mockResolvedValue({ nodes: [node] });
    vi.mocked(fetchTerminalSnippetTasks).mockReset().mockResolvedValue({ tasks: [] });
    vi.mocked(updateTerminalSnippetFavorite).mockReset().mockResolvedValue({ ...snippets[0], favorite: true });
    vi.mocked(reauthenticate).mockReset().mockResolvedValue({ proof: "one-time-proof-with-more-than-thirty-two-characters", expiresAt: "2026-07-14T00:05:00.000Z" });
    vi.mocked(executeTerminalSnippet).mockReset().mockResolvedValue({ snippet: { ...snippets[0], lastUsedAt: collectedAt }, task });
  });

  afterEach(() => vi.useRealTimers());

  it("shows the CloudPulse heading while retaining freshness", async () => {
    const { container } = render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    await screen.findByText("系统资源概览");
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "常用命令" })).not.toHaveClass("sr-only");
    expect(screen.getByText(/后端更新于/)).toBeInTheDocument();
  });

  it("loads Controller snippets and persists favorite state", async () => {
    const user = userEvent.setup(); render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    expect(await screen.findByText("系统资源概览")).toBeInTheDocument();
    expect(screen.queryByText("重启 Worker")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "收藏 系统资源概览" }));
    await waitFor(() => expect(updateTerminalSnippetFavorite).toHaveBeenCalledWith("system-resource-summary", true));
    expect(screen.getByRole("button", { name: "取消收藏 系统资源概览" })).toBeInTheDocument();
  });

  it("submits only snippet identity after fast current-password input", async () => {
    render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    fireEvent.click(await screen.findByRole("button", { name: "执行 系统资源概览" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认执行受控命令" });
    const password = within(dialog).getByLabelText("当前账号密码");
    fireEvent.input(password, { target: { value: "correct password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(executeTerminalSnippet).toHaveBeenCalled());
    expect(reauthenticate).toHaveBeenCalledWith("correct password");
    const [id, payload, proof] = vi.mocked(executeTerminalSnippet).mock.calls[0];
    expect(id).toBe("system-resource-summary"); expect(payload).toMatchObject({ nodeId: node.nodeId, snippetVersion: 1 });
    expect(payload).not.toHaveProperty("command"); expect(payload).not.toHaveProperty("parameters"); expect(proof).toContain("one-time-proof");
    expect(await screen.findByText("等待 Agent")).toBeInTheDocument();
  });

  it("uses the stable node ID when two Agents share the same name", async () => {
    const secondNode = { ...node, nodeId: "44444444-4444-4444-8444-444444444444" };
    vi.mocked(fetchTerminalSnippetNodes).mockResolvedValue({ nodes: [node, secondNode] });
    const user = userEvent.setup(); render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    await screen.findByText("系统资源概览");
    await user.click(screen.getByRole("combobox", { name: "目标 Agent agent-sg-01 · 在线 · 11111111" }));
    await user.click(screen.getByRole("option", { name: "agent-sg-01 · 在线 · 44444444" }));
    await user.click(screen.getByRole("button", { name: "执行 系统资源概览" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认执行受控命令" });
    await user.type(within(dialog).getByLabelText("当前账号密码"), "correct password");
    await user.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(executeTerminalSnippet).toHaveBeenCalled());
    expect(vi.mocked(executeTerminalSnippet).mock.calls[0][1].nodeId).toBe(secondNode.nodeId);
  });

  it("rejects before reauthentication when the pending default Agent goes offline", async () => {
    vi.useFakeTimers();
    const offlineNode = { ...node, status: "offline" as const };
    const replacementNode = {
      ...node,
      nodeId: "44444444-4444-4444-8444-444444444444",
      nodeName: "agent-sg-02",
    };
    const notify = vi.fn();
    vi.mocked(fetchTerminalSnippetNodes)
      .mockResolvedValueOnce({ nodes: [node] })
      .mockResolvedValue({ nodes: [offlineNode, replacementNode] });

    render(<TerminalPage page="terminal-snippets" notify={notify} permissions={[...permissions]} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "执行 系统资源概览" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认执行受控命令" });
    fireEvent.input(within(dialog).getByLabelText("当前账号密码"), { target: { value: "correct password" } });

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchTerminalSnippetNodes).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "确认执行" })); });

    expect(notify).toHaveBeenCalledWith("目标 Agent 能力已变更，请重新选择命令", "danger");
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(executeTerminalSnippet).not.toHaveBeenCalled();
  });

  it("rejects before reauthentication when the pending Agent capability is narrowed", async () => {
    vi.useFakeTimers();
    const restrictedNode = { ...node, allowedCapabilities: [] };
    const notify = vi.fn();
    vi.mocked(fetchTerminalSnippetNodes)
      .mockResolvedValueOnce({ nodes: [node] })
      .mockResolvedValue({ nodes: [restrictedNode] });

    render(<TerminalPage page="terminal-snippets" notify={notify} permissions={[...permissions]} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "执行 系统资源概览" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认执行受控命令" });
    fireEvent.input(within(dialog).getByLabelText("当前账号密码"), { target: { value: "correct password" } });

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchTerminalSnippetNodes).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "确认执行" })); });

    expect(notify).toHaveBeenCalledWith("目标 Agent 能力已变更，请重新选择命令", "danger");
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(executeTerminalSnippet).not.toHaveBeenCalled();
  });

  it("keeps dangerous snippets inspectable but never executable", async () => {
    const user = userEvent.setup(); render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    expect(await screen.findByRole("button", { name: "执行 清理临时缓存" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "查看 清理临时缓存 详情" }));
    const drawer = screen.getByRole("dialog", { name: "清理临时缓存" });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("仅供检查，禁止执行")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "尚未接入" })).toBeDisabled();
  });

  it("uses independent terminal permissions", async () => {
    const { unmount } = render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={["terminal:read"]} />);
    expect(await screen.findByRole("button", { name: "执行 系统资源概览" })).toBeDisabled();
    expect(fetchTerminalSnippets).toHaveBeenCalled();
    unmount(); vi.clearAllMocks();
    render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={["nodes:read", "tasks:create"]} />);
    expect(await screen.findByText("当前账号没有常用命令读取权限")).toBeInTheDocument();
    expect(fetchTerminalSnippets).not.toHaveBeenCalled();
  });

  it("reuses the idempotency key when an execution response is lost", async () => {
    vi.mocked(executeTerminalSnippet).mockRejectedValueOnce(new Error("响应连接中断"));
    const user = userEvent.setup(); render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    await user.click(await screen.findByRole("button", { name: "执行 系统资源概览" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认执行受控命令" });
    await user.type(within(dialog).getByLabelText("当前账号密码"), "correct password");
    await user.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(executeTerminalSnippet).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(executeTerminalSnippet).toHaveBeenCalledTimes(2));
    expect(vi.mocked(executeTerminalSnippet).mock.calls[1][1].idempotencyKey).toBe(vi.mocked(executeTerminalSnippet).mock.calls[0][1].idempotencyKey);
  });

  it("shows a retryable error without falling back to demo data", async () => {
    vi.mocked(fetchTerminalSnippets).mockRejectedValueOnce(new Error("后端暂不可用"));
    const user = userEvent.setup(); render(<TerminalPage page="terminal-snippets" notify={vi.fn()} permissions={[...permissions]} />);
    expect(await screen.findByText("后端暂不可用")).toBeInTheDocument();
    expect(screen.getByText("真实片段加载失败，未显示示例数据")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("系统资源概览")).toBeInTheDocument();
  });
});
