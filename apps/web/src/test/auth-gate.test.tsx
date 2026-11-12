import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { login, restoreSession } from "../api/authApi";
import { AuthGate } from "../features/auth/AuthGate";

vi.mock("../api/authApi", () => ({ login: vi.fn(), restoreSession: vi.fn() }));
const user = { id: "test-user", username: "operator", displayName: "Operator", permissions: [], roles: [], nodeScope: "all" as const };
beforeEach(() => { vi.mocked(login).mockReset(); vi.mocked(restoreSession).mockReset().mockResolvedValue(null); });

describe("AuthGate", () => {
  it("keeps anonymous 401 errors on the login form and re-enables retry", async () => {
    vi.mocked(login).mockImplementation(async () => { window.dispatchEvent(new Event("stackpilot:session-expired")); throw new Error("用户名或密码无效"); });
    render(<AuthGate>{() => <div>authenticated content</div>}</AuthGate>);
    await screen.findByRole("heading", { name: "登录控制台" });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "operator" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "wrong-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "登录" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码无效");
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: /已锁定/ })).not.toBeInTheDocument();
    expect(screen.queryByText("authenticated content")).not.toBeInTheDocument();
  });

  it("removes protected content on expiry and requires a new login", async () => {
    vi.mocked(restoreSession).mockResolvedValue(user);
    render(<AuthGate>{() => <div>authenticated content</div>}</AuthGate>);
    await screen.findByText("authenticated content");
    act(() => window.dispatchEvent(new Event("stackpilot:session-expired")));
    expect(screen.queryByText("authenticated content")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "StackPilot 控制台已锁定" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect(screen.getByRole("heading", { name: "登录控制台" })).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("explains the real CLI initialization without exposing a Web registration form", async () => {
    render(<AuthGate>{() => <div>authenticated content</div>}</AuthGate>);
    await screen.findByRole("heading", { name: "登录控制台" });
    fireEvent.click(screen.getByRole("button", { name: "首次初始化说明" }));
    expect(screen.getByRole("heading", { name: "首次初始化" })).toBeInTheDocument();
    expect(screen.getByText("npm run db:init --workspace @stackpilot/controller")).toBeInTheDocument();
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
  });
});
