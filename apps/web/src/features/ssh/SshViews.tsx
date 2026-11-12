import { useState } from "react";
import type { Notify } from "../../types/app";
import type { SshWorkspace } from "./useSshWorkspace";
import { sshPreflightItems, sshVerificationItems, validateSshDraft } from "./model";
import { SshAction, SshChecks, SshDefinition, SshEmpty, SshNote, SshPanel, SshWaiting } from "./SshPrimitives";
import { SshDraftForm } from "./SshDraftForm";

type ViewProps = { workspace: SshWorkspace; notify: Notify };

export function SshPolicyView({ workspace, notify }: ViewProps) {
  return <><SshEmpty title="授权策略等待接入">未读取到真实主机、Linux 账号与操作者授权；不会使用画布示例策略。</SshEmpty><SshDraftForm kind="policy" workspace={workspace} notify={notify} /><div className="ssh-columns"><SshPanel title="主机端执行授权范围"><SshDefinition items={[["主机范围", "指定主机，不是任意持平台证书即可通行"], ["Linux 账号", "由各目标主机核对允许的账号与 principal"], ["操作者", "绑定真实平台身份与审批主体"], ["有效期", "由实际策略上限决定，客户端草稿不能扩大授权"]]} /></SshPanel><SshPanel title="计划中的认证基线"><SshDefinition items={[["允许的凭据", "受控平台 CA 签发的短期用户证书"], ["原认证路径", "逐项检查并停用密码、个人公钥、云注入、外部命令和非平台 CA 等来源"], ["范围校验", "主机、账号、操作者和有效期同时匹配"], ["配置漂移", "额外入口或旧来源恢复时，需要重新核验"]]} /></SshPanel></div><SshNote title="当前没有已生效的 SSH 策略">草稿中的目标值不是主机端当前配置。保存、审批、分发和验证都需要服务端权限与真实能力接入。</SshNote></>;
}

export function SshAuditView() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState("全部结果");
  return <><div className="ssh-filter-row"><label className="ssh-search-field"><span>搜索 SSH 审计</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="主机、凭据、操作者或 trace ID" /></label><label className="ssh-select-field"><span>结果</span><select value={result} onChange={(event) => setResult(event.target.value)}><option>全部结果</option><option>成功</option><option>失败</option><option>等待验证</option></select></label><SshAction>导出 SSH 审计</SshAction></div><SshEmpty title="SSH 审计等待接入">当前没有来自 SSH 服务的签发、下载、验证、吊销或救援记录。筛选不会生成示例事件。</SshEmpty><SshPanel title="需要保留的审计证据"><SshDefinition items={[["访问主体", "平台操作者、审批人与来源"], ["目标身份", "主机稳定 ID、地址、Linux 账号与主机指纹"], ["凭据生命周期", "CA / 证书序列号、签发、领取、到期与吊销结果"], ["保护与恢复", "实际配置检查、独立新连接、负向验证、回滚与带外恢复结果"]]} /></SshPanel><SshNote title="审计不包含私钥或登录密码">只有服务端返回的真实记录才能显示成功、已拒绝或已恢复。其他模块的资源状态不代替 SSH 验证证据。</SshNote></>;
}

export function SshCredentialView({ page, workspace, notify }: ViewProps & { page: string }) {
  if (page === "ssh-revoke") return <><div className="ssh-columns"><SshPanel title="撤销后续登录"><SshEmpty title="尚无可吊销的真实凭据">需取得凭据目录、授权范围及逐主机吊销回执。</SshEmpty><SshDefinition items={[["目标主机", "等待凭据授权范围"], ["KRL / 吊销版本", "等待后端"], ["逐主机应用结果", "尚未取得"], ["撤销完成", "所有授权目标确认应用并验证新登录被拒绝后才可确认"]]} /><SshAction>吊销凭据</SshAction></SshPanel><SshPanel title="终止当前会话"><SshEmpty title="等待 SSH 会话归因数据">吊销不会自动终止已建立的连接。会话终止需要单独定位、授权和确认。</SshEmpty><SshAction>终止当前会话</SshAction></SshPanel></div><SshPanel title="轮换顺序"><ol className="ssh-ordered-copy"><li>在实际授权范围内签发新的短期凭据。</li><li>新凭据通过独立连接验证后，再吊销旧凭据。</li><li>逐目标确认吊销生效，离线或失败目标显示待同步，不宣称全部完成。</li></ol><button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-issue")}>查看签发草稿</button></SshPanel><SshNote title="泄露处置不等待常规轮换" warning>疑似私钥或 CA 泄露时先阻止再签发并尽快吊销。终止 SSH 连接也不保证清除全部后台进程或其他协议会话。</SshNote></>;
  if (page === "ssh-issue") return <><SshDraftForm kind="issue" workspace={workspace} notify={notify} /><div className="ssh-columns"><SshPanel title="一次性交付"><SshEmpty title="尚未签发，不可领取">没有生成私钥、公钥或证书，也没有可消耗的下载次数。</SshEmpty><SshDefinition items={[["证书与指纹", "等待实际签发结果"], ["有效起止时间", "等待服务端时间与策略结果"], ["领取状态", "尚未签发"], ["私钥", "不会在页面、日志或本地存储中展示"]]} /><SshAction>一次性下载凭据包</SshAction></SshPanel><SshPanel title="签发范围的判断"><p className="ssh-body-small">主机端必须核对平台 CA 与主机、Linux 账号、操作者的 principal 范围。前端填写主机名或证书 key ID 不能替代主机端授权。</p><SshDefinition items={[["CA 私钥", "留在签发服务，永不下发"], ["凭据丢失", "重新批准并签发，不反复查看旧私钥"], ["到期或吊销", "阻止后续登录，已有会话仍单独处置"]]} /></SshPanel></div></>;
  return <><div className="ssh-toolbar"><button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-issue")}>填写签发草稿</button><button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-revoke")}>查看吊销与会话规则</button><SshAction>签发凭据</SshAction></div><SshEmpty title="平台凭据与证书等待接入">没有实际签发服务，不显示示例证书、指纹、剩余下载次数或有效期。</SshEmpty><SshPanel title="平台签发的短期凭据"><SshDefinition items={[["凭据包", "操作者专用私钥、公钥、短期用户证书、连接配置"], ["授权范围", "必须匹配主机、Linux 账号、操作者与有效期"], ["一次性交付", "领取后不能在界面反复查看私钥；丢失后重新批准签发"], ["CA 私钥", "始终保留在签发服务，不下发"]]} /></SshPanel></>;
}

export function SshRescueView({ workspace, notify }: ViewProps) {
  return <><SshNote title="救援仍使用平台信任体系">单主机、单 Linux 账号、单操作者的短期凭据，不另开密码或长期公钥入口。当前没有签名服务和审批能力，申请保持禁用。</SshNote><SshDraftForm kind="rescue" workspace={workspace} notify={notify} /><div className="ssh-columns"><SshPanel title="当前恢复能力"><SshDefinition items={[["在线签名服务", <SshWaiting>尚未接入</SshWaiting>], ["预置离线救援包", "尚未取得准备、保管与有效期证据"], ["Agent / 控制通道", "尚未取得可执行恢复的验证结果"], ["带外恢复", "需有权限管理员登记并演练"]]} /><SshAction>一次性领取救援凭据</SshAction></SshPanel><SshPanel title="恢复路径的条件"><SshDefinition items={[["在线短期救援", "签名服务、目标 SSH、身份授权与审批都必须可用"], ["离线平台救援包", "提前平台签发、独立保管、未过期且可取回；仍依赖 SSH 与 CA 信任有效"], ["远程配置恢复", "仅 Agent 或控制通道仍在线时，才可尝试按已验证备份恢复"], ["独立带外恢复", "SSH 与控制通道均不可达或回滚失败时，由有权限管理员执行已演练的带外流程"]]} /></SshPanel></div><SshNote title="平台停机与主机失联必须分别处理" warning>平台不可用时不能在线签发，也不能把无法取回的救援包当成已存在。离线证书不能修复不可达 SSH 或损坏的信任配置；如果恢复原认证，必须退出托管结论并重新核验。</SshNote></>;
}

function SshFlowSteps({ page }: { page: string }) {
  const pages = ["ssh-precheck", "ssh-confirm", "ssh-verify", "ssh-complete"];
  const titles = ["连接与预检", "确认策略变更", "独立新连接验证", "提交接管"];
  return <ol className="ssh-flow-steps" aria-label="接管步骤">{pages.map((key, index) => <li key={key} aria-current={page === key ? "step" : undefined}><span>0{index + 1}</span>{titles[index]}</li>)}</ol>;
}

function SshConfirmDraft({ workspace }: { workspace: SshWorkspace }) {
  const draft = workspace.draftFor("takeover");
  const host = workspace.hosts.find((candidate) => candidate.id === draft.hostId);
  const complete = Object.keys(validateSshDraft(draft, workspace.hosts, "takeover")).length === 0;
  const [acks, setAcks] = useState([false, false, false]);
  const [confirmation, setConfirmation] = useState("");
  const impacts = ["只允许平台签发、在指定主机 / 账号 / 操作者范围有效的凭据建立新登录。", "逐项审查并停用原个人公钥、云注入、外部命令、密码及其他旧认证路径。", "保存备份、核对独立恢复能力，并在完整验证通过前保留可用控制通道。"];
  return <>{!complete && <SshNote title="接管范围草稿尚未完整">请先填写真实目标、Linux 账号、操作者与用途。<button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-precheck", draft.hostId || null)}>返回草稿</button></SshNote>}<SshPanel title="待核验的目标与拟议变更"><SshDefinition items={[["目标主机", host ? <><strong>{host.name}</strong><code>{host.address ?? "地址未提供"}</code></> : "未选择或原目标不可用"], ["草稿 Linux 账号", draft.account || "未填写"], ["草稿操作者", draft.operator || "未填写"], ["主机当前认证来源", "未执行预检，不能推断当前是否允许原公钥或密码"], ["计划允许来源", "平台用户 CA 与授权范围 principal"], ["计划停用来源", "按实际盘点逐项确认，不能只关闭密码"]]} /></SshPanel><div className="ssh-columns"><SshPanel title="影响确认（仅草稿）"><div className="ssh-acknowledgements">{impacts.map((text, index) => <label key={text}><input type="checkbox" checked={acks[index]} onChange={(event) => setAcks((current) => current.map((value, position) => position === index ? event.target.checked : value))} /><span>{text}</span></label>)}</div><label className="ssh-field"><span>主机名确认</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={host ? `输入 ${host.name}` : "请先选择目标"} autoComplete="off" /><small>勾选和输入仅保存本页草稿，不是身份验证、主机预检或应用许可。</small></label><SshAction>应用接管策略</SshAction></SshPanel><SshPanel title="恢复与身份验证证据"><SshDefinition items={[["接管备份", "等待后端创建并核对完整性"], ["独立本地回滚", "等待实际准备与可执行验证"], ["保留控制通道", "等待后端核验，不作永久救援保证"], ["平台身份重新验证", "后端尚未启用，未发起"], ["回滚截止时间", "尚未准备，不显示虚构倒计时"]]} /><SshAction>重新验证身份</SshAction></SshPanel></div><button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-verify", draft.hostId || null)}>查看独立验证要求</button></>;
}

export function SshFlowView({ page, workspace, notify }: ViewProps & { page: string }) {
  const draft = workspace.draftFor("takeover");
  const selected = workspace.hosts.find((host) => host.id === (workspace.hostId ?? draft.hostId));
  if (page === "ssh-complete" || page === "ssh-rollback") return <><SshEmpty title={page === "ssh-complete" ? "尚无真实接管完成证据" : "尚无真实回滚任务"}>没有后端任务、备份与连接验证证据，不能显示已接管、已恢复或虚构的备份编号。</SshEmpty>{selected && <SshPanel title="当前选择的目标"><SshDefinition items={[["主机", selected.name], ["稳定 ID", <code>{selected.id}</code>], ["资源地址", selected.address ?? "地址未提供"], ["SSH 保护结论", "尚未取得真实证据"]]} /></SshPanel>}<SshNote title={page === "ssh-complete" ? "提交接管的必要条件" : "恢复成功与恢复失败必须区分"}>{page === "ssh-complete" ? "有效配置收敛、新凭据独立连接、旧来源与范围外凭据负向验证、恢复准备都通过后，才可显示已托管并解除回滚计时器。" : "恢复原认证后仍是未托管；回滚失败、通道丢失或证据不足时应显示需人工救援，不得沿用绿色成功结论。"}</SshNote><button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-hosts", workspace.hostId)}>返回候选主机</button></>;
  if (page === "ssh-confirm") return <><SshFlowSteps page={page} /><SshConfirmDraft key={`${draft.hostId}:${draft.account}:${draft.operator}`} workspace={workspace} /></>;
  if (page === "ssh-verify") return <><SshFlowSteps page={page} /><SshPanel title="独立新连接验证"><SshDefinition items={[["当前主机", selected ? <><strong>{selected.name}</strong><code>{selected.address ?? "地址未提供"}</code></> : "未选择或原目标已移除"], ["草稿账号 / 操作者", [draft.account, draft.operator].filter(Boolean).join(" / ") || "尚未填写"], ["平台证书与 principal", "等待实际签发和主机端范围校验"], ["主机 / CA / 公钥指纹", "等待可信登记值及服务端验证"], ["有效起止时间", "等待真实证书，不使用客户端时间代替"], ["回滚准备", "等待实际任务与可执行证据"]]} /><SshChecks items={sshVerificationItems} /><div className="ssh-toolbar"><SshAction>开始独立新连接验证</SshAction><SshAction>提交接管</SshAction><SshAction>执行回滚</SshAction></div></SshPanel><details className="ssh-technical-details"><summary>新连接与负向验证的技术要求</summary><pre>{"ControlMaster no\nControlPath none\nIdentitiesOnly yes\nIdentityAgent none"}</pre><p>必须建立新的 TCP / SSH 完整认证。原终端、新标签页、端口可达或 Agent 心跳不能代替验证。只接受服务端返回且绑定同一主机、账号、操作者和凭据的完整证据。</p><p>负向验证需要证明认证被拒绝，而不是网络超时；不收集原用户私钥，证据缺口必须明确记录并补验。</p></details><SshNote title="本页没有模拟通过入口">当前没有实际 SSH 验证任务，不能通过本地勾选或按钮将主机改为已托管。<button className="ssh-button ssh-button-ghost" type="button" onClick={() => workspace.navigate("ssh-rescue", selected?.id ?? null)}>查看失败恢复条件</button></SshNote></>;
  return <><SshFlowSteps page="ssh-precheck" /><SshDraftForm kind="takeover" workspace={workspace} notify={notify} reviewRoute="ssh-confirm" /><SshPanel title="后端接入后需要执行的预检"><SshChecks items={sshPreflightItems} /></SshPanel><SshNote title="当前没有执行任何主机探测">这里是接管规则与草稿界面，不会测试原用户凭据、生成私钥、修改 sshd 或改变原授权。</SshNote></>;
}
