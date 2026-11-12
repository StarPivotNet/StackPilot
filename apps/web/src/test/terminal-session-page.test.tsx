import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalTask } from "../api/terminalApi";
import { TerminalPage } from "../pages/TerminalPage";
import type { Notify } from "../types/app";
import { resetTerminalApiMocks, terminalNode } from "./terminalTestFixtures";

vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));
vi.mock("../api/terminalApi", () => ({ createTerminalTask: vi.fn(), fetchTerminalHosts: vi.fn(), fetchTerminalNodes: vi.fn(), fetchTerminalTasks: vi.fn() }));

describe("terminal session page", () => {
  beforeEach(resetTerminalApiMocks);

  it.each([
    ["terminal", "终端"],
    ["terminal-sessions", "会话列表"],
  ] as const)("shows the CloudPulse heading and navigation on %s", async (page, title) => {
    const { container } = render(<TerminalPage page={page} notify={vi.fn()} />);
    await screen.findByText("real-agent-01");
    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(screen.getByText(/后端更新于/)).toBeInTheDocument();
  });

  it("opens complete Agent details and closes them with Escape", async () => {
    const user = userEvent.setup();
    render(<TerminalPage page="terminal" notify={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "详情" }));

    const drawer = screen.getByRole("dialog", { name: "real-agent-01 · Agent 详情" });
    expect(drawer.parentElement).toBe(document.body);
    expect(drawer).toHaveClass("terminal-session-drawer");
    expect(within(drawer).getAllByText("198.18.0.10")).toHaveLength(2);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "real-agent-01 · Agent 详情" })).toHaveAttribute("data-closing", "true");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "real-agent-01 · Agent 详情" })).not.toBeInTheDocument());
  });

  it("reauthenticates before running an allowed read-only command", async () => {
    const user = userEvent.setup();
    const notify = vi.fn<Notify>();
    render(<TerminalPage page="terminal" notify={notify} />);

    const input = await screen.findByLabelText("命令输入");
    await user.type(input, "systemctl status nginx --no-pager");
    await user.click(screen.getByRole("button", { name: "运行" }));

    const dialog = screen.getByRole("alertdialog", { name: "确认执行受控命令" });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveClass("terminal-command-confirm");
    expect(input).toHaveValue("systemctl status nginx --no-pager");
    await user.type(within(dialog).getByLabelText("当前密码"), "current-password");
    await user.click(within(dialog).getByRole("button", { name: "确认执行" }));

    await vi.waitFor(() => expect(createTerminalTask).toHaveBeenCalledWith(
      terminalNode.nodeId,
      expect.objectContaining({ type: "terminal.command.execute", parameters: { command: "service-status", serviceName: "nginx" } }),
      expect.any(String),
    ));
    expect(input).toHaveValue("");
    expect(notify).toHaveBeenCalledWith("真实任务已提交，等待 Agent 返回结果", "success");
  });

  it("keeps a cancelled command ready for review", async () => {
    const user = userEvent.setup();
    render(<TerminalPage page="terminal" notify={vi.fn()} />);

    const input = await screen.findByLabelText("命令输入");
    await user.type(input, "uptime");
    await user.click(screen.getByRole("button", { name: "运行" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "确认执行受控命令" })).getByRole("button", { name: "取消" }));

    expect(input).toHaveValue("uptime");
  });
});
