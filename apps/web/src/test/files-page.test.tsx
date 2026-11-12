import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesPage } from "../pages/FilesPages";

const listPayload = { root: "/tmp/files", path: "/", collectedAt: "2026-07-14T00:00:00.000Z", entries: [{ id: "0123456789abcdef", name: "index.html", path: "/index.html", kind: "file", sizeBytes: 18, modifiedAt: "2026-07-14T00:00:00.000Z", owner: "uid:1000" }] };
function response(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }); }

describe("files browser page", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("settles an initial error and automatically recovers on the next read-only poll", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ error: "目录暂不可读" }, 503)).mockResolvedValueOnce(response(listPayload));
    vi.stubGlobal("fetch", fetchMock);
    render(<FilesPage page="files" notify={vi.fn()} canWrite={false} />);
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("正在从 /api/files 读取文件目录")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("index.html").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });
  it.each([
    ["files", "文件"],
    ["files-www", "受管目录"],
  ] as const)("shows the CloudPulse heading from %s while retaining actions and freshness", async (page, title) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(listPayload)));
    const { container } = render(<FilesPage page={page} notify={vi.fn()} canWrite />);
    expect((await screen.findAllByText("index.html")).length).toBeGreaterThan(0);
    expect(container.querySelector(".module-head h1:not(.sr-only)")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "创建文件夹" })).toBeInTheDocument();
    expect(screen.getByText(/后端采集于/)).toBeInTheDocument();
  });
  it("loads backend files and sends a recoverable delete mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(listPayload)).mockResolvedValueOnce(response({ message: "文件项已移入回收站", trashEntry: { id: "11111111-1111-4111-8111-111111111111", name: "index.html", originalPath: "/index.html", kind: "file", sizeBytes: 18, deletedAt: "2026-07-14T00:00:00.000Z", expiresAt: "2026-07-21T00:00:00.000Z", owner: "uid:1000" } })).mockResolvedValueOnce(response({ ...listPayload, entries: [] }));
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup(); const notify = vi.fn(); render(<FilesPage page="files" notify={notify} canWrite />);
    expect((await screen.findAllByText("index.html")).length).toBeGreaterThan(0); await user.click(screen.getAllByRole("button", { name: "删除 index.html 到回收站" })[0]);
    const dialog = screen.getByRole("dialog", { name: "移入回收站" }); await user.click(within(dialog).getByRole("button", { name: "确认移入" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/files/trash", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/index.html" }) })));
    expect(notify).toHaveBeenCalledWith("文件项已移入回收站");
  });
  it("renders initial failures as errors without fixture fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "目录不可读" }, 403))); render(<FilesPage page="files" notify={vi.fn()} canWrite={false} />);
    expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument(); expect(screen.queryByText("index.html")).not.toBeInTheDocument();
  });
  it("hides stale parent entries while a child directory loads", async () => {
    let resolveChild!: (value: Response) => void; const child = new Promise<Response>((resolve) => { resolveChild = resolve; }); const folderPayload = { ...listPayload, entries: [{ id: "folder-id-012345", name: "logs", path: "/logs", kind: "directory", sizeBytes: null, modifiedAt: "2026-07-14T00:00:00.000Z", owner: "uid:1000" }, ...listPayload.entries] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(folderPayload)).mockReturnValueOnce(child)); const user = userEvent.setup(); render(<FilesPage page="files" notify={vi.fn()} canWrite />); await user.click((await screen.findAllByRole("button", { name: "logs" }))[0]); await waitFor(() => expect(screen.queryByText("index.html")).not.toBeInTheDocument()); expect(screen.queryByRole("button", { name: "删除 index.html 到回收站" })).not.toBeInTheDocument(); resolveChild(response({ ...listPayload, path: "/logs", entries: [] }));
  });
});
