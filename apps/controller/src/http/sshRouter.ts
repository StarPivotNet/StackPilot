import { SshIssueRequestSchema, SshPolicyInputSchema, SshWorkspaceSchema } from "@stackpilot/contracts";
import type { RequestContext } from "./types.js";
import { sendJson } from "./response/json.js";
import { parseSchema } from "./validation.js";
import { ServiceError } from "../modules/serviceError.js";

export function routeSshRequest(context: RequestContext) {
  const { identity, principal, services, request, response, parts } = context;
  if (!identity || !principal || !services.ssh) throw new ServiceError(503, "NOT_READY", "SSH 存储不可用");
  response.setHeader("Cache-Control", "no-store");
  const method = request.method ?? "GET";
  if (method === "GET" && parts.length === 3 && ["workspace", "hosts", "policies", "credentials", "sessions"].includes(parts[2] ?? "")) {
    identity.require(principal, "ssh:read");
    const workspace = services.ssh.list(principal);
    if (parts[2] === "workspace") sendJson(response, 200, workspace, SshWorkspaceSchema);
    else { const name = parts[2] as "hosts" | "policies" | "credentials" | "sessions"; sendJson(response, 200, { [name]: workspace[name], collectedAt: workspace.collectedAt }); }
    return;
  }
  const reauth = () => identity.consumeReauth(principal, typeof request.headers["x-reauth-proof"] === "string" ? request.headers["x-reauth-proof"] : undefined);
  if (method === "POST" && parts.length === 3 && parts[2] === "policies") {
    const input = parseSchema(SshPolicyInputSchema, context.body, "SSH 授权");
    identity.require(principal, "ssh:manage", input.nodeId); reauth();
    sendJson(response, 201, services.ssh.upsertPolicy(principal, input)); return;
  }
  if (method === "POST" && parts.length === 3 && parts[2] === "credentials") {
    const input = parseSchema(SshIssueRequestSchema, context.body, "SSH 临时密码申请");
    identity.require(principal, "ssh:connect", input.nodeId); reauth();
    sendJson(response, 201, services.ssh.issue(principal, input)); return;
  }
  if (method === "POST" && parts.length === 5 && parts[2] === "credentials" && parts[4] === "revoke") {
    identity.require(principal, "ssh:connect"); reauth();
    sendJson(response, 202, services.ssh.revoke(principal, parts[3]!)); return;
  }
  if (method === "POST" && parts.length === 5 && parts[2] === "sessions" && parts[4] === "terminate") {
    identity.require(principal, "ssh:sessions:terminate"); reauth();
    sendJson(response, 202, services.ssh.terminate(principal, parts[3]!)); return;
  }
  if (method === "POST" && parts[2] === "takeover-plans") {
    identity.require(principal, "ssh:manage");
    throw new ServiceError(503, "NOT_READY", "原生 PAM、主机会话执行器和独立 SSH 验证尚未完成，禁止切换 SSH 认证");
  }
  throw new ServiceError(404, "NOT_FOUND", "SSH 接口不存在");
}
