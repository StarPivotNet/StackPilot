import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAuditEvents } from "../api/auditApi";
import { AuditPage } from "../pages/AuditPage";

vi.mock("../api/auditApi", () => ({ fetchAuditEvents: vi.fn(), fetchAllAuditEvents: vi.fn() }));

const collectedAt = "2026-07-15T02:03:04.000Z";
const failed = auditEvent({ eventId: "failed-event", action: "database.backup.scheduled", outcome: "failed", traceId: "trace-failed" });

describe("failed audit page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/#audit-failed");
    vi.mocked(fetchAuditEvents).mockReset().mockResolvedValue({ collectedAt, events: [failed], total: 1, limit: 200, nextCursor: null });
  });

  it("renders only failed records from the real audit response", async () => {
    const { container } = render(<AuditPage page="audit-failed" notify={vi.fn()} permissions={["audit:read"]} />);

    await waitFor(() => expect(fetchAuditEvents).toHaveBeenCalledTimes(1));
    expect(fetchAuditEvents).toHaveBeenCalledWith({ result: "failure" }, expect.any(AbortSignal));
    expect((await screen.findAllByText("database.backup.scheduled")).length).toBeGreaterThan(0);
    expect(screen.queryByText("auth.login")).not.toBeInTheDocument();
    expect(screen.getByText(/后端采集于/)).toHaveTextContent("2026");
    expect(screen.getAllByText("失败").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "失败操作" })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
  });

  it("closes stale details after the next real polling response removes the event", async () => {
    vi.mocked(fetchAuditEvents)
      .mockResolvedValueOnce({ collectedAt, events: [failed], total: 1, limit: 200, nextCursor: null })
      .mockResolvedValueOnce({ collectedAt: "2026-07-15T02:03:14.000Z", events: [], total: 0, limit: 200, nextCursor: null });
    render(<AuditPage page="audit-failed" notify={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "详情" }))[0]);
    expect(screen.getByRole("dialog", { name: "审计详情" })).toBeInTheDocument();

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchAuditEvents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "审计详情" })).not.toBeInTheDocument());
  });

});

function auditEvent(overrides: Record<string, unknown>) {
  return {
    sequence: 1,
    eventId: "event",
    occurredAt: "2026-07-15T02:00:00.000Z",
    actorType: "user",
    actorId: "operator",
    source: "database-controller",
    targetType: "database-operation",
    targetId: "operation-1",
    action: "test.action",
    parameters: "{}",
    outcome: "success",
    authorization: "session+rbac",
    requestId: "request",
    traceId: "trace",
    eventHash: "hash",
    ...overrides,
  };
}
