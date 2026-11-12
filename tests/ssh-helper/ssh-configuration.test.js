import assert from "node:assert/strict";
import test from "node:test";
import { managedSshConfiguration, verifyManagedSshConfiguration, MANAGED_PAM } from "../../apps/ssh-helper/dist/sshConfiguration.js";
const input = { listeners: [{ address: "0.0.0.0", port: 22 }, { address: "::", port: 2222 }], hostKeys: ["/etc/ssh/ssh_host_ed25519_key"] };
test("managed configuration preserves exact entrances and removes every inherited auth path", () => {
  const config = managedSshConfiguration(input);
  assert.match(config, /^ListenAddress 0.0.0.0:22$/m); assert.match(config, /^ListenAddress \[::\]:2222$/m);
  assert(!/^\s*(?:Include|Match)\b/m.test(config)); assert.match(config, /^AuthenticationMethods keyboard-interactive:pam$/m);
  assert.match(config, /^PasswordAuthentication no$/m); assert.match(config, /^PubkeyAuthentication no$/m); assert.match(config, /^DisableForwarding yes$/m);
  assert(!MANAGED_PAM.includes("pam_systemd")); assert.equal(MANAGED_PAM.split("pam_stackpilot.so").length, 4);
  const output = config.split("\n").filter(line => line && !line.startsWith("#")).map(line => { const index = line.indexOf(" "); return `${line.slice(0, index).toLowerCase()}${line.slice(index)}`; }).join("\n");
  verifyManagedSshConfiguration(output); assert.throws(() => verifyManagedSshConfiguration(output.replace("pubkeyauthentication no", "pubkeyauthentication yes")));
  assert.throws(() => verifyManagedSshConfiguration(output.replace("subsystem sftp internal-sftp", "subsystem sftp /bin/sh")));
});
test("managed SSH rejects dynamic paths, invalid addresses and empty inventory", () => {
  for (const bad of [{ ...input, listeners: [] }, { ...input, hostKeys: ["/tmp/key\nMatch all"] }, { ...input, listeners: [{ address: "*", port: 22 }] }, { ...input, listeners: [{ address: "127.0.0.1", port: 70000 }] }]) assert.throws(() => managedSshConfiguration(bad));
});
