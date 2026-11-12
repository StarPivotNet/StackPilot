import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHosts, type HostMonitoringRecord } from "../api/hostsApi";
import { SshManagementPage } from "../pages/SshManagementPage";
import { emptySshDraft, SSH_BACKEND_CAPABILITY, sshActionAllowed, validateSshDraft } from "../features/ssh/model";

vi.mock("../api/hostsApi", () => ({ fetchHosts: vi.fn() }));
const notify = vi.fn();
const unexpectedFetch = vi.fn();
const stamp = "2026-11-12T06:32:10.000Z";
function host(id: string, name = id, address = "198.18.0.11"): HostMonitoringRecord {
  return { id, name, address, source: "agent", platform: "linux", environment: "生产", owner: "平台团队", connectionStatus: "online", healthStatus: "healthy", telemetryFreshness: "current", telemetryCollectedAt: stamp, lastSeenAt: stamp, cpuPercent: null, memory: null, disk: null, uptimeSeconds: null, backup: null, services: [], version: "1.0.0", latency: null, updateStatus: null };
}
function Harness({ initial = "ssh" }: { initial?: string }) {
  const [page, setPage] = useState(initial);
  useEffect(() => {
    const sync = () => setPage(window.location.hash.slice(1) || initial);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [initial]);
  return <SshManagementPage page={page} notify={notify} setPage={(next) => {
    const url = new URL(window.location.href); url.hash = next;
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    setPage(next);
  }} />;
}
function resolveHosts(rows: HostMonitoringRecord[] = []) { vi.mocked(fetchHosts).mockResolvedValue({ collectedAt: stamp, hosts: rows }); }
async function fillScope(user: ReturnType<typeof userEvent.setup>, hostId = "node-b") {
  await user.selectOptions(screen.getByRole("combobox", { name: "目标主机" }), hostId);
  await user.type(screen.getByRole("textbox", { name: "Linux 账号" }), "deploy");
  await user.type(screen.getByRole("textbox", { name: "操作者或用户组" }), "operator-a");
  await user.type(screen.getByRole("textbox", { name: "用途说明" }), "生产维护");
}

beforeEach(() => {
  vi.mocked(fetchHosts).mockReset(); notify.mockReset(); unexpectedFetch.mockReset();
  unexpectedFetch.mockRejectedValue(new Error("Unexpected request outside read-only host directory"));
  vi.stubGlobal("fetch", unexpectedFetch);
  window.history.replaceState(null, "", "/#ssh");
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  resolveHosts();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("SSH management without a backend capability", () => {
  it("shows genuine empty capability states without production fixture hosts or certificate evidence", async () => {
    render(<Harness />);
    await screen.findAllByText("资源目录尚无主机，系统将继续自动读取。");
    expect(screen.getByText("SSH 托管尚未启用")).toBeInTheDocument();
    expect(screen.queryByText(/production-web-01|#SP-2048|SHA256:spDemo/)).not.toBeInTheDocument();
    expect(screen.getByText("实际资源数量，不代表已接管")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /刷新|重新扫描|重新采集/ })).not.toBeInTheDocument();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("keeps all mutation actions disabled on credential and revocation routes", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole("button", { name: "凭据与证书" }));
    expect(screen.getByRole("button", { name: "签发凭据" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "填写签发草稿" }));
    expect(screen.getByRole("button", { name: "签发短期凭据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "一次性下载凭据包" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "凭据与证书" }));
    await user.click(screen.getByRole("button", { name: "查看吊销与会话规则" }));
    expect(screen.getByRole("button", { name: "吊销凭据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "终止当前会话" })).toBeDisabled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("supports field validation and draft review without turning acknowledgements into authorization", async () => {
    resolveHosts([host("node-a"), host("node-b", "actual-target-b", "198.18.0.12")]);
    window.history.replaceState(null, "", "/#ssh-precheck");
    const user = userEvent.setup(); render(<Harness initial="ssh-precheck" />);
    await screen.findByRole("option", { name: /actual-target-b/ });
    await user.click(screen.getByRole("button", { name: "预览变更草稿" }));
    expect(screen.getByText(/请选择资源目录中的目标主机/)).toBeInTheDocument();
    await fillScope(user);
    await user.click(screen.getByRole("button", { name: "预览变更草稿" }));
    expect(screen.getByRole("heading", { level: 1, name: "确认接管策略" })).toBeInTheDocument();
    expect(screen.getByText("actual-target-b")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("sshHost")).toBe("node-b");
    for (const box of screen.getAllByRole("checkbox")) await user.click(box);
    await user.type(screen.getByRole("textbox", { name: /主机名确认/ }), "actual-target-b");
    expect(screen.getByRole("button", { name: "应用接管策略" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新验证身份" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "查看独立验证要求" }));
    expect(screen.getByRole("button", { name: "提交接管" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "执行回滚" })).toBeDisabled();
    expect(screen.getByText("ControlPath none", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /模拟.*通过|模拟完整验证/ })).not.toBeInTheDocument();
    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps rescue scoped to 15 minutes and unavailable after a complete local draft", async () => {
    resolveHosts([host("node-b", "rescue-target")]);
    window.history.replaceState(null, "", "/#ssh-rescue");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup(); const { container } = render(<Harness initial="ssh-rescue" />);
    await screen.findByRole("option", { name: /rescue-target/ });
    await fillScope(user);
    await user.type(screen.getByRole("textbox", { name: "事故编号" }), "INC-actual-42");
    expect(screen.getByRole("combobox", { name: "计划有效期" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "计划有效期" })).toHaveValue("15");
    await user.click(screen.getByRole("button", { name: "检查草稿格式" }));
    expect(screen.getByText("草稿字段已填写，尚未发出请求")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "申请平台救援凭据" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "一次性领取救援凭据" })).toBeDisabled();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("clears actor/account context when a draft target changes", async () => {
    resolveHosts([host("node-a", "alpha"), host("node-b", "beta")]);
    window.history.replaceState(null, "", "/#ssh-issue");
    const user = userEvent.setup(); render(<Harness initial="ssh-issue" />);
    await screen.findByRole("option", { name: /beta/ }); await fillScope(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "目标主机" }), "node-a");
    expect(screen.getByRole("textbox", { name: "Linux 账号" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "操作者或用户组" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "用途说明" })).toHaveValue("");
    expect(new URLSearchParams(window.location.search).get("sshHost")).toBe("node-a");
  });

  it("opens the selected real host in a portal and keeps SSH protection unknown", async () => {
    const long = "beta-observability-node-with-a-very-long-hostname.internal.example";
    resolveHosts([host("node-a", "alpha"), host("node-b", long, "198.18.0.12")]);
    window.history.replaceState(null, "", "/#ssh-hosts");
    const user = userEvent.setup(); render(<Harness initial="ssh-hosts" />);
    await user.click((await screen.findAllByRole("button", { name: `查看 ${long} 的 SSH 托管详情` }))[0]);
    const drawer = screen.getByRole("dialog", { name: long });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getByText("node-b")).toBeInTheDocument();
    expect(within(drawer).getAllByText("198.18.0.12").length).toBeGreaterThan(0);
    expect(within(drawer).queryByText("alpha")).not.toBeInTheDocument();
    expect(within(drawer).getByText("尚未取得，不能确认托管保护")).toBeInTheDocument();
    expect(window.location.hash).toBe("#ssh-host-detail");
    expect(new URLSearchParams(window.location.search).get("sshHost")).toBe("node-b");
  });

  it.each(
    ["ssh", "ssh-hosts"].flatMap((origin) => ["desktop", "mobile"].flatMap((view) =>
      ["close", "escape", "back"].map((exit) => ({ origin, view, exit })))),
  )("restores the $view target by stable ID after $exit from $origin", async ({ origin, view, exit }) => {
    resolveHosts([host("node-a", "alpha"), host("node-b", "beta")]);
    window.history.replaceState(null, "", `/#${origin}`);
    const user = userEvent.setup(); render(<Harness initial={origin} />);
    await screen.findAllByRole("button", { name: "查看 beta 的 SSH 托管详情" });
    const selector = `button[data-ssh-detail-host="node-b"][data-ssh-detail-view="${view}"]`;
    const original = document.querySelector<HTMLButtonElement>(selector)!;
    await user.click(original);
    const dialog = screen.getByRole("dialog", { name: "beta" });
    if (origin === "ssh") expect(original.isConnected).toBe(false);
    if (exit === "close") await user.click(within(dialog).getByRole("button", { name: "关闭 SSH 主机详情" }));
    else if (exit === "escape") await user.keyboard("{Escape}");
    else act(() => window.history.back());
    await waitFor(() => {
      expect(window.location.hash).toBe(`#${origin}`);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const restored = document.querySelector<HTMLButtonElement>(selector);
      expect(restored).toHaveFocus();
      expect(restored).toHaveAttribute("data-ssh-detail-host", "node-b");
    });
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("reconciles details by ID through reorder, background failure and target removal", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchHosts)
      .mockResolvedValueOnce({ collectedAt: stamp, hosts: [host("node-a", "alpha"), host("node-b", "beta", "198.18.0.12")] })
      .mockResolvedValueOnce({ collectedAt: "2026-11-12T06:32:20.000Z", hosts: [host("node-b", "beta-new", "198.18.0.12"), host("node-a", "alpha")] })
      .mockRejectedValueOnce(new Error("Temporary host directory failure"))
      .mockResolvedValueOnce({ collectedAt: "2026-11-12T06:32:40.000Z", hosts: [host("node-a", "alpha")] });
    window.history.replaceState(null, "", "/?sshHost=node-b#ssh-host-detail");
    render(<Harness initial="ssh-host-detail" />);
    await act(async () => undefined);
    expect(screen.getByRole("dialog", { name: "beta" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByRole("dialog", { name: "beta-new" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByRole("dialog", { name: "beta-new" })).toBeInTheDocument();
    expect(notify).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("原目标已不在资源目录，详情已关闭")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "alpha" })).not.toBeInTheDocument();
    expect(fetchHosts).toHaveBeenCalledTimes(4);
  });

  it("offers retry on an initial read failure without inventing hosts", async () => {
    vi.mocked(fetchHosts).mockRejectedValue(new Error("资源目录不可用"));
    window.history.replaceState(null, "", "/#ssh-hosts");
    render(<Harness initial="ssh-hosts" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("资源目录不可用");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByText("production-web-01")).not.toBeInTheDocument();
  });

  it.each(["ssh-complete", "ssh-rollback"])("does not fabricate task outcomes for direct route %s", async (page) => {
    window.history.replaceState(null, "", `/#${page}`);
    render(<Harness initial={page} />);
    expect(screen.getByText(page === "ssh-complete" ? "尚无真实接管完成证据" : "尚无真实回滚任务")).toBeInTheDocument();
    expect(screen.queryByText(/^已托管$|^已恢复$|^接管成功$/)).not.toBeInTheDocument();
    await act(async () => undefined);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("restores route-selected identity on a browser popstate", async () => {
    resolveHosts([host("node-a", "alpha"), host("node-b", "beta")]);
    window.history.replaceState(null, "", "/?sshHost=node-a#ssh-host-detail");
    render(<Harness initial="ssh-host-detail" />);
    expect(await screen.findByRole("dialog", { name: "alpha" })).toBeInTheDocument();
    window.history.replaceState(null, "", "/?sshHost=node-b#ssh-host-detail");
    fireEvent.popState(window);
    expect(await screen.findByRole("dialog", { name: "beta" })).toBeInTheDocument();
  });
});

describe("SSH draft and capability decisions", () => {
  it("never treats local draft completion as an available service", () => {
    expect(sshActionAllowed(SSH_BACKEND_CAPABILITY)).toBe(false);
    expect(sshActionAllowed({ available: true, authorized: false, verifiedEvidence: true })).toBe(false);
    expect(sshActionAllowed({ available: true, authorized: true, verifiedEvidence: false })).toBe(false);
  });
  it("rejects a removed or non-Linux draft target and a rescue lifetime above its ceiling", () => {
    const draft = { ...emptySshDraft("rescue"), hostId: "missing", account: "deploy", operator: "a", purpose: "maintenance", incident: "INC-42", minutes: 480 };
    expect(validateSshDraft(draft, [host("node-a")], "rescue")).toHaveProperty("hostId");
    expect(validateSshDraft(draft, [host("node-a")], "rescue")).toHaveProperty("minutes");
    const nonLinux = { ...host("windows"), platform: "win32" as const };
    expect(validateSshDraft({ ...draft, hostId: "windows", minutes: 15 }, [nonLinux], "rescue")).toHaveProperty("hostId");
  });
});
