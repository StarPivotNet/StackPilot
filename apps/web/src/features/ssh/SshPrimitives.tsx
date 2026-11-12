import { CircleHelp, Clock3, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { SSH_DISABLED_REASON, SSH_BACKEND_CAPABILITY, sshActionAllowed } from "./model";

export function SshNote({ title, children, warning = false }: { title: string; children?: ReactNode; warning?: boolean }) {
  return <div className={`ssh-note ${warning ? "ssh-note-warning" : ""}`}><CircleHelp size={20} aria-hidden="true" /><div><strong>{title}</strong>{children && <p>{children}</p>}</div></div>;
}
export function SshPanel({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return <section className="ssh-panel"><header><h2>{title}</h2>{description && <p>{description}</p>}</header>{children}</section>;
}
export function SshEmpty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="ssh-empty"><LockKeyhole size={24} aria-hidden="true" /><div><h3>{title}</h3><p>{children}</p></div></div>;
}
export function SshAction({ children, reason = SSH_DISABLED_REASON }: { children: ReactNode; reason?: string }) {
  return <button className="ssh-button ssh-button-primary" type="button" disabled={!sshActionAllowed(SSH_BACKEND_CAPABILITY)} title={reason} aria-describedby="ssh-integration-reason">{children}</button>;
}
export function SshWaiting({ children = "等待后端核验" }: { children?: ReactNode }) {
  return <span className="ssh-status ssh-status-pending"><Clock3 size={16} aria-hidden="true" />{children}</span>;
}
export function SshChecks({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return <ol className="ssh-checklist">{items.map(([title, copy]) => <li key={title}><Clock3 size={20} aria-hidden="true" /><div><strong>{title}</strong><p>{copy}</p></div><SshWaiting /></li>)}</ol>;
}
export function SshDefinition({ items }: { items: Array<readonly [string, ReactNode]> }) {
  return <dl className="ssh-definition">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
