import { createHash } from "node:crypto";
import ssh2, { type Client, type ConnectConfig } from "ssh2";

export type SshProbeEndpoint = { address: string; port: number; fingerprints: string[]; account: string };
export type SshProbeAuth = { method: "keyboard-interactive" | "password"; password: string } | { method: "publickey"; privateKey: string | Buffer };
export class SshProbeError extends Error {
  constructor(readonly code: "SSH_HOST_KEY_MISMATCH" | "SSH_AUTH_REJECTED" | "SSH_CONNECTION_FAILED" | "SSH_CONNECTION_TIMEOUT" | "SSH_COMMAND_FAILED" | "SSH_OUTPUT_TOO_LARGE") { super(code); }
}
const commands = {
  identity: "/usr/bin/id -u",
  groups: "/usr/bin/id -G",
  sudoListing: "/usr/bin/env LC_ALL=C /usr/bin/sudo -n -l",
  sudoIdentity: "/usr/bin/sudo -n /usr/bin/id -u",
} as const;
export type SshProbeCommand = keyof typeof commands;

export class SshProbeConnection {
  constructor(private readonly client: Client, readonly closed: Promise<number>) {}
  close() { this.client.end(); }
  destroy() { this.client.destroy(); }
  forwardingDenied(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.client.destroy(); reject(new SshProbeError("SSH_CONNECTION_TIMEOUT")); }, 5000);
      this.client.forwardOut("127.0.0.1", 1, "127.0.0.1", 22, (error, stream) => { clearTimeout(timer); stream?.destroy(); resolve(!!error && (error as Error & { reason?: number }).reason === 1); });
    });
  }
  inspectSftp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.client.destroy(); reject(new SshProbeError("SSH_CONNECTION_TIMEOUT")); }, 10_000);
      this.client.sftp((error, sftp) => {
        if (error) { clearTimeout(timer); reject(new SshProbeError("SSH_COMMAND_FAILED")); return; }
        sftp.readdir(".", failure => { clearTimeout(timer); sftp.end(); if (failure) reject(new SshProbeError("SSH_COMMAND_FAILED")); else resolve(); });
      });
    });
  }
  exec(command: SshProbeCommand): Promise<{ code: number; stdout: string; stderr: string }> {
    const text = commands[command]; if (typeof text !== "string") throw new SshProbeError("SSH_COMMAND_FAILED");
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.client.destroy(); reject(new SshProbeError("SSH_CONNECTION_TIMEOUT")); } }, 10_000);
      this.client.exec(text, (error, stream) => {
        if (error) { settled = true; clearTimeout(timer); reject(new SshProbeError("SSH_COMMAND_FAILED")); return; }
        let stdout = "", stderr = "", size = 0;
        const append = (chunk: Buffer, destination: "stdout" | "stderr") => {
          size += chunk.length;
          if (size > 65_536) { if (!settled) { settled = true; clearTimeout(timer); stream.destroy(); this.client.destroy(); reject(new SshProbeError("SSH_OUTPUT_TOO_LARGE")); } return; }
          if (destination === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
        };
        stream.on("data", (chunk: Buffer) => append(chunk, "stdout")); stream.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
        stream.on("error", () => { if (!settled) { settled = true; clearTimeout(timer); reject(new SshProbeError("SSH_COMMAND_FAILED")); } });
        stream.on("close", (code: number | undefined) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: Number.isSafeInteger(code) ? code! : -1, stdout, stderr }); } });
      });
    });
  }
}

/** Fresh TCP connection, pinned host key, a single explicitly selected auth
 * method and fixed diagnostic commands. No agent or ambient user key is used. */
export async function connectSshProbe(endpoint: SshProbeEndpoint, auth: SshProbeAuth): Promise<SshProbeConnection> {
  if (!endpoint.address || endpoint.address.length > 253 || /[\s/@?#]/.test(endpoint.address) || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(endpoint.account) || !endpoint.fingerprints.length || endpoint.fingerprints.some(value => !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value))) throw new SshProbeError("SSH_CONNECTION_FAILED");
  const client = new ssh2.Client(); let closedAt: (time: number) => void = () => undefined;
  const closed = new Promise<number>(resolve => { closedAt = resolve; }); client.once("close", () => closedAt(Date.now()));
  return new Promise((resolve, reject) => {
    let settled = false, wrongHost = false, prompted = false;
    const fail = (code: ConstructorParameters<typeof SshProbeError>[0]) => { if (!settled) { settled = true; clearTimeout(timer); client.destroy(); reject(new SshProbeError(code)); } };
    const timer = setTimeout(() => fail("SSH_CONNECTION_TIMEOUT"), 15_000);
    client.on("error", (error: Error & { level?: string }) => fail(wrongHost ? "SSH_HOST_KEY_MISMATCH" : error.level === "client-authentication" ? "SSH_AUTH_REJECTED" : "SSH_CONNECTION_FAILED"));
    client.once("close", () => fail("SSH_CONNECTION_FAILED"));
    client.once("ready", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(new SshProbeConnection(client, closed)); } });
    if (auth.method === "keyboard-interactive") client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
      if (prompted || prompts.length !== 1 || prompts[0]?.echo !== false) { finish([]); fail("SSH_AUTH_REJECTED"); return; }
      prompted = true; finish([auth.password]);
    });
    const config: ConnectConfig = {
      host: endpoint.address, port: endpoint.port, username: endpoint.account, readyTimeout: 15_000, keepaliveInterval: 5000, keepaliveCountMax: 2,
      authHandler: [auth.method], tryKeyboard: auth.method === "keyboard-interactive",
      hostVerifier: (key: Buffer) => { const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`; wrongHost = !endpoint.fingerprints.includes(fingerprint); return !wrongHost; },
      ...(auth.method === "publickey" ? { privateKey: auth.privateKey } : { password: auth.password }),
    };
    try { client.connect(config); } catch { fail("SSH_CONNECTION_FAILED"); }
  });
}
