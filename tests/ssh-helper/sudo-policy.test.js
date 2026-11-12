import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sshAccountName } from "@stackpilot/contracts";
import { buildSudoPolicy } from "../../apps/ssh-helper/dist/sudoPolicy.js";

function policy(profile, services = []) { const userId = randomUUID(); return { id: randomUUID(), userId, nodeId: randomUUID(), account: sshAccountName(userId), profile, services, enabled: true, sessionSeconds: 28_800, revision: 1, appliedRevision: 0, updatedAt: new Date().toISOString() }; }
test("restricted sudo grants only exact service wrapper invocations", () => {
  const value = policy("service-operator", ["api.service", "worker.service"]); const result = buildSudoPolicy(value, value.nodeId);
  assert.equal(result.grants, "api.service\nworker.service\n");
  assert(!result.sudoers.includes("NOPASSWD: ALL")); assert(!result.sudoers.includes("/usr/bin/systemctl"));
  assert(result.sudoers.includes("/usr/libexec/stackpilot-ssh-service restart api.service")); assert(!result.sudoers.includes("*")); assert(result.sudoers.includes("NOSETENV:"));
});
test("normal and disabled accounts receive no sudo grant; full root must be explicit", () => {
  const shell = policy("shell"); assert.deepEqual(buildSudoPolicy(shell, shell.nodeId), { sudoers: "", grants: "" });
  const admin = policy("host-admin"); assert(buildSudoPolicy(admin, admin.nodeId).sudoers.includes("NOPASSWD: ALL")); admin.enabled = false; assert.equal(buildSudoPolicy(admin, admin.nodeId).sudoers, "");
});
test("sudo policy rejects other node/account bindings, control services and injection", () => {
  const value = policy("service-operator", ["api.service"]);
  assert.throws(() => buildSudoPolicy(value, randomUUID())); assert.throws(() => buildSudoPolicy({ ...value, account: "root" }, value.nodeId));
  for (const unit of ["ssh.service", "sshd.service", "stackpilot-ssh-helper.service", "systemd-logind.service", "user@1000.service", "dbus.service", "cron.service", "a;id.service", "api.service\n"]) assert.throws(() => buildSudoPolicy({ ...value, services: [unit] }, value.nodeId));
});
