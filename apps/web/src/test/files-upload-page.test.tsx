import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileUploadQueuePage } from "../pages/FilesPages";

const empty = { uploads: [], collectedAt: "2026-07-14T00:00:00.000Z", maxUploadBytes: 1024 };
describe("files upload page", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows the CloudPulse heading while retaining upload action and freshness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(empty), { status: 200 })));
    const { container } = render(<FileUploadQueuePage page="files-upload" notify={vi.fn()} canWrite />);
    await screen.findAllByText("还没有真实上传记录");
    expect(container.querySelector(".module-head h1:not(.sr-only)")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "上传队列" })).not.toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "添加上传" })).toBeInTheDocument();
    expect(screen.getByText(/后端采集于/)).toBeInTheDocument();
  });
  it("uploads the selected bytes to the real endpoint", async () => {
    const upload = { id: "11111111-1111-4111-8111-111111111111", name: "release.zip", targetPath: "/", sizeBytes: 7, status: "completed", owner: "Admin", startedAt: "2026-07-14T00:00:00.000Z", completedAt: "2026-07-14T00:00:01.000Z", error: null };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(empty), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: "release.zip 上传完成", upload, entry: { id: "0123456789abcdef", name: "release.zip", path: "/release.zip", kind: "file", sizeBytes: 7, modifiedAt: "2026-07-14T00:00:01.000Z", owner: "uid:1000" } }), { status: 201 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...empty, uploads: [upload] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock); const user = userEvent.setup(); render(<FileUploadQueuePage page="files-upload" notify={vi.fn()} canWrite />); expect((await screen.findAllByText("还没有真实上传记录")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "添加上传" })); const dialog = screen.getByRole("dialog", { name: "添加上传" }); const input = within(dialog).getByText("本地文件").closest("label")?.querySelector("input"); expect(input).toBeInstanceOf(HTMLInputElement); await user.upload(input as HTMLInputElement, new File(["release"], "release.zip")); await user.click(within(dialog).getByRole("button", { name: "开始上传" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/file-uploads", expect.objectContaining({ method: "POST", body: expect.any(File) })));
  });
  it("clears a cancelled file selection before reopening the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(empty), { status: 200 })));
    const user = userEvent.setup(); render(<FileUploadQueuePage page="files-upload" notify={vi.fn()} canWrite />); await screen.findAllByText("还没有真实上传记录");
    await user.click(screen.getByRole("button", { name: "添加上传" })); let dialog = screen.getByRole("dialog", { name: "添加上传" }); const input = within(dialog).getByText("本地文件").closest("label")?.querySelector("input"); expect(input).toBeInstanceOf(HTMLInputElement); await user.upload(input as HTMLInputElement, new File(["release"], "release.zip")); await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "添加上传" })); dialog = screen.getByRole("dialog", { name: "添加上传" }); expect(within(dialog).getByText("尚未选择文件")).toBeInTheDocument(); await user.click(within(dialog).getByRole("button", { name: "开始上传" })); expect(within(dialog).getByRole("alert")).toHaveTextContent("请选择需要上传的文件");
  });
});
