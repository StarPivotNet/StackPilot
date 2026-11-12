import { createPublicKey, randomUUID, verify } from "node:crypto";
import {
  AGENT_REQUEST_TIME_WINDOW_MS, agentSignaturePayload,
  isAgentProtocolCompatible, type AgentHeartbeat,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AgentCredentialState, AuditEvent } from "../../repositories/agentControlRepository.js";
import { CONTROLLER_SUPPORTED_AGENT_CAPABILITIES } from "../../repositories/agentControlRepository.js";
import { ServiceError } from "../serviceError.js";

const audit = (event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent => ({ eventId: randomUUID(), timestamp: new Date().toISOString(), ...event });

export type SignedAgentRequest = {
  nodeId: string; credentialId: string; timestamp: string; nonce: string; signature: string;
  method: string; path: string; bodySha256: string; protocolVersion: string;
};

export class NodeService {
  constructor(private readonly repository: AgentControlRepository, private readonly offlineAfterMs = 45_000) {}

  async authenticate(input: SignedAgentRequest): Promise<{ nodeId: string; credential: AgentCredentialState; protocolVersion: string }> {
    if (!isAgentProtocolCompatible(input.protocolVersion)) throw new ServiceError(409, "BAD_REQUEST", "Agent 协议版本不兼容");
    const requestTime = Date.parse(input.timestamp);
    if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > AGENT_REQUEST_TIME_WINDOW_MS) throw new ServiceError(401, "UNAUTHORIZED", "Agent 请求时间无效");
    const state = await this.repository.read({ sections: ["nodes", "credentials"], nodeId: input.nodeId, credentialId: input.credentialId });
    const node = state.nodes.find((item) => item.nodeId === input.nodeId);
    const credential = state.credentials.find((item) => item.credentialId === input.credentialId && item.nodeId === input.nodeId);
    const rotationRecovery = input.path === "/api/agent/credentials/rotate" && credential?.revokedAt && credential.replacedBy && credential.rotationId;
    if (!node || node.revokedAt || !credential || (credential.revokedAt && !rotationRecovery)) throw new ServiceError(401, "UNAUTHORIZED", "Agent 身份无效或已撤销");
    const payload = agentSignaturePayload(input);
    let valid = false;
    try { valid = verify(null, Buffer.from(payload), credential.publicKey, Buffer.from(input.signature, "base64url")); } catch { valid = false; }
    if (!valid) throw new ServiceError(401, "UNAUTHORIZED", "Agent 请求签名无效");
    const nonceResult = await this.repository.consumeNonce({
      nodeId: input.nodeId,
      credentialId: input.credentialId,
      nonce: input.nonce,
      expiresAt: new Date(Date.now() + AGENT_REQUEST_TIME_WINDOW_MS).toISOString(),
      allowRevokedCredential: input.path === "/api/agent/credentials/rotate",
    });
    if (nonceResult === "unauthorized") throw new ServiceError(401, "UNAUTHORIZED", "Agent 身份无效或已撤销");
    if (nonceResult === "replayed") throw new ServiceError(409, "BAD_REQUEST", "Agent 请求已重放");
    return { nodeId: input.nodeId, credential, protocolVersion: input.protocolVersion };
  }

  async heartbeat(nodeId: string, heartbeat: AgentHeartbeat, traceId: string) {
    if (heartbeat.nodeId !== nodeId) throw new ServiceError(403, "FORBIDDEN", "心跳目标节点不匹配");
    if (!isAgentProtocolCompatible(heartbeat.protocolVersion)) throw new ServiceError(409, "BAD_REQUEST", "Agent 协议版本不兼容");
    if (Math.abs(Date.now() - Date.parse(heartbeat.timestamp)) > AGENT_REQUEST_TIME_WINDOW_MS) throw new ServiceError(400, "BAD_REQUEST", "心跳时间超出允许窗口");
    const acceptedAt = new Date().toISOString();
    const updated = await this.repository.updateNodeWithAudit(nodeId, (node) => {
      if (node.revokedAt) throw new ServiceError(401, "UNAUTHORIZED", "节点不存在或已撤销");
      const previous = node.status;
      const previousPhysicalHostId = node.physicalHostId;
      node.status = "online"; node.lastSeenAt = acceptedAt; node.agentVersion = heartbeat.agentVersion;
      node.protocolVersion = heartbeat.protocolVersion; node.platform = heartbeat.platform; node.declaredCapabilities = heartbeat.capabilities;
      if (heartbeat.physicalHostId) node.physicalHostId = heartbeat.physicalHostId;
      node.heartbeatHealthStatus = heartbeat.health.status;
      if (heartbeat.telemetry) node.telemetry = heartbeat.telemetry;
      if (heartbeat.siteSnapshot) node.siteSnapshot = heartbeat.siteSnapshot;
      if (heartbeat.databaseSnapshot) node.databaseSnapshot = heartbeat.databaseSnapshot;
      if (heartbeat.systemdSnapshot) node.systemdSnapshot = heartbeat.systemdSnapshot;
      if (heartbeat.firewallDenySnapshot) node.firewallDenySnapshot = heartbeat.firewallDenySnapshot;
      const physicalHostIdentity = heartbeat.physicalHostId === undefined ? "legacy"
        : previousPhysicalHostId === heartbeat.physicalHostId
        ? "unchanged"
        : previousPhysicalHostId ? "changed" : "reported";
      return audit({ requester: `agent:${nodeId}`, nodeId, taskId: null, event: "node.heartbeat", taskType: null, parameters: { health: heartbeat.health.status, capabilities: heartbeat.capabilities, physicalHostIdentity }, fromStatus: previous, toStatus: "online", resultSummary: null, traceId });
    });
    if (!updated) throw new ServiceError(401, "UNAUTHORIZED", "节点不存在或已撤销");
    return { acceptedAt, nextHeartbeatSeconds: 15 };
  }

  async list() {
    const now = Date.now();
    const state = await this.repository.read({ sections: ["nodes"] });
    for (const node of state.nodes) if (!node.revokedAt && node.lastSeenAt && now - Date.parse(node.lastSeenAt) > this.offlineAfterMs) node.status = "offline";
    return state.nodes;
  }

  async revoke(nodeId: string, requester: string, traceId: string) {
    await this.repository.update((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node) throw new ServiceError(404, "NOT_FOUND", "节点不存在");
      const now = new Date().toISOString(); const previous = node.status;
      node.revokedAt = now; node.status = "revoked";
      for (const credential of state.credentials.filter((item) => item.nodeId === nodeId && !item.revokedAt)) credential.revokedAt = now;
      for (const task of state.tasks.filter((item) => item.targetNodeId === nodeId && ["queued", "dispatched"].includes(item.status))) {
        const fromStatus = task.status; task.status = "cancelled"; task.updatedAt = now; task.errorCode = "NODE_REVOKED";
        state.audits.push(audit({ requester, nodeId, taskId: task.taskId, event: "task.cancelled-by-node-revocation", taskType: task.type, parameters: null, fromStatus, toStatus: "cancelled", resultSummary: null, traceId }));
      }
      state.audits.push(audit({ requester, nodeId, taskId: null, event: "node.revoked", taskType: null, parameters: null, fromStatus: previous, toStatus: "revoked", resultSummary: null, traceId }));
    }, { sections: ["nodes", "credentials", "tasks"], nodeId, activeTasks: true });
  }

  async updateCapabilities(nodeId: string, allowedCapabilities: AgentHeartbeat["capabilities"], requester: string, traceId: string) {
    const updated = await this.repository.updateNodeWithAudit(nodeId, (node) => {
      if (node.revokedAt) throw new ServiceError(404, "NOT_FOUND", "节点不存在或已撤销");
      for (const capability of allowedCapabilities) {
        if (!CONTROLLER_SUPPORTED_AGENT_CAPABILITIES.includes(capability) || !node.declaredCapabilities.includes(capability)) {
          throw new ServiceError(400, "BAD_REQUEST", "只能授权 Controller 支持且 Agent 已声明的能力");
        }
      }
      const previous = node.allowedCapabilities;
      node.allowedCapabilities = [...allowedCapabilities];
      return audit({
        requester, nodeId, taskId: null, event: "node.capabilities-updated", taskType: null,
        parameters: { allowedCapabilities }, fromStatus: previous.join(","), toStatus: allowedCapabilities.join(","), resultSummary: null, traceId,
      });
    });
    if (!updated) throw new ServiceError(404, "NOT_FOUND", "节点不存在");
    return updated;
  }

  async rotate(nodeId: string, credentialId: string, rotationId: string, publicKey: string, traceId: string) {
    try { if (createPublicKey(publicKey).asymmetricKeyType !== "ed25519") throw new Error(); }
    catch { throw new ServiceError(400, "BAD_REQUEST", "Agent 公钥无效"); }
    const replacementId = randomUUID(); const now = new Date().toISOString();
    let response: { credentialId: string; rotatedAt: string } | null = null;
    await this.repository.update((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      const current = state.credentials.find((item) => item.credentialId === credentialId && item.nodeId === nodeId);
      if (!node || node.revokedAt || !current) throw new ServiceError(401, "UNAUTHORIZED", "Agent 身份无效或已撤销");
      if (current.revokedAt) {
        const replacement = state.credentials.find((item) => item.credentialId === current.replacedBy);
        if (current.rotationId === rotationId && replacement?.publicKey === publicKey) { response = { credentialId: replacement.credentialId, rotatedAt: replacement.createdAt }; return; }
        throw new ServiceError(401, "UNAUTHORIZED", "Agent 身份无效或已撤销");
      }
      current.revokedAt = now; current.replacedBy = replacementId; current.rotationId = rotationId;
      state.credentials.push({ credentialId: replacementId, nodeId, publicKey, createdAt: now, revokedAt: null, replacedBy: null, rotationId: null });
      state.audits.push(audit({ requester: `agent:${nodeId}`, nodeId, taskId: null, event: "credential.rotated", taskType: null, parameters: { oldCredentialId: credentialId, newCredentialId: replacementId }, fromStatus: null, toStatus: null, resultSummary: null, traceId }));
    }, { sections: ["nodes", "credentials"], nodeId });
    return response ?? { credentialId: replacementId, rotatedAt: now };
  }
}
