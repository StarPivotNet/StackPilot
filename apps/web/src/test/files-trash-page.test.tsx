import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTrashPage } from "../pages/FilesPages";

const entry = { id: "11111111-1111-4111-8111-111111111111", name: "old.log", originalPath: "/old.log", kind: "file", sizeBytes: 32, deletedAt: "2026-07-14T00:00:00.000Z", expiresAt: "2026-07-21T00:00:00.000Z", owner: "uid:1000" };
const payload = { entries: [entry], collectedAt: "2026-07-14T00:00:00.000Z" };
describe("files trash page", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows the CloudPulse heading while retaining trash action and freshness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    const { container } = render(<FileTrashPage page="files-trash" notify={vi.fn()} canWrite canDelete />);
    await screen.findAllByText("old.log");
    expect(container.querySelector(".module-head h1:not(.sr-only)")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "回收站" })).not.toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "清空回收站" })).toBeInTheDocument();
    expect(screen.getByText(/后端采集于/)).toBeInTheDocument();
  });
  it("requires confirmation before the real permanent-delete request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ proof: "proof-value-held-in-memory-1234567890", expiresAt: "2026-07-14T00:05:00.000Z" }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: "文件已永久删除" }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup(); render(<FileTrashPage page="files-trash" notify={vi.fn()} canWrite canDelete />); expect((await screen.findAllByText("old.log")).length).toBeGreaterThan(0); await user.click(screen.getAllByRole("button", { name: "永久删除" })[0]);
    const dialog = screen.getByRole("alertdialog", { name: "永久删除文件" }); const password = within(dialog).getByLabelText("当前密码"); const confirm = within(dialog).getByRole("button", { name: "永久删除" }); expect(confirm).toBeDisabled(); await user.type(password, "current password"); expect(password).toHaveValue("current password"); expect(document.activeElement).toBe(password); expect(confirm).toBeEnabled(); await user.click(confirm); await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/reauthenticate", expect.objectContaining({ body: JSON.stringify({ password: "current password" }) }))); await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/file-trash", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ id: entry.id }), headers: expect.objectContaining({ "X-Reauth-Proof": "proof-value-held-in-memory-1234567890" }) }))); await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});
