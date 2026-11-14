import { createServer } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as HttpsServerOptions } from "node:https";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createControllerServices, createStackPilotApp, type AppOptions } from "./app.js";
import { loadControllerConfig } from "./config/environment.js";
import { NativePlatformAdapter } from "./platform/nativeAdapter.js";
import { openDatabase } from "./database/database.js";
import { IdentityService } from "./identity/identityService.js";
import { loadOrCreateAuditKey, SecretStore } from "./security/secretStore.js";
import { parseMasterKey } from "./security/crypto.js";
import { SqliteAgentControlRepository } from "./repositories/sqliteAgentControlRepository.js";
import { SqliteSiteManagementRepository } from "./modules/sites/siteManagementRepository.js";

function assertLegacyStateImported(config:ReturnType<typeof loadControllerConfig>,repoRoot:string):void{const legacyPath=isAbsolute(config.agentStatePath)?config.agentStatePath:resolve(repoRoot,config.agentStatePath);if(!existsSync(legacyPath))return;const digest=createHash("sha256").update(readFileSync(legacyPath)).digest("hex");const databasePath=isAbsolute(config.databasePath)?config.databasePath:resolve(repoRoot,config.databasePath);const database=openDatabase(databasePath);const imported=database.prepare("SELECT 1 FROM legacy_imports WHERE source_path=? AND source_digest=?").get(legacyPath,digest);database.close();if(!imported)throw new Error("Legacy Agent state must be explicitly imported before startup");}

export function createStackPilotServer(options: AppOptions = {}) {
  return createServer(createStackPilotApp({ ...options, surface: "management" }));
}

export function createStackPilotAgentServer(tls: HttpsServerOptions, options: AppOptions = {}) {
  return createHttpsServer({ ...tls, minVersion: "TLSv1.2" }, createStackPilotApp({ ...options, surface: "agent" }));
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const config = loadControllerConfig();
    if (!config.masterKey) throw new Error("STACKPILOT_MASTER_KEY is required");
    if (!config.cookieSecure && config.host !== "127.0.0.1" && config.host !== "localhost") throw new Error("Insecure cookies are allowed only on loopback development listeners");
    if(config.production&&(!config.agentTlsCertPath||!config.agentTlsKeyPath))throw new Error("Production Controller requires Agent TLS certificate and key");
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    assertLegacyStateImported(config,repoRoot);
    const platform = new NativePlatformAdapter(config, repoRoot);
    const databasePath=isAbsolute(config.databasePath)?config.databasePath:resolve(repoRoot,config.databasePath);
    const database=openDatabase(databasePath);
    const identity=new IdentityService(database,loadOrCreateAuditKey(database,parseMasterKey(config.masterKey)),config.sessionSeconds);
    const secrets=new SecretStore(database,parseMasterKey(config.masterKey));
    const agentRepository=new SqliteAgentControlRepository(database,identity.audit,secrets);
    const siteRepository=new SqliteSiteManagementRepository(database,secrets);
    const services = createControllerServices(platform, repoRoot, config, agentRepository, database, siteRepository, identity.audit);
    await services.sites.startup();
    await services.certificateRenewals.startup();
    services.egress.start();
    const appOptions={ config, services, platform, repoRoot,database,identity,agentRepository };
    const server = createStackPilotServer(appOptions);
    const agentServer = config.agentTlsCertPath && config.agentTlsKeyPath
      ? createStackPilotAgentServer({ cert: readFileSync(config.agentTlsCertPath), key: readFileSync(config.agentTlsKeyPath) }, appOptions)
      : null;

    server.listen(config.port, config.host, () => {
      services.siteManagement.startBackgroundReconciliation(10_000, () => {
        process.stderr.write("StackPilot site operation reconciliation failed; it will be retried.\n");
      });
      process.stdout.write(`StackPilot Controller listening on http://${config.host}:${config.port}\n`);
    });
    if (agentServer) agentServer.listen(config.agentPort, config.agentHost, () => process.stdout.write(`StackPilot Agent API listening on https://${config.agentHost}:${config.agentPort}\n`));
    else process.stdout.write("StackPilot Agent API disabled: TLS certificate and key are not configured.\n");

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        services.sites.shutdown();
        services.databaseRetention?.shutdown();
        services.auditExports?.shutdown();
        services.egress.shutdown();
        const reconciliationStopped = services.siteManagement.stopBackgroundReconciliation();
        let remaining=agentServer?2:1;const closed=()=>{remaining-=1;if(remaining===0){void reconciliationStopped.finally(()=>{database.close();process.exit(0);});}};
        agentServer?.close(closed);
        server.close(closed);
      });
    }
  } catch {
    process.stderr.write("StackPilot Controller configuration is invalid; server was not started.\n");
    process.exitCode = 1;
  }
}
