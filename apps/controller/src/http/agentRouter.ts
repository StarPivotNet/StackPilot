import {
  AGENT_FEATURE_DATABASE_INVENTORY, AGENT_FEATURE_FIREWALL_DENY_SNAPSHOT, AGENT_FEATURE_PHYSICAL_HOST_IDENTITY, AGENT_FEATURE_SYSTEMD_SNAPSHOT, AgentEnrollmentRequestSchema, AgentEnrollmentResponseSchema, AgentHeartbeatResponseSchema, AgentHeartbeatSchema,
  RemoteTaskPollResponseSchema, RemoteTaskRecordSchema, RemoteTaskStatusUpdateSchema, RotateCredentialRequestSchema, RotateCredentialResponseSchema,
  MeshPeerDirectoryResponseSchema,
} from "@stackpilot/contracts";
import type { RequestContext } from "./types.js";
import { notFound } from "./errors/ApiError.js";
import { sendJson } from "./response/json.js";
import { parseSchema } from "./validation.js";
import { routeDatabaseAgentRequest } from "./databaseAgentRouter.js";

export async function routeAgentRequest(context: RequestContext) {
  const method = context.request.method ?? "GET";
  context.response.setHeader("X-StackPilot-Agent-Features", [AGENT_FEATURE_DATABASE_INVENTORY, AGENT_FEATURE_PHYSICAL_HOST_IDENTITY, AGENT_FEATURE_SYSTEMD_SNAPSHOT, AGENT_FEATURE_FIREWALL_DENY_SNAPSHOT].join(","));
  if (context.url.pathname.startsWith("/api/agent/databases/")) {
    await routeDatabaseAgentRequest(context);
    return;
  }
  if (context.url.pathname === "/api/agent/enroll" && method === "POST") {
    const input = parseSchema(AgentEnrollmentRequestSchema, context.body, "注册请求");
    sendJson(context.response, 201, await context.services.enrollments.enroll(input, context.requestId), AgentEnrollmentResponseSchema);
    return;
  }
  const identity = context.agentIdentity;
  if (!identity) throw notFound("Agent 身份不可用");
  if (context.url.pathname === "/api/agent/mesh/peers" && method === "GET") {
    sendJson(context.response, 200, await context.services.egress.peerDirectory(identity.nodeId), MeshPeerDirectoryResponseSchema);
    return;
  }
  if (context.url.pathname === "/api/agent/heartbeat" && method === "POST") {
    const input = parseSchema(AgentHeartbeatSchema, context.body, "心跳");
    const result = await context.services.nodes.heartbeat(identity.nodeId, input, context.requestId);
    await context.services.mesh.reconcileNode(identity.nodeId, context.requestId);
    if (input.databaseSnapshot && input.capabilities.includes("databases.inventory.read") && !input.capabilities.includes("database.inventory.read")) {
      context.services.databaseInventory?.ingestSnapshot(identity.nodeId, input.databaseSnapshot);
    }
    sendJson(context.response, 200, result, AgentHeartbeatResponseSchema);
    return;
  }
  if (context.url.pathname === "/api/agent/tasks/poll" && method === "POST") {
    const tasks = await context.services.remoteTasks.poll(identity.nodeId, context.requestId);
    const cancelledTaskIds = await context.services.remoteTasks.cancellations(identity.nodeId);
    sendJson(context.response, 200, { tasks, cancelledTaskIds, controllerTime: new Date().toISOString() }, RemoteTaskPollResponseSchema);
    return;
  }
  if (context.url.pathname === "/api/agent/tasks/status" && method === "POST") {
    const input = parseSchema(RemoteTaskStatusUpdateSchema, context.body, "任务状态");
    sendJson(context.response, 200, await context.services.remoteTasks.update(identity.nodeId, input, context.requestId), RemoteTaskRecordSchema);
    return;
  }
  if (context.url.pathname === "/api/agent/credentials/rotate" && method === "POST") {
    const input = parseSchema(RotateCredentialRequestSchema, context.body, "凭据轮换");
    sendJson(context.response, 200, await context.services.nodes.rotate(identity.nodeId, identity.credentialId, input.rotationId, input.publicKey, context.requestId), RotateCredentialResponseSchema);
    return;
  }
  throw notFound("Agent 接口不存在");
}
