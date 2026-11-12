import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentNodes } from "../api/agentApi";
import { reauthenticate } from "../api/identityApi";
import { createSitePlan, fetchSiteOperation, fetchSites, querySiteLogs, updateSiteLifecycle } from "../api/sitesApi";
import type { SiteOperation, SitePlan, SiteRuntimePayload } from "../api/sitesApi";
import { SitesPage } from "../pages/SitesPage";

vi.mock("../api/agentApi", () => ({ listAgentNodes: vi.fn() }));
vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));
vi.mock("../api/sitesApi", () => ({
  activateSitePlan: vi.fn(), createSitePlan: vi.fn(), fetchSiteOperation: vi.fn(), fetchSites: vi.fn(),
  querySiteLogs: vi.fn(), updateSiteLifecycle: vi.fn(),
}));

const now = "2026-07-14T00:00:00.000Z";
const operationId = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const nodeId = "node-example-01";

function operation(overrides: Partial<SiteOperation> = {}): SiteOperation {
  return {
    operationId, taskId: null, type: "prepare", nodeId, siteId: null, planId, rollback: null, status: "queued",
    stage: "awaiting_executor", progressPercent: 0, result: null, errorCode: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function plan(): SitePlan {
  return {
    planId, nodeId, domains: ["app.example.com"], repositoryUrl: "https://github.com/example/site.git",
    repositoryRef: "main", deploymentEnvironment: "production", certificateEnvironment: "staging", environmentVariableNames: [], operator: "管理员", status: "queued",
    digest: "a".repeat(64), version: 1, preview: null, operationId, createdAt: now, updatedAt: now,
    expiresAt: "2026-07-14T00:30:00.000Z",
  };
}

function sites(): SiteRuntimePayload {
  return {
    collectedAt: now, collectionStatus: "complete", warnings: [], sites: [{
      id: "site-example-01", domain: "app.example.com", status: "running", runtime: "Node.js", host: "host-example-01",
      upstream: "http://127.0.0.1:3000", source: "Nginx", latencyMs: 24, trafficBytes: 1024,
      errorRatePercent: 0, lastDeployAt: now, manageability: "managed", managementReason: null, protected: false,
      version: 3, desiredState: "running", nodeId, collectedAt: now, freshness: "current",
      certificate: { status: "valid", notBefore: now, expiresAt: "2026-10-01T00:00:00.000Z", issuer: "Example CA", subjectAlternativeNames: ["app.example.com"], fingerprintSha256: null, renewalMode: "automatic", renewable: true, unavailableReason: null, certificateId: "cert-example-01" },
      renewal: { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null },
    }],
  };
}

describe("site management UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.mocked(fetchSites).mockResolvedValue(sites());
    vi.mocked(reauthenticate).mockResolvedValue({ proof: "proof-value-with-more-than-thirty-two-characters", expiresAt: "2026-07-14T00:05:00.000Z" });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("hides deploy, log and lifecycle commands without their permissions", async () => {
    render(<SitesPage page="sites-create" notify={vi.fn()} permissions={["sites:read"]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("没有站点部署权限");

    render(<SitesPage page="sites-running" notify={vi.fn()} permissions={["sites:read"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 app.example.com 站点操作" }));
    const drawer = screen.getByRole("region", { name: "app.example.com" });
    expect(within(drawer).queryByRole("button", { name: "日志" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: "软删除" })).not.toBeInTheDocument();
  });

  it("removes the inventory summary from the default sites page", async () => {
    const { container } = render(<SitesPage page="sites" notify={vi.fn()} permissions={["sites:read"]} />);

    await act(async () => Promise.resolve());

    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.queryByText("站点资产清单")).not.toBeInTheDocument();
    expect(screen.queryByText(/总数 \d+ 个/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "网站" })).not.toHaveClass("sr-only");
  });

  it("shows the CloudPulse heading from the site deployment page", async () => {
    vi.mocked(listAgentNodes).mockResolvedValue({ nodes: [] });
    const { container } = render(<SitesPage page="sites-create" notify={vi.fn()} permissions={["sites:read", "sites:deploy", "nodes:read"]} />);

    await act(async () => Promise.resolve());

    expect(container.querySelector(".page-head")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "部署站点" })).not.toHaveClass("sr-only");
    expect(screen.getByText("生产先预检再确认上线；预发仅构建和预检，不切换生产流量。")).toBeInTheDocument();
  });

  it("turns a successful preparation result into an activatable plan", async () => {
    vi.useFakeTimers();
    vi.mocked(listAgentNodes).mockResolvedValue({ nodes: [{
      nodeId, nodeName: "host-example-01", status: "online", agentVersion: "0.2.0", protocolVersion: "1.0",
      platform: "linux", declaredCapabilities: ["sites.deploy"], allowedCapabilities: ["sites.deploy"],
      enrolledAt: now, lastSeenAt: now, revokedAt: null,
    }] });
    vi.mocked(createSitePlan).mockResolvedValue(plan());
    vi.mocked(fetchSiteOperation).mockResolvedValue(operation({
      status: "succeeded", stage: "complete", progressPercent: 100,
      result: { message: null, siteId: null, releaseId: null, stagingId: "staging-example-01", desiredState: null, siteVersion: null, certificateRenewalBatchId: null, planPreview: { runtime: "static", healthCheckPath: "/health", changes: ["repository", "nginx"] }, logs: [] },
    }));

    render(<SitesPage page="sites-create" notify={vi.fn()} permissions={["sites:read", "sites:deploy", "nodes:read"]} />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText("域名"), { target: { value: "app.example.com" } });
    fireEvent.change(screen.getByLabelText("仓库地址"), { target: { value: "https://github.com/example/site.git" } });
    fireEvent.change(screen.getByLabelText("证书邮箱"), { target: { value: "ops@example.com" } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并预检" }));
    await act(async () => Promise.resolve());
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });

    expect(fetchSiteOperation).toHaveBeenCalledTimes(1);
    expect(screen.getByText("/health")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认摘要并上线" })).toBeDisabled();
  });

  it("keeps a staging plan on the real preparation path without exposing production activation", async () => {
    vi.useFakeTimers();
    vi.mocked(listAgentNodes).mockResolvedValue({ nodes: [{
      nodeId, nodeName: "host-example-01", status: "online", agentVersion: "0.2.0", protocolVersion: "1.0",
      platform: "linux", declaredCapabilities: ["sites.deploy"], allowedCapabilities: ["sites.deploy"],
      enrolledAt: now, lastSeenAt: now, revokedAt: null,
    }] });
    vi.mocked(createSitePlan).mockImplementation(async (input) => ({ ...plan(), deploymentEnvironment: input.deploymentEnvironment }));
    vi.mocked(fetchSiteOperation).mockResolvedValue(operation({
      status: "succeeded", stage: "complete", progressPercent: 100,
      result: { message: null, siteId: null, releaseId: null, stagingId: "staging-example-01", desiredState: null, siteVersion: null, certificateRenewalBatchId: null, planPreview: { runtime: "static", healthCheckPath: "/health", changes: ["repository", "nginx"] }, logs: [] },
    }));

    render(<SitesPage page="sites-create" notify={vi.fn()} permissions={["sites:read", "sites:deploy", "nodes:read"]} />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText("域名"), { target: { value: "app.example.com" } });
    fireEvent.change(screen.getByLabelText("仓库地址"), { target: { value: "https://github.com/example/site.git" } });
    fireEvent.click(screen.getByRole("combobox", { name: /发布环境/ }));
    fireEvent.click(screen.getByRole("option", { name: "预发" }));
    fireEvent.change(screen.getByLabelText("证书邮箱"), { target: { value: "ops@example.com" } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并预检" }));
    await act(async () => Promise.resolve());
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });

    expect(createSitePlan).toHaveBeenCalledWith(expect.objectContaining({ deploymentEnvironment: "staging" }), expect.any(String));
    expect(screen.getByText("预发构建与预检已完成，不会切换生产流量。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认摘要并上线" })).not.toBeInTheDocument();
  });

  it("keeps environment values in memory and sends names only to the public summary", async () => {
    vi.mocked(listAgentNodes).mockResolvedValue({ nodes: [{
      nodeId, nodeName: "host-example-01", status: "online", agentVersion: "0.2.0", protocolVersion: "1.0",
      platform: "linux", declaredCapabilities: ["sites.deploy"], allowedCapabilities: ["sites.deploy"],
      enrolledAt: now, lastSeenAt: now, revokedAt: null,
    }] });
    vi.mocked(createSitePlan).mockImplementation(async (input) => ({ ...plan(), environmentVariableNames: input.environmentVariables.map((entry) => entry.name) }));
    render(<SitesPage page="sites-create" notify={vi.fn()} permissions={["sites:read", "sites:deploy", "nodes:read"]} />);
    await act(async () => Promise.resolve());
    fireEvent.change(screen.getByLabelText("域名"), { target: { value: "app.example.com" } });
    fireEvent.change(screen.getByLabelText("仓库地址"), { target: { value: "https://github.com/example/site.git" } });
    fireEvent.change(screen.getByLabelText("证书邮箱"), { target: { value: "ops@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
    fireEvent.change(screen.getByLabelText("环境变量 1 名称"), { target: { value: "api_token" } });
    fireEvent.change(screen.getByLabelText("环境变量 1 值"), { target: { value: "secret-value" } });
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并预检" }));
    await act(async () => Promise.resolve());
    expect(createSitePlan).toHaveBeenCalledWith(expect.objectContaining({ environmentVariables: [{ name: "API_TOKEN", value: "secret-value" }] }), expect.any(String));
    expect(screen.getByText("API_TOKEN")).toBeInTheDocument();
    expect(screen.queryByText("secret-value")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新填写" })).not.toBeInTheDocument();
  });

  it("shows structured logs returned by the asynchronous operation", async () => {
    vi.useFakeTimers();
    vi.mocked(querySiteLogs).mockResolvedValue(operation({ type: "log_query", planId: null, siteId: "site-example-01" }));
    vi.mocked(fetchSiteOperation).mockResolvedValue(operation({
      type: "log_query", planId: null, siteId: "site-example-01", status: "succeeded", stage: "complete", progressPercent: 100,
      result: { message: null, siteId: "site-example-01", releaseId: null, stagingId: null, desiredState: null, siteVersion: null, certificateRenewalBatchId: null, planPreview: null, logs: [{ timestamp: now, method: "GET", path: "/health", status: 200, bytesSent: 12, clientAddressMasked: "client_abcdef123456" }] },
    }));
    render(<SitesPage page="sites-running" notify={vi.fn()} permissions={["sites:read", "sites:logs"]} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "查看 app.example.com 站点操作" }));
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    await act(async () => Promise.resolve());
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByText("GET /health")).toBeInTheDocument();
    expect(screen.getByText(/client_abcdef123456/)).toBeInTheDocument();
  });

  it("shows an explicit empty state for a successful empty log query", async () => {
    vi.useFakeTimers();
    vi.mocked(querySiteLogs).mockResolvedValue(operation({ type: "log_query", planId: null, siteId: "site-example-01" }));
    vi.mocked(fetchSiteOperation).mockResolvedValue(operation({
      type: "log_query", planId: null, siteId: "site-example-01", status: "succeeded", stage: "complete", progressPercent: 100,
      result: { message: null, siteId: "site-example-01", releaseId: null, stagingId: null, desiredState: null, siteVersion: null, certificateRenewalBatchId: null, planPreview: null, logs: [] },
    }));
    render(<SitesPage page="sites-running" notify={vi.fn()} permissions={["sites:read", "sites:logs"]} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "查看 app.example.com 站点操作" }));
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    await act(async () => Promise.resolve());
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByText("当前查询范围内没有访问日志")).toBeInTheDocument();
  });

  it("continues polling after a transient failure and refreshes lifecycle state only after success", async () => {
    vi.useFakeTimers();
    vi.mocked(updateSiteLifecycle).mockResolvedValue(operation({ type: "lifecycle", planId: null, siteId: "site-example-01", stage: "lifecycle_stopped" }));
    vi.mocked(fetchSiteOperation).mockRejectedValueOnce(new Error("临时网络错误")).mockResolvedValueOnce(operation({
      type: "lifecycle", planId: null, siteId: "site-example-01", status: "succeeded", stage: "complete", progressPercent: 100,
      result: { message: null, siteId: "site-example-01", releaseId: null, stagingId: null, desiredState: "stopped", siteVersion: null, certificateRenewalBatchId: null, planPreview: null, logs: [] },
    }));
    render(<SitesPage page="sites-running" notify={vi.fn()} permissions={["sites:read", "sites:operate"]} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "查看 app.example.com 站点操作" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    const dialog = screen.getByRole("alertdialog", { name: "停止站点" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "correct-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "停止" }));
    await act(async () => Promise.resolve());
    expect(fetchSites).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByText("临时网络错误")).toBeInTheDocument();
    expect(fetchSites).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchSiteOperation).toHaveBeenCalledTimes(2);
    expect(fetchSites).toHaveBeenCalledTimes(4);
  });

  it("pauses operation polling while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    vi.mocked(querySiteLogs).mockResolvedValue(operation({ type: "log_query", planId: null, siteId: "site-example-01" }));
    vi.mocked(fetchSiteOperation).mockResolvedValue(operation({ type: "log_query", planId: null, siteId: "site-example-01" }));
    render(<SitesPage page="sites-running" notify={vi.fn()} permissions={["sites:read", "sites:logs"]} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "查看 app.example.com 站点操作" }));
    fireEvent.click(screen.getByRole("button", { name: "日志" }));
    await act(async () => Promise.resolve());
    hidden = true; fireEvent(document, new Event("visibilitychange"));
    await act(async () => { vi.advanceTimersByTime(20_000); await Promise.resolve(); });
    expect(fetchSiteOperation).not.toHaveBeenCalled();
    hidden = false; fireEvent(document, new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(fetchSiteOperation).toHaveBeenCalledTimes(1);
  });

  it("never fakes a failed lifecycle mutation", async () => {
    vi.mocked(updateSiteLifecycle).mockRejectedValue(new Error("节点拒绝操作"));
    render(<SitesPage page="sites-running" notify={vi.fn()} permissions={["sites:read", "sites:operate"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 app.example.com 站点操作" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    const dialog = screen.getByRole("alertdialog", { name: "停止站点" });
    fireEvent.change(within(dialog).getByLabelText("当前密码"), { target: { value: "correct-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "停止" }));
    expect(await screen.findByText("节点拒绝操作")).toBeInTheDocument();
    expect(fetchSites).toHaveBeenCalledTimes(1);
    expect(screen.getByText("running")).toBeInTheDocument();
  });
});
