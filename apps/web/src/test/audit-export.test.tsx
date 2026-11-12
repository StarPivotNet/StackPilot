import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrfToken } from "../api/client";
import { AuditPage } from "../pages/AuditPage";

const record = { id: "11111111-1111-4111-8111-111111111111", name: "真实审计快照", format: "csv", status: "ready", rowCount: 42, sizeBytes: 2048, sha256: "a".repeat(64), createdBy: "Administrator", createdAt: "2026-07-15T12:00:00.000Z", completedAt: "2026-07-15T12:00:01.000Z", expiresAt: "2026-07-22T12:00:00.000Z", traceId: "22222222-2222-4222-8222-222222222222", errorCode: null } as const;

describe("audit export real backend", () => {
  afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(""); });

  it("loads persistent export records without demo fallback and creates a real snapshot", async () => {
    window.history.replaceState(null, "", "/#audit-export"); setCsrfToken("csrf-token-held-in-memory-1234567890");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ exports: [record], collectedAt: "2026-07-15T12:00:02.000Z" }))
      .mockResolvedValueOnce(json({ proof: "proof-held-in-memory-1234567890123456", expiresAt: "2026-07-15T12:05:00.000Z" }))
      .mockResolvedValueOnce(json({ export: record }, 201))
      .mockResolvedValueOnce(json({ exports: [record], collectedAt: "2026-07-15T12:00:03.000Z" }));
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup(); const { container } = render(<AuditPage page="audit-export" notify={vi.fn()} permissions={["audit:read", "audit:export"]} />);
    expect((await screen.findAllByText("真实审计快照")).length).toBeGreaterThan(0); expect(screen.queryByText("今日操作审计 CSV")).not.toBeInTheDocument(); expect(screen.getByText(/后端采集/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "导出记录" })).not.toHaveClass("sr-only"); expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建导出" })); const dialog = screen.getByRole("alertdialog", { name: "创建审计快照" }); expect(within(dialog).getByRole("combobox", { name: /文件格式/ })).toHaveTextContent("CSV"); await user.type(within(dialog).getByLabelText("当前密码"), "current password"); await user.click(within(dialog).getByRole("button", { name: "确认生成" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/audit-exports", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token-held-in-memory-1234567890", "X-Reauth-Proof": "proof-held-in-memory-1234567890123456" }), body: expect.stringContaining('"format":"csv"') })));
  });

  it("shows the POST result immediately when an older list request is still running", async () => {
    window.history.replaceState(null, "", "/#audit-export"); setCsrfToken("csrf-token-held-in-memory-1234567890");
    let resolveInitial: ((response: Response) => void) | undefined;
    const created = { ...record, id: "33333333-3333-4333-8333-333333333333", name: "竞态后的真实快照" };
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce(json({ proof: "proof-held-in-memory-1234567890123456", expiresAt: "2026-07-15T12:05:00.000Z" }))
      .mockResolvedValueOnce(json({ export: created }, 201))
      .mockResolvedValueOnce(json({ exports: [created], collectedAt: "2026-07-15T12:00:04.000Z" }));
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup();
    render(<AuditPage page="audit-export" notify={vi.fn()} permissions={["audit:read", "audit:export"]} />);
    await user.click(screen.getByRole("button", { name: "新建导出" }));
    const dialog = screen.getByRole("alertdialog", { name: "创建审计快照" });
    await user.type(within(dialog).getByLabelText("当前密码"), "current password");
    await user.click(within(dialog).getByRole("button", { name: "确认生成" }));
    expect((await screen.findAllByText("竞态后的真实快照")).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    resolveInitial?.(json({ exports: [], collectedAt: "2026-07-15T11:59:59.000Z" }));
    await waitFor(() => expect((screen.getAllByText("竞态后的真实快照")).length).toBeGreaterThan(0));
  });

  it("hides export actions and polling without audit:export", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<AuditPage page="audit-export" notify={vi.fn()} permissions={["audit:read"]} />);
    expect(screen.queryByRole("button", { name: "新建导出" })).not.toBeInTheDocument();
    expect(screen.getByText("当前账号没有审计导出权限")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not load exports when audit:export is present without audit:read", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<AuditPage page="audit-export" notify={vi.fn()} permissions={["audit:export"]} />);
    expect(screen.getByText("当前账号没有审计导出权限")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
