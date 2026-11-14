import { spawn } from "node:child_process";
import { HelperError } from "./types.js";

export type CommandOutput = { stdout: string; stderr: string };
export type FixedCommandRunner = (executable: string, args: readonly string[], timeoutMs: number, input?: string) => Promise<CommandOutput>;

export const WG_EXECUTABLE = "/usr/bin/wg";
export const IP_EXECUTABLE = "/usr/sbin/ip";
export const NFT_EXECUTABLE = "/usr/sbin/nft";
const ALLOWED = new Set([WG_EXECUTABLE, IP_EXECUTABLE, NFT_EXECUTABLE]);
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export const runFixedCommand: FixedCommandRunner = (executable, args, timeoutMs, input) => {
  if (!ALLOWED.has(executable)) return Promise.reject(new HelperError("EXECUTABLE_FORBIDDEN", "Executable is not in the helper allowlist"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let stdoutBytes = 0; let stderrBytes = 0; let settled = false;
    const finish = (error: HelperError | null, output?: CommandOutput) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(output!);
    };
    const timer = setTimeout(() => finish(new HelperError("COMMAND_TIMEOUT", "The fixed mesh helper command timed out")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk); });
    child.once("error", () => finish(new HelperError("COMMAND_FAILED", "The fixed mesh helper command could not start")));
    child.once("close", (code) => finish(
      code === 0 ? null : new HelperError("COMMAND_FAILED", "The fixed mesh helper command failed"),
      code === 0 ? { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") } : undefined,
    ));
    child.stdin.once("error", () => undefined);
    child.stdin.end(input ?? "");
  });
};
