import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { DeploymentPayload } from "@stackpilot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDeployments } from "../api/deploymentsApi";
import { DeployPage } from "../pages/DeployPage";

vi.mock("../api/deploymentsApi", () => ({ fetchDeployments: vi.fn() }));

const now = "2026-07-15T00:00:00.000Z";
const payload: DeploymentPayload = {
  collectedAt: now,
  deployments: [{
    id: "11111111-1111-4111-8111-111111111111", planId: "22222222-2222-4222-8222-222222222222",
    operationId: "11111111-1111-4111-8111-111111111111", nodeId: "node-production-long-name-01", siteId: "site-production-01",
    domains: ["stackpilot.example.com"], repositoryUrl: "https://github.com/example/stackpilot.git", repositoryRef: "main",
    environment: "production", certificateEnvironment: "production", runtime: "node22", healthCheckPath: "/healthz",
    status: "succeeded", stage: "complete", progressPercent: 100, errorCode: null, releaseId: "release_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    operator: "管理员", createdAt: now, updatedAt: now,
  }],
  releases: [{ releaseId: "release_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", siteId: "site-production-01", planId: "22222222-2222-4222-8222-222222222222", nodeId: "node-production-long-name-01", domains: ["stackpilot.example.com"], repositoryRef: "main", environment: "production", status: "active", createdAt: now, activatedAt: now }],
};

describe("real deployment page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.mocked(fetchDeployments).mockResolvedValue(payload);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["deploy", "部署"],
    ["deploy-prod", "生产发布"],
    ["deploy-staging", "预发环境"],
  ])("shows the CloudPulse heading and preserves freshness on %s", async (page, title) => {
    const { container } = render(<DeployPage page={page} permissions={["sites:read"]} />);
    await screen.findByText(/后端采集于/);
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
    expect(container.querySelector(".module-freshness-note")).toHaveTextContent("后端采集于");
  });

  it("renders backend deployments and opens stable-id details without mock actions", async () => {
    render(<DeployPage page="deploy-prod" permissions={["sites:read", "sites:deploy"]} />);
    expect((await screen.findAllByText("stackpilot.example.com")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("release_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "完成" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回滚" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 stackpilot.example.com 发布详情" }));
    const dialog = screen.getByRole("dialog", { name: "发布详情" });
    expect(within(dialog).getByText("node-production-long-name-01")).toBeInTheDocument();
    expect(within(dialog).getByText("https://github.com/example/stackpilot.git")).toBeInTheDocument();
  });

  it("shows all environments on the parent deployment route", async () => {
    render(<DeployPage page="deploy" permissions={["sites:read"]} />);
    expect(await screen.findByRole("button", { name: "全部" })).toHaveClass("active");
  });

  it("searches real records across environments on the parent route", async () => {
    const staging = { ...payload.deployments[0]!, id: "77777777-7777-4777-8777-777777777777", planId: "88888888-8888-4888-8888-888888888888", environment: "staging" as const, domains: ["staging.example.com"] };
    vi.mocked(fetchDeployments).mockResolvedValueOnce({ ...payload, deployments: [...payload.deployments, staging] });
    render(<DeployPage page="deploy" permissions={["sites:read"]} />);
    const table = await screen.findByRole("table");
    expect(await within(table).findByText("stackpilot.example.com")).toBeInTheDocument();
    expect(within(table).getByText("staging.example.com")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索项目、节点、版本或操作人"), { target: { value: "staging.example.com" } });
    expect(within(table).queryByText("stackpilot.example.com")).not.toBeInTheDocument();
    expect(within(table).getByText("staging.example.com")).toBeInTheDocument();
  });

  it("synchronizes the environment filter when the route changes", async () => {
    const view = render(<DeployPage page="deploy-prod" permissions={["sites:read"]} />);
    expect(await screen.findByRole("button", { name: "生产" })).toHaveClass("active");
    view.rerender(<DeployPage page="deploy-staging" permissions={["sites:read"]} />);
    await act(async () => Promise.resolve());
    expect(screen.getByRole("button", { name: "预发" })).toHaveClass("active");
  });

  it("polls every ten seconds and preserves the selected record", async () => {
    vi.useFakeTimers();
    render(<DeployPage page="deploy-prod" permissions={["sites:read"]} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "查看 stackpilot.example.com 发布详情" }));
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchDeployments).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "发布详情" })).toBeInTheDocument();
  });

  it("preserves deployment details by plan id when the current operation changes", async () => {
    const refreshed = structuredClone(payload);
    refreshed.deployments[0].id = "33333333-3333-4333-8333-333333333333";
    refreshed.deployments[0].operationId = refreshed.deployments[0].id;
    vi.mocked(fetchDeployments).mockResolvedValueOnce(payload).mockResolvedValue(refreshed);
    vi.useFakeTimers();
    render(<DeployPage page="deploy-prod" permissions={["sites:read"]} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "查看 stackpilot.example.com 发布详情" }));
    await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(screen.getByRole("dialog", { name: "发布详情" })).toBeInTheDocument();
  });

  it("shows a retryable initial error and no fixtures", async () => {
    vi.mocked(fetchDeployments).mockRejectedValueOnce(new Error("deployment api offline")).mockResolvedValue(payload);
    render(<DeployPage page="deploy-prod" permissions={["sites:read"]} />);
    expect(await screen.findByText("deployment api offline")).toBeInTheDocument();
    expect(screen.queryByText("shop-web")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect((await screen.findAllByText("stackpilot.example.com")).length).toBeGreaterThan(0);
  });

  it("blocks accounts without sites read permission", () => {
    render(<DeployPage page="deploy-prod" permissions={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("没有站点读取权限");
    expect(fetchDeployments).not.toHaveBeenCalled();
  });
});
