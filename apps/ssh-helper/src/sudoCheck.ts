import { checkSudoListing, type SshPolicy } from "@stackpilot/contracts";
import type { CommandRunner } from "./commands.js";
export { checkSudoListing };
export async function verifyEffectiveSudo(policy: SshPolicy, run: CommandRunner) {
  const noGrant = (text: string) => /^[a-z0-9_]+$/.test(policy.account) && new RegExp(`^User ${policy.account} is not allowed to run sudo on [^\\n]+\\.$`).test(text.trim());
  let output: string;
  try { output = await run("/usr/bin/sudo", ["-n", "-l", "-U", policy.account]); }
  catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if ((!policy.enabled || policy.profile === "shell") && failure.code === 1 && noGrant(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`)) return;
    throw new Error("Cannot verify effective SSH sudo policy");
  }
  if ((!policy.enabled || policy.profile === "shell") && noGrant(output)) return;
  checkSudoListing(policy, output);
}
