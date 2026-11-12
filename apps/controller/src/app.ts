import { randomUUID } from "node:crypto";
import { AGENT_API_BODY_LIMIT_BYTES } from "@stackpilot/contracts";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadControllerConfig, type ControllerConfig } from "./config/environment.js";
import { mapError } from "./http/errors/mapError.js";
import { applyCors } from "./http/middleware/cors.js";
import { readJsonRequest } from "./http/middleware/jsonBody.js";
import { authenticateAgentRequest } from "./http/middleware/agentAuthentication.js";
import { sendError } from "./http/response/json.js";
import { routeRequest } from "./http/router.js";
import { routeAgentRequest } from "./http/agentRouter.js";
import type { Services } from "./http/types.js";
import { consoleLogger, type Logger } from "./logging/logger.js";
import { OverviewService } from "./modules/overview/overviewService.js";
import { RiskService } from "./modules/risks/riskService.js";
import { ScheduleService } from "./modules/schedules/scheduleService.js";
import { TaskService } from "./modules/tasks/taskService.js";
import { EnrollmentService } from "./modules/enrollments/enrollmentService.js";
import { NodeService } from "./modules/nodes/nodeService.js";
import { HostMonitoringService } from "./modules/hosts/hostMonitoringService.js";
import { SiteMonitoringService } from "./modules/sites/siteMonitoringService.js";
import { CertificateRenewalService } from "./modules/sites/certificateRenewalService.js";
import { DatabaseMonitoringService } from "./modules/databases/databaseMonitoringService.js";
import { DatabaseBackupService } from "./modules/databases/databaseBackupService.js";
import { NginxSiteCollector } from "./platform/siteCollector.js";
import { RemoteTaskService } from "./modules/remote-tasks/remoteTaskService.js";
import { TerminalSnippetService } from "./modules/terminal/terminalSnippetService.js";
import { MemoryTerminalSnippetRepository, SqliteTerminalSnippetRepository } from "./modules/terminal/terminalSnippetRepository.js";
import { NativePlatformAdapter } from "./platform/nativeAdapter.js";
import type { PlatformAdapter } from "./platform/types.js";
import { FileExportRepository } from "./repositories/exportRepository.js";
import { CrontabScheduleRepository } from "./repositories/scheduleRepository.js";
import { MemoryTaskStateRepository } from "./repositories/taskStateRepository.js";
import { FileAgentControlRepository, type AgentControlRepository } from "./repositories/agentControlRepository.js";
import { ServiceError } from "./modules/serviceError.js";
import type Database from "better-sqlite3";
import { IdentityService } from "./identity/identityService.js";
import { authenticateUser, requireCsrf } from "./http/middleware/userAuthentication.js";
import { parseMasterKey } from "./security/crypto.js";
import { loadOrCreateAuditKey } from "./security/secretStore.js";
import { openDatabase } from "./database/database.js";
import { SqliteAgentControlRepository } from "./repositories/sqliteAgentControlRepository.js";
import { requestSource } from "./http/trustedProxy.js";
import { SecretStore } from "./security/secretStore.js";
import { MemorySiteManagementRepository, SqliteSiteManagementRepository, type SiteManagementRepository } from "./modules/sites/siteManagementRepository.js";
import { RemoteSiteExecutor, SiteManagementService } from "./modules/sites/siteManagementService.js";
import { DeploymentQueryService } from "./modules/deployments/deploymentQueryService.js";
import { FileService } from "./modules/files/fileService.js";
import { FileUploadRepository } from "./repositories/fileUploadRepository.js";
import { FileUploadService } from "./modules/files/fileUploadService.js";
import { DatabaseSlowQueryService } from "./modules/databases/databaseSlowQueryService.js";
import { PostgresSlowQueryCollector } from "./platform/postgresSlowQueryCollector.js";
import { SqliteDatabaseRepository } from "./repositories/sqliteDatabaseRepository.js";
import { DatabaseInventoryService } from "./modules/databases/databaseInventoryService.js";
import { DatabaseBackupWorkspaceService } from "./modules/databases/databaseBackupWorkspaceService.js";
import { DatabaseOperationService } from "./modules/databases/databaseOperationService.js";
import { DatabaseRetentionService } from "./modules/databases/databaseRetentionService.js";
import type { AuditRepository } from "./audit/auditRepository.js";
import { SystemdDatabaseCollector } from "@stackpilot/host-telemetry";
import { SystemdService } from "./modules/systemd/systemdService.js";
import { FirewallService } from "./modules/firewall/firewallService.js";
import { FirewallDenyService } from "./modules/firewall/firewallDenyService.js";
import { FirewallOpenPortService } from "./modules/firewall/firewallOpenPortService.js";
import { AuditExportService } from "./modules/audit/auditExportService.js";
import { FileScheduleExecutionRepository } from "./modules/schedules/scheduleExecutionRepository.js";
import { SshService } from "./modules/ssh/sshService.js";

export type AppOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  config?: ControllerConfig;
  platform?: PlatformAdapter;
  services?: Services;
  logger?: Logger;
  repoRoot?: string;
  agentRepository?: AgentControlRepository;
  surface?: "all" | "management" | "agent";
  database?: Database.Database;
  identity?: IdentityService | null;
};

function createFileUploadService(database: Database.Database, repoRoot: string, config: ControllerConfig): FileUploadService {
  const uploadRoot = isAbsolute(config.uploadRoot) ? config.uploadRoot : resolve(repoRoot, config.uploadRoot);
  return new FileUploadService(new FileUploadRepository(database), uploadRoot, config.uploadMaxBytes, config.uploadChunkMaxBytes);
}

export function createControllerServices(
  platform: PlatformAdapter,
  repoRoot: string,
  config: ControllerConfig,
  agentRepository?: AgentControlRepository,
  database: Database.Database | null = null,
  siteRepository?: SiteManagementRepository,
  audit?: AuditRepository,
): Services {
  const state = new MemoryTaskStateRepository();
  const exports = new FileExportRepository(repoRoot);
  const repository = agentRepository ?? new FileAgentControlRepository(isAbsolute(config.agentStatePath) ? config.agentStatePath : resolve(repoRoot, config.agentStatePath));
  const overview = new OverviewService(platform, state, repository);
  const sites = new SiteMonitoringService(new NginxSiteCollector(config.nginxConfigDirs), repository);
  const certificateRenewals = new CertificateRenewalService(repository, sites);
  const remoteTasks = new RemoteTaskService(repository);
  const managementRepository = siteRepository ?? new MemorySiteManagementRepository();
  const terminalRepository = database ? new SqliteTerminalSnippetRepository(database) : new MemoryTerminalSnippetRepository();
  const fileUploads = database ? createFileUploadService(database, repoRoot, config) : undefined;
  const databaseRepository = database && config.masterKey
    ? new SqliteDatabaseRepository(database, parseMasterKey(config.masterKey))
    : undefined;
  const nodes = new NodeService(repository);
  const databasePath = isAbsolute(config.databasePath) ? config.databasePath : resolve(repoRoot, config.databasePath);
  const scheduleExecutions = new FileScheduleExecutionRepository(
    join(dirname(databasePath), "schedule-executions"),
    join(repoRoot, "apps/controller/dist/modules/schedules/scheduleRunner.js"),
    process.execPath,
    repoRoot,
  );
  return {
    ...(database && audit ? { ssh: new SshService(database, audit) } : {}),
    overview,
    hosts: new HostMonitoringService(platform, repository, 45_000, config.production),
    databaseSlowQueries: new DatabaseSlowQueryService(new PostgresSlowQueryCollector()),
    databaseInstances: new DatabaseMonitoringService(repository, new SystemdDatabaseCollector()),
    sites,
    siteManagement: new SiteManagementService(managementRepository, sites, certificateRenewals, new RemoteSiteExecutor(remoteTasks, managementRepository), config.protectedSiteIds),
    deployments: new DeploymentQueryService(managementRepository),
    certificateRenewals,
    files: new FileService(config.fileRoot, config.fileTrashDir, config.fileUploadLimitBytes, repoRoot),
    databaseBackups: new DatabaseBackupService(database, isAbsolute(config.databasePath) ? config.databasePath : resolve(repoRoot, config.databasePath), config, repoRoot),
    tasks: new TaskService(overview, state, exports),
    risks: new RiskService(overview, exports),
    schedules: new ScheduleService(new CrontabScheduleRepository(platform, scheduleExecutions), platform, scheduleExecutions, config.crontabWriteEnabled),
    enrollments: new EnrollmentService(repository),
    nodes,
    remoteTasks,
    terminalSnippets: new TerminalSnippetService(terminalRepository, remoteTasks),
    systemd: new SystemdService(repository),
    firewall: new FirewallService(),
    firewallDeny: new FirewallDenyService(repository),
    firewallOpenPorts: new FirewallOpenPortService(),
    ...(database && audit ? { auditExports: new AuditExportService(database, audit, isAbsolute(config.auditExportDir) ? config.auditExportDir : resolve(repoRoot, config.auditExportDir)) } : {}),
    ...(databaseRepository ? {
      databaseInventory: new DatabaseInventoryService(databaseRepository),
      databaseWorkspace: new DatabaseBackupWorkspaceService(databaseRepository, audit),
      databaseOperations: new DatabaseOperationService(databaseRepository, nodes, audit),
      databaseRetention: new DatabaseRetentionService(databaseRepository),
    } : {}),
    ...(fileUploads ? { fileUploads } : {}),
  };
}

function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

function requestUrl(request: IncomingMessage, config: ControllerConfig): URL {
  return new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
}

export function createStackPilotApp(options: AppOptions = {}): RequestListener {
  const config = options.config ?? loadControllerConfig(options.env);
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const platform = options.platform ?? new NativePlatformAdapter(config, repoRoot);
  const database = options.database ?? (config.masterKey ? openDatabase(isAbsolute(config.databasePath) ? config.databasePath : resolve(repoRoot, config.databasePath)) : null);
  const identity = options.identity === undefined ? (database && config.masterKey ? new IdentityService(database, loadOrCreateAuditKey(database,parseMasterKey(config.masterKey)), config.sessionSeconds) : null) : options.identity;
  const secrets = database && config.masterKey ? new SecretStore(database, parseMasterKey(config.masterKey)) : undefined;
  const agentRepository = options.agentRepository ?? (database ? new SqliteAgentControlRepository(database,identity?.audit,secrets) : undefined);
  const siteRepository = database && secrets ? new SqliteSiteManagementRepository(database, secrets) : undefined;
  const services = options.services ?? createControllerServices(platform, repoRoot, config, agentRepository, database, siteRepository, identity?.audit);
  if (!services.fileUploads && database) services.fileUploads = createFileUploadService(database, repoRoot, config);
  const logger = options.logger ?? consoleLogger;
  const surface = options.surface ?? "all";

  return async (request: IncomingMessage, response: ServerResponse) => {
    const started = performance.now();
    const requestId = randomUUID();
    const method = request.method ?? "GET";
    let path = "/";
    let principal: import("./identity/types.js").Principal | undefined;
    let outcome="success";
    response.setHeader("X-Request-Id", requestId);
    try {
      const url = requestUrl(request, config);
      path = url.pathname;
      applyCors(request, response, config.allowedOrigins);
      if (method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const isAgentPath = url.pathname.startsWith("/api/agent/");
      const isHealthPath = url.pathname === "/healthz" || url.pathname === "/readyz";
      const isLoginPath = url.pathname === "/api/auth/login";
      const isSessionStatusPath = url.pathname === "/api/auth/session";
      const isFileChunkPath = /^\/api\/resumable-file-uploads\/[0-9a-f-]+\/chunks$/i.test(url.pathname) && method === "POST";
      if (surface === "agent" && !isAgentPath && !isHealthPath) throw new ServiceError(404, "NOT_FOUND", "接口不存在");
      if (isAgentPath && (!("encrypted" in request.socket) || request.socket.encrypted !== true)) throw new ServiceError(426, "BAD_REQUEST", "Agent API 要求 TLS");
      if (surface === "management" && isAgentPath) throw new ServiceError(426, "BAD_REQUEST", "Agent API 仅在 TLS 监听器可用");
      principal = !isAgentPath && !isHealthPath && !isLoginPath && !isSessionStatusPath ? authenticateUser(request, identity) : isSessionStatusPath && identity ? (()=>{try{return authenticateUser(request,identity);}catch{return undefined;}})() : undefined;
      if (!isAgentPath && isWriteMethod(method) && !isLoginPath && principal && identity) requireCsrf(request, principal, identity, config.allowedOrigins);
      const isFileUpload = url.pathname === "/api/file-uploads" && method === "POST";
      if (isFileUpload) identity?.require(principal, "files:write");
      const isLargeAgentPayload = url.pathname === "/api/agent/heartbeat" || url.pathname.startsWith("/api/agent/databases/");
      const bodyLimit = isLargeAgentPayload ? Math.max(config.jsonBodyLimitBytes, AGENT_API_BODY_LIMIT_BYTES) : config.jsonBodyLimitBytes;
      const parsedBody = isFileUpload ? { value: {}, raw: Buffer.alloc(0) }
        : isWriteMethod(method) && !isFileChunkPath ? await readJsonRequest(request, bodyLimit) : { value: {}, raw: Buffer.alloc(0) };
      const parts = url.pathname.split("/").filter(Boolean);
      const authenticatedAgent = isAgentPath && url.pathname !== "/api/agent/enroll"
        ? await authenticateAgentRequest(request, `${url.pathname}${url.search}`, parsedBody.raw, services.nodes)
        : undefined;
      const context = { request, response, requestId, url, parts, config, services, platform, logger, body: parsedBody.value, rawBody: parsedBody.raw, identity, ...(principal ? { principal } : {}), ...(authenticatedAgent ? { agentIdentity: { nodeId: authenticatedAgent.nodeId, credentialId: authenticatedAgent.credential.credentialId, protocolVersion: authenticatedAgent.protocolVersion } } : {}) };
      if (isAgentPath) await routeAgentRequest(context);
      else await routeRequest(context);
    } catch (error) {
      outcome="failure";
      const apiError = mapError(error, requestId, logger);
      if (!response.headersSent) sendError(response, apiError.status, apiError.code, apiError.message, requestId, apiError.headers);
      else response.destroy();
    } finally {
      if(identity&&surface!=="agent"&&isWriteMethod(method))try{const reauth=typeof request.headers["x-reauth-proof"]==="string"?"confirmed":"not-provided";identity.audit.append({actorType:principal?.type??"anonymous",actorId:principal?.userId,sessionId:principal?.type==="session"?principal.id:null,source:requestSource(request,config.trustedProxies),targetType:"http-route",targetId:path,action:`http.${method.toLowerCase()}`,parameters:{path},outcome,authorization:principal?`allowed:${[...principal.permissions].join(",")};reauth:${reauth}`:"denied:unauthenticated",requestId});}catch{logger.log({level:"error",time:new Date().toISOString(),message:"审计事件写入失败",requestId});}
      logger.log({ level: "info", time: new Date().toISOString(), message: "HTTP request", requestId, method, path, status: response.statusCode, durationMs: Math.round(performance.now() - started) });
    }
  };
}
