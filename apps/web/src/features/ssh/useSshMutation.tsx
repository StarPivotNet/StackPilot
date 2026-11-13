import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { reauthenticate } from "../../api/identityApi";
import type { Notify } from "../../types/app";

type Pending = { title: string; message: string; execute: (proof: string, signal: AbortSignal) => Promise<void> };
export function useSshMutation(refresh: () => Promise<void>, notify: Notify) {
  const [pending, setPending] = useState<Pending | null>(null), [password, setPassword] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  const ask = <T,>(title: string, message: string, execute: (proof: string, signal: AbortSignal) => Promise<T>, success?: (result: T) => void) => {
    if (busy) return;
    setPassword(""); setError(""); setPending({ title, message, execute: async (proof, signal) => { const result = await execute(proof, signal); if (!signal.aborted) success?.(result); } });
  };
  const submit = async () => {
    if (!pending || busy || !password) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError("");
    const secret = password; setPassword("");
    try {
      const proof = await reauthenticate(secret, controller.signal);
      if (controller.signal.aborted) return;
      await pending.execute(proof.proof, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setPending(null); notify("操作已登记，请以主机确认结果为准", "success"); void refresh();
    } catch (reason) { if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { if (mounted.current) setBusy(false); request.current = null; }
  };
  const dialog = pending && <ConfirmDialog title={pending.title} message={pending.message} confirmLabel="验证并继续" tone="info" className="ssh-reauth-dialog" busy={busy} confirmDisabled={!password} onClose={() => { if (!busy) { setPending(null); setPassword(""); setError(""); } }} onConfirm={() => void submit()}><label className="ssh-field"><span>当前账号密码</span><input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>{error && <p className="ssh-field-error" role="alert">{error}</p>}</ConfirmDialog>;
  return { ask, dialog, busy };
}
