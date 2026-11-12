import {
  CreateScheduleJobRequestSchema, EmptyObjectSchema, HealthResponseSchema, OverviewHealthPayloadSchema,
  OverviewCheckUpdatesResponseSchema, OverviewHealthRefreshResponseSchema, OverviewNodeMutationResponseSchema,
  OverviewRisksPayloadSchema, OverviewRisksScanResponseSchema, OverviewSummaryPayloadSchema,
  OverviewTasksPayloadSchema, OverviewTasksRefreshResponseSchema, PathIdSchema,
  CreateCertificateRenewalRequestSchema, CertificateRenewalBatchSchema, DeploymentPayloadSchema,
  DatabaseInstancesPayloadSchema, DatabaseSlowQueriesPayloadSchema, HostMonitoringPayloadSchema, ReadinessResponseSchema,
  RunOverviewTaskRequestSchema, RunScheduleJobRequestSchema,
  ScheduleMutationResponseSchema, SchedulePayloadSchema, UpdateScheduleJobRequestSchema,
  SystemdServicesPayloadSchema,
  FirewallDenyRecordsPayloadSchema,
  FirewallOpenPortsPayloadSchema,
} from "@stackpilot/contracts";
import type { RequestContext } from "./types.js";
import { ApiNoticeSchema } from "@stackpilot/contracts";
import { ApiError, badRequest, forbidden, notFound } from "./errors/ApiError.js";
import { sendJson } from "./response/json.js";
import { parseSchema } from "./validation.js";
import { routeControlPlaneRequest } from "./controlPlaneRouter.js";
import { routeIdentityRequest } from "./identityRouter.js";
import { routeSshRequest } from "./sshRouter.js";
import { routeTerminalRequest } from "./terminalRouter.js";
import type { OverviewAccess } from "../modules/overview/overviewService.js";
import { routeDatabaseBackupRequest } from "./databaseBackupRouter.js";
import { routeSiteRequest } from "./siteRouter.js";
import { routeDatabaseRequest } from "./databaseRouter.js";
import { routeFileRequest, routeFileUploadRequest } from "./fileRouter.js";
import { routeSystemdRequest } from "./systemdRouter.js";
import { routeAuditExportRequest } from "./auditExportRouter.js";
import { CONTROLLER_FIREWALL_NODE_ID, routeFirewallRequest } from "./firewallRouter.js";

function idAt(context: RequestContext, index: number) {
  try {
    return parseSchema(PathIdSchema, decodeURIComponent(context.parts[index] ?? ""), "路径参数");
  } catch (error) {
    if (error instanceof URIError) throw badRequest("路径参数编码无效");
    throw error;
  }
}

function overviewAccess(context:RequestContext):OverviewAccess{return{nodeScope:context.principal?.nodeScope??[],canReadTasks:Boolean(context.principal?.permissions.has("tasks:read")),canReadAudit:Boolean(context.principal?.permissions.has("audit:read"))};}


export async function routeRequest(context: RequestContext): Promise<void> {
  const { request, response, parts, services } = context;
  const method = request.method ?? "GET";
  if (context.parts[0] === "api" && context.parts[1] === "ssh") { routeSshRequest(context); return; }
  if (parts[0] === "api" && parts[1] === "databases" && services.databaseInventory && services.databaseWorkspace && services.databaseOperations) { await routeDatabaseRequest(context); return; }
  if (context.url.pathname === "/api/databases" && method === "GET") {
    context.identity?.require(context.principal, "databases:read");
    sendJson(response, 200, await services.databaseInstances.getInstances({ nodeScope: context.principal?.nodeScope ?? [] }), DatabaseInstancesPayloadSchema);
    return;
  }
  if (context.url.pathname === "/api/databases/slow-queries" && method === "GET" && [...context.url.searchParams.keys()].every((key) => key === "range")) {
    context.identity?.require(context.principal, "databases:read");
    sendJson(response, 200, await services.databaseSlowQueries.getSlowQueries(), DatabaseSlowQueriesPayloadSchema);
    return;
  }
  if (context.url.pathname === "/api/systemd/services" && method === "GET") {
    context.identity?.require(context.principal, "systemd:read");
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, await services.systemd.list(context.principal?.nodeScope ?? []), SystemdServicesPayloadSchema);
    return;
  }
  if (context.url.pathname === "/api/firewall/deny-records" && method === "GET") {
    context.identity?.require(context.principal, "firewall:read");
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, await services.firewallDeny.list(context.principal?.nodeScope ?? []), FirewallDenyRecordsPayloadSchema);
    return;
  }
  if (context.url.pathname === "/api/firewall/open-ports" && method === "GET") {
    context.identity?.require(context.principal, "firewall:read", CONTROLLER_FIREWALL_NODE_ID);
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, await services.firewallOpenPorts.list(), FirewallOpenPortsPayloadSchema);
    return;
  }
  if (context.url.searchParams.size > 0 && !["/api/files", "/api/audit"].includes(context.url.pathname)) throw new ApiError(400, "BAD_REQUEST", "查询参数无效：当前接口不接受查询参数");

  if (context.url.pathname === "/healthz" && method === "GET") {
    sendJson(response, 200, { ok: true, service: "stackpilot-api", time: new Date().toLocaleString("zh-CN", { hour12: false }) }, HealthResponseSchema);
    return;
  }
  if (context.url.pathname === "/readyz" && method === "GET") {
    const ready = await context.platform.readiness();
    sendJson(response, ready ? 200 : 503, { ready, service: "stackpilot-api" }, ReadinessResponseSchema);
    return;
  }
  if (parts[0] === "api" && ["auth", "tokens", "roles", "users", "audit"].includes(parts[1] ?? "")) { await routeIdentityRequest(context); return; }
  if (parts[0] === "api" && parts[1] === "audit-exports") { await routeAuditExportRequest(context); return; }
  if (parts[0] === "api" && ["enrollments", "nodes", "remote-tasks"].includes(parts[1] ?? "")) {
    await routeControlPlaneRequest(context); return;
  }
  if (parts[0] === "api" && parts[1] === "terminal") { await routeTerminalRequest(context); return; }
  if (parts[0] === "api" && parts[1] === "systemd" && parts[2] === "services") { await routeSystemdRequest(context); return; }
  if (parts[0] === "api" && parts[1] === "firewall" && parts[2] === "rules") { await routeFirewallRequest(context); return; }
  if (parts[0] === "api" && parts[1] === "database-backups") { await routeDatabaseBackupRequest(context); return; }
  if (parts[0] === "api" && ["files", "file-trash", "file-uploads"].includes(parts[1] ?? "")) { await routeFileRequest(context); return; }
  if (parts[0] === "api" && parts[1] === "resumable-file-uploads") { await routeFileUploadRequest(context); return; }
  if (parts[0] === "api" && ["site-plans", "site-operations", "site-rollbacks"].includes(parts[1] ?? "")) { await routeSiteRequest(context); return; }
  if (context.url.pathname === "/api/deployments" && method === "GET") {
    context.identity?.require(context.principal, "sites:read");
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, services.deployments.list({ nodeScope: context.principal?.nodeScope ?? [] }), DeploymentPayloadSchema); return;
  }
  if (context.url.pathname === "/api/hosts" && method === "GET") {
    context.identity?.require(context.principal, "overview:read");
    const nodeScope = context.principal?.nodeScope ?? [];
    const canReadNodes = Boolean(context.principal?.permissions.has("nodes:read"));
    sendJson(response,200,await services.hosts.getHosts(canReadNodes&&(nodeScope==="all"||nodeScope.length>0),nodeScope),HostMonitoringPayloadSchema);return;
  }
  if (context.url.pathname === "/api/sites/certificate-renewals" && method === "POST") {
    context.identity?.require(context.principal,"sites:renew");
    context.identity?.consumeReauth(context.principal!,typeof context.request.headers["x-reauth-proof"]==="string"?context.request.headers["x-reauth-proof"]:undefined);
    const input=parseSchema(CreateCertificateRenewalRequestSchema,context.body,"证书续期");
    sendJson(response,202,await services.certificateRenewals.create(input,{nodeScope:context.principal?.nodeScope??[]},`user:${context.principal?.userId}`,context.requestId),CertificateRenewalBatchSchema);return;
  }
  if (parts[0] === "api" && parts[1] === "sites" && parts[2] === "certificate-renewals" && parts.length === 4 && method === "GET") {
    context.identity?.require(context.principal,"sites:read");
    sendJson(response,200,await services.certificateRenewals.get(idAt(context,3),{nodeScope:context.principal?.nodeScope??[]}),CertificateRenewalBatchSchema);return;
  }
  if (context.url.pathname === "/api/databases" && method === "GET") {
    context.identity?.require(context.principal, "databases:read");
    sendJson(response, 200, await services.databaseInstances.getInstances({ nodeScope: context.principal?.nodeScope ?? [] }), DatabaseInstancesPayloadSchema);
    return;
  }
  if (context.url.pathname === "/api/databases/slow-queries" && method === "GET") {
    context.identity?.require(context.principal, "databases:read");
    sendJson(response, 200, await services.databaseSlowQueries.getSlowQueries(), DatabaseSlowQueriesPayloadSchema);
    return;
  }
  if (context.url.pathname === "/api/sites" || (parts[0] === "api" && parts[1] === "sites")) { await routeSiteRequest(context); return; }
  if (parts[0] !== "api" || parts[1] !== "overview") throw notFound();
  context.identity?.require(context.principal, "overview:read");
  const access=overviewAccess(context);

  if (parts.length === 2 && method === "GET") {
    sendJson(response,200,await services.overview.getOverview(access),OverviewSummaryPayloadSchema);return;
  }
  if (parts[2] === "refresh" && parts.length === 3 && method === "POST") {
    context.identity?.require(context.principal,"overview:operate");
    parseSchema(EmptyObjectSchema, context.body, "请求体");
    sendJson(response,200,await services.overview.getOverview(access,{bypassCache:true}),OverviewSummaryPayloadSchema);return;
  }
  if (parts[2] === "cluster" && parts.length === 3 && method === "POST") {
    context.identity?.require(context.principal,"overview:operate");
    parseSchema(EmptyObjectSchema, context.body, "请求体");
    sendJson(response,200,await services.overview.getOverview(access,{bypassCache:true}),OverviewSummaryPayloadSchema);return;
  }
  if (parts[2] === "check-updates" && parts.length === 3 && method === "POST") {
    context.identity?.require(context.principal,"overview:operate");
    parseSchema(EmptyObjectSchema, context.body, "请求体");
    const overview=await services.overview.getOverview(access,{bypassCache:true});
    sendJson(response, 200, { message: `检查完成：${overview.cluster.pendingUpdates} 个待处理项`, tone: overview.cluster.pendingUpdates ? "warning" : "success", overview }, OverviewCheckUpdatesResponseSchema); return;
  }
  if (parts[2] === "health") { await routeHealth(context); return; }
  if (parts[2] === "tasks") { await routeTasks(context); return; }
  if (parts[2] === "risks") { await routeRisks(context); return; }
  if (parts[2] === "current-user-crontab") { await routeSchedules(context); return; }
  throw notFound("总览接口不存在");
}

async function routeHealth(context: RequestContext) {
  const { request, response, parts, services } = context; const method = request.method;
  const access=overviewAccess(context);
  if(parts.length===3&&method==="GET"){const overview=await services.overview.getOverview(access);sendJson(response,200,{nodes:overview.nodes,lastRefresh:overview.lastRefresh,collectedAt:overview.collectedAt},OverviewHealthPayloadSchema);return;}
  if(parts[3]==="refresh"&&parts.length===4&&method==="POST"){context.identity?.require(context.principal,"overview:operate");parseSchema(EmptyObjectSchema,context.body,"请求体");const overview=await services.overview.getOverview(access,{bypassCache:true});sendJson(response,200,{nodes:overview.nodes,lastRefresh:overview.lastRefresh,collectedAt:overview.collectedAt},OverviewHealthPayloadSchema);return;}
  if(parts[3]==="nodes"&&parts.length===4&&method==="POST"){context.identity?.require(context.principal,"overview:operate");parseSchema(EmptyObjectSchema,context.body,"请求体");const overview=await services.overview.getOverview(access,{bypassCache:true});sendJson(response,200,{nodes:overview.nodes,lastRefresh:overview.lastRefresh,collectedAt:overview.collectedAt,message:"已重新采集节点状态",tone:"info"},OverviewHealthRefreshResponseSchema);return;}
  if(parts[3]==="nodes"&&parts.length===5&&method==="PATCH"){context.identity?.require(context.principal,"overview:operate");parseSchema(EmptyObjectSchema,context.body,"请求体");const id=idAt(context,4),overview=await services.overview.getOverview(access,{bypassCache:true}),node=overview.nodes.find(item=>item.id===id);if(!node)throw notFound("节点不存在");sendJson(response,200,{node,message:"已重新采集节点状态",tone:"info"},OverviewNodeMutationResponseSchema);return;}
  if (parts[3] === "nodes" && parts[5] === "restart" && parts.length === 6 && method === "POST") { context.identity?.require(context.principal,"overview:operate"); parseSchema(EmptyObjectSchema, context.body, "请求体"); const id = idAt(context, 4); if (id !== context.platform.nodeId) throw notFound("节点不存在"); const result = await context.platform.restartNode(); if (!result.ok) throw new ApiError(result.status, result.status < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR", result.status < 500 ? result.message : "服务内部错误"); sendJson(response, 200, { message: result.message, tone: "success" }, ApiNoticeSchema); return; }
  throw notFound("集群状态接口不存在");
}

async function routeTasks(context: RequestContext) {
  const { request, response, parts, services } = context; const method = request.method;
  const access=overviewAccess(context);
  if(parts.length===3&&method==="GET"){sendJson(response,200,await services.tasks.list(access),OverviewTasksPayloadSchema);return;}
  if (method !== "GET") context.identity?.require(context.principal,"overview:operate");
  if(parts.length===3&&method==="POST"){parseSchema(EmptyObjectSchema,context.body,"请求体");const payload=await services.tasks.refresh(access);sendJson(response,200,{...payload,message:"已重新采集真实任务流",tone:"info"},OverviewTasksRefreshResponseSchema);return;}
  if(parts[3]==="export"&&parts.length===4&&method==="POST"){parseSchema(EmptyObjectSchema,context.body,"请求体");await services.tasks.export(access);sendJson(response,200,{message:"任务流已导出",tone:"success"},ApiNoticeSchema);return;}
  if(parts.length===4&&method==="PATCH"){idAt(context,3);parseSchema(RunOverviewTaskRequestSchema,context.body,"请求体");throw new ApiError(501,"NOT_IMPLEMENTED","工作台任务仅展示真实状态，请通过远程任务控制面创建任务");}
  throw notFound("任务流接口不存在");
}

async function routeRisks(context: RequestContext) {
  const { request, response, parts, services } = context; const method = request.method;
  const access=overviewAccess(context);
  if(parts.length===3&&method==="GET"){sendJson(response,200,await services.risks.list(access),OverviewRisksPayloadSchema);return;}
  if (method !== "GET") context.identity?.require(context.principal,"overview:operate");
  if (parts.length === 3 && method === "POST") { parseSchema(EmptyObjectSchema, context.body, "请求体"); throw new ApiError(501, "NOT_IMPLEMENTED", "真实风险创建尚未配置风险扫描器写入接口"); }
  if(parts[3]==="scan"&&parts.length===4&&method==="POST"){parseSchema(EmptyObjectSchema,context.body,"请求体");const payload=await services.risks.scan(access);sendJson(response,200,{...payload,message:"已触发风险重新扫描",tone:"info"},OverviewRisksScanResponseSchema);return;}
  if(parts[3]==="export"&&parts.length===4&&method==="POST"){parseSchema(EmptyObjectSchema,context.body,"请求体");await services.risks.export(access);sendJson(response,200,{message:"风险报告已导出",tone:"success"},ApiNoticeSchema);return;}
  if (parts.length === 4 && method === "PATCH") { parseSchema(EmptyObjectSchema, context.body, "请求体"); throw new ApiError(501, "NOT_IMPLEMENTED", "真实风险处置器尚未配置，未修改风险状态"); }
  throw notFound("风险中心接口不存在");
}

async function routeSchedules(context: RequestContext) {
  const { request, response, parts, services, config } = context; const method = request.method;
  context.identity?.require(context.principal,method === "GET" ? "schedules:read" : "schedules:write");
  if (parts.length === 3 && method === "GET") { response.setHeader("Cache-Control", "no-store"); sendJson(response, 200, await services.schedules.list(), SchedulePayloadSchema); return; }
  const authorizeMutation = () => {
    if (!config.crontabWriteEnabled) throw forbidden("crontab 写入与立即执行能力未开启");
    context.identity?.consumeReauth(context.principal!, typeof request.headers["x-reauth-proof"] === "string" ? request.headers["x-reauth-proof"] : undefined);
  };
  if (parts.length === 3 && method === "POST") { const payload = parseSchema(CreateScheduleJobRequestSchema, context.body, "请求体"); authorizeMutation(); const result = await services.schedules.create(payload, context.principal!.userId); sendJson(response, 201, { ...result, message: `${result.job.name} 已写入当前用户 crontab`, tone: "success" }, ScheduleMutationResponseSchema); return; }
  if (parts.length === 4 && method === "PATCH") { const id = idAt(context, 3); const run = RunScheduleJobRequestSchema.safeParse(context.body); const update = run.success ? null : parseSchema(UpdateScheduleJobRequestSchema, context.body, "请求体"); authorizeMutation(); const result = run.success ? await services.schedules.run(id, run.data.idempotencyKey, context.principal!.userId) : await services.schedules.update(id, update!); sendJson(response, 200, { ...result, message: `${result.job.name} ${run.success ? "已立即执行" : "已保存到当前用户 crontab"}`, tone: result.job.result === "失败" ? "warning" : "success" }, ScheduleMutationResponseSchema); return; }
  if (parts.length === 4 && method === "DELETE") { parseSchema(EmptyObjectSchema, context.body, "请求体"); const id = idAt(context, 3); authorizeMutation(); const result = await services.schedules.delete(id); sendJson(response, 200, { ...result, message: `${result.job.name} 已从当前用户 crontab 删除`, tone: "warning" }, ScheduleMutationResponseSchema); return; }
  throw notFound("定时任务接口不存在");
}
