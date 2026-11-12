import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AGENT_PROTOCOL_VERSION, type AgentEnrollmentRequest, type CreateEnrollmentRequest, isAgentProtocolCompatible } from "@stackpilot/contracts";
import type { AgentControlRepository, AuditEvent } from "../../repositories/agentControlRepository.js";
import { DEFAULT_AGENT_CAPABILITIES } from "../../repositories/agentControlRepository.js";
import { ServiceError } from "../serviceError.js";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const safeDigestEqual = (left: string, right: string) => timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
const audit = (event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent => ({ eventId: randomUUID(), timestamp: new Date().toISOString(), ...event });

export class EnrollmentService {
  constructor(private readonly repository: AgentControlRepository) {}

  async create(input: CreateEnrollmentRequest, requester: string, traceId: string) {
    const token = randomBytes(32).toString("base64url");
    const enrollmentId = randomUUID();
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
    await this.repository.update((state) => {
      state.enrollments.push({ enrollmentId, tokenDigest: digest(token), nodeName: input.nodeName, expiresAt, usedAt: null, revokedAt: null });
      state.audits.push(audit({ requester, nodeId: null, taskId: null, event: "enrollment.created", taskType: null, parameters: { enrollmentId, nodeName: input.nodeName, expiresAt }, fromStatus: null, toStatus: null, resultSummary: null, traceId }));
    }, { sections: [] });
    return { enrollmentId, token, expiresAt, purpose: "agent-enrollment" as const };
  }

  async revoke(enrollmentId: string, requester: string, traceId: string) {
    await this.repository.update((state) => {
      const enrollment = state.enrollments.find((item) => item.enrollmentId === enrollmentId);
      if (!enrollment) throw new ServiceError(404, "NOT_FOUND", "注册凭据不存在");
      if (!enrollment.revokedAt) enrollment.revokedAt = new Date().toISOString();
      state.audits.push(audit({ requester, nodeId: null, taskId: null, event: "enrollment.revoked", taskType: null, parameters: { enrollmentId }, fromStatus: null, toStatus: null, resultSummary: null, traceId }));
    }, { sections: ["enrollments"] });
  }

  async enroll(input: AgentEnrollmentRequest, traceId: string) {
    if (!isAgentProtocolCompatible(input.protocolVersion)) throw new ServiceError(409, "BAD_REQUEST", "Agent 协议版本不兼容");
    try { if (createPublicKey(input.publicKey).asymmetricKeyType !== "ed25519") throw new Error(); }
    catch { throw new ServiceError(400, "BAD_REQUEST", "Agent 公钥无效"); }
    const tokenDigest = digest(input.enrollmentToken);
    let response: { nodeId: string; credentialId: string; protocolVersion: string; controllerTime: string; heartbeatIntervalSeconds: number } | null = null;
    await this.repository.update((state) => {
      const enrollment = state.enrollments.find((item) => safeDigestEqual(item.tokenDigest, tokenDigest));
      if (!enrollment || enrollment.revokedAt || enrollment.usedAt || Date.parse(enrollment.expiresAt) <= Date.now()) throw new ServiceError(401, "UNAUTHORIZED", "注册凭据无效或已失效");
      if (enrollment.nodeName !== input.nodeName) throw new ServiceError(403, "FORBIDDEN", "注册凭据用途与节点不匹配");
      const now = new Date().toISOString();
      const nodeId = randomUUID();
      const credentialId = randomUUID();
      const allowedCapabilities = input.capabilities.filter((item) => DEFAULT_AGENT_CAPABILITIES.includes(item));
      enrollment.usedAt = now;
      state.nodes.push({ nodeId, nodeName: input.nodeName, status: "pending", agentVersion: input.agentVersion, protocolVersion: input.protocolVersion, platform: input.platform, declaredCapabilities: input.capabilities, allowedCapabilities, enrolledAt: now, lastSeenAt: null, revokedAt: null });
      state.credentials.push({ credentialId, nodeId, publicKey: input.publicKey, createdAt: now, revokedAt: null, replacedBy: null, rotationId: null });
      state.audits.push(audit({ requester: "agent-enrollment", nodeId, taskId: null, event: "node.enrolled", taskType: null, parameters: { nodeName: input.nodeName, credentialId, allowedCapabilities }, fromStatus: null, toStatus: "pending", resultSummary: null, traceId }));
      response = { nodeId, credentialId, protocolVersion: AGENT_PROTOCOL_VERSION, controllerTime: now, heartbeatIntervalSeconds: 15 };
    }, { sections: ["enrollments"] });
    if (!response) throw new ServiceError(500, "INTERNAL_ERROR", "注册状态未保存");
    return response;
  }
}
