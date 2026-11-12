import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrfToken } from "../api/client";
import { AclPage } from "../pages/AclPage";

const roles = [
  { id: "administrator", name: "管理员", description: "内置管理员", builtin: true, permissions: ["overview:read", "roles:read", "roles:manage"] },
  { id: "audit-reader", name: "只读审计员", description: "只读审计角色", builtin: true, permissions: ["overview:read", "nodes:read", "systemd:read", "sites:read", "files:read", "firewall:read", "tasks:read", "audit:read", "roles:read"] },
  { id: "release-manager", name: "发布经理", description: "自定义发布角色", builtin: false, permissions: ["overview:read", "sites:read"] },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderAcl(page: "acl" | "acl-users" | "acl-roles" | "acl-policies") {
  const notify = vi.fn();
  const setPage = vi.fn();
  const result = render(<AclPage page={page} setPage={setPage} notify={notify} />);
  return { ...result, notify, setPage };
}

afterEach(() => {
  setCsrfToken("");
  vi.unstubAllGlobals();
});

describe("ACL workbench", () => {
  it.each([
    ["acl", "权限"],
    ["acl-users", "用户"],
    ["acl-roles", "角色"],
    ["acl-policies", "权限项"],
  ] as const)("renders the design heading without redundant context on %s", (page, title) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ users: [], roles })));
    const { container } = renderAcl(page);
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
  });

  it("keeps the server-backed user directory on one content track", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ users: [], roles })));
    const { container } = renderAcl("acl-users");
    expect(container.querySelector(".identity-management")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "用户访问" })).toBeInTheDocument();
  });

  it("loads Controller roles and keeps built-in roles read-only", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ roles })));
    renderAcl("acl-roles");

    await screen.findByRole("button", { name: /管理员/ });
    await user.click(screen.getByRole("button", { name: /只读审计员/ }));
    expect(screen.getByText("内置角色由 Controller 管理，仅显示已授予权限。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /已允许/ })).toHaveLength(9);
    expect(screen.queryByRole("button", { name: /总览操作/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /总览查看/ })[0]).toBeDisabled();
  });

  it("reauthenticates and PATCHes a changed custom role", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ roles }))
      .mockResolvedValueOnce(jsonResponse({ proof: "proof-value-with-at-least-thirty-two-characters", expiresAt: "2026-07-15T14:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ message: "角色权限已更新" }));
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-token-held-only-in-memory-123456");
    const { notify } = renderAcl("acl-roles");

    await user.click(await screen.findByRole("button", { name: /发布经理/ }));
    await user.click(screen.getByRole("button", { name: /总览操作/ }));
    await user.click(screen.getByRole("button", { name: "保存当前角色" }));

    const dialog = screen.getByRole("alertdialog", { name: "保存 发布经理 权限" });
    await user.type(within(dialog).getByLabelText("当前管理员密码"), "administrator password");
    await user.click(within(dialog).getByRole("button", { name: "确认保存" }));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("发布经理 权限已保存", "success"));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/roles/release-manager", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({
        "X-CSRF-Token": "csrf-token-held-only-in-memory-123456",
        "X-Reauth-Proof": "proof-value-with-at-least-thirty-two-characters",
      }),
    }));
    const body = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string) as { permissions: string[] };
    expect(body.permissions).toContain("overview:operate");
  });

  it("creates a role through the Controller instead of demo state", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ roles }))
      .mockResolvedValueOnce(jsonResponse({ proof: "proof-value-with-at-least-thirty-two-characters", expiresAt: "2026-07-15T14:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ message: "角色已创建" }, 201))
      .mockResolvedValueOnce(jsonResponse({ roles }));
    vi.stubGlobal("fetch", fetchMock);
    const { notify } = renderAcl("acl-roles");

    await user.click(await screen.findByRole("button", { name: "创建角色" }));
    const drawer = screen.getByRole("dialog", { name: "创建角色" });
    await user.type(within(drawer).getByLabelText("角色 ID"), "ops-reader");
    await user.type(within(drawer).getByLabelText("角色名称"), "运维只读");
    await user.type(within(drawer).getByLabelText("当前管理员密码"), "administrator password");
    await user.click(within(drawer).getByRole("button", { name: "创建角色" }));

    await waitFor(() => expect(notify).toHaveBeenCalledWith("角色已创建", "success"));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/roles", expect.objectContaining({ method: "POST" }));
  });
});
