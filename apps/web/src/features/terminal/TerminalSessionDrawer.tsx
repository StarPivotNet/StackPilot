import { CheckCircle2, PlugZap, Unplug, WifiOff } from "lucide-react";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import type { LiveTerminalSession } from "./liveTypes";
import type { TerminalSessionRecord } from "./types";

function TerminalSessionDrawer({
  session,
  outputLineCount,
  onClose,
  onConnect,
  onDisconnect,
}: {
  session: TerminalSessionRecord | LiveTerminalSession;
  outputLineCount: number;
  onClose: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}) {
  const connected = session.status === "connected";

  return (
    <DetailDrawer
      className="terminal-session-drawer"
      title={onConnect ? `${session.user}@${session.host}` : `${session.host} · Agent 详情`}
      subtitle={session.ip}
      modal
      onClose={onClose}
      actions={onConnect && onDisconnect ? connected
        ? <button className="ghost" type="button" onClick={onDisconnect}><Unplug size={15} />关闭会话</button>
        : <button className="primary" type="button" onClick={onConnect}><PlugZap size={15} />打开会话</button> : undefined}
    >
      <div className="terminal-session-detail">
        <div className={`terminal-session-detail-status ${session.status}`}>
          {connected ? <CheckCircle2 size={20} /> : <WifiOff size={20} />}
          <span>
            <strong>{onConnect ? connected ? "会话已打开" : "会话未打开" : connected ? "Agent 已连接" : "Agent 未连接"}</strong>
            <small>{onConnect ? connected ? `当前延迟 ${session.latency}` : "连接已关闭，可从抽屉底部重新打开" : connected ? "受控命令将由此 Agent 执行" : "等待 Agent 心跳恢复"}</small>
          </span>
        </div>
        <dl className="terminal-session-detail-grid">
          <div><dt>主机名</dt><dd>{session.host}</dd></div>
          <div><dt>IP 地址</dt><dd>{session.ip}</dd></div>
          <div><dt>{onConnect ? "登录用户" : "执行用户"}</dt><dd>{session.user}</dd></div>
          <div><dt>权限</dt><dd>{session.privilege === "unknown" ? "由 Controller 与 Agent 校验" : session.privilege === "sudo" ? "sudo 管理权限" : "普通用户"}</dd></div>
          <div><dt>{onConnect ? "会话开始" : "最近心跳"}</dt><dd>{session.startedAt}</dd></div>
          <div><dt>当前目录</dt><dd><code>{session.cwd}</code></dd></div>
          <div><dt>最后命令</dt><dd><code>{session.lastCommand}</code></dd></div>
          <div><dt>输出行数</dt><dd>{outputLineCount} 行</dd></div>
        </dl>
      </div>
    </DetailDrawer>
  );
}

export { TerminalSessionDrawer };
