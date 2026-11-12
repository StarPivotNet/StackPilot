import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalTask } from "../api/terminalApi";
import { TerminalPage } from "../pages/TerminalPage";
import type { Notify } from "../types/app";
import { resetTerminalApiMocks } from "./terminalTestFixtures";

vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));
vi.mock("../api/terminalApi", () => ({ createTerminalTask: vi.fn(), fetchTerminalHosts: vi.fn(), fetchTerminalNodes: vi.fn(), fetchTerminalTasks: vi.fn() }));

describe("terminal sessions page", () => {
  beforeEach(resetTerminalApiMocks);

  it("opens real Agent details in a body-level modal drawer", async () => {
    const user = userEvent.setup();
    const { container } = render(<TerminalPage page="terminal-sessions" notify={vi.fn<Notify>()} />);

    await user.click(await screen.findByRole("button", { name: "查看 real-agent-01 目标详情" }));

    const drawer = screen.getByRole("dialog", { name: "real-agent-01 · Agent 详情" });
    expect(drawer.parentElement).toBe(document.body);
    expect(drawer).toHaveClass("terminal-session-drawer");
    expect(container.querySelector(".module-layout")).not.toHaveClass("has-side");
    expect(within(drawer).getByText("Agent 已连接")).toBeInTheDocument();
    expect(within(drawer).getAllByText("198.18.0.10")).toHaveLength(2);
    expect(within(drawer).getByText("当前目录").parentElement).toHaveTextContent("未提供");
  });

  it("does not expose fake connect or disconnect controls", async () => {
    const user = userEvent.setup();
    render(<TerminalPage page="terminal-sessions" notify={vi.fn<Notify>()} />);

    await user.click(await screen.findByRole("button", { name: "查看 real-agent-01 目标详情" }));

    const drawer = screen.getByRole("dialog", { name: "real-agent-01 · Agent 详情" });
    expect(within(drawer).queryByRole("button", { name: /打开会话|关闭会话/ })).not.toBeInTheDocument();
  });

  it("rejects mutation commands before creating a backend task", async () => {
    const user = userEvent.setup();
    const notify = vi.fn<Notify>();
    render(<TerminalPage page="terminal-sessions" notify={notify} />);

    const input = await screen.findByRole("textbox", { name: "命令输入" });
    await user.type(input, "systemctl restart nginx");
    await user.click(screen.getByRole("button", { name: "运行" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(createTerminalTask).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("仅支持"), "danger");
  });
});
