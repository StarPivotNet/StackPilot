import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import type { SessionRuntime } from "./runtime.js";

const pid = z.number().int().min(2).max(2_147_483_647);
const account = z.string().regex(/^sp_[a-z0-9]{1,25}$/);
const PamRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("authenticate"), monitorPid: pid, phasePid: pid, account, password: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ operation: z.literal("check"), phasePid: pid, account }).strict(),
]);
export async function startPamSocket(runtime: SessionRuntime, path = "/run/stackpilot-ssh-helper/pam.sock") {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (process.platform === "linux" && (parent.mode & 0o077))) throw new Error("PAM socket directory must be root-owned mode 0700");
  const stale = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (stale) {
    if (!stale.isSocket() || stale.uid !== 0 || stale.isSymbolicLink()) throw new Error("Unsafe existing PAM socket");
    await new Promise<void>((resolve, reject) => { const probe = createConnection(path); probe.setTimeout(1000, () => probe.destroy(new Error("PAM socket probe timed out"))); probe.on("connect", () => { probe.destroy(); reject(new Error("PAM helper already running")); }); probe.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error)); });
    const current = await lstat(path); if (current.ino !== stale.ino || current.dev !== stale.dev) throw new Error("PAM socket changed"); await unlink(path);
  }
  let connections = 0;
  const server = createServer(socket => {
    if (connections >= 16) { socket.destroy(); return; } connections++;
    socket.once("close", () => { connections--; }); socket.on("error", () => undefined); socket.setTimeout(20_000, () => socket.destroy());
    const chunks: Buffer[] = []; let bytes = 0; let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) { socket.destroy(); return; } bytes += chunk.length;
      if (bytes > 4096) { socket.destroy(); return; } chunks.push(chunk);
      if (chunk.includes(10)) {
        handled = true; const body = Buffer.concat(chunks); const newline = body.indexOf(10);
        if (newline !== body.length - 1) { body.fill(0); socket.destroy(); return; }
        void (async () => {
          try {
            const input = PamRequest.parse(JSON.parse(body.toString("utf8"))); body.fill(0);
            if (socket.destroyed) return;
            if (input.operation === "authenticate") await runtime.authenticate(input.monitorPid, input.phasePid, input.account, input.password);
            else await runtime.check(input.phasePid, input.account);
            if (!socket.destroyed) socket.end("OK\n");
          } catch { body.fill(0); if (!socket.destroyed) socket.end("NO\n"); }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  try { await chmod(path, 0o600); } catch (error) { server.close(); throw error; } return server;
}
