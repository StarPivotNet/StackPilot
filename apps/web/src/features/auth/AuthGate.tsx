import type { PublicUser } from "@stackpilot/contracts";
import { AlertTriangle, CloudUpload, KeyRound, LoaderCircle, LockKeyhole, LogIn, ShieldCheck, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { login, restoreSession } from "../../api/authApi";
import "./auth.css";

export function AuthGate({ children }: { children: (user: PublicUser) => React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialization, setInitialization] = useState(false);
  const [locked, setLocked] = useState(false);
  const authenticated = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const attempt = ++epoch.current;
    restoreSession().then((restored) => {
      if (!active || attempt !== epoch.current) return;
      authenticated.current = Boolean(restored);
      setUser(restored);
    }).catch(() => {
      if (active && attempt === epoch.current) setUser(null);
    }).finally(() => {
      if (active) setChecking(false);
    });
    const expired = () => {
      // A failed anonymous login also emits 401; it must remain a login error.
      const wasAuthenticated = authenticated.current;
      if (!wasAuthenticated) return;
      authenticated.current = false;
      ++epoch.current;
      setUser(null);
      setBusy(false);
      setPassword("");
      setLocked(true);
      setInitialization(false);
    };
    window.addEventListener("stackpilot:session-expired", expired);
    return () => {
      active = false;
      mounted.current = false;
      window.removeEventListener("stackpilot:session-expired", expired);
    };
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !username || !password) return;
    const attempt = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const next = await login(username, password);
      if (!mounted.current || attempt !== epoch.current) return;
      authenticated.current = true;
      setPassword("");
      setLocked(false);
      setUser(next);
    } catch (reason) {
      if (mounted.current && attempt === epoch.current) setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      if (mounted.current && attempt === epoch.current) setBusy(false);
    }
  };

  if (user) return <>{children(user)}</>;
  return <main className="auth-screen cloudpulse-auth">
    <div className="auth-brand"><CloudUpload size={32} aria-hidden="true" /><span>StackPilot</span></div>
    <div className="auth-content">
      {checking ? <section className="auth-session-state" role="status"><LoaderCircle size={32} aria-hidden="true" /><h1>正在验证会话</h1><p>正在确认当前会话状态。</p></section> : locked ? <section className="auth-session-state" aria-labelledby="auth-lock-title"><span className="auth-state-icon"><LockKeyhole size={32} aria-hidden="true" /></span><span className="auth-eyebrow">会话已退出</span><h1 id="auth-lock-title">StackPilot 控制台已锁定</h1><p>当前会话已失效，请重新登录后继续访问控制台。</p><button type="button" className="primary" autoFocus onClick={() => { setLocked(false); setError(""); }}>返回登录</button></section> : initialization ? <section className="auth-form auth-initialization" aria-labelledby="auth-init-title">
        <header><span className="auth-eyebrow">FIRST ADMINISTRATOR</span><h1 id="auth-init-title">首次初始化</h1><p>首位管理员需要在 Controller 所在主机的交互式终端中创建。</p></header>
        <ol className="auth-setup-steps"><li><strong>打开本机交互式终端</strong><p>进入项目工作区，执行管理员初始化命令。</p><code>npm run db:init --workspace @stackpilot/controller</code></li><li><strong>按照提示创建首位管理员</strong><p>输入管理员用户名、显示名称与 12–128 个字符的密码。密码在终端中隐藏输入。</p></li><li><strong>返回控制台登录</strong><p>初始化成功后，使用刚创建的用户名与密码登录。</p></li></ol>
        <p className="auth-setup-note"><TerminalSquare size={20} aria-hidden="true" />管理员创建只在本机 CLI 执行，此处不收集初始化信息。</p>
        <button className="primary" type="button" autoFocus onClick={() => setInitialization(false)}>返回登录</button>
      </section> : <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <header><ShieldCheck size={32} aria-hidden="true" /><span className="auth-eyebrow">STACKPILOT CONSOLE</span><h1>登录控制台</h1></header>
        <label htmlFor="stackpilot-username"><span>用户名</span><input id="stackpilot-username" name="username" autoFocus autoComplete="username" required disabled={busy} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入用户名" /></label>
        <label htmlFor="stackpilot-password"><span>密码</span><input id="stackpilot-password" name="password" type="password" autoComplete="current-password" required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /></label>
        {error && <p className="auth-error" role="alert"><AlertTriangle size={20} aria-hidden="true" />{error}</p>}
        <button className="primary" type="submit" disabled={busy || !username || !password}>{busy ? <LoaderCircle size={16} aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}{busy ? "正在登录" : "登录"}</button>
        <button type="button" className="auth-help" onClick={() => { setInitialization(true); setError(""); }}><KeyRound size={16} aria-hidden="true" />首次初始化说明</button>
      </form>}
    </div>
    <p className="auth-footer">StackPilot · 让基础设施始终可见</p>
  </main>;
}
