import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureOverlayFirewall, OVERLAY_DATA_PLANE_PORT, OVERLAY_FIREWALL_TABLE, readOverlayFirewall, removeOverlayFirewall, renderFirewallRuleset,
} from "../../apps/mesh-helper/dist/firewall.js";
import { HelperError } from "../../apps/mesh-helper/dist/types.js";

const config = { interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" };

/** What `nft list table` prints for the ruleset above, including the counter counters. */
const installedListing = `table inet ${OVERLAY_FIREWALL_TABLE} {
\tchain input {
\t\ttype filter hook input priority filter; policy accept;
\t\tiifname "wg0" ct state established,related accept
\t\tiifname "wg0" ip protocol icmp accept
\t\tiifname "wg0" tcp dport ${OVERLAY_DATA_PLANE_PORT} accept
\t\tiifname "wg0" counter packets 0 bytes 0 drop
\t}
\tchain forward {
\t\ttype filter hook forward priority filter; policy accept;
\t\tiifname "wg0" counter packets 0 bytes 0 drop
\t}
}
`;

function runner({ listing = null, failOn = null } = {}) {
  const calls = [];
  const run = async (executable, args, _timeout, input) => {
    calls.push({ executable, args: [...args], input });
    if (failOn?.(executable, args)) throw new HelperError("COMMAND_FAILED", "the fixed command failed");
    if (executable === "/usr/sbin/nft" && args[0] === "list") {
      if (listing === null) throw new HelperError("COMMAND_FAILED", "no such table");
      return { stdout: listing, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("the overlay whitelist only forwards icmp, the data plane and replies", () => {
  const ruleset = renderFirewallRuleset("wg0");
  assert.match(ruleset, /^add table inet stackpilot_mesh$/m);
  assert.match(ruleset, /^delete table inet stackpilot_mesh$/m);
  assert.match(ruleset, /^table inet stackpilot_mesh \{$/m);
  assert.match(ruleset, /type filter hook input priority filter; policy accept;/);
  assert.match(ruleset, /iifname "wg0" ct state established,related accept/);
  assert.match(ruleset, /iifname "wg0" ip protocol icmp accept/);
  assert.match(ruleset, new RegExp(`iifname "wg0" tcp dport ${OVERLAY_DATA_PLANE_PORT} accept`));
  assert.match(ruleset, /iifname "wg0" counter drop/);
  // Everything else stays untouched: the helper owns one table, never the host ruleset.
  assert.equal(ruleset.match(/^table /gm).length, 1);
  assert.doesNotMatch(ruleset, /flush ruleset|policy drop|hook output/);
  assert.equal(OVERLAY_DATA_PLANE_PORT, 18_080);
});

test("no overlay traffic is relayed to a third hop", () => {
  const ruleset = renderFirewallRuleset("wg0");
  assert.match(ruleset, /chain forward \{\n\t\ttype filter hook forward priority filter; policy accept;\n\t\tiifname "wg0" counter drop/);
});

test("enforcement is read back from the scoped rules, not from the table name", async () => {
  const absent = runner();
  assert.deepEqual(await readOverlayFirewall(absent.run, "wg0"), { enforced: false, dataPlanePort: OVERLAY_DATA_PLANE_PORT });
  assert.deepEqual(absent.calls, [{ executable: "/usr/sbin/nft", args: ["list", "table", "inet", OVERLAY_FIREWALL_TABLE], input: undefined }]);

  assert.equal((await readOverlayFirewall(runner({ listing: installedListing }).run, "wg0")).enforced, true);
  // Another interface's table, or a whitelist deleted from the input chain while forward still drops,
  // must not read as enforced.
  assert.equal((await readOverlayFirewall(runner({ listing: installedListing }).run, "wg1")).enforced, false);
  const inputOnlyHeader = installedListing.replace(/\t\tiifname "wg0" tcp dport 18080 accept\n/, "");
  assert.equal((await readOverlayFirewall(runner({ listing: inputOnlyHeader }).run, "wg0")).enforced, false);
  const forwardOnlyDrop = `table inet ${OVERLAY_FIREWALL_TABLE} {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t\tiifname "wg0" tcp dport ${OVERLAY_DATA_PLANE_PORT} accept\n\t}\n\tchain forward {\n\t\ttype filter hook forward priority filter; policy accept;\n\t\tiifname "wg0" counter drop\n\t}\n}\n`;
  assert.equal((await readOverlayFirewall(runner({ listing: forwardOnlyDrop }).run, "wg0")).enforced, false);
});

test("installing replaces the table in one transaction, whatever the previous state was", async () => {
  const fresh = runner();
  await ensureOverlayFirewall(config, fresh.run);
  assert.deepEqual(fresh.calls.map((call) => call.args), [["-f", "-"]]);
  assert.equal(fresh.calls[0].input, renderFirewallRuleset("wg0"));
  // `add` then `delete` is the idempotent reset, so the same batch covers a reinstall: there is
  // never a window in which the interface exists without the whitelist.
  assert.match(fresh.calls[0].input, /^add table inet stackpilot_mesh$/m);
  assert.match(fresh.calls[0].input, /^delete table inet stackpilot_mesh$/m);

  const reinstall = runner({ listing: installedListing });
  await ensureOverlayFirewall(config, reinstall.run);
  assert.deepEqual(reinstall.calls.map((call) => call.args), [["-f", "-"]]);
});

test("a host without a usable nft fails closed instead of leaving the overlay open", async () => {
  const missing = runner({ failOn: (executable, args) => executable === "/usr/sbin/nft" && args[0] === "-f" });
  await assert.rejects(() => ensureOverlayFirewall(config, missing.run), (error) => error instanceof HelperError && error.code === "FIREWALL_UNAVAILABLE");
  // One transaction means a failure cannot have deleted the previous table.
  assert.deepEqual(missing.calls.map((call) => call.args), [["-f", "-"]]);
});

test("teardown removes the table and never fails the caller", async () => {
  const present = runner({ listing: installedListing });
  await removeOverlayFirewall(present.run);
  assert.deepEqual(present.calls.map((call) => call.args), [["delete", "table", "inet", OVERLAY_FIREWALL_TABLE]]);
  await removeOverlayFirewall(runner({ failOn: () => true }).run);
});

test("an unsafe interface name never reaches the ruleset", async () => {
  const calls = runner();
  await assert.rejects(() => ensureOverlayFirewall({ interfaceName: 'wg0" ; flush ruleset ; "', stateRoot: "/var/lib/stackpilot-mesh" }, calls.run), (error) => error.code === "INVALID_CONFIG");
  assert.deepEqual(calls.calls, []);
});
