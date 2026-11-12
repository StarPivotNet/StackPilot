import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const allowed = new Set(["/usr/bin/getent", "/usr/bin/id", "/usr/bin/sudo", "/usr/bin/systemctl", "/usr/bin/busctl", "/usr/sbin/useradd", "/usr/sbin/visudo", "/usr/sbin/sshd", "/usr/bin/ss", "/usr/bin/ssh-keygen"]);
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>;
export const runCommand: CommandRunner = async (file, args) => {
  if (!allowed.has(file)) throw new Error("Unsupported SSH helper executable");
  const result = await execute(file, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
  return result.stdout;
};
