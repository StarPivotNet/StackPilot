import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { NetworkMeshApplyDataSchema } from "@stackpilot/contracts";
import { applyMeshConfiguration, meshConfigurationPath, meshStatePath, renderConfiguration } from "../../apps/mesh-helper/dist/configure.js";
import { collectMeshIdentity } from "../../apps/mesh-helper/dist/identity.js";
import { HelperError } from "../../apps/mesh-helper/dist/types.js";
import { parseRequest } from "../../apps/mesh-helper/dist/validation.js";

const config = { interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" };
const keyPath = `${config.stateRoot}/wg0.key`;
const generatedKey = () => randomBytes(32).toString("base64");
/** What `nft list table` prints once the helper ruleset is installed. */
const installedListing = `table inet stackpilot_mesh {\n\tchain input {\n\t\ttype filter hook input priority filter; policy accept;\n\t\tiifname "wg0" tcp dport 18080 accept\n\t\tiifname "wg0" counter packets 0 bytes 0 drop\n\t}\n}\n`;

function environment(initial = {}) {
  const store = new Map(Object.entries({ "/sys/class/net/wg0/flags": "0x1003\n", ...initial }));
  const calls = [];
  const state = { generated: generatedKey(), published: generatedKey(), failOn: null, firewallInstalled: false, interfacePresent: false, keepInterfaceOnDelete: false };
  const files = {
    store,
    read: async (path) => (store.has(path) ? store.get(path) : null),
    writePrivate: async (path, content) => { store.set(path, content); },
    remove: async (path) => { store.delete(path); },
    ensureDirectory: async () => {},
  };
  const run = async (executable, args, _timeout, input) => {
    calls.push([executable, ...args]);
    if (state.failOn?.(executable, args)) throw new HelperError("COMMAND_FAILED", "the fixed command failed");
    if (executable === "/usr/bin/wg" && args[0] === "genkey") return { stdout: `${state.generated}\n`, stderr: "" };
    if (executable === "/usr/bin/wg" && args[0] === "pubkey") {
      if (store.has(keyPath)) assert.equal(input, store.get(keyPath));
      return { stdout: `${state.published}\n`, stderr: "" };
    }
    if (executable === "/usr/sbin/nft" && args[0] === "list") {
      if (!state.firewallInstalled) throw new HelperError("COMMAND_FAILED", "no such table");
      return { stdout: installedListing, stderr: "" };
    }
    if (executable === "/usr/sbin/nft" && args[0] === "-f") { state.firewallInstalled = true; return { stdout: "", stderr: "" }; }
    if (executable === "/usr/sbin/nft" && args[0] === "delete") { state.firewallInstalled = false; return { stdout: "", stderr: "" }; }
    if (executable === "/usr/sbin/ip" && args[0] === "link" && args[1] === "show" && !state.interfacePresent) throw new HelperError("COMMAND_FAILED", "interface is missing");
    if (executable === "/usr/sbin/ip" && args[0] === "link" && args[1] === "add") state.interfacePresent = true;
    if (executable === "/usr/sbin/ip" && args[0] === "link" && args[1] === "del" && !state.keepInterfaceOnDelete) state.interfacePresent = false;
    return { stdout: "", stderr: "" };
  };
  return { files, run, state, calls };
}

const configuration = (revision, overrides = {}) => ({
  sourceRevision: revision, address: "100.64.0.7", listenPort: 51820, mtu: 1420,
  peers: [
    { publicKey: randomBytes(32).toString("base64"), overlayAddress: "100.64.0.2", endpoint: "203.0.113.7:51820" },
    { publicKey: randomBytes(32).toString("base64"), overlayAddress: "100.64.0.3", endpoint: null },
  ],
  ...overrides,
});

test("the first identity generates the key locally and never returns the private half", async () => {
  const environmentValue = environment();
  const identity = await collectMeshIdentity(config, environmentValue);
  assert.equal(identity.interfaceName, "wg0");
  assert.equal(identity.publicKey, environmentValue.state.published);
  assert.equal(identity.configuredRevision, 0);
  assert.equal(environmentValue.files.store.get(keyPath), `${environmentValue.state.generated}\n`);
  assert.equal(JSON.stringify(identity).includes(environmentValue.state.generated), false);
  assert.deepEqual(environmentValue.calls, [["/usr/bin/wg", "genkey"], ["/usr/bin/wg", "pubkey"]]);
});

test("configure writes a root-only setconf file, applies the interface and records the revision", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  const applied = await applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue);
  assert.equal(applied.appliedRevision, 1);
  assert.equal(applied.peerCount, 2);
  assert.equal(applied.publicKey, environmentValue.state.published);
  assert.equal(NetworkMeshApplyDataSchema.safeParse(applied).success, true);
  assert.deepEqual(environmentValue.calls, [
    ["/usr/bin/wg", "pubkey"],
    ["/usr/sbin/nft", "-f", "-"],
    ["/usr/sbin/ip", "link", "show", "dev", "wg0"],
    ["/usr/sbin/ip", "link", "add", "dev", "wg0", "type", "wireguard"],
    ["/usr/bin/wg", "setconf", "wg0", meshConfigurationPath(config)],
    ["/usr/sbin/ip", "address", "replace", "100.64.0.7/32", "dev", "wg0"],
    ["/usr/sbin/ip", "link", "set", "dev", "wg0", "mtu", "1420", "up"],
    ["/usr/sbin/ip", "route", "replace", "100.64.0.0/10", "dev", "wg0"],
  ]);
  const rendered = environmentValue.files.store.get(meshConfigurationPath(config));
  assert.match(rendered, /PrivateKey = /);
  assert.match(rendered, /ListenPort = 51820/);
  assert.match(rendered, /AllowedIPs = 100\.64\.0\.2\/32/);
  assert.match(rendered, /Endpoint = 203\.0\.113\.7:51820/);
  assert.match(rendered, /AllowedIPs = 100\.64\.0\.3\/32/);
  assert.equal(rendered.includes("Address ="), false);
  const state = JSON.parse(environmentValue.files.store.get(meshStatePath(config)));
  assert.equal(state.revision, 1);
  assert.equal(state.address, "100.64.0.7");
  assert.equal(state.peerCount, 2);
});

test("replaying the same revision is idempotent and never touches the interface again", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  const request = { revision: 1, configuration: configuration(1) };
  const first = await applyMeshConfiguration(config, request, environmentValue);
  const callsAfterFirst = environmentValue.calls.length;
  const second = await applyMeshConfiguration(config, request, environmentValue);
  assert.equal(second.appliedAt, first.appliedAt);
  assert.deepEqual(environmentValue.calls.slice(callsAfterFirst), [
    ["/usr/sbin/ip", "link", "show", "dev", "wg0"],
    ["/usr/sbin/nft", "list", "table", "inet", "stackpilot_mesh"],
    ["/usr/bin/wg", "pubkey"],
  ]);
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue), (error) => error.code === "REVISION_CONFLICT");
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 0, configuration: configuration(0) }, environmentValue), (error) => error.code === "REVISION_STALE");
});

test("a failed reload restores the previous accepted configuration", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  await applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue);
  const accepted = environmentValue.files.store.get(meshConfigurationPath(config));
  environmentValue.state.failOn = (executable, args) => executable === "/usr/sbin/ip" && args[0] === "route";
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 2, configuration: configuration(2) }, environmentValue), (error) => error.code === "COMMAND_FAILED");
  assert.equal(environmentValue.files.store.get(meshConfigurationPath(config)), accepted);
  assert.equal(JSON.parse(environmentValue.files.store.get(meshStatePath(config))).revision, 1);
  assert.equal(environmentValue.files.store.has(`${config.stateRoot}/wg0.previous.conf`), false);
  environmentValue.state.failOn = null;
  const retried = await applyMeshConfiguration(config, { revision: 2, configuration: configuration(2) }, environmentValue);
  assert.equal(retried.appliedRevision, 2);
});

test("a reload whose whitelist cannot be reinstalled takes the overlay down", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  await applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue);
  const accepted = environmentValue.files.store.get(meshConfigurationPath(config));
  environmentValue.state.failOn = (executable, args) => executable === "/usr/sbin/nft" && args[0] === "-f";
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 2, configuration: configuration(2) }, environmentValue), (error) => error.code === "FIREWALL_UNAVAILABLE");
  assert.equal(environmentValue.files.store.get(meshConfigurationPath(config)), accepted);
  assert.equal(JSON.parse(environmentValue.files.store.get(meshStatePath(config))).revision, 1);
  assert.deepEqual(environmentValue.calls.slice(-1), [["/usr/sbin/ip", "link", "set", "dev", "wg0", "down"]]);
});

test("a revision still on disk is re-applied when the host lost the interface", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  const request = { revision: 1, configuration: configuration(1) };
  await applyMeshConfiguration(config, request, environmentValue);
  // Host reboot: the state file survives, the device does not.
  environmentValue.state.interfacePresent = false;
  const callsBefore = environmentValue.calls.length;
  const reapplied = await applyMeshConfiguration(config, request, environmentValue);
  assert.equal(reapplied.appliedRevision, 1);
  assert.equal(environmentValue.calls.slice(callsBefore).some(([executable, action, sub]) => executable === "/usr/sbin/ip" && action === "link" && sub === "add"), true);
});

test("a revision still on disk is re-applied after a fail-closed link down", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  const request = { revision: 1, configuration: configuration(1) };
  await applyMeshConfiguration(config, request, environmentValue);
  // Fail-closed rollback took the link down while the accepted configuration and its whitelist stayed.
  environmentValue.files.store.set("/sys/class/net/wg0/flags", "0x1002\n");
  const callsBefore = environmentValue.calls.length;
  await applyMeshConfiguration(config, request, environmentValue);
  const replay = environmentValue.calls.slice(callsBefore).map((call) => call.join(" "));
  assert.equal(replay.some((line) => line.includes("wg setconf wg0")), true);
  assert.equal(replay.some((line) => line.endsWith("link set dev wg0 mtu 1420 up")), true);
});

test("a refused interface delete keeps the whitelist and takes the link down", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  environmentValue.state.interfacePresent = true;
  environmentValue.state.keepInterfaceOnDelete = true;
  environmentValue.state.failOn = (executable, args) => executable === "/usr/bin/wg" && args[0] === "setconf";
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue), (error) => error.code === "COMMAND_FAILED");
  const tail = environmentValue.calls.slice(-3);
  assert.deepEqual(tail, [
    ["/usr/sbin/ip", "link", "del", "dev", "wg0"],
    ["/usr/sbin/ip", "link", "show", "dev", "wg0"],
    ["/usr/sbin/ip", "link", "set", "dev", "wg0", "down"],
  ]);
  assert.equal(environmentValue.state.firewallInstalled, true, "the whitelist must survive a device that refused deletion");
});

test("a first apply that fails leaves no interface and no accepted revision behind", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  environmentValue.state.failOn = (executable, args) => executable === "/usr/bin/wg" && args[0] === "setconf";
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue), (error) => error.code === "COMMAND_FAILED");
  assert.equal(environmentValue.files.store.has(meshStatePath(config)), false);
  assert.deepEqual(environmentValue.calls.slice(-3), [
    ["/usr/sbin/ip", "link", "del", "dev", "wg0"],
    ["/usr/sbin/ip", "link", "show", "dev", "wg0"],
    ["/usr/sbin/nft", "delete", "table", "inet", "stackpilot_mesh"],
  ]);
});

test("a host that cannot install the overlay whitelist never gets an interface", async () => {
  const environmentValue = environment({ [keyPath]: `${generatedKey()}\n` });
  environmentValue.state.failOn = (executable, args) => executable === "/usr/sbin/nft" && args[0] === "-f";
  await assert.rejects(() => applyMeshConfiguration(config, { revision: 1, configuration: configuration(1) }, environmentValue), (error) => error.code === "FIREWALL_UNAVAILABLE");
  assert.equal(environmentValue.files.store.has(meshConfigurationPath(config)), false);
  assert.equal(environmentValue.files.store.has(meshStatePath(config)), false);
  assert.equal(environmentValue.calls.some(([executable, action, sub]) => executable === "/usr/sbin/ip" && action === "link" && sub === "add"), false);
});

test("rendering only emits keys that wg setconf understands", () => {
  const request = configuration(4);
  const rendered = renderConfiguration(request, "private-key-material=");
  assert.equal(rendered.includes("Address"), false);
  assert.equal(rendered.includes("[Interface]"), true);
  assert.equal(rendered.split("[Peer]").length - 1, 2);
  assert.equal(rendered.includes(`PublicKey = ${request.peers[0].publicKey}`), true);
  // Every peer route stays a host route, so no configuration can turn into a default route.
  assert.deepEqual(rendered.match(/AllowedIPs = .*/g), ["AllowedIPs = 100.64.0.2/32", "AllowedIPs = 100.64.0.3/32"]);
  assert.equal(rendered.includes("0.0.0.0/0"), false);
  assert.equal(rendered.includes("::/0"), false);
});

test("the fixed protocol only accepts a strictly shaped configure request", () => {
  const valid = { operation: "configure", revision: 3, configuration: configuration(3) };
  assert.equal(parseRequest(JSON.stringify(valid)).operation, "configure");
  assert.equal(parseRequest(JSON.stringify({ operation: "identity" })).operation, "identity");
  const reject = (body) => assert.throws(() => parseRequest(JSON.stringify(body)), (error) => error instanceof HelperError && error.code === "INVALID_REQUEST", JSON.stringify(body));
  reject({ ...valid, path: "/etc/wireguard/wg0.conf" });
  reject({ ...valid, command: "wg-quick up wg0" });
  reject({ ...valid, revision: 4 });
  reject({ ...valid, revision: 1.5 });
  reject({ ...valid, configuration: { ...valid.configuration, address: "10.8.0.1" } });
  reject({ ...valid, configuration: { ...valid.configuration, peers: [valid.configuration.peers[0], valid.configuration.peers[0]] } });
  reject({ ...valid, configuration: { ...valid.configuration, peers: [{ ...valid.configuration.peers[0], overlayAddress: "100.64.0.7" }] } });
  reject({ ...valid, configuration: { ...valid.configuration, peers: [{ ...valid.configuration.peers[0], endpoint: "203.0.113.7" }] } });
  reject({ ...valid, configuration: { ...valid.configuration, listenPort: 0 } });
  reject({ ...valid, configuration: { ...valid.configuration, mtu: 9001 } });
});
