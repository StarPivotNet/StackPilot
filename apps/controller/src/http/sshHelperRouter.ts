import { createHash } from "node:crypto";
import { SshHelperAuthSchema, SshHelperEnrollSchema, SshHelperLoginSchema, SshHelperReportSchema, SshHelperSessionAckSchema, SshHelperStateSchema, SshHelperPolicyAckSchema, SshTakeoverReceiptSchema, SSH_HELPER_PROTOCOL } from "@stackpilot/contracts";
import type { RequestContext } from "./types.js";
import { ServiceError } from "../modules/serviceError.js";
import { sendJson } from "./response/json.js";
import { parseSchema } from "./validation.js";

export function routeSshHelperRequest(context: RequestContext) {
  const { request, response, services, url } = context;
  if (!("encrypted" in request.socket) || request.socket.encrypted !== true) throw new ServiceError(426, "BAD_REQUEST", "SSH helper API 要求 TLS");
  if (!services.sshHelpers || !services.ssh) throw new ServiceError(503, "NOT_READY", "SSH helper 身份服务未配置");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/api/ssh-helper/enroll" && request.method === "POST") {
    const input = parseSchema(SshHelperEnrollSchema, context.body, "SSH helper 注册");
    sendJson(response, 201, services.sshHelpers.enroll(input.enrollmentToken, input.publicKey)); return;
  }
  const header = (name: string) => typeof request.headers[name] === "string" ? request.headers[name] : "";
  if (header("x-stackpilot-ssh-protocol") !== SSH_HELPER_PROTOCOL) throw new ServiceError(401, "UNAUTHORIZED", "SSH helper 协议无效");
  const parsed = SshHelperAuthSchema.safeParse({ nodeId: header("x-stackpilot-ssh-node"), credentialId: header("x-stackpilot-ssh-credential"), timestamp: header("x-stackpilot-ssh-time"), nonce: header("x-stackpilot-ssh-nonce"), signature: header("x-stackpilot-ssh-signature") });
  if (!parsed.success) throw new ServiceError(401, "UNAUTHORIZED", "SSH helper 身份头无效");
  const identity = services.sshHelpers.authenticate(parsed.data, { method: request.method ?? "GET", path: `${url.pathname}${url.search}`, bodySha256: createHash("sha256").update(context.rawBody).digest("hex") });
  if (url.pathname === "/api/ssh-helper/report" && request.method === "POST") {
    const report = parseSchema(SshHelperReportSchema, context.body, "SSH helper 状态");
    const accepted = services.sshHelpers.report(identity, report); services.sshTakeovers?.observe(identity.nodeId, report.inventory); sendJson(response, 200, accepted); return;
  }
  if (url.pathname === "/api/ssh-helper/authenticate" && request.method === "POST") {
    const input = parseSchema(SshHelperLoginSchema, context.body, "SSH 登录");
    sendJson(response, 200, services.ssh.authenticate(identity.nodeId, input.account, input.password, input.connectionId)); return;
  }
  if (url.pathname === "/api/ssh-helper/state" && request.method === "GET") {
    sendJson(response, 200, { ...services.ssh.hostState(identity.nodeId), takeover: services.sshTakeovers?.next(identity.nodeId) ?? null }, SshHelperStateSchema); return;
  }
  if (url.pathname === "/api/ssh-helper/takeover-receipts" && request.method === "POST" && services.sshTakeovers) {
    const input = parseSchema(SshTakeoverReceiptSchema, context.body, "SSH 接管步骤回执"); sendJson(response, 200, services.sshTakeovers.receive(identity.nodeId, identity.credentialId, input)); return;
  }
  if (url.pathname === "/api/ssh-helper/sessions/ack" && request.method === "POST") {
    const input = parseSchema(SshHelperSessionAckSchema, context.body, "SSH 会话结束确认");
    sendJson(response, 200, services.ssh.acknowledgeTerminated(identity.nodeId, input.sessionId, input.connectionId, `helper:${identity.credentialId}`)); return;
  }
  if (url.pathname === "/api/ssh-helper/policies/ack" && request.method === "POST") {
    const input = parseSchema(SshHelperPolicyAckSchema, context.body, "SSH 策略应用确认");
    sendJson(response, 200, services.ssh.acknowledgePolicy(identity.nodeId, input, `helper:${identity.credentialId}`)); return;
  }
  throw new ServiceError(404, "NOT_FOUND", "SSH helper 接口不存在");
}
