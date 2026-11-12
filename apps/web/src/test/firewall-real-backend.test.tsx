import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reauthenticate } from "../api/identityApi";
import { FirewallPage } from "../pages/FirewallPage";

vi.mock("../api/identityApi", () => ({ reauthenticate: vi.fn() }));
const collectedAt = "2026-07-15T12:00:00.000Z";
const rule = { id: "firewall:11111111-1111-4111-8111-111111111111:ipv4", name: "HTTPS 公网访问", port: "443", protocol: "tcp", source: "Anywhere", destination: "Anywhere", action: "allow", direction: "in", ipVersion: "ipv4", managed: true, version: "a".repeat(64) };
const response = { engine: "ufw", host: "host-a", active: true, collectedAt, collectionStatus: "complete", warnings: [], rules: [rule] };
const denyResponse = { collectedAt, collectionStatus: "complete", warnings: [], records: [] };

describe("firewall real backend", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }))); vi.mocked(reauthenticate).mockResolvedValue({ proof: "proof-value-with-more-than-thirty-two-characters", expiresAt: collectedAt }); });
  it.each([
    ["firewall", "防火墙"],
    ["firewall-rules", "规则列表"],
  ])("renders the design heading without redundant context on %s", async (page, title) => {
    const { container } = render(<FirewallPage page={page} notify={vi.fn()} permissions={["firewall:read"]} />);
    await screen.findAllByText("HTTPS 公网访问");
    expect(screen.getByRole("heading", { name: title })).not.toHaveClass("sr-only");
    expect(container.querySelector(".module-head h1:not(.sr-only)")).toBeInTheDocument();
    expect(container.querySelector(".module-view-context")).not.toBeInTheDocument();
  });
  it("loads UFW rules and shows backend freshness", async () => {
    render(<FirewallPage page="firewall" notify={vi.fn()} permissions={["firewall:read"]} />);
    expect(await screen.findAllByText("HTTPS 公网访问")).toHaveLength(2); expect(screen.getByText(/host-a · 采集时间/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增规则" })).not.toBeInTheDocument();
  });
  it("requires password reauthentication before creating a real rule", async () => {
    const user = userEvent.setup(); render(<FirewallPage page="firewall" notify={vi.fn()} permissions={["firewall:read", "firewall:operate"]} />); await screen.findAllByText("HTTPS 公网访问");
    await user.click(screen.getByRole("button", { name: "新增规则" })); const dialog = screen.getByRole("dialog", { name: "新增放行规则" });
    await user.type(within(dialog).getByLabelText("端口"), "8443"); await user.clear(within(dialog).getByLabelText("来源")); await user.type(within(dialog).getByLabelText("来源"), "10.0.0.0/8");
    await user.type(within(dialog).getByLabelText("当前密码"), "current-password"); await user.click(within(dialog).getByRole("button", { name: "保存规则" }));
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledWith("current-password"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/firewall/rules", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Reauth-Proof": expect.any(String) }) })));
  });
  it("loads real deny records without rendering fixture rows", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(denyResponse), { status: 200 }));
    render(<FirewallPage page="firewall-deny" notify={vi.fn()} permissions={["firewall:read"]} />);
    expect(await screen.findByText(/数据来自 Agent 的只读内核防火墙日志/)).toBeInTheDocument();
    expect(screen.getAllByText(/没有匹配的真实拦截记录/)).toHaveLength(2);
    expect(screen.queryByText("198.51.100.24")).not.toBeInTheDocument();
  });
});
