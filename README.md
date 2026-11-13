# StackPilot

StackPilot 是开源自托管多服务器总控台。当前仓库采用 npm workspaces，包含前端控制台、Node.js Controller API、非 root Agent、root-only 数据库 helper 和共享运行时契约。

> **项目成熟度：预览版。** 当前版本为 `0.3.0-preview.52`，提供可重复的部署、迁移、回滚和发布验证流程，但尚未达到稳定生产发布条件，也不提供 SLA。正式支持范围和已验证边界见[兼容性矩阵](docs/compatibility.md)。

## 当前前端范围

- 总览：服务器健康摘要、服务器列表、待处理事项、最近审计。
- 服务器：Agent 安装命令、节点状态、资源占用、常用操作入口。
- 服务：Agent 只读采集的 systemd 服务状态、资源指标和脱敏 journal 摘要。
- 防火墙：Controller 主机真实 UFW 状态、规则和监听端口；Agent 上报的真实拦截记录；规则变更仅允许操作 StackPilot 受管规则。
- 发布：GitHub/GitLab 项目发布列表、阶段进度、失败原因、日志、重试和回滚入口。
- 审计日志：关键操作筛选、来源信息和详情追踪。
- 设置：中心地址、token 策略、主题偏好、通知偏好、安全配置和保存反馈。

## 目录结构

```text
apps/
  web/          React、Vite 和 TypeScript 前端
  controller/   严格 TypeScript Controller API（HTTP、业务、存储与平台适配分层）
  agent/        独立非 root Agent，负责节点采集和签名任务投递
  cert-helper/  root-only 证书与防火墙操作边界，仅接受固定协议
  database-helper/ root-only 本机数据库操作边界，仅接受严格枚举参数
packages/
  contracts/    前后端共享 API、错误和领域契约
  config/       Web 与 Controller 共用的安全开发默认值
deploy/         Docker Compose、systemd、nginx、安装和发布脚本
docs/           项目文档
tests/          Controller、Web、公共包和架构边界测试
```

Controller 与 Agent 通信的威胁、信任边界和残余风险记录在 [Controller-Agent 威胁模型](docs/security/controller-agent-threat-model.md)。Agent 是独立 TypeScript 进程，不导入 Controller 内部实现。

SSH 管理已接通 Controller、独立 root helper、原生 PAM、接管验证与真实管理界面，并在两种受支持的测试虚拟机完成基础接管和配置恢复后的重新验证。提供独立的被动安装器和显式注册服务；完整故障、权限与发布安全验收仍在进行，升级不会自动接管服务器。见 [SSH 实现状态](docs/ssh-access.md)。

## 本地运行

开发要求 Node.js `^20.19.0` 或 `>=22.12.0`、npm 10 或更高版本；正式部署只支持 Node.js 22.x，CI 固定使用 22.22.0。首次运行先从仓库根目录安装锁定依赖：

```bash
npm ci
```

Controller 直接读取启动进程的环境变量，不自动加载根目录 `.env` 文件。首次启动需要生成主密钥、在本机交互式终端创建管理员，然后启动 Controller 与 Web：

PowerShell：

```powershell
$env:STACKPILOT_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
$env:STACKPILOT_COOKIE_SECURE = "0"
npm run build --workspace @stackpilot/controller
npm run db:init --workspace @stackpilot/controller
npm run dev
```

Bash：

```bash
export STACKPILOT_MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
export STACKPILOT_COOKIE_SECURE=0
npm run build --workspace @stackpilot/controller
npm run db:init --workspace @stackpilot/controller
npm run dev
```

也可以分别启动两个应用：

```bash
npm run dev:controller
npm run dev:web
```

前端默认访问 `http://127.0.0.1:5173`，API 默认监听 `http://127.0.0.1:8787`。Web 的 dev 和 preview 脚本都只绑定 `127.0.0.1`。确实需要局域网访问开发前端时，必须显式执行：

```bash
npm run dev --workspace @stackpilot/web -- --host 0.0.0.0
```

这只改变前端监听地址，不会放宽 API 认证、CORS 或危险能力开关。公开监听前应先配置防火墙和精确来源白名单。

## 安全配置

`.env.example` 是配置参考，不包含可用令牌。当前 API 直接读取启动进程的环境变量，不会自动加载 `.env` 文件。不要使用 `VITE_` 前缀保存服务端令牌，因为该前缀会把值暴露给浏览器构建。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API 监听地址；监听地址不参与身份认证。 |
| `PORT` | `8787` | API 端口。 |
| `STACKPILOT_MASTER_KEY` | 未配置 | 必需的 32 字节主密钥；缺失时 Controller 安全失败。不得存入数据库、Git 或日志。 |
| `STACKPILOT_DATABASE_PATH` | `.stackpilot/stackpilot.sqlite3` | SQLite 数据库路径。 |
| `STACKPILOT_COOKIE_SECURE` | `1` | Cookie 的 `Secure` 属性；只有本机 HTTP 开发可显式设为 `0`。 |
| `STACKPILOT_SESSION_SECONDS` | `43200` | 可撤销浏览器会话期限。 |
| `STACKPILOT_ALLOWED_ORIGINS` | 本机 `5173`/`4173` 的 `localhost` 与 `127.0.0.1` 来源 | 逗号分隔的精确 HTTP(S) 来源；不允许 `*` 或带路径的 URL。设为空字符串可禁止所有跨域来源。 |
| `STACKPILOT_JSON_BODY_LIMIT_BYTES` | `65536` | 管理端 JSON 请求体字节上限，超限返回 `413`；严格校验的 Agent API 为遥测保留最多 `1 MiB`。 |
| `STACKPILOT_UPLOAD_ROOT` | `.stackpilot/uploads` | Controller 本机上传根目录。浏览器只能选择该根目录下的相对目录，不能写任意绝对路径。 |
| `STACKPILOT_UPLOAD_MAX_BYTES` | `1073741824` | 单文件最大字节数。 |
| `STACKPILOT_UPLOAD_CHUNK_MAX_BYTES` | `8388608` | 单个上传分片最大字节数；反向代理必须允许同等大小。 |
| `STACKPILOT_ENABLE_CRONTAB_WRITE` | `0` | 危险开关；只有精确设置为 `1` 才允许 crontab 写入、修改、删除和立即执行。 |
| `STACKPILOT_BACKUP_DIRS` | 未配置 | 可选备份目录列表，供本机平台采集使用。 |
| `STACKPILOT_FILE_ROOT` | `.stackpilot/files` | 文件管理器唯一允许访问的受管根目录；浏览器只使用该根下的虚拟路径。 |
| `STACKPILOT_FILE_TRASH_DIR` | `.stackpilot/file-trash` | 回收站元数据、上传历史及隔离文件目录，必须仅允许 Controller 写入。 |
| `STACKPILOT_FILE_UPLOAD_LIMIT_BYTES` | `134217728` | 单文件上传字节上限；反向代理限制必须不低于该值。 |
| `STACKPILOT_NGINX_CONFIG_DIRS` | `/etc/nginx/conf.d,/etc/nginx/sites-enabled` | 逗号分隔的只读 Nginx 配置目录，供站点运行时自动发现使用。 |
| `STACKPILOT_NODE_RESTART_COMMAND` | 未配置 | 受控兼容开关；配置后允许已认证的本机节点重启入口执行该命令。 |
| `STACKPILOT_API_PROXY_TARGET` | `http://127.0.0.1:8787` | 仅用于覆盖 Web 开发代理目标；不改变 Controller 安全边界。 |
| `STACKPILOT_AGENT_PORT` | `9443` | HTTPS Agent API 端口。只有同时配置证书和私钥路径才启动。 |
| `STACKPILOT_AGENT_HOST` | `127.0.0.1` | 独立 Agent HTTPS 监听地址；不会改变管理 API 的 `HOST`。远程接入必须显式开放。 |
| `STACKPILOT_AGENT_TLS_CERT_PATH` | 未配置 | Controller Agent API TLS 证书。 |
| `STACKPILOT_AGENT_TLS_KEY_PATH` | 未配置 | Controller Agent API TLS 私钥；不得提交。 |
| `STACKPILOT_AGENT_STATE_PATH` | `.stackpilot/controller-agent-state.json` | 仅供显式导入旧节点状态，不再是 Controller 主存储。 |

浏览器使用 `HttpOnly`、`SameSite=Strict`、默认 `Secure` 的随机 Cookie 会话；会话标识在数据库中只保存摘要。Cookie 状态变更还需内存 CSRF 值和精确允许的 Origin。前端不在 `localStorage` 或 `sessionStorage` 保存登录 Token。除 `/healthz` 和 `/readyz` 外，Controller 管理 API 均要求登录会话或受限 API Token，并在服务端校验具体权限与节点范围。

内置角色为管理员、运维人员和只读审计员。高风险的节点撤销、远程任务、用户权限和 API Token 操作还要求五分钟内的一次性密码重新认证证明。API Token 只保存摘要，可设置名称、权限、节点范围、期限并立即撤销，明文仅在创建响应中出现一次。

服务端不使用 `Origin`、客户端 IP、监听地址、`Host` 或 `X-Forwarded-*` 判断身份。只有来自 `STACKPILOT_TRUSTED_PROXIES` 精确 IP/CIDR 的转发头可用于审计来源；其他转发头被忽略，可信来源也不能替代会话、API Token 或 Agent 签名。

## 本地 Controller-Agent 验证

当前 Agent 协议版本为 `1.1`。Controller 仅接受明确列出的 `1.0` 和 `1.1`，其他协议版本均拒绝；数据库能力只在 `1.1` Agent 与本机 helper 均可用时启用。开发环境先显式生成 30 天本地证书：

```bash
npm run agent:cert
```

该命令只写入被 Git 忽略的 `.stackpilot/dev-certs/`。这是开发证书，不得用于生产。Agent 必须显式信任证书文件；禁止设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或关闭证书验证。

配置并启动 Controller：

```powershell
$env:STACKPILOT_MASTER_KEY = "<32-byte master key>"
$env:STACKPILOT_COOKIE_SECURE = "0"
$env:STACKPILOT_AGENT_TLS_CERT_PATH = ".stackpilot/dev-certs/controller-cert.pem"
$env:STACKPILOT_AGENT_TLS_KEY_PATH = ".stackpilot/dev-certs/controller-key.pem"
npm run dev:controller
```

管理员登录 Web、完成密码重新认证后，可创建仅用于指定节点、五分钟有效、一次性的注册凭据。API Token 不能绕过此交互式高风险确认，也不能替代 Agent 身份。

```powershell
# 在 Web 的 Agent 节点抽屉中输入当前密码完成重新认证并创建凭据。
```

在被控主机以专用非 root 用户启动 Agent。注册 Token 只放入首次启动进程环境，注册完成后 Agent 会从当前进程环境删除它，并在 `0700` 状态目录中以 `0600` 保存自己的独立 Ed25519 私钥：

```powershell
$env:STACKPILOT_CONTROLLER_URL = "https://localhost:9443"
$env:STACKPILOT_AGENT_CA_PATH = ".stackpilot/dev-certs/controller-cert.pem"
$env:STACKPILOT_AGENT_STATE_DIR = ".stackpilot/agent-node-a"
$env:STACKPILOT_AGENT_NAME = "node-a"
$env:STACKPILOT_AGENT_ENROLLMENT_TOKEN = $enrollment.token
npm run dev:agent
```

第二个 Agent 必须创建另一个 enrollment，并使用不同状态目录。所有 Agent 请求由节点私钥签名，覆盖请求方法、路径、时间、nonce 和 body digest；Controller 持久化 nonce 以拒绝重放。用户会话和 API Token 不能代替 Agent 身份，来源 IP 也不参与认证。

主机页面使用 `/api/hosts` 每 10 秒静默读取 Controller 本机和授权范围内的 Agent 遥测。systemd 页面以同样节奏读取 Controller 保存的有界 Agent 快照；Agent 只执行固定 `systemctl` / `journalctl` 参数，上传前脱敏常见凭据，并限制服务、日志条目和消息长度。Agent 每 15 秒上报主机遥测，并每 60 秒通过本机 helper 互斥采集数据库快照和有界查询数据；数据库页面的 10 秒轮询只读取 Controller 已保存的快照。升级顺序固定为 Controller/Web、database-helper、Agent。

需要轮换单个 Agent身份时，在该 Agent下一次启动前设置 `STACKPILOT_AGENT_ROTATE_CREDENTIAL=1`。Agent会先安全保存 pending 私钥，再用当前身份执行带 rotation ID 的幂等轮换；响应丢失时可继续同一轮换，成功后旧凭据立即撤销。管理员撤销节点后，旧身份和轮换恢复路径都会被拒绝。

Agent 任务注册表支持：

- `system.summary.read`：读取主机名、平台、CPU/内存、运行时间和可选负载摘要；
- `service.status.read`：使用固定平台程序和固定参数形式查询单个服务状态；
- `sites.certificates.renew`：仅 Linux 且管理员显式授权，通过本地 root helper 续期 Nginx/Certbot 证书。

不存在通用 Shell、脚本正文或动态可执行路径。Agent 默认拒绝以 root 运行。Linux Agent 每 60 秒采集一次 Nginx 站点与公开 PEM 证书，从不读取私钥；可选续期通过 systemd Unix Socket root helper 完成，只接受 opaque 证书 ID 和固定命令。Docker Agent 只支持清单采集，不直接续期宿主证书。节点列表和任务状态位于 `/api/nodes` 与 `/api/remote-tasks`，要求用户会话或具备相应权限和节点范围的 API Token。

发现安全漏洞时不要创建公开 Issue。请遵循 [SECURITY.md](SECURITY.md)；仓库维护者还需要在 GitHub 设置中启用 Private Vulnerability Reporting，当前没有已验证的安全邮箱。

## 危险能力开关

即使用户已通过权限和重新认证，crontab 创建、修改、删除和立即执行默认仍返回 `403`。只有在理解任意计划命令及立即执行可获得当前 API 进程用户权限后，才应在 API 进程环境中设置：

```powershell
$env:STACKPILOT_ENABLE_CRONTAB_WRITE = "1"
npm run dev:controller
```

身份/RBAC 和危险开关是独立的服务端检查；前端隐藏或禁用按钮不能替代它们。

## 数据库、密钥与审计

Controller 使用 SQLite、事务迁移和外键保存用户、角色、会话、节点、任务、Token 状态与审计。密码使用 Argon2id；API Token 和会话只保存 SHA-256 摘要；需要解密的秘密使用 AES-256-GCM，主密钥只来自进程环境。审计是追加式 HMAC 哈希链，普通 API 不提供更新或删除入口，数据库触发器也会拒绝修改。

```bash
npm run db:migrate --workspace @stackpilot/controller
npm run db:import-legacy --workspace @stackpilot/controller
npm run db:backup --workspace @stackpilot/controller -- .stackpilot/backups/stackpilot.sqlite3
npm run db:restore --workspace @stackpilot/controller -- .stackpilot/backups/stackpilot.sqlite3
npm run audit:verify --workspace @stackpilot/controller
```

完整初始化、旧 JSON 导入、主密钥轮换与恢复流程见 [身份、数据与审计运维](docs/security/identity-and-data.md)。旧 JSON 不会被静默删除或覆盖。

## 验证

以下命令与 GitHub Actions CI 一致：

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run test:deploy
npm run build
npm run test:e2e
npm audit --audit-level=high
npm run release:build
npm run release:verify -- output/release/0.3.0-preview.52/SHA256SUMS
npm run release:scan
```

CI 使用 Ubuntu 24.04 和 Node.js 22.22.0，额外构建并扫描三类镜像、验证 Compose/systemd、执行升级恢复演练与桌面/移动 HTTPS E2E。依赖、镜像或部署配置出现高危/严重漏洞会使 CI 失败。

Controller 使用 `zod` 作为共享运行时 schema：Web 与 Controller 从 `@stackpilot/contracts` 消费同一请求、响应、错误和领域契约。`/healthz` 只表示进程存活，`/readyz` 表示平台依赖是否就绪；两者均不返回主机敏感信息。Controller 的结构化请求日志包含请求 ID、方法、路径、状态和耗时，并对认证、Cookie、令牌和命令输出字段脱敏。

各 workspace 可从根目录独立操作：

```bash
npm install --workspace @stackpilot/web
npm run dev --workspace @stackpilot/web
npm run build --workspace @stackpilot/web
npm run test --workspace @stackpilot/web

npm install --workspace @stackpilot/controller
npm run dev --workspace @stackpilot/controller
npm run typecheck --workspace @stackpilot/controller
npm run build --workspace @stackpilot/controller
npm run test --workspace @stackpilot/controller

npm run dev --workspace @stackpilot/agent
npm run typecheck --workspace @stackpilot/agent
npm run build --workspace @stackpilot/agent
npm run test --workspace @stackpilot/agent
```

`apps/agent` 是独立非 root 进程，使用结构化任务且不存在通用 Shell。`apps/cert-helper` 是仅供原生 Linux Nginx/Certbot 使用的最小 root helper，通过本地 systemd Socket 激活。生产部署必须使用私有 Agent 网络、独立节点身份与真实 CA 证书。

## 生产部署与发布

正式支持的 Controller/Web 运行时为 Debian 12 或 Ubuntu 24.04 x86_64、Node.js 22.x 和 SQLite schema 12。Docker Compose 默认仅公开 HTTPS 443；Controller 8787 位于内部网络，Agent 9443 默认只绑定回环地址。原生 systemd 方案为 Controller、Agent、站点 helper 和 database-helper 建立独立权限边界，并通过 systemd credential 注入主密钥和 TLS 私钥。Agent/helper 的其他发行版能力只有通过固定镜像集成测试后才列入兼容性矩阵。

- [Docker Compose 安装](docs/installation/docker-compose.md)
- [systemd 安装](docs/installation/systemd.md)
- [反向代理与安全加固](docs/security-hardening.md)
- [Agent 证书生命周期](docs/operations/agent-certificates.md)
- [升级说明](docs/upgrades/0.3.0-preview.37.md)
- [备份与恢复](docs/backup-restore/README.md)
- [生产排障](docs/troubleshooting/production.md)

官方发布包含版本化归档、CycloneDX SBOM、第三方许可清单、来源信息和 SHA-256。标签工作流用 GitHub OIDC 进行 Cosign keyless 签名；本地构建不会伪造签名，只生成 `SIGNING_REQUIRED.txt`。

## 文档

- [贡献指南](CONTRIBUTING.md)：开发环境、分支、提交与 Pull Request 要求。
- [安全策略](SECURITY.md)：支持范围、私密漏洞报告和响应流程。
- [身份、数据与审计运维](docs/security/identity-and-data.md)：初始化、会话、RBAC、密钥轮换、迁移和备份恢复。
- [版本与兼容性](docs/compatibility.md)：支持平台、协议和数据库升级范围。
- [发布检查清单](docs/release-checklist.md)：正式标签的强制门禁与签名要求。
- [帮助中心](docs/help.md)：当前入口与本地排障。
- [前端验收清单](docs/frontend-acceptance.md)：现有前端质量与响应式验收范围。
- [行为准则](CODE_OF_CONDUCT.md)：社区参与和执行标准。

## 许可证

本项目按 [GNU Affero General Public License v3.0 only](LICENSE) 发布，SPDX 标识为 `AGPL-3.0-only`。当前界面中的仓库链接指向本项目公开源码。修改后的版本若通过网络向用户提供交互，应按 AGPLv3 第 13 节向这些用户提供对应源码。第三方依赖仍适用各自的许可证。
