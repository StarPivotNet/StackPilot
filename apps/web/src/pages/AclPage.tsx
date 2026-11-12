import { Check, CircleAlert, Lock, Plus, Shield, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PermissionSchema, type Permission } from "@stackpilot/contracts";
import { aclPagePreset } from "../app/pagePresets";
import { resolvePageMeta } from "../app/navigation";
import { createIdentityRole, listIdentityRoles, reauthenticate, updateIdentityRole, type RoleRecord } from "../api/identityApi";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch, PanelCard } from "../components/ui/Cards";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect } from "../components/ui/FormControls";
import { IdentityManagement } from "../features/access/IdentityManagement";
import type { Notify, PageKey, SetPage } from "../types/app";

type PermissionMeta = {
  key: Permission;
  name: string;
  module: string;
  risk: "低" | "中" | "高";
  description: string;
};

type RoleDraft = {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
};

const permissionDetails: Partial<Record<Permission, Omit<PermissionMeta, "key">>> = {
  "overview:read": { name: "总览查看", module: "工作台", risk: "低", description: "查看控制面健康、任务与风险摘要。" },
  "overview:operate": { name: "总览操作", module: "工作台", risk: "中", description: "从工作台发起受控运维操作。" },
  "schedules:read": { name: "定时任务查看", module: "定时任务", risk: "低", description: "查看任务计划、执行记录和日历。" },
  "schedules:write": { name: "定时任务管理", module: "定时任务", risk: "高", description: "创建、修改、启停和删除定时任务。" },
  "nodes:read": { name: "节点查看", module: "主机", risk: "低", description: "查看授权节点及其运行状态。" },
  "nodes:manage": { name: "节点管理", module: "主机", risk: "高", description: "注册、轮换、撤销节点或授权高风险能力。" },
  "services:read": { name: "服务清单查看", module: "systemd", risk: "低", description: "查看授权节点的服务清单与运行状态。" },
  "services:operate": { name: "服务操作", module: "systemd", risk: "高", description: "在授权节点执行服务启动、停止与重启操作。" },
  "terminal:read": { name: "终端片段查看", module: "终端", risk: "低", description: "查看受控命令片段和会话信息。" },
  "terminal:execute": { name: "终端命令执行", module: "终端", risk: "高", description: "在授权节点执行受控命令。" },
  "systemd:read": { name: "服务状态查看", module: "systemd", risk: "中", description: "查看 systemd 状态与脱敏日志。" },
  "firewall:read": { name: "防火墙查看", module: "防火墙", risk: "中", description: "查看监听端口与授权节点的防火墙拒绝事件。" },
  "firewall:operate": { name: "防火墙规则管理", module: "防火墙", risk: "高", description: "新增或删除受管 UFW 放行规则。" },
  "sites:read": { name: "网站查看", module: "网站", risk: "低", description: "查看站点、运行时与证书状态。" },
  "sites:logs": { name: "网站日志查看", module: "网站", risk: "中", description: "查看站点结构化日志。" },
  "sites:deploy": { name: "网站发布", module: "网站", risk: "高", description: "创建并激活站点部署计划。" },
  "sites:operate": { name: "网站生命周期", module: "网站", risk: "高", description: "启动、停止或重启站点。" },
  "sites:renew": { name: "证书续期", module: "网站", risk: "高", description: "为站点签发或续期证书。" },
  "files:read": { name: "文件查看", module: "文件", risk: "低", description: "查看授权目录和文件内容。" },
  "files:write": { name: "文件修改", module: "文件", risk: "高", description: "上传、创建、重命名或修改文件。" },
  "files:delete": { name: "文件删除", module: "文件", risk: "高", description: "永久删除受管文件。" },
  "databases:read": { name: "数据库查看", module: "数据库", risk: "低", description: "查看数据库实例、状态和脱敏慢查询。" },
  "databases:sql:read": { name: "完整 SQL 查看", module: "数据库", risk: "高", description: "查看数据库完整 SQL 文本。" },
  "databases:backup": { name: "数据库备份", module: "数据库", risk: "高", description: "管理和执行数据库备份计划。" },
  "databases:operate": { name: "数据库治理", module: "数据库", risk: "高", description: "执行数据库会话和查询治理操作。" },
  "databases:install": { name: "数据库安装", module: "数据库", risk: "高", description: "安装数据库服务并创建实例。" },
  "databases:restore": { name: "数据库恢复", module: "数据库", risk: "高", description: "执行数据库原地恢复。" },
  "tasks:read": { name: "远程任务查看", module: "任务", risk: "低", description: "查看远程任务与执行结果。" },
  "tasks:create": { name: "远程任务创建", module: "任务", risk: "高", description: "创建远程运维任务。" },
  "tasks:cancel": { name: "远程任务取消", module: "任务", risk: "中", description: "取消尚未完成的远程任务。" },
  "audit:read": { name: "审计查看", module: "审计", risk: "低", description: "查看只读审计日志和操作详情。" },
  "audit:export": { name: "审计导出", module: "审计", risk: "高", description: "创建并下载完整全局审计证据快照。" },
  "users:read": { name: "用户查看", module: "权限", risk: "低", description: "查看服务端用户和访问范围。" },
  "users:manage": { name: "用户管理", module: "权限", risk: "高", description: "创建用户并修改角色、范围或状态。" },
  "roles:read": { name: "角色查看", module: "权限", risk: "低", description: "查看角色及其权限集合。" },
  "roles:manage": { name: "角色管理", module: "权限", risk: "高", description: "创建自定义角色并修改其权限。" },
  "tokens:manage": { name: "令牌管理", module: "设置", risk: "高", description: "创建、复制或撤销 API Token。" },
  "system:backup": { name: "系统备份", module: "设置", risk: "高", description: "创建、校验、下载或恢复 Controller 备份。" },
};

const permissions: PermissionMeta[] = PermissionSchema.options.map((key) => ({
  key,
  ...(permissionDetails[key] ?? { name: key, module: "其他", risk: "高" as const, description: key }),
}));

const emptyRoleDraft: RoleDraft = { id: "", name: "", description: "", permissions: ["overview:read"] };

function AclPage({ page, setPage, notify }: { page: PageKey; setPage: SetPage; notify: Notify }) {
  const aclPreset = aclPagePreset(page);
  const tab = aclPreset.tab;
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Permission[]>>({});
  const [loading, setLoading] = useState(tab !== "users");
  const [error, setError] = useState("");
  const [roleId, setRoleId] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [policySearch, setPolicySearch] = useState("");
  const [policyModule, setPolicyModule] = useState("全部");
  const [policyRisk, setPolicyRisk] = useState("全部");
  const [selectedPermission, setSelectedPermission] = useState<Permission>(PermissionSchema.options[0]);
  const [saveRoleId, setSaveRoleId] = useState<string | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<RoleDraft>(emptyRoleDraft);
  const [createPassword, setCreatePassword] = useState("");

  const loadRoles = useCallback(async (preservedDrafts?: Record<string, Permission[]>) => {
    setLoading(true);
    try {
      const result = await listIdentityRoles();
      setRoles(result.roles);
      setDrafts(Object.fromEntries(result.roles.map((role) => [role.id, preservedDrafts?.[role.id] ?? [...role.permissions]])));
      setRoleId((current) => result.roles.some((role) => role.id === current) ? current : result.roles[0]?.id ?? "");
      setError("");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "角色数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "users" || roles.length > 0) return;
    const loadFrame = window.setTimeout(() => { void loadRoles(); }, 0);
    return () => window.clearTimeout(loadFrame);
  }, [loadRoles, roles.length, tab]);

  const selectedRole = roles.find((role) => role.id === roleId) ?? roles[0] ?? null;
  const rolePermissions = selectedRole ? drafts[selectedRole.id] ?? selectedRole.permissions : [];
  const visibleRolePermissions = selectedRole?.builtin
    ? permissions.filter((permission) => rolePermissions.includes(permission.key))
    : permissions;
  const dirtyRoleIds = roles.filter((role) => {
    const draft = drafts[role.id] ?? role.permissions;
    return draft.length !== role.permissions.length || draft.some((permission) => !role.permissions.includes(permission));
  }).map((role) => role.id);
  const dirtyRoleIdSet = new Set(dirtyRoleIds);
  const editableDirtyRoleIds = dirtyRoleIds.filter((id) => !roles.find((role) => role.id === id)?.builtin);

  const filteredPermissions = useMemo(() => permissions.filter((permission) => {
    const query = policySearch.trim().toLowerCase();
    const linkedRoles = roles.filter((role) => (drafts[role.id] ?? role.permissions).includes(permission.key)).map((role) => role.name);
    return (!query || `${permission.name} ${permission.key} ${permission.module} ${permission.description} ${linkedRoles.join(" ")}`.toLowerCase().includes(query))
      && (policyModule === "全部" || permission.module === policyModule)
      && (policyRisk === "全部" || permission.risk === policyRisk);
  }), [drafts, policyModule, policyRisk, policySearch, roles]);
  const activePermission = filteredPermissions.find((permission) => permission.key === selectedPermission) ?? filteredPermissions[0] ?? null;
  const policyModules = ["全部", ...Array.from(new Set(permissions.map((permission) => permission.module)))];

  const setAclTab = (nextTab: "users" | "roles" | "policies") => {
    const pageForTab = nextTab === "roles" ? "acl-roles" : nextTab === "policies" ? "acl-policies" : "acl-users";
    setPage(pageForTab, { message: `已切换到${nextTab === "users" ? "用户" : nextTab === "roles" ? "角色" : "权限项"}视图`, tone: "info" });
  };

  const toggleRolePermission = (targetRole: RoleRecord, permission: Permission) => {
    if (targetRole.builtin) return;
    setDrafts((current) => {
      const existing = current[targetRole.id] ?? targetRole.permissions;
      const next = existing.includes(permission) ? existing.filter((item) => item !== permission) : [...existing, permission];
      return { ...current, [targetRole.id]: next };
    });
  };

  const openSave = (targetRoleId: string) => {
    const target = roles.find((role) => role.id === targetRoleId);
    if (!target || target.builtin || !dirtyRoleIdSet.has(targetRoleId)) return;
    setAdminPassword("");
    setError("");
    setSaveRoleId(targetRoleId);
  };

  const saveRole = async () => {
    const target = roles.find((role) => role.id === saveRoleId);
    if (!target) return;
    setSaving(true);
    setError("");
    try {
      const proof = await reauthenticate(adminPassword);
      await updateIdentityRole(target.id, {
        id: target.id,
        name: target.name,
        description: target.description,
        permissions: drafts[target.id] ?? target.permissions,
      }, proof.proof);
      notify(`${target.name} 权限已保存`, "success");
      const savedPermissions = drafts[target.id] ?? target.permissions;
      setRoles((current) => current.map((role) => role.id === target.id ? { ...role, permissions: [...savedPermissions] } : role));
      setSaveRoleId(null);
      setAdminPassword("");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "角色权限保存失败");
    } finally {
      setSaving(false);
    }
  };

  const submitCreateRole = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const preservedDrafts = Object.fromEntries(dirtyRoleIds.map((id) => [id, drafts[id]]).filter((entry): entry is [string, Permission[]] => Boolean(entry[1])));
      const proof = await reauthenticate(createPassword);
      await createIdentityRole({
        id: createDraft.id.trim(),
        name: createDraft.name.trim(),
        description: createDraft.description.trim(),
        permissions: createDraft.permissions,
      }, proof.proof);
      notify("角色已创建", "success");
      setCreateOpen(false);
      setCreateDraft(emptyRoleDraft);
      setCreatePassword("");
      await loadRoles(preservedDrafts);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "角色创建失败");
    } finally {
      setSaving(false);
    }
  };

  const saveTarget = roles.find((role) => role.id === saveRoleId) ?? null;

  return (
    <>
      <ModulePageShell
        title={resolvePageMeta(page).title}
        subtitle={aclPreset.subtitle}
        page={page}
        className="cloudpulse-security"
        viewContext={false}
        actions={tab === "roles" ? <button className="primary" type="button" onClick={() => { setError(""); setCreateOpen(true); }}><Plus size={16} aria-hidden="true" />创建角色</button> : undefined}
        tabs={<nav className="deploy-tabs" aria-label="权限视图"><button className={tab === "users" ? "active" : ""} type="button" aria-current={tab === "users" ? "page" : undefined} onClick={() => setAclTab("users")}>用户</button><button className={tab === "roles" ? "active" : ""} type="button" aria-current={tab === "roles" ? "page" : undefined} onClick={() => setAclTab("roles")}>角色</button><button className={tab === "policies" ? "active" : ""} type="button" aria-current={tab === "policies" ? "page" : undefined} onClick={() => setAclTab("policies")}>权限项</button></nav>}
        filters={<>{tab === "users" && <ModuleSearch value={userSearch} placeholder="搜索用户、邮箱或角色" onChange={setUserSearch} />}{tab === "policies" && <><ModuleSearch value={policySearch} placeholder="搜索权限项、权限键或角色" onChange={setPolicySearch} /><FieldSelect label="模块" value={policyModule} options={policyModules} onChange={setPolicyModule} /><FieldSelect label="风险" value={policyRisk} options={["全部", "高", "中", "低"]} onChange={setPolicyRisk} /></>}</>}
        metrics={tab === "users" ? undefined : <><MetricTile icon={Lock} label="当前角色权限" value={selectedRole ? `${rolePermissions.length}/${permissions.length}` : "--"} tone="blue" /><MetricTile icon={Shield} label="高风险权限" value={`${permissions.filter((permission) => permission.risk === "高").length}`} tone="orange" /><MetricTile icon={UserRound} label="服务端角色" value={loading ? "--" : `${roles.length}`} tone="blue" /></>}
      >
        {tab === "users" ? <IdentityManagement notify={notify} search={userSearch} /> : error && !saveRoleId && !createOpen ? <div className="identity-error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span><button className="ghost small" type="button" onClick={() => void loadRoles()}>重试</button></div> : loading ? <div className="identity-list-state" role="status">正在加载角色数据</div> : tab === "roles" ? (
          <div className="acl-role-layout">
            <PanelCard title="角色列表">
              <div className="role-list" aria-label="角色列表">
                {roles.length === 0 && <p className="module-empty-card">当前没有可用角色</p>}{roles.map((role) => <button key={role.id} className={role.id === selectedRole?.id ? "active" : ""} type="button" aria-current={role.id === selectedRole?.id ? "true" : undefined} onClick={() => setRoleId(role.id)}><strong>{role.name}</strong><em>{(drafts[role.id] ?? role.permissions).length}/{permissions.length} 项权限</em><span>{role.description || "未填写角色说明"}</span></button>)}
              </div>
            </PanelCard>
            {selectedRole && <PanelCard title={`${selectedRole.name} 权限项`} action={!selectedRole.builtin && dirtyRoleIdSet.has(selectedRole.id) ? "保存当前角色" : undefined} onAction={() => openSave(selectedRole.id)}>
              {selectedRole.builtin && <p className="acl-readonly-note"><Lock size={16} aria-hidden="true" />内置角色由 Controller 管理，仅显示已授予权限。</p>}
              <div className="permission-grid">
                {visibleRolePermissions.map((permission) => {
                  const checked = rolePermissions.includes(permission.key);
                  return <button key={permission.key} className={checked ? "checked" : ""} type="button" aria-pressed={checked} disabled={selectedRole.builtin} onClick={() => toggleRolePermission(selectedRole, permission.key)}><span className="permission-copy"><b>{permission.name}</b><small>{permission.description}</small></span><i>{checked ? <><Check size={14} aria-hidden="true" />已允许</> : <><X size={14} aria-hidden="true" />未允许</>}</i></button>;
                })}
              </div>
            </PanelCard>}
          </div>
        ) : (
          <div className="acl-policy-layout">
            <div className="policy-catalog" aria-label="权限项目录">
              {filteredPermissions.map((permission) => <button key={permission.key} className={permission.key === activePermission?.key ? "active" : ""} type="button" aria-current={permission.key === activePermission?.key ? "true" : undefined} onClick={() => setSelectedPermission(permission.key)}><span><b>{permission.name}</b><i>{permission.module}</i></span><em className={permission.risk === "高" ? "orange-text" : permission.risk === "中" ? "orange-text" : "blue-text"}>{permission.risk}风险</em><small>{permission.description}</small></button>)}
              {filteredPermissions.length === 0 && <p className="module-empty-card">没有匹配的权限项</p>}
            </div>
            {activePermission ? <PanelCard className="acl-policy-detail-panel" title={`${activePermission.name} 关联角色`}>
              <div className="policy-detail"><p><span>权限键</span><b><code>{activePermission.key}</code></b></p><p><span>模块</span><b>{activePermission.module}</b></p><p><span>风险级别</span><b className={activePermission.risk === "高" ? "red-text" : activePermission.risk === "中" ? "orange-text" : "blue-text"}>{activePermission.risk}风险</b></p><p className="policy-detail-description"><span>说明</span><b>{activePermission.description}</b></p></div>
              <div className="policy-role-section"><div className="policy-role-heading"><span>关联角色</span><small>选择自定义角色后保存</small></div><div className="policy-role-list">{roles.map((role) => { const checked = (drafts[role.id] ?? role.permissions).includes(activePermission.key); return <button key={role.id} className={checked ? "checked" : ""} type="button" aria-pressed={checked} disabled={role.builtin} onClick={() => { toggleRolePermission(role, activePermission.key); if (!role.builtin) setRoleId(role.id); }}><span>{role.name}</span><i>{role.builtin ? "内置角色" : checked ? "已关联" : "未关联"}</i></button>; })}</div>{editableDirtyRoleIds.length > 0 && <div className="acl-policy-save-actions">{editableDirtyRoleIds.map((id) => { const role = roles.find((item) => item.id === id); return role ? <button className="secondary" key={id} type="button" onClick={() => openSave(id)}>保存 {role.name}</button> : null; })}</div>}</div>
            </PanelCard> : <PanelCard title="权限项详情"><p className="module-empty-card">没有可展示的权限项详情</p></PanelCard>}
          </div>
        )}
      </ModulePageShell>

      {createOpen && <DetailDrawer title="创建角色" subtitle="创建自定义角色并绑定 Controller 权限键。" className="acl-role-create-modal" modal onClose={() => { if (!saving) { setCreateOpen(false); setError(""); } }} closeLabel="关闭创建角色弹窗" scrimCloseLabel="点击遮罩关闭创建角色弹窗" actions={<><button className="ghost" type="button" disabled={saving} onClick={() => setCreateOpen(false)}>取消</button><button className="primary" type="submit" form="acl-create-role-form" disabled={saving || !createDraft.id.trim() || !createDraft.name.trim() || createDraft.permissions.length === 0 || !createPassword}>{saving ? "创建中" : "创建角色"}</button></>}><form id="acl-create-role-form" className="identity-form" onSubmit={submitCreateRole}><label><span>角色 ID</span><input aria-label="角色 ID" autoFocus value={createDraft.id} onChange={(event) => setCreateDraft({ ...createDraft, id: event.target.value })} placeholder="例如 release-manager" autoComplete="off" /><small>仅支持小写英文、数字和连字符。</small></label><label><span>角色名称</span><input aria-label="角色名称" value={createDraft.name} onChange={(event) => setCreateDraft({ ...createDraft, name: event.target.value })} placeholder="例如 发布经理" autoComplete="off" /></label><label><span>角色说明</span><input aria-label="角色说明" value={createDraft.description} onChange={(event) => setCreateDraft({ ...createDraft, description: event.target.value })} placeholder="说明该角色的职责边界" autoComplete="off" /></label><fieldset><legend>初始权限</legend><div className="acl-role-create-permissions">{permissions.map((permission) => <label className="identity-checkbox" key={permission.key}><input type="checkbox" checked={createDraft.permissions.includes(permission.key)} onChange={() => setCreateDraft((current) => ({ ...current, permissions: current.permissions.includes(permission.key) ? current.permissions.filter((item) => item !== permission.key) : [...current.permissions, permission.key] }))} /><span>{permission.name}</span><small>{permission.key}</small></label>)}</div></fieldset><label><span>当前管理员密码</span><input aria-label="当前管理员密码" type="password" value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="用于确认本次敏感操作" autoComplete="current-password" /></label>{error && <p className="identity-form-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>}</form></DetailDrawer>}

      {saveTarget && <ConfirmDialog className="acl-role-save-confirm" tone="warning" title={`保存 ${saveTarget.name} 权限`} message="此操作会立即更新 Controller 的角色授权，并影响使用该角色的用户。" detail={`${(drafts[saveTarget.id] ?? saveTarget.permissions).length} 项权限`} confirmLabel="确认保存" busy={saving} confirmDisabled={!adminPassword} onClose={() => { if (!saving) { setSaveRoleId(null); setError(""); } }} onConfirm={() => void saveRole()}><label className="settings-reauth-field"><span>当前管理员密码</span><input autoFocus type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="identity-form-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>}</ConfirmDialog>}
    </>
  );
}

export { AclPage };
