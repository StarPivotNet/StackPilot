import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { z } from "zod";
import { SshSessionSchema } from "@stackpilot/contracts";

export const LocalSessionSchema = z.object({ session: SshSessionSchema, bootId: z.string().uuid(), monitorPid: z.number().int().min(2), monitorStart: z.string().regex(/^\d+$/), scope: z.string().regex(/^stackpilot-ssh-[0-9a-f-]{36}\.scope$/), cgroup: z.string().regex(/^\/[a-zA-Z0-9_./@:-]+$/).refine(value => !value.split("/").includes("..")), deadlineBootMs: z.number().positive(), terminationRequested: z.boolean(), terminated: z.boolean(), acknowledged: z.boolean() }).strict().refine(value => value.scope === `stackpilot-ssh-${value.session.id}.scope` && value.cgroup.endsWith(`/${value.scope}`), "SSH scope must match its session");
export type LocalSession = z.infer<typeof LocalSessionSchema>;
const StoredIdentitySchema = z.object({ nodeId: z.string().uuid(), credentialId: z.string().uuid() }).strict();
export class RootStore {
  constructor(readonly directory: string) {}
  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (process.platform === "linux" && (stat.mode & 0o077))) throw new Error("SSH state directory must be root-owned mode 0700");
  }
  async read(name: string): Promise<string> {
    if (!/^[a-z-]+\.json$|^identity\.pem$/.test(name)) throw new Error("Invalid SSH state name");
    const fd = await open(join(this.directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const stat = await fd.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (process.platform === "linux" && (stat.mode & 0o077)) || stat.size > 4 * 1024 * 1024) throw new Error("Unsafe SSH state file"); return await fd.readFile("utf8"); } finally { await fd.close(); }
  }
  async write(name: string, value: string, replace = true) {
    if (!/^[a-z-]+\.json$|^identity\.pem$/.test(name)) throw new Error("Invalid SSH state name");
    const temporary = join(this.directory, `.write-${randomUUID()}`); const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      try { await fd.writeFile(value); await fd.sync(); } finally { await fd.close(); }
      if (replace) await rename(temporary, join(this.directory, name));
      else { try { await link(temporary, join(this.directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } await unlink(temporary); }
      if (process.platform === "linux") { const dir = await open(this.directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async key() {
    let pem: string;
    try { pem = await this.read("identity.pem"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(); await this.write("identity.pem", pem, false); pem = await this.read("identity.pem");
    }
    const key = createPrivateKey(pem); if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid SSH helper private key"); return key;
  }
  async identity() { return StoredIdentitySchema.parse(JSON.parse(await this.read("identity.json"))); }
  async sessions() {
    try { return z.array(LocalSessionSchema).max(1024).parse(JSON.parse(await this.read("sessions.json"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async saveSessions(values: LocalSession[]) { await this.write("sessions.json", JSON.stringify(values)); }
}
