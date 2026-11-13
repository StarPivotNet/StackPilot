import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { rootDirectory, rootFile } from "./files.js";
import { runCommand, type CommandRunner } from "./commands.js";

/** Boot recovery must gate both native SSH activation paths before a trial. */
export async function requireBootRecovery(run: CommandRunner = runCommand) {
  const unit = "/etc/systemd/system/stackpilot-ssh-boot-recovery.service";
  await rootDirectory(dirname(unit));
  const contents = await rootFile(unit);
  if (!contents.includes("Before=ssh.service ssh.socket") || !contents.includes("/apps/ssh-helper/dist/rollback.js boot")) throw new Error("SSH boot recovery unit is unavailable");
  for (const name of ["ssh.service", "ssh.socket"]) {
    const link = `/etc/systemd/system/${name}.requires/stackpilot-ssh-boot-recovery.service`;
    await rootDirectory(dirname(link)); const stat = await lstat(link);
    if (!stat.isSymbolicLink() || stat.uid !== 0 || await realpath(link) !== unit) throw new Error("SSH startup does not require boot recovery");
  }
  const properties = await run("/usr/bin/systemctl", ["show", "stackpilot-ssh-boot-recovery.service", "--property=LoadState,UnitFileState"]);
  if (!/^LoadState=loaded$/m.test(properties) || !/^UnitFileState=enabled$/m.test(properties)) throw new Error("SSH boot recovery is not enabled");
}
