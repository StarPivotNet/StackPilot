import { LockKeyhole } from "lucide-react";

export function SettingsCapabilityState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="settings-capability-state" role="status"><LockKeyhole size={24} /><div><strong>{title}</strong><p>{children}</p></div></div>;
}
