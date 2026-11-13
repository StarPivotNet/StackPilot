import { SshHelperEnrollmentInputSchema, SshIssueRequestSchema, SshPolicyInputSchema, SshWorkspaceSchema, SshTakeoverInputSchema } from "@stackpilot/contracts";
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
  if (method === "POST" && parts.length === 3 && parts[2] === "helper-enrollments") {
    const input = parseSchema(SshHelperEnrollmentInputSchema, context.body, "SSH helper 注册授权");
    identity.require(principal, "ssh:manage", input.nodeId); reauth();
    if (!services.sshHelpers) throw new ServiceError(503, "NOT_READY", "SSH helper 身份服务不可用");
    sendJson(response, 201, services.sshHelpers.createEnrollment(input.nodeId, principal.userId)); return;
  }
  if (method === "POST" && parts.length === 5 && parts[2] === "helpers" && parts[4] === "revoke") {
    const input = parseSchema(SshHelperEnrollmentInputSchema, { nodeId: parts[3] }, "SSH helper 节点");
    identity.require(principal, "ssh:manage", input.nodeId); reauth();
    if (!services.sshHelpers) throw new ServiceError(503, "NOT_READY", "SSH helper 身份服务不可用");
    services.sshHelpers.revoke(input.nodeId, principal.userId); sendJson(response, 202, { message: "SSH helper 已撤销，现有连接终止等待主机确认", tone: "warning" }); return;
  }
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
  if (parts[2] === "takeover-plans" && services.sshTakeovers) {
    if (method === "GET") {
      identity.require(principal, "ssh:read"); const plans = services.sshTakeovers.list(principal);
      if (parts.length === 3) sendJson(response, 200, { plans, collectedAt: services.ssh.list(principal).collectedAt });
      else { const plan = plans.find(value => value.id === parts[3]); if (!plan) throw new ServiceError(404, "NOT_FOUND", "接管计划不存在"); sendJson(response, 200, plan); } return;
    }
    if (method === "POST" && parts.length === 3) {
      const input = parseSchema(SshTakeoverInputSchema, context.body, "SSH 接管计划"); identity.require(principal, "ssh:manage", input.nodeId); reauth(); sendJson(response, 201, services.sshTakeovers.create(principal, input)); return;
    }
    if (method === "POST" && parts.length === 5 && ["apply", "rollback"].includes(parts[4] ?? "")) {
      const plan = services.sshTakeovers.get(parts[3]!); identity.require(principal, "ssh:manage", plan.nodeId); reauth(); sendJson(response, 202, parts[4] === "apply" ? services.sshTakeovers.apply(principal, plan.id) : services.sshTakeovers.rollback(principal, plan.id)); return;
    }
  }
  throw new ServiceError(404, "NOT_FOUND", "SSH 接口不存在");
}
