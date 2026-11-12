import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCertificateRenewal, fetchCertificateRenewal, fetchSites } from "../api/sitesApi";
import type { CertificateRenewalBatch, SiteRuntimePayload, SiteRuntimeRecord } from "../api/sitesApi";
import { reauthenticate } from "../api/identityApi";
import { SitesPage } from "../pages/SitesPage";

vi.mock("../api/sitesApi", () => ({ fetchSites: vi.fn(), createCertificateRenewal: vi.fn(), fetchCertificateRenewal: vi.fn() }));
vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));

const collectedAt = "2026-07-13T12:30:00.000Z";

function site(overrides: Partial<SiteRuntimeRecord> = {}): SiteRuntimeRecord {
  return {
    id: "site-api",
    domain: "api.example.com",
    status: "running",
    runtime: "反向代理",
    host: "controller-01",
    upstream: "http://127.0.0.1:3000",
    source: "Nginx · api.conf",
    latencyMs: 38,
    trafficBytes: null,
    errorRatePercent: null,
    lastDeployAt: null,
    manageability: "monitored",
    managementReason: null,
    protected: false,
    version: 1,
    desiredState: null,
    nodeId: "node-local",
    collectedAt,
    freshness: "current",
    certificate: {
      status: "valid",
      notBefore: "2026-06-10T00:00:00.000Z",
      expiresAt: "2026-09-10T00:00:00.000Z",
      issuer: "Let's Encrypt",
      subjectAlternativeNames: ["api.example.com"],
      fingerprintSha256: "A".repeat(64),
      renewalMode: "automatic",
      renewable: true,
      unavailableReason: null,
      certificateId: "cert_api_example",
    },
    renewal: { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null },
    ...overrides,
  };
}

function payload(sites: SiteRuntimeRecord[], overrides: Partial<SiteRuntimePayload> = {}): SiteRuntimePayload {
  return { collectedAt, collectionStatus: "complete", warnings: [], sites, ...overrides };
}

describe("sites live monitoring page", () => {
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockClear();
    vi.mocked(fetchSites).mockReset();
    vi.mocked(createCertificateRenewal).mockReset();
    vi.mocked(fetchCertificateRenewal).mockReset();
    vi.mocked(reauthenticate).mockReset();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("keeps view filters separate when navigating between inventory and running sites", async () => {
    vi.mocked(fetchSites).mockResolvedValue(payload([site(), site({ id: "stopped", domain: "stopped.example.com", status: "stopped" })]));
    const { rerender } = render(<SitesPage page="sites" notify={notify} />);
    await screen.findAllByTitle("stopped.example.com");
    fireEvent.change(screen.getByPlaceholderText("搜索域名、上游、主机或数据源"), { target: { value: "stopped" } });
    rerender(<SitesPage page="sites-running" notify={notify} />);
    expect(screen.getByPlaceholderText("搜索域名、上游、主机或数据源")).toHaveValue("");
    expect(screen.queryByTitle("stopped.example.com")).not.toBeInTheDocument();
    expect(screen.getAllByTitle("api.example.com").length).toBeGreaterThan(0);
    rerender(<SitesPage page="sites" notify={notify} />);
    expect(screen.getByPlaceholderText("搜索域名、上游、主机或数据源")).toHaveValue("stopped");
  });

  it.each([
    ["sites-running", "运行中站点"],
    ["sites-runtime", "服务分组"],
  ] as const)("shows the CloudPulse heading and summary from %s", async (page, title) => {
    vi.mocked(fetchSites).mockResolvedValue(payload([site()]));
    const { container } = render(<SitesPage page={page} notify={notify} />);

    if (page === "sites-runtime") {
      await screen.findByRole("button", { name: "查看 反向代理 服务详情" });
    } else {
      await screen.findAllByTitle("api.example.com");
    }

    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(screen.queryByText("正在加载已保存的站点快照")).not.toBeInTheDocument();
  });

  it("shows the certificate heading and summary while retaining its action", async () => {
    vi.mocked(fetchSites).mockResolvedValue(payload([site()]));
    const { container } = render(<SitesPage page="sites-cert" notify={notify} />);

    await screen.findAllByTitle("api.example.com");

    expect(container.querySelector(".module-head > div:first-child")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "证书续期" })).not.toHaveClass("sr-only");
    expect(screen.queryByText("正在加载已保存的证书快照")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量续期" })).toBeInTheDocument();
  });

  it("shows an initial error and retries without falling back to demo sites", async () => {
    vi.mocked(fetchSites)
      .mockRejectedValueOnce(new Error("站点采集不可用"))
      .mockResolvedValueOnce(payload([site()]));

    render(<SitesPage page="sites" notify={notify} />);
    expect(await screen.findByText("站点采集不可用")).toBeInTheDocument();
    expect(screen.queryByText("实时采集失败，未显示示例站点")).not.toBeInTheDocument();
    expect(screen.queryByText("站点资产清单")).not.toBeInTheDocument();
    expect(screen.queryByText("api.stackpilot.local")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect((await screen.findAllByTitle("api.example.com")).length).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("polls every ten seconds, keeps filters, and retains data after a background failure", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSites)
      .mockResolvedValueOnce(payload([site(), site({ id: "site-admin", domain: "admin.example.com" })]))
      .mockResolvedValueOnce(payload([site({ latencyMs: 64 }), site({ id: "site-admin", domain: "admin.example.com" })], { collectedAt: "2026-07-13T12:30:10.000Z" }))
      .mockRejectedValueOnce(new Error("瞬时失败"));

    render(<SitesPage page="sites-running" notify={notify} />);
    await act(async () => undefined);
    const search = screen.getByPlaceholderText("搜索域名、上游、主机或数据源");
    fireEvent.change(search, { target: { value: "api.example.com" } });
    expect(screen.queryByTitle("admin.example.com")).not.toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchSites).toHaveBeenCalledTimes(2);
    expect(search).toHaveValue("api.example.com");
    expect(screen.getAllByText("64ms").length).toBeGreaterThan(0);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchSites).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText("64ms").length).toBeGreaterThan(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("shows backend freshness and labels unknown or missing measurements as unavailable", async () => {
    vi.mocked(fetchSites).mockResolvedValue(payload([site({
      status: "unknown",
      upstream: null,
      latencyMs: null,
      certificate: {
        status: "unavailable", notBefore: null, expiresAt: null, issuer: null,
        subjectAlternativeNames: [], fingerprintSha256: null, renewalMode: "unsupported",
        renewable: false, unavailableReason: "站点未启用 TLS", certificateId: null,
      },
      trafficBytes: null,
    })], { collectionStatus: "partial", warnings: ["证书探测不完整"] }));

    render(<SitesPage page="sites" notify={notify} />);
    expect((await screen.findAllByText("待采集")).length).toBeGreaterThan(0);
    expect(screen.getByText(/部分采集 · 后端采集于/)).toBeInTheDocument();
    expect(screen.getByText(/证书探测不完整/)).toBeInTheDocument();
    expect(screen.getAllByText("暂不可用").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /刷新|添加|启动|停止|续期/ })).not.toBeInTheDocument();
  });

  it("keeps an unknown site reported by a remote agent visible on the running page", async () => {
    vi.mocked(fetchSites).mockResolvedValue(payload([
      site(),
      site({
        id: "site-agent-unknown",
        domain: "agent-pending.example.com",
        status: "unknown",
        host: "edge-node-01",
        source: "Agent · edge-node-01",
        nodeId: "node-edge-01",
        latencyMs: null,
      }),
    ]));

    render(<SitesPage page="sites-running" notify={notify} />);
    expect((await screen.findAllByTitle("agent-pending.example.com")).length).toBeGreaterThan(0);
    expect(screen.getByText("已发现站点")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: /状态 活跃/ }));
    fireEvent.click(screen.getByRole("option", { name: "待采集" }));
    expect(screen.getAllByTitle("agent-pending.example.com").length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle("api.example.com")).toHaveLength(0);
  });

  it("derives an open runtime detail from the latest polling snapshot", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSites)
      .mockResolvedValueOnce(payload([site()]))
      .mockResolvedValueOnce(payload([site({ latencyMs: 91, source: "Nginx · refreshed.conf" })], { collectedAt: "2026-07-13T12:30:10.000Z" }))
      .mockResolvedValueOnce(payload([], { collectedAt: "2026-07-13T12:30:20.000Z" }));

    render(<SitesPage page="sites-runtime" notify={notify} />);
    await act(async () => undefined);
    expect(screen.queryByText("服务容量视图")).not.toBeInTheDocument();
    expect(screen.queryByText(/数据来源：/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 反向代理 服务详情" }));
    const drawer = screen.getByRole("region", { name: "反向代理" });
    expect(drawer.parentElement).toBe(document.body);
    expect(within(drawer).getAllByText(/38ms/).length).toBeGreaterThan(0);

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(within(drawer).getAllByText(/91ms/).length).toBeGreaterThan(0);
    expect(within(drawer).getByText(/refreshed\.conf/)).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.queryByRole("region", { name: "反向代理" })).not.toBeInTheDocument();
  });

  it("pauses polling while hidden and refreshes immediately when visible again", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchSites).mockResolvedValue(payload([site()]));
    render(<SitesPage page="sites" notify={notify} />);
    await act(async () => undefined);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(fetchSites).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    expect(fetchSites).toHaveBeenCalledTimes(2);
  });

  it("keeps certificate detail bound to stable site id across refresh and closes it when removed", async () => {
    vi.useFakeTimers();
    const due = site({ certificate: { ...site().certificate, status: "critical", expiresAt: "2026-07-18T00:00:00.000Z" } });
    vi.mocked(fetchSites)
      .mockResolvedValueOnce(payload([due]))
      .mockResolvedValueOnce(payload([{ ...due, certificate: { ...due.certificate, issuer: "Let's Encrypt R12" } }], { collectedAt: "2026-07-13T12:30:10.000Z" }))
      .mockResolvedValueOnce(payload([], { collectedAt: "2026-07-13T12:30:20.000Z" }));

    render(<SitesPage page="sites-cert" notify={notify} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "查看 api.example.com 证书详情" }));
    const drawer = screen.getByRole("region", { name: "api.example.com" });
    expect(within(drawer).getByText("Let's Encrypt")).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(within(drawer).getByText("Let's Encrypt R12")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.queryByRole("region", { name: "api.example.com" })).not.toBeInTheDocument();
  });

  it("submits one renewal with one-time reauth and keeps the backend expiry unchanged", async () => {
    const due = site({ certificate: { ...site().certificate, status: "critical", expiresAt: "2026-07-18T00:00:00.000Z" } });
    const queued = renewalBatch("queued", [due.id]);
    vi.mocked(fetchSites).mockResolvedValue(payload([due]));
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "proof-value-with-more-than-thirty-two-characters", expiresAt: "2026-07-13T12:35:00.000Z" });
    vi.mocked(createCertificateRenewal).mockResolvedValue(queued);

    render(<SitesPage page="sites-cert" notify={notify} />);
    fireEvent.click(await screen.findByRole("button", { name: "续期 api.example.com 证书" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认证书续期" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "correct-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认续期" }));

    await screen.findByText("续期批次：排队中");
    expect(reauthenticate).toHaveBeenCalledWith("correct-password");
    expect(createCertificateRenewal).toHaveBeenCalledWith(expect.objectContaining({ siteIds: [due.id] }), "proof-value-with-more-than-thirty-two-characters");
    expect(screen.getAllByText("5 天").length).toBeGreaterThan(0);
  });

  it("bulk renewal ignores active filters and reports executable and skipped counts", async () => {
    const renewable = site({ id: "site-renewable", domain: "renew.example.com", certificate: { ...site().certificate, status: "expiring", expiresAt: "2026-07-24T00:00:00.000Z" } });
    const skipped = site({ id: "site-not-renewable", domain: "skip.example.com", certificate: { ...site().certificate, status: "critical", expiresAt: "2026-07-18T00:00:00.000Z", renewable: false, certificateId: null, renewalMode: "manual", unavailableReason: "节点未授权" } });
    vi.mocked(fetchSites).mockResolvedValue(payload([renewable, skipped]));

    render(<SitesPage page="sites-cert" notify={notify} />);
    const search = await screen.findByPlaceholderText("搜索域名、节点、主机或签发方");
    fireEvent.change(search, { target: { value: "skip.example.com" } });
    expect(screen.queryByTitle("renew.example.com")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批量续期" }));

    const dialog = screen.getByRole("alertdialog", { name: "确认批量续期" });
    expect(within(dialog).getByText(/执行 1 个站点，跳过 1 个站点/)).toBeInTheDocument();
  });

  it("keeps the certificate page read-only without sites renew permission", async () => {
    const due = site({ certificate: { ...site().certificate, status: "critical", expiresAt: "2026-07-18T00:00:00.000Z" } });
    vi.mocked(fetchSites).mockResolvedValue(payload([due]));

    render(<SitesPage page="sites-cert" notify={notify} permissions={["sites:read"]} />);
    expect(await screen.findByRole("button", { name: "查看 api.example.com 证书详情" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /续期/ })).not.toBeInTheDocument();
  });
});

function renewalBatch(status: CertificateRenewalBatch["status"], siteIds: string[]): CertificateRenewalBatch {
  return {
    batchId: "9e83bbd0-9399-46ed-80a4-a36752cbb86b",
    status,
    createdAt: collectedAt,
    updatedAt: collectedAt,
    operations: [{
      siteIds, nodeId: "node-local", certificateId: "cert_api_example",
      taskId: "751392f5-6bb8-4f39-a43a-8351081f13d5", status: status === "partially_succeeded" ? "failed" : status,
      message: null, updatedAt: collectedAt,
    }],
  };
}
