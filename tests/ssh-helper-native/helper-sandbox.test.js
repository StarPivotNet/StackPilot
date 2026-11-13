import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

test("installed root helper sandbox retains sudo policy inspection on both distributions", { timeout: 30_000 }, async () => {
  assert.equal(process.getuid(), 0);
  assert.equal(process.env.STACKPILOT_DISPOSABLE_SYSTEMD_TEST, "1");
  const unit = await readFile("deploy/systemd/stackpilot-ssh-helper.service", "utf8");
  const keys = new Set(["User", "Group", "UMask", "NoNewPrivileges", "AmbientCapabilities", "PrivateTmp", "ProtectSystem", "ReadWritePaths", "ProtectHome", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectControlGroups", "ProtectClock", "RestrictRealtime", "LockPersonality", "RestrictAddressFamilies"]);
  const properties = unit.split("\n").filter(line => keys.has(line.split("=", 1)[0])).map(line => `--property=${line}`);
  const result = await promisify(execFile)("/usr/bin/systemd-run", ["--collect", "--wait", "--pipe", `--unit=stackpilot-ssh-sandbox-test-${randomUUID()}`, ...properties, "/usr/bin/sudo", "-n", "-l", "-U", "root"], { timeout: 25_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
  assert.match(result.stdout, /(?:User root|root may run)/);
  assert.doesNotMatch(result.stderr, /Operation not permitted|unable to open/);
});
