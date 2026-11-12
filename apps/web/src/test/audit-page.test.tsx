import type { AuditEvent, AuditEventsResponse } from "@stackpilot/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAllAuditEvents, fetchAuditEvents } from "../api/auditApi";
import { auditRecord } from "../features/audit/model";
import { AuditPage } from "../pages/AuditPage";

vi.mock("../api/auditApi", () => ({ fetchAuditEvents: vi.fn(), fetchAllAuditEvents: vi.fn() }));

const successEvent: AuditEvent = {
  sequence: 2,
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-07-15T10:00:00.000Z",
  actorType: "user",
  actorId: "operator",
  source: "controller",
  targetType: "file",
  targetId: "/var/www/index.html",
  action: "file.upload",
  parameters: "{}",
  outcome: "success",
  authorization: "allowed:files:write",
  requestId: "request-success",
  traceId: "trace-success",
  eventHash: "a".repeat(64),
};
const failedEvent: AuditEvent = {
  ...successEvent,
  sequence: 1,
  eventId: "22222222-2222-4222-8222-222222222222",
  action: "auth.login",
  outcome: "denied",
  requestId: "request-denied",
  traceId: "trace-denied",
  eventHash: "b".repeat(64),
};

function response(events: AuditEvent[], overrides: Partial<AuditEventsResponse> = {}): AuditEventsResponse {
  return { events, collectedAt: "2026-07-15T10:01:00.000Z", total: events.length, limit: 200, nextCursor: null, ...overrides };
}

describe("audit real backend", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/#audit-all");
    vi.mocked(fetchAuditEvents).mockReset().mockResolvedValue(response([successEvent, failedEvent], { total: 42 }));
    vi.mocked(fetchAllAuditEvents).mockReset().mockResolvedValue(response([successEvent, failedEvent], { total: 42, limit: 1_000 }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:audit-export") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it.each([
    ["audit", "审计日志"],
    ["audit-all", "全部日志"],
  ])("renders the design heading without redundant context on %s", async (page, title) => {
    const { container } = render(<AuditPage page={page} notify={vi.fn()} permissions={["audit:read"]} />);
    await screen.findAllByText("file.upload");
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
  });

  it("loads real audit rows without demo records", async () => {
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    await waitFor(() => expect(fetchAuditEvents).toHaveBeenCalledWith({}, expect.any(AbortSignal)));
    expect((await screen.findAllByText("file.upload")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("auth.login")).length).toBeGreaterThan(0);
    expect(screen.queryByText("匹配 42")).not.toBeInTheDocument();
    expect(screen.queryByText("部署应用")).not.toBeInTheDocument();
  });

  it("sends failed and database filters to the backend before limiting", async () => {
    vi.mocked(fetchAuditEvents).mockResolvedValue(response([failedEvent]));
    const failed = render(<AuditPage page="audit-failed" notify={vi.fn()} />);
    await waitFor(() => expect(fetchAuditEvents).toHaveBeenCalledWith({ result: "failure" }, expect.any(AbortSignal)));
    failed.unmount();

    vi.mocked(fetchAuditEvents).mockClear().mockResolvedValue(response([{ ...successEvent, action: "database.backup" }]));
    window.history.replaceState(null, "", "/?auditSource=database#audit-all");
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    await waitFor(() => expect(fetchAuditEvents).toHaveBeenCalledWith({ actionPrefix: "database." }, expect.any(AbortSignal)));
  });

  it("keeps recorded outcomes distinct and exposes complete real details", async () => {
    vi.mocked(fetchAuditEvents).mockResolvedValue(response([{ ...successEvent, outcome: "queued", parameters: '{"kind":"backup"}' }]));
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    expect((await screen.findAllByText("已记录")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "详情" })[0]!);
    const drawer = screen.getByRole("dialog", { name: "审计详情" });
    expect(drawer.parentElement).toBe(document.body);
    expect(drawer).toHaveClass("audit-detail-drawer");
    expect(within(drawer).getByText("request-success")).toBeInTheDocument();
    expect(within(drawer).getByText("a".repeat(64))).toBeInTheDocument();
    expect(within(drawer).getByText(/backup/)).toBeInTheDocument();
  });

  it("renders a retryable initial error without a false empty state", async () => {
    vi.mocked(fetchAuditEvents).mockRejectedValueOnce(new Error("审计服务暂不可用")).mockResolvedValueOnce(response([]));
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    expect(await screen.findByText("审计服务暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的真实审计日志，系统将继续自动查询")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetchAuditEvents).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText("没有匹配的真实审计日志，系统将继续自动查询")).length).toBeGreaterThan(0);
  });

  it("clears rows from the previous query when a changed filter fails", async () => {
    vi.mocked(fetchAuditEvents)
      .mockResolvedValueOnce(response([successEvent], { total: 1 }))
      .mockRejectedValueOnce(new Error("筛选查询失败"));
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    expect((await screen.findAllByText("file.upload")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByPlaceholderText("搜索关键字、对象、request id 或 trace id"), { target: { value: "missing" } });
    expect(await screen.findByText("筛选查询失败")).toBeInTheDocument();
    expect(screen.queryByText("file.upload")).not.toBeInTheDocument();
    expect(fetchAuditEvents).toHaveBeenLastCalledWith({ search: "missing" }, expect.any(AbortSignal));
  });

  it("keeps a selected actor visible when polling replaces the result window", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: AuditEventsResponse) => void) | undefined;
    vi.mocked(fetchAuditEvents)
      .mockResolvedValueOnce(response([successEvent, failedEvent], { total: 42 }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    await screen.findAllByText("file.upload");
    const actorSelect = screen.getAllByRole("combobox")[0]!;
    await user.click(actorSelect);
    await user.click(screen.getByRole("option", { name: "operator" }));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(resolveRefresh).toBeDefined());
    resolveRefresh!(response([]));
    await waitFor(() => expect(within(actorSelect).getByText("operator")).toBeInTheDocument());
  });

  it("loads older matching events with a stable backend cursor", async () => {
    const recentEvent: AuditEvent = { ...successEvent, sequence: 201 };
    const secondEvent: AuditEvent = { ...failedEvent, sequence: 200 };
    const oldEvent: AuditEvent = { ...failedEvent, sequence: 199, eventId: "33333333-3333-4333-8333-333333333333", action: "audit.old" };
    vi.mocked(fetchAuditEvents)
      .mockResolvedValueOnce(response([recentEvent, secondEvent], { total: 201, limit: 2, nextCursor: 200 }))
      .mockResolvedValueOnce(response([oldEvent], { total: 201, limit: 2 }));
    render(<AuditPage page="audit-all" notify={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "加载更早记录" }));
    expect((await screen.findAllByText("audit.old")).length).toBeGreaterThan(0);
    expect(fetchAuditEvents).toHaveBeenNthCalledWith(2, { beforeSequence: 200 }, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "加载更早记录" })).not.toBeInTheDocument();
  });
});

describe("audit semantics", () => {
  it.each([["failure", "失败"], ["timeout", "失败"], ["success", "成功"], ["queued", "已记录"]] as const)("maps %s to %s", (outcome, result) => {
    expect(auditRecord({ ...successEvent, outcome }).result).toBe(result);
  });
});
