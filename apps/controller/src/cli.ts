import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { loadControllerConfig } from "./config/environment.js";
import { openDatabase } from "./database/database.js";
import { importLegacyAgentState } from "./database/legacyImport.js";
import { IdentityService } from "./identity/identityService.js";
import { parseMasterKey } from "./security/crypto.js";
import { loadOrCreateAuditKey, SecretStore } from "./security/secretStore.js";
import { fileURLToPath } from "node:url";

const command=process.argv[2];const config=loadControllerConfig();const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");const dbPath=isAbsolute(config.databasePath)?config.databasePath:resolve(root,config.databasePath);
function masterKey(){if(!config.masterKey)throw new Error("缺少 STACKPILOT_MASTER_KEY，操作已拒绝");return parseMasterKey(config.masterKey);}
function identity(database:Database.Database){const key=masterKey();return new IdentityService(database,loadOrCreateAuditKey(database,key),config.sessionSeconds);}
async function secretQuestion(prompt:string):Promise<string>{stdout.write(prompt);if(!stdin.isTTY)throw new Error("需要交互式终端");stdin.setRawMode?.(true);stdin.resume();let value="";return new Promise((resolveSecret,reject)=>{const onData=(chunk:Buffer)=>{for(const byte of chunk){if(byte===3){cleanup();reject(new Error("操作已取消"));return;}if(byte===13||byte===10){cleanup();stdout.write("\n");resolveSecret(value);return;}if(byte===8||byte===127){value=value.slice(0,-1);continue;}if(byte>=32)value+=String.fromCharCode(byte);}};const cleanup=()=>{stdin.off("data",onData);stdin.setRawMode?.(false);stdin.pause();};stdin.on("data",onData);});}
async function main(){
 if(command==="migrate"){openDatabase(dbPath).close();stdout.write("数据库迁移完成。\n");return;}
 if(command==="init"){if(!stdin.isTTY)throw new Error("首次管理员只能从本机交互式终端创建");const database=openDatabase(dbPath);const service=identity(database);if(service.hasAdministrator())throw new Error("系统已有管理员");const rl=createInterface({input:stdin,output:stdout});try{const username=await rl.question("管理员用户名: ");const displayName=await rl.question("显示名称: ");rl.close();const password=await secretQuestion("密码（12-128 字符）: ");await service.createInitialAdministrator(username,displayName,password);stdout.write("首位管理员已创建。\n");}finally{rl.close();database.close();}return;}
 if(command==="audit-verify"){const database=openDatabase(dbPath);const result=identity(database).audit.verify();database.close();stdout.write(`${JSON.stringify(result)}\n`);if(!result.valid)process.exitCode=2;return;}
 if(command==="import-legacy"){const database=openDatabase(dbPath);const path=isAbsolute(config.agentStatePath)?config.agentStatePath:resolve(root,config.agentStatePath);const result=await importLegacyAgentState(database,path);database.close();stdout.write(`旧状态${result.imported?"已导入":"已导入过"}；源文件保持不变；SHA-256 ${result.digest}\n`);return;}
 if(command==="secrets-rotate"){const next=process.env.STACKPILOT_NEW_MASTER_KEY;if(!next)throw new Error("缺少 STACKPILOT_NEW_MASTER_KEY");const database=openDatabase(dbPath);new SecretStore(database,masterKey()).rotate(parseMasterKey(next),2);database.close();stdout.write("敏感数据已使用新主密钥重新加密；请切换 STACKPILOT_MASTER_KEY 后重启。\n");return;}
 const target=process.argv[3];if(command==="backup"){if(!target)throw new Error("用法: npm run db:backup -- <backup-path>");if(!existsSync(dbPath))throw new Error("数据库不存在，无法备份");const database=new Database(dbPath);database.pragma("foreign_keys = ON");database.pragma("busy_timeout = 5000");const integrity=database.pragma("integrity_check",{simple:true});const version=(database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as {version:number|null}).version;if(integrity!=="ok"||![1,2,3,4,5,6,7,8,9,10,11,12].includes(version??0)){database.close();throw new Error("当前数据库完整性或 schema 版本不在支持范围，备份已拒绝");}await database.backup(resolve(target));database.close();stdout.write(`数据库 schema ${version} 在线备份完成。\n`);return;}
 if(command==="restore"){if(!target)throw new Error("用法: npm run db:restore -- <backup-path>");const source=resolve(target);if(source===dbPath)throw new Error("恢复源不能是当前数据库");const candidate=new Database(source,{readonly:true});const integrity=candidate.pragma("integrity_check",{simple:true});const version=(candidate.prepare("SELECT max(version) AS version FROM schema_migrations").get() as {version:number|null}).version;candidate.close();if(integrity!=="ok"||![1,2,3,4,5,6,7,8,9,10,11,12].includes(version??0))throw new Error("备份完整性或 schema 版本不在支持范围，恢复已拒绝");const temporary=`${dbPath}.restore.tmp`;copyFileSync(source,temporary);if(existsSync(dbPath))renameSync(dbPath,`${dbPath}.before-restore`);renameSync(temporary,dbPath);stdout.write(`数据库 schema ${version} 已恢复；原数据库保留为 .before-restore。\n`);return;}
 throw new Error("未知命令");
}
main().catch((error)=>{rmSync(`${dbPath}.restore.tmp`,{force:true});process.stderr.write(`${error instanceof Error?error.message:"操作失败"}\n`);process.exitCode=1;});
