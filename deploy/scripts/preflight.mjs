import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { loadControllerConfig } from "../../apps/controller/dist/config/environment.js";
import { parseMasterKey } from "../../apps/controller/dist/security/crypto.js";
import { isAgentProtocolCompatible } from "@stackpilot/contracts";

const requiredFree=512*1024*1024;const config=loadControllerConfig();const databasePath=resolve(config.databasePath);const checks=[];
const isExecutable=(path)=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}};
const isDirectory=(path)=>{try{return statSync(path).isDirectory();}catch{return false;}};
const systemGroupExists=(name)=>{try{execFileSync("getent",["group",name],{stdio:"ignore"});return true;}catch{return false;}};
const major=Number(process.versions.node.split(".")[0]);checks.push([major===22,`Node.js ${process.versions.node}（生产仅支持 22.x）`]);
checks.push([Boolean(config.masterKey),"主密钥已配置"]);if(config.masterKey)try{parseMasterKey(config.masterKey);checks.push([true,"主密钥格式有效"]);}catch{checks.push([false,"主密钥格式无效"]);}
checks.push([config.cookieSecure,"Secure Cookie 已启用"]);checks.push([config.allowedOrigins.every(value=>value.startsWith("https://")),"所有允许来源均使用 HTTPS"]);checks.push([Boolean(config.agentTlsCertPath&&config.agentTlsKeyPath),"Agent TLS 证书与私钥已配置"]);
if(config.crontabWriteEnabled){checks.push([isExecutable("/usr/bin/crontab"),"crontab 写能力依赖可执行的 /usr/bin/crontab（Debian/Ubuntu 请安装 cron 包）"]);checks.push([systemGroupExists("crontab"),"crontab 写能力依赖现有的 crontab 系统组（Debian/Ubuntu 请安装 cron 包）"]);checks.push([isDirectory("/var/spool/cron/crontabs"),"crontab 写能力依赖 /var/spool/cron/crontabs 目录（请安装或修复 cron 包）"]);}
let diskPath=databasePath;while(!existsSync(diskPath)){const parent=dirname(diskPath);if(parent===diskPath)break;diskPath=parent;}const disk=statfsSync(diskPath);checks.push([disk.bavail*disk.bsize>=requiredFree,"数据库卷至少有 512 MiB 可用空间"]);
if(existsSync(databasePath)){const db=new Database(databasePath,{readonly:true});const integrity=db.pragma("integrity_check",{simple:true});const schema=(db.prepare("SELECT max(version) AS version FROM schema_migrations").get()).version;checks.push([integrity==="ok","SQLite integrity_check 通过"]);checks.push([[1,2,3,4,5,6,7,8,9,10,11,12].includes(schema),`数据库 schema ${schema} 可升级到 12`]);const versions=db.prepare("SELECT DISTINCT json_extract(payload,'$.agentVersion') AS version FROM agent_nodes WHERE revoked_at IS NULL").all().map(row=>row.version).filter(Boolean);checks.push([versions.every(version=>String(version).startsWith("0.1.")||String(version).startsWith("0.2.")||String(version).startsWith("0.3.")),"已注册 Agent 版本在 0.1.x/0.2.x/0.3.x 兼容范围"]);db.close();}
checks.push([isAgentProtocolCompatible("1.0")&&isAgentProtocolCompatible("1.1"),"Agent 协议 1.0/1.1 兼容"]);
for(const[ok,message]of checks)process.stdout.write(`${ok?"PASS":"FAIL"} ${message}\n`);if(checks.some(([ok])=>!ok))process.exitCode=1;
