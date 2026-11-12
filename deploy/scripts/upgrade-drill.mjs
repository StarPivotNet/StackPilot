import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase } from "../../apps/controller/dist/database/migrator.js";

const root=resolve(import.meta.dirname,"../..");const work=resolve(root,"output","upgrade-drill");rmSync(work,{recursive:true,force:true});mkdirSync(work,{recursive:true});
const databasePath=resolve(work,"stackpilot.sqlite3");const backupPath=resolve(work,"pre-upgrade.sqlite3");const marker="upgrade-drill-user";const migrationOne=readFileSync(resolve(root,"apps/controller/src/database/migrations/001_identity.sql"),"utf8");
const database=new Database(databasePath);migrateDatabase(database,[{version:1,name:"identity-rbac-agent-audit",sql:migrationOne}]);const now=new Date().toISOString();database.prepare("INSERT INTO users(id,username,password_hash,display_name,password_changed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("11111111-1111-4111-8111-111111111111",marker,"not-a-login-hash","Upgrade Drill",now,now,now);database.close();
const cert=resolve(work,"agent.crt");const key=resolve(work,"agent.key");writeFileSync(cert,"drill placeholder\n");writeFileSync(key,"drill placeholder\n");const npmCli=process.env.npm_execpath;if(!npmCli)throw new Error("必须通过 npm run release:drill 启动演练");const env={...process.env,STACKPILOT_DATABASE_PATH:databasePath,STACKPILOT_MASTER_KEY:randomBytes(32).toString("base64url"),STACKPILOT_COOKIE_SECURE:"1",STACKPILOT_PRODUCTION:"1",STACKPILOT_ALLOWED_ORIGINS:"https://stackpilot.invalid",STACKPILOT_AGENT_TLS_CERT_PATH:cert,STACKPILOT_AGENT_TLS_KEY_PATH:key};
execFileSync(process.execPath,[resolve(root,"deploy/scripts/upgrade.mjs"),backupPath],{cwd:root,env,stdio:"inherit"});
const checksum=createHash("sha256").update(readFileSync(backupPath)).digest("hex");const manifest=readFileSync(`${backupPath}.sha256`,"utf8");if(!manifest.startsWith(checksum))throw new Error("备份校验值不匹配");
const upgraded=new Database(databasePath,{readonly:true});if(upgraded.prepare("SELECT max(version) AS version FROM schema_migrations").get().version!==11||upgraded.prepare("SELECT username FROM users WHERE username=?").get(marker)?.username!==marker)throw new Error("升级后数据验证失败");upgraded.close();
rmSync(databasePath,{force:true});execFileSync(process.execPath,[npmCli,"run","db:restore","--workspace","@stackpilot/controller","--",backupPath],{cwd:root,env,stdio:"inherit"});
const restored=new Database(databasePath,{readonly:true});if(restored.pragma("integrity_check",{simple:true})!=="ok"||restored.prepare("SELECT max(version) AS version FROM schema_migrations").get().version!==1||restored.prepare("SELECT username FROM users WHERE username=?").get(marker)?.username!==marker)throw new Error("恢复后 schema、完整性或数据验证失败");restored.close();
process.stdout.write(`schema 1→11 升级、SHA-256 校验、测试实例删除及 schema 1 回滚恢复演练通过：${work}\n`);
