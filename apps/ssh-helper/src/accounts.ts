import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sshAccountName, SshPolicySchema, type SshPolicy } from "@stackpilot/contracts";
import type { RootStore } from "./store.js";
import { buildSudoPolicy } from "./sudoPolicy.js";
import { atomicRootFile, rootDirectory, rootFile } from "./files.js";
import { runCommand, type CommandRunner } from "./commands.js";
import { verifyEffectiveSudo } from "./sudoCheck.js";

const RecordSchema = z.object({ policyId: z.string().uuid(), nodeId: z.string().uuid(), userId: z.string().uuid(), account: z.string(), uid: z.number().int().min(1000), gid: z.number().int().positive().nullable(), revision: z.number().int(), enabled: z.boolean(), status: z.enum(["creating", "create-dispatched", "applying", "ready"]), sudoHash: z.string().nullable(), nextSudoHash: z.string().nullable(), grantsHash: z.string().nullable(), policy: SshPolicySchema }).strict();
type AccountRecord = z.infer<typeof RecordSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type AccountPaths = { homes: string; sudoers: string; grants: string };
const defaultPaths = { homes: "/var/lib/stackpilot-ssh-users", sudoers: "/etc/sudoers.d", grants: "/etc/stackpilot-ssh-helper/service-grants" };
export class AccountManager {
  private records: AccountRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RootStore, private readonly nodeId: string, private readonly beforeChange: (account: string) => Promise<void>, private readonly validateService: (unit: string) => Promise<void>, private readonly run: CommandRunner = runCommand, private readonly paths: AccountPaths = defaultPaths) {}
  async initialize() {
    await mkdir(this.paths.homes, { recursive: true, mode: 0o755 }); await rootDirectory(this.paths.homes); await chmod(this.paths.homes, 0o755);
    try { this.records = z.array(RecordSchema).max(1024).parse(JSON.parse(await this.store.read("accounts.json"))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.records.some(record => record.nodeId !== this.nodeId || record.account !== sshAccountName(record.userId))) throw new Error("Invalid local SSH account registry");
  }
  private async save() { await this.store.write("accounts.json", JSON.stringify(this.records)); }
  private async lookup(account: string) {
    let text: string;
    try { text = await this.run("/usr/bin/getent", ["passwd", account]); } catch (error) { if ((error as { code?: unknown }).code === 2) return null; throw error; }
    const fields = text.trim().split(":");
    if (fields.length !== 7 || fields[0] !== account || !/^\d+$/.test(fields[2] ?? "") || !/^\d+$/.test(fields[3] ?? "")) throw new Error("Invalid system account response");
    return { uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5], shell: fields[6] };
  }
  async verify(account: string) {
    const record = this.records.find(value => value.account === account && value.status === "ready" && value.enabled);
    if (!record) throw new Error("SSH account is not provisioned");
    const user = await this.lookup(account);
    if (!user || user.uid !== record.uid || user.gid !== record.gid || user.home !== join(this.paths.homes, account) || user.shell !== "/bin/bash") throw new Error("SSH system identity drifted");
    const groups = (await this.run("/usr/bin/id", ["-G", account])).trim().split(/\s+/).map(Number); if (groups.length !== 1 || groups[0] !== record.gid) throw new Error("SSH supplementary groups drifted");
    if (hash(await this.sudoContents(account)) !== record.sudoHash || hash(await rootFile(join(this.paths.grants, account))) !== record.grantsHash) throw new Error("SSH privilege policy drifted");
    await verifyEffectiveSudo(record.policy, this.run);
  }
  private async sudoContents(account: string) { try { return await rootFile(join(this.paths.sudoers, `stackpilot-ssh-${account}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } }
  async binding(account: string, policyId: string, revision: number) {
    await this.verify(account);
    const record = this.records.find(value => value.account === account && value.policyId === policyId && value.revision === revision && value.enabled && value.status === "ready");
    if (!record) throw new Error("SSH policy binding changed before takeover preparation");
    return { uid: record.uid, home: join(this.paths.homes, account) };
  }
  async apply(raw: SshPolicy) {
    const result = this.tail.then(async () => {
      try { return await this.applyExclusive(raw); }
      catch (error) {
        const record = this.records.find(value => value.account === raw.account && value.nodeId === raw.nodeId && value.userId === raw.userId);
        if (record) { record.enabled = false; if (record.status === "ready") record.status = "applying"; await this.save().catch(() => undefined); await this.beforeChange(record.account).catch(() => undefined); }
        throw error;
      }
    }); this.tail = result.catch(() => undefined); return result;
  }
  private async applyExclusive(raw: SshPolicy) {
    const policy = SshPolicySchema.parse(raw); const files = buildSudoPolicy(policy, this.nodeId);
    if (policy.enabled && policy.profile === "service-operator") for (const unit of policy.services) await this.validateService(unit);
    let record = this.records.find(value => value.account === policy.account); let user = await this.lookup(policy.account);
    if (record?.status === "ready" && record.revision === policy.revision && record.enabled === policy.enabled && record.sudoHash === hash(files.sudoers) && record.grantsHash === hash(files.grants)) {
      if (record.enabled) await this.verify(policy.account);
      else if (!user || user.uid !== record.uid || user.gid !== record.gid || hash(await this.sudoContents(policy.account)) !== record.sudoHash) throw new Error("Disabled SSH identity drifted");
      if (!record.enabled) await verifyEffectiveSudo(policy, this.run); return { policyId: policy.id, revision: policy.revision, account: policy.account, uid: record.uid };
    }
    await this.beforeChange(policy.account);
    if (!record && !policy.enabled) return { policyId: policy.id, revision: policy.revision, account: policy.account, uid: null };
    if (!record) {
      if (user || this.records.length >= 1024) throw new Error("Refuse to adopt an existing unmanaged account");
      await mkdir(this.paths.homes, { recursive: true, mode: 0o755 }); await rootDirectory(this.paths.homes);
      await chmod(this.paths.homes, 0o755);
      const home = join(this.paths.homes, policy.account); if (await lstat(home).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; })) throw new Error("Refuse to adopt an existing home");
      if (await lstat(join(this.paths.sudoers, `stackpilot-ssh-${policy.account}`)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; })) throw new Error("Refuse to adopt an unmanaged sudo grant");
      const used = new Set((await this.run("/usr/bin/getent", ["passwd"])).trim().split("\n").map(line => Number(line.split(":")[2]))); for (const entry of this.records) used.add(entry.uid);
      let uid = 10_000; while (used.has(uid) && uid < 60_000) uid++; if (uid >= 60_000) throw new Error("SSH UID range exhausted");
      record = { policyId: policy.id, nodeId: this.nodeId, userId: policy.userId, account: policy.account, uid, gid: null, revision: policy.revision, enabled: false, status: "creating", sudoHash: null, nextSudoHash: hash(files.sudoers), grantsHash: null, policy }; this.records.push(record); await this.save();
    }
    if (record.policyId !== policy.id || record.userId !== policy.userId || record.nodeId !== policy.nodeId) throw new Error("SSH account ownership mismatch");
    if (!user) {
      if (record.status !== "creating") throw new Error("Managed account disappeared; manual recovery required");
      if (await lstat(join(this.paths.homes, policy.account)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; })) throw new Error("Incomplete SSH home requires manual recovery");
      record.status = "create-dispatched"; await this.save();
      await this.run("/usr/sbin/useradd", ["--uid", String(record.uid), "--user-group", "--groups", "", "--create-home", "--home-dir", join(this.paths.homes, policy.account), "--shell", "/bin/bash", "--password", "!", "--no-log-init", "--", policy.account]); user = await this.lookup(policy.account);
    }
    if (!user || user.uid !== record.uid || user.gid <= 0 || user.home !== join(this.paths.homes, policy.account) || user.shell !== "/bin/bash" || (record.gid !== null && record.gid !== user.gid)) throw new Error("Managed system account does not match its creation intent");
    const groups = (await this.run("/usr/bin/id", ["-G", policy.account])).trim().split(/\s+/).map(Number);
    if (groups.length !== 1 || groups[0] !== user.gid) throw new Error("SSH account has unmanaged supplementary groups");
    if ((await this.run("/usr/bin/getent", ["group", String(user.gid)])).split(":")[0] !== policy.account) throw new Error("SSH account does not own its private group");
    const homeStat = await lstat(user.home); if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== user.uid) throw new Error("Unsafe managed SSH home"); await chmod(user.home, 0o700);
    const sudoPath = join(this.paths.sudoers, `stackpilot-ssh-${policy.account}`);
    let old = ""; try { old = await rootFile(sudoPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (old && hash(old) !== record.sudoHash && hash(old) !== record.nextSudoHash) throw new Error("Managed sudo policy drifted");
    await this.run("/usr/sbin/visudo", ["-c"]);
    record.status = "applying"; record.enabled = false; record.nextSudoHash = hash(files.sudoers); record.gid = user.gid; await this.save();
    await mkdir(this.paths.grants, { recursive: true, mode: 0o700 }); await rootDirectory(this.paths.grants);
    await chmod(this.paths.grants, 0o700);
    await atomicRootFile(join(this.paths.grants, policy.account), files.grants, 0o600);
    if (files.sudoers) await atomicRootFile(sudoPath, files.sudoers, 0o440, async temporary => { await this.run("/usr/sbin/visudo", ["-cf", temporary]); });
    else { await rootDirectory(this.paths.sudoers); await unlink(sudoPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    try { await this.run("/usr/sbin/visudo", ["-c"]); } catch (error) { if (old) await atomicRootFile(sudoPath, old, 0o440); else await unlink(sudoPath).catch(() => undefined); throw error; }
    await verifyEffectiveSudo(policy, this.run);
    record.revision = policy.revision; record.enabled = policy.enabled; record.status = "ready"; record.sudoHash = hash(files.sudoers); record.nextSudoHash = null; record.grantsHash = hash(files.grants); record.policy = policy; await this.save();
    return { policyId: policy.id, revision: policy.revision, account: policy.account, uid: record.uid };
  }
}
