import {
  AgentNodeListResponseSchema, CancelRemoteTaskRequestSchema, CreateEnrollmentRequestSchema,
  CreateRemoteTaskRequestSchema, EnrollmentCredentialSchema, PathIdSchema, RemoteTaskListResponseSchema, RemoteTaskRecordSchema, ApiNoticeSchema,
  AgentNodeRecordSchema, UpdateNodeCapabilitiesRequestSchema,
} from "@stackpilot/contracts";
import type { RequestContext } from "./types.js";
import { notFound } from "./errors/ApiError.js";
import { sendJson } from "./response/json.js";
import { parseSchema } from "./validation.js";

const id = (context: RequestContext, index: number) => parseSchema(PathIdSchema, context.parts[index] ?? "", "路径参数");
const publicNode = (value: Awaited<ReturnType<RequestContext["services"]["nodes"]["list"]>>[number]) => ({
  nodeId: value.nodeId, nodeName: value.nodeName, status: value.status, agentVersion: value.agentVersion,
  protocolVersion: value.protocolVersion, platform: value.platform, declaredCapabilities: value.declaredCapabilities,
  allowedCapabilities: value.allowedCapabilities, enrolledAt: value.enrolledAt, lastSeenAt: value.lastSeenAt, revokedAt: value.revokedAt,
});

export async function routeControlPlaneRequest(context: RequestContext) {
  const method = context.request.method ?? "GET";
  const identity=context.identity;const principal=context.principal;
  if (context.parts[1] === "enrollments" && context.parts.length === 2 && method === "POST") {
    identity?.require(principal,"nodes:manage");identity?.consumeReauth(principal!,typeof context.request.headers["x-reauth-proof"]==="string"?context.request.headers["x-reauth-proof"]:undefined);
    const input = parseSchema(CreateEnrollmentRequestSchema, context.body, "注册凭据");
    sendJson(context.response, 201, await context.services.enrollments.create(input, `user:${principal?.userId}`, context.requestId), EnrollmentCredentialSchema); return;
  }
  if (context.parts[1] === "enrollments" && context.parts.length === 3 && method === "DELETE") {
    identity?.require(principal,"nodes:manage");identity?.consumeReauth(principal!,typeof context.request.headers["x-reauth-proof"]==="string"?context.request.headers["x-reauth-proof"]:undefined);
    await context.services.enrollments.revoke(id(context, 2), `user:${principal?.userId}`, context.requestId);
    sendJson(context.response, 200, { message: "注册凭据已撤销", tone: "warning" }, ApiNoticeSchema); return;
  }
  if (context.parts[1] === "nodes" && context.parts.length === 2 && method === "GET") {
    identity?.require(principal,"nodes:read");const nodes=await context.services.nodes.list();const scoped=principal?.nodeScope==="all"?nodes:nodes.filter(node=>principal?.nodeScope.includes(node.nodeId));
    sendJson(context.response, 200, { nodes: scoped.map(publicNode) }, AgentNodeListResponseSchema); return;
  }
  if (context.parts[1] === "nodes" && context.parts.length === 3 && method === "DELETE") {
    const nodeId=id(context,2);identity?.require(principal,"nodes:manage",nodeId);identity?.consumeReauth(principal!,typeof context.request.headers["x-reauth-proof"]==="string"?context.request.headers["x-reauth-proof"]:undefined);await context.services.nodes.revoke(nodeId, `user:${principal?.userId}`, context.requestId);
    sendJson(context.response, 200, { message: "节点及其凭据已撤销", tone: "warning" }, ApiNoticeSchema); return;
  }
  if (context.parts[1] === "nodes" && context.parts[3] === "capabilities" && context.parts.length === 4 && method === "PATCH") {
    const nodeId=id(context,2);identity?.require(principal,"nodes:manage",nodeId);identity?.consumeReauth(principal!,typeof context.request.headers["x-reauth-proof"]==="string"?context.request.headers["x-reauth-proof"]:undefined);
    const input=parseSchema(UpdateNodeCapabilitiesRequestSchema,context.body,"节点能力");
    sendJson(context.response,200,publicNode(await context.services.nodes.updateCapabilities(nodeId,input.allowedCapabilities,`user:${principal?.userId}`,context.requestId)),AgentNodeRecordSchema);return;
  }
  if (context.parts[1] === "nodes" && context.parts[3] === "tasks" && context.parts.length === 4 && method === "POST") {
    const nodeId=id(context,2);identity?.require(principal,"tasks:create",nodeId);
    const input = parseSchema(CreateRemoteTaskRequestSchema, context.body, "远程任务");
    const authorize=()=>identity?.consumeReauth(principal!,typeof context.request.headers["x-reauth-proof"]==="string"?context.request.headers["x-reauth-proof"]:undefined);
    sendJson(context.response, 201, await context.services.remoteTasks.createForUser(nodeId, input, `user:${principal?.userId}`, context.requestId,
      { permissions: principal?.permissions ?? new Set(), nodeScope: principal?.nodeScope ?? [] }, authorize), RemoteTaskRecordSchema); return;
  }
  if (context.parts[1] === "remote-tasks" && context.parts.length === 2 && method === "GET") {
    identity?.require(principal,"tasks:read");const tasks=await context.services.remoteTasks.listReadOnly(undefined,principal?.nodeScope??[]);sendJson(context.response, 200, { tasks: tasks.sort((left,right)=>Date.parse(right.updatedAt)-Date.parse(left.updatedAt)), collectedAt: new Date().toISOString() }, RemoteTaskListResponseSchema); return;
  }
  if (context.parts[1] === "remote-tasks" && context.parts[3] === "cancel" && context.parts.length === 4 && method === "POST") {
    identity?.require(principal,"tasks:cancel");
    const input = parseSchema(CancelRemoteTaskRequestSchema, context.body, "取消任务");
    const taskId=id(context,2);const task=await context.services.remoteTasks.getReadOnly(taskId);if(task)identity?.require(principal,"tasks:cancel",task.targetNodeId);sendJson(context.response, 200, await context.services.remoteTasks.cancel(taskId, `user:${principal?.userId}`, input.reason, context.requestId), RemoteTaskRecordSchema); return;
  }
  throw notFound("节点控制接口不存在");
}
