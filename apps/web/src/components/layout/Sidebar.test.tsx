import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

function setup() {
  const setPage = vi.fn();
  const onNavigate = vi.fn();
  const result = render(<Sidebar page="overview" setPage={setPage} collapsed={false} onToggleCollapsed={vi.fn()} onExpandCollapsed={vi.fn()} onNavigate={onNavigate} permissions={["nodes:read", "sites:read"]} />);
  return { ...result, setPage, onNavigate };
}

describe("shared CloudPulse sidebar", () => {
  it("keeps one group open and each parent as one complete click target", async () => {
    const user = userEvent.setup();
    const { container, setPage, onNavigate } = setup();
    const hosts = screen.getByRole("button", { name: "主机" });
    await user.click(hosts);
    expect(hosts).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "工作台" })).toHaveAttribute("aria-expanded", "false");
    expect(setPage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "生产环境" }));
    expect(setPage).toHaveBeenLastCalledWith("hosts-prod", expect.any(Object));
    expect(onNavigate).toHaveBeenCalledOnce();
    const ssh = screen.getByRole("button", { name: "SSH 管理" });
    await user.click(ssh);
    expect(ssh).toHaveAttribute("aria-expanded", "true");
    expect(hosts).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "生产环境" })).not.toBeInTheDocument();
    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });

  it("hides the proposed SSH module when node read permission is absent", () => {
    render(<Sidebar page="overview" setPage={vi.fn()} collapsed={false} onToggleCollapsed={vi.fn()} onExpandCollapsed={vi.fn()} onNavigate={vi.fn()} permissions={[]} />);
    expect(screen.queryByRole("button", { name: "SSH 管理" })).not.toBeInTheDocument();
  });
});
