import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { requireNativeSshHost } from "../../apps/ssh-helper/dist/environment.js";
import { rootDirectory, rootFile } from "../../apps/ssh-helper/dist/files.js";
import { RootStore } from "../../apps/ssh-helper/dist/store.js";
import { TakeoverJournalStore } from "../../apps/ssh-helper/dist/takeoverJournal.js";

const execute = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prefix = "/opt/stackpilot-ssh-helper", current = `${prefix}/current`;
const units = ["stackpilot-ssh-helper.service", "stackpilot-ssh-enroll.service", "stackpilot-ssh-rollback@.service", "stackpilot-ssh-boot-recovery.service"];
const environment = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
let phase = "preflight";
class InstallError extends Error { constructor(code, message) { super(message); this.code = code; } }
async function run(file, args, cwd = source) { return execute(file, args, { cwd, env: environment, timeout: 120_000, maxBuffer: 1024 * 1024 }); }
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function directory(path, mode) { if (!await exists(path)) { await rootDirectory(dirname(path)); await mkdir(path, { mode }); } await rootDirectory(path); await chmod(path, mode); }
async function copyTree(from, to) {
  const stat = await lstat(from);
  if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("Release inputs must be root-owned and not writable by other users");
  if (stat.isDirectory()) { await mkdir(to, { mode: 0o755 }); for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name)); }
  else { if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsupported release input"); await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, 0o644); }
}
async function atomicInstall(from, target, mode) {
  await rootDirectory(dirname(target));
  const previous = await exists(target);
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.uid !== 0 || previous.nlink !== 1 || (previous.mode & 0o022))) throw new Error("Unsafe installed SSH helper target");
  const temporary = join(dirname(target), `.stackpilot-install-${randomUUID()}`);
  try {
    await copyFile(from, temporary, constants.COPYFILE_EXCL); await chmod(temporary, mode);
    const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const parent = await open(dirname(target), constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function authenticationDigest() {
  return createHash("sha256").update(await rootFile("/etc/ssh/sshd_config")).update("\0").update(await rootFile("/etc/pam.d/sshd")).digest("hex");
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "install") throw new Error("Usage: node deploy/scripts/install-ssh-helper.mjs install");
  await requireNativeSshHost(); await rootDirectory(source);
  process.umask(0o022);
  const active = (await run("/usr/bin/systemctl", ["show", "stackpilot-ssh-helper.service", "--property=ActiveState", "--value"])).stdout.trim();
  if (!["inactive", "failed"].includes(active)) throw new InstallError("HELPER_ACTIVE", "Stop the SSH helper explicitly before installing or upgrading; existing connection scopes keep their deadlines");
  const state = new RootStore("/var/lib/stackpilot-ssh-helper"); await state.prepare();
  const journal = await new TakeoverJournalStore(state).read();
  if (journal && !["managed", "rolled-back"].includes(journal.state)) throw new InstallError("TAKEOVER_UNRESOLVED", "Resolve the unfinished SSH takeover before changing helper files");
  const baseline = await authenticationDigest();
  const pkg = JSON.parse(await rootFile(join(source, "package.json")));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("Invalid release version");
  await directory(prefix, 0o755); await directory(`${prefix}/releases`, 0o755);
  const previous = await exists(current);
  if (previous) { if (!previous.isSymbolicLink() || previous.uid !== 0) throw new Error("Current helper release must be a root-owned symlink"); await rootDirectory(await realpath(current)); }
  const release = `${prefix}/releases/${pkg.version}`, staging = `${release}.installing-${randomUUID()}`;
  if (await exists(release)) {
    await rootDirectory(release);
    const recorded = JSON.parse(await rootFile(join(release, "ssh-installation.json")));
    if (recorded.version !== pkg.version) throw new Error("Existing release is incomplete");
    for (const entry of recorded.files) {
      if (typeof entry.path !== "string" || !/^[a-zA-Z0-9_./@-]+$/.test(entry.path) || entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error("Invalid installed release receipt");
      const stat = await lstat(join(release, entry.path)); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("Installed release permissions drifted");
      if (createHash("sha256").update(await readFile(join(release, entry.path))).digest("hex") !== entry.sha256) throw new Error("Installed release contents drifted");
    }
  } else {
    phase = "stage-release";
    await mkdir(staging, { mode: 0o755 });
    try {
      for (const path of ["apps/ssh-helper", "packages/contracts", "deploy/systemd"]) await mkdir(join(staging, path), { recursive: true, mode: 0o755 });
      for (const path of ["package.json", "package-lock.json", "apps/ssh-helper/package.json", "apps/ssh-helper/dist", "apps/ssh-helper/native", "packages/contracts/package.json", "packages/contracts/dist"])
        await copyTree(join(source, path), join(staging, path));
      for (const unit of units) await copyTree(join(source, "deploy/systemd", unit), join(staging, "deploy/systemd", unit));
      phase = "install-dependencies";
      await run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--workspace", "@stackpilot/ssh-helper", "--include-workspace-root", "--no-audit", "--no-fund"], staging);
      phase = "compile-native";
      const native = join(staging, "apps/ssh-helper/native"), build = join(staging, "apps/ssh-helper/build"); await mkdir(build, { mode: 0o755 });
      const flags = ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2", "-Wl,-z,relro,-z,now"];
      await run("/usr/bin/cc", [...flags, "-fPIC", "-shared", "-o", join(build, "pam_stackpilot.so"), join(native, "pam_stackpilot.c"), "-lpam"], staging);
      await run("/usr/bin/cc", [...flags, "-o", join(build, "stackpilot-ssh-service"), join(native, "stackpilot_ssh_service.c")], staging);
      phase = "verify-release";
      await run("/usr/bin/node", ["--input-type=module", "-e", 'await import("./apps/ssh-helper/dist/main.js")'], staging);
      const files = [];
      const inventory = async path => { for (const name of await readdir(join(staging, path))) { const relative = path ? `${path}/${name}` : name, stat = await lstat(join(staging, relative)); if (stat.isDirectory()) await inventory(relative); else if (stat.isFile()) files.push({ path: relative, sha256: createHash("sha256").update(await readFile(join(staging, relative))).digest("hex") }); else if (!stat.isSymbolicLink() || !relative.startsWith("node_modules/")) throw new Error("Unexpected release file type"); } };
      await inventory("");
      const receipt = await open(join(staging, "ssh-installation.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644); try { await receipt.writeFile(JSON.stringify({ version: pkg.version, files })); await receipt.sync(); } finally { await receipt.close(); }
      await rename(staging, release);
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  }
  phase = "install-passive-files";
  const beforeActivation = (await run("/usr/bin/systemctl", ["show", "stackpilot-ssh-helper.service", "--property=ActiveState", "--value"])).stdout.trim();
  if (!["inactive", "failed"].includes(beforeActivation)) throw new InstallError("HELPER_ACTIVE", "SSH helper was started during installation; stop it and retry");
  for (const path of ["/usr/lib/security", "/usr/libexec"]) await directory(path, 0o755);
  await directory("/etc/stackpilot-ssh-helper", 0o700);
  await atomicInstall(join(release, "apps/ssh-helper/build/pam_stackpilot.so"), "/usr/lib/security/pam_stackpilot.so", 0o755);
  await atomicInstall(join(release, "apps/ssh-helper/build/stackpilot-ssh-service"), "/usr/libexec/stackpilot-ssh-service", 0o755);
  for (const unit of units) await atomicInstall(join(release, "deploy/systemd", unit), `/etc/systemd/system/${unit}`, 0o644);
  const link = `${prefix}/.current-${randomUUID()}`;
  try { await symlink(release, link); await rename(link, current); } finally { await unlink(link).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  await run("/usr/bin/systemctl", ["daemon-reload"]);
  if (await authenticationDigest() !== baseline) throw new Error("SSH authentication changed during installation; inspect the host before continuing");
  process.stdout.write(`Installed SSH helper ${pkg.version}. SSH authentication and service activation are unchanged.\nConfigure root-only helper.env, CA and enrollment-token, then explicitly start stackpilot-ssh-enroll.service. Enable boot recovery before requesting takeover; start the helper separately.\n`);
}
void main().catch(error => { const code = /^[A-Z0-9_]{1,40}$/.test(String(error.code ?? "")) ? String(error.code) : "INSTALL_FAILED"; const reason = error instanceof InstallError ? error.message : "Check supported OS, root-owned inputs, compiler/PAM headers, npm access and unfinished takeover state"; process.stderr.write(`SSH helper installation failed during ${phase} (${code}). ${reason}. SSH authentication is not switched by this installer.\n`); process.exitCode = 1; });
