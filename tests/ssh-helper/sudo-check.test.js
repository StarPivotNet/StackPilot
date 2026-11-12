import assert from "node:assert/strict";
import test from "node:test";
import { checkSudoListing, verifyEffectiveSudo } from "../../apps/ssh-helper/dist/sudoCheck.js";
const base = { account: "sp_test", enabled: true, services: ["api.service"], profile: "service-operator" };
const commands = ["start", "stop", "restart"].map(action => `/usr/libexec/stackpilot-ssh-service ${action} api.service`).join(", ");
const listing = `User sp_test may run the following commands on host:\n    (root) NOPASSWD: NOSETENV: EXEC: ${commands}\n`;
test("effective sudo requires all and only the permitted wrapper commands", () => {
  checkSudoListing(base, listing);
  checkSudoListing(base, listing.replace("on host:", "on\n        long-hostname:"));
  for (const changed of [listing.replace("NOSETENV", "SETENV"), listing.replace("(root)", "(ALL : ALL)"), `${listing}    (root) NOPASSWD: ALL\n`, listing.replace("restart api.service", "restart worker.service"), listing.replace("NOPASSWD", "PASSWD")]) assert.throws(() => checkSudoListing(base, changed));
});
test("shell and disabled policies reject inherited sudo access", async () => {
  assert.throws(() => checkSudoListing({ ...base, profile: "shell" }, listing));
  assert.throws(() => checkSudoListing({ ...base, enabled: false }, listing));
  const denied = async () => { throw Object.assign(new Error("denied"), { code: 1, stderr: "User sp_test is not allowed to run sudo on host." }); };
  await verifyEffectiveSudo({ ...base, profile: "shell" }, denied);
  await verifyEffectiveSudo({ ...base, profile: "shell" }, async () => "User sp_test is not allowed to run sudo on host.\n");
  await assert.rejects(verifyEffectiveSudo({ ...base, profile: "shell" }, async () => "User sp_other is not allowed to run sudo on host.\n"));
  await assert.rejects(verifyEffectiveSudo({ ...base, profile: "shell" }, async () => `User sp_test is not allowed to run sudo on host.\n${listing}`));
  await assert.rejects(verifyEffectiveSudo(base, denied));
  await assert.rejects(verifyEffectiveSudo({ ...base, profile: "shell" }, async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }));
});
