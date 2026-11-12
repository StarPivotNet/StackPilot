import { Globe2, Network, ShieldCheck } from "lucide-react";
import { MetricTile } from "../../components/ui/Cards";
import { FormLine } from "../../components/ui/FormControls";
import type { Notify, PageKey, SetPage, SettingsReadOnlyState } from "../../types/app";
import { SettingsCapabilityState } from "./SettingsCapabilityState";
import { SettingsPageFrame } from "./SettingsPageFrame";

function SettingsProxyPage({ page, setPage }: { page: PageKey; setPage: SetPage; notify: Notify; readOnlyState: SettingsReadOnlyState }) {
  return <SettingsPageFrame page={page} setPage={setPage} metrics={<><MetricTile icon={Globe2} label="代理节点" value="暂不可用" tone="blue" /><MetricTile icon={Network} label="路由规则" value="暂不可用" tone="purple" /><MetricTile icon={ShieldCheck} label="连通状态" value="尚未验证" tone="blue" /></>}>
    <div className="proxy-settings-workspace">
      <section className="settings-section proxy-node-workbench"><header className="settings-section-head"><div><h2>代理节点与路由</h2><p>统一查看出口节点、目标路由与运行时代理策略。</p></div></header><SettingsCapabilityState title="代理管理接口尚未开放">当前服务未提供代理节点、路由配置或连通性探测接口，暂不能新增、切换或测试代理。</SettingsCapabilityState><div className="settings-empty"><Globe2 size={24} /><strong>暂无可读取的代理节点</strong><p>该能力可用后将显示节点配置和最近探测结果。</p></div></section>
      <div className="proxy-lower-grid"><section className="settings-section"><h2>代理路由规则</h2><div className="settings-empty"><Network size={24} /><strong>暂无可读取的路由规则</strong><p>代理规则需由服务端提供真实配置。</p></div></section><section className="settings-section proxy-policy-panel"><h2>运行时策略</h2><div className="settings-form-grid"><FormLine label="HTTP_PROXY" value="" disabled hint="尚未读取服务端配置" /><FormLine label="HTTPS_PROXY" value="" disabled hint="尚未读取服务端配置" /><FormLine label="NO_PROXY" value="" disabled hint="尚未读取服务端配置" /></div><button className="primary" type="button" disabled>保存策略</button></section></div>
    </div>
  </SettingsPageFrame>;
}
export { SettingsProxyPage };
