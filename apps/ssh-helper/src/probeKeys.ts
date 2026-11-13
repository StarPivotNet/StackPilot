import { constants } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RootStore } from "./store.js";

const EntrySchema = z.object({ account: z.string().regex(/^sp_[a-z0-9]{1,25}$/), planId: z.string().uuid(), home: z.string().startsWith("/var/lib/stackpilot-ssh-users/sp_"), uid: z.number().int().min(1000), hash: z.string().regex(/^[a-f0-9]{64}$/), directoryInode: z.string().nullable() }).strict();
type Entry = z.infer<typeof EntrySchema>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Public probe keys live in a fresh root-owned directory inside the managed
 * home. Directory FDs anchor every operation so user-writable home entries
 * cannot redirect privileged writes through a swapped .ssh symlink. */
export class ProbeKeys {
  constructor(private readonly store: RootStore) {}
  private async entries() { try { return z.array(EntrySchema).max(1024).parse(JSON.parse(await this.store.read("probe-keys.json"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  private async save(entries: Entry[]) { await this.store.write("probe-keys.json", JSON.stringify(entries)); }
  private async directory(entry: Entry, create: boolean) {
    if (entry.home !== `/var/lib/stackpilot-ssh-users/${entry.account}`) throw new Error("Invalid SSH probe home");
    const home = await open(entry.home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await home.stat(); if (!stat.isDirectory() || stat.uid !== entry.uid || stat.mode & 0o077) throw new Error("Managed home changed before probe preparation");
      const path = `/proc/self/fd/${home.fd}/.ssh`;
      if (create) await mkdir(path, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const metadata = await directory.stat();
        if (!metadata.isDirectory() || metadata.uid !== 0 || metadata.mode & 0o022 || (entry.directoryInode !== null && String(metadata.ino) !== entry.directoryInode)) throw new Error("Unsafe SSH public probe directory");
        return directory;
      } catch (error) { await directory.close(); throw error; }
    } finally { await home.close(); }
  }
  async prepare(input: { account: string; planId: string; publicKey: string; binding: { uid: number; home: string } }) {
    if (!/^ssh-rsa [A-Za-z0-9+/=]{100,8192}$/.test(input.publicKey)) throw new Error("Invalid public SSH probe key");
    if (!/^sp_[a-z0-9]{1,25}$/.test(input.account) || !z.string().uuid().safeParse(input.planId).success || input.binding.home !== `/var/lib/stackpilot-ssh-users/${input.account}`) throw new Error("Invalid managed SSH probe binding");
    const contents = `restrict ${input.publicKey} stackpilot-probe-${input.planId}\n`, entries = await this.entries();
    let entry = entries.find(value => value.account === input.account);
    if (entry && (entry.uid !== input.binding.uid || entry.home !== input.binding.home)) throw new Error("SSH probe account identity changed");
    if (entry && (entry.planId !== input.planId || entry.hash !== digest(contents))) {
      await this.remove(entry.planId, entry.account); entry.planId = input.planId; entry.hash = digest(contents); await this.save(entries);
    }
    if (!entry) {
      if (entries.length >= 1024) throw new Error("SSH public probe registry limit reached");
      // Never adopt an existing user or administrator .ssh directory.
      const home = await open(input.binding.home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { try { const existing = await open(`/proc/self/fd/${home.fd}/.ssh`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await existing.close(); throw new Error("Existing SSH directory requires manual review"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } finally { await home.close(); }
      entry = EntrySchema.parse({ account: input.account, planId: input.planId, home: input.binding.home, uid: input.binding.uid, hash: digest(contents), directoryInode: null }); entries.push(entry); await this.save(entries);
    }
    const directory = await this.directory(entry, true);
    try {
      const path = `/proc/self/fd/${directory.fd}/authorized_keys`;
      if ((await readdir(`/proc/self/fd/${directory.fd}`)).some(name => name !== "authorized_keys")) throw new Error("SSH probe directory has unexpected contents");
      entry.directoryInode = String((await directory.stat()).ino); await directory.chmod(0o755); await this.save(entries);
      let file;
      try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stat = await existing.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.mode & 0o022 || stat.size > 16384 || digest(await existing.readFile("utf8")) !== entry.hash) throw new Error("SSH public probe key drifted"); } finally { await existing.close(); }
        return;
      }
      try { await file.chmod(0o644); await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
      await directory.sync();
    } finally { await directory.close(); }
  }
  async remove(planId: string, account: string) {
    const entries = await this.entries(), entry = entries.find(value => value.account === account && value.planId === planId); if (!entry) return;
    let directory;
    try { directory = await this.directory(entry, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && entry.directoryInode === null) return; throw error; }
    try {
      const path = `/proc/self/fd/${directory.fd}/authorized_keys`;
      let file;
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.mode & 0o022 || stat.size > 16384 || digest(await file.readFile("utf8")) !== entry.hash) throw new Error("SSH public probe key no longer belongs to this plan"); } finally { await file.close(); }
      await unlink(path); await directory.sync();
    } finally { await directory.close(); }
    // Retain the protected directory binding so a later plan can reuse only
    // this helper-created, empty directory without adopting user data.
    await this.save(entries);
  }
}
