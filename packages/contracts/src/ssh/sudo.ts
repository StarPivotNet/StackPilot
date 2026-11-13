import type { SshPolicy } from "./domain.js";
export function checkSudoListing(policy: SshPolicy, output: string) {
  const header = /may run the following commands on\s+[^\n]+:\s*\n/.exec(output);
  if (!header) throw new Error("Unsupported effective sudo listing");
  const block = output.slice(header.index + header[0].length).trim();
  const entries = block.split(/\n\s*(?=\()/).map(value => value.replace(/\s+/g, " ").trim());
  const wanted = new Set(policy.services.flatMap(unit => ["start", "stop", "restart"].map(action => `/usr/libexec/stackpilot-ssh-service ${action} ${unit}`)));
  if (!policy.enabled || policy.profile === "shell") throw new Error("SSH account has unexpected sudo permissions");
  let admin = false; const seen = new Set<string>();
  for (const entry of entries) {
    const match = /^\(root\)\s+((?:(?:[A-Z_]+):\s*)+)(.+)$/.exec(entry);
    if (!match) throw new Error("Unexpected sudo run-as or command entry");
    const tags = match[1]!.split(":").map(value => value.trim()).filter(Boolean);
    if (!tags.includes("NOPASSWD") || tags.includes("SETENV") || tags.includes("NOEXEC")) throw new Error("Unexpected sudo authentication or environment policy");
    for (const command of match[2]!.split(/\s*,\s*/)) {
      if (policy.profile === "host-admin" && command === "ALL") { admin = true; continue; }
      if (policy.profile !== "service-operator" || !tags.includes("NOSETENV") || !wanted.has(command)) throw new Error("Effective sudo exceeds the SSH grant"); seen.add(command);
    }
  }
  if (policy.profile === "host-admin" ? !admin : seen.size !== wanted.size) throw new Error("Effective sudo is missing required commands");
}
