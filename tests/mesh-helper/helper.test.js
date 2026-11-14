import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { NetworkMeshStatusDataSchema } from "@stackpilot/contracts";
import { loadConfig } from "../../apps/mesh-helper/dist/config.js";
import { serve } from "../../apps/mesh-helper/dist/main.js";
import { handleRequest } from "../../apps/mesh-helper/dist/protocol.js";
import { collectMeshStatus, parseInterfaceDump, readInterfaceMtu } from "../../apps/mesh-helper/dist/status.js";
import { HelperError } from "../../apps/mesh-helper/dist/types.js";

const key = () => randomBytes(32).toString("base64");
const collectedAt = new Date("2026-07-16T04:00:00.000Z");
const enforced = { enforced: true, dataPlanePort: 18_080 };

function dump({ listenPort = 51820, peers = [] } = {}) {
  const header = `${key()}\t${key()}\t${listenPort}\toff`;
  return [header, ...peers].join("\n");
}

function peer({ address = "100.64.0.2", handshake = Math.floor(collectedAt.getTime() / 1_000) - 12 } = {}) {
  return `${key()}\t(none)\t203.0.113.7:51820\t${address}/32\t${handshake}\t1024\t2048\toff`;
}

test("interface dump parsing reports overlay peers and never exposes the private key", () => {
  const privateKey = key();
  const publicKey = key();
  const header = `${privateKey}\t${publicKey}\t51820\toff`;
  const status = parseInterfaceDump("wg0", [header, peer()].join("\n"), collectedAt, enforced);
  assert.equal(JSON.stringify(status).includes(privateKey), false);
  assert.equal(status.collectionStatus, "complete");
  assert.deepEqual(status.warnings, []);
  assert.equal(status.interface.publicKey, publicKey);
  assert.equal(status.interface.listenPort, 51820);
  assert.equal(status.interface.peerCount, 1);
  assert.equal(status.peers[0].overlayAddress, "100.64.0.2");
  assert.equal(status.peers[0].handshakeAgeSeconds, 12);
  assert.equal(status.peers[0].endpoint, "203.0.113.7:51820");
  assert.equal(NetworkMeshStatusDataSchema.safeParse(status).success, true);
});

test("peers outside the overlay plan and unlistened interfaces degrade to partial collection", () => {
  const status = parseInterfaceDump("wg0", dump({ listenPort: 0, peers: [peer({ address: "10.8.0.2" }), peer({ handshake: 0 })] }), collectedAt, enforced);
  assert.equal(status.collectionStatus, "partial");
  assert.equal(status.peers.length, 1);
  assert.equal(status.peers[0].latestHandshakeAt, null);
  assert.equal(status.peers[0].handshakeAgeSeconds, null);
  assert.equal(status.interface.listenPort, null);
  assert.ok(status.warnings.some((warning) => /overlay address plan/.test(warning)));
  assert.ok(status.warnings.some((warning) => /not listening/.test(warning)));
  assert.equal(NetworkMeshStatusDataSchema.safeParse(status).success, true);
});

test("interface MTU comes from the link, not from the wireguard dump", async () => {
  const config = { interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" };
  const status = await collectMeshStatus(config, { now: () => collectedAt, run: async () => ({ stdout: dump({ peers: [peer()] }), stderr: "" }), mtu: async () => 1420 });
  assert.equal(status.interface.mtu, 1420);
  assert.equal(status.peers.length, 1);
  const missing = await collectMeshStatus(config, { now: () => collectedAt, run: async () => ({ stdout: dump(), stderr: "" }), mtu: async () => null });
  assert.equal(missing.interface.mtu, null);
  assert.equal(await readInterfaceMtu("stackpilot-nonexistent-interface"), null);
});

test("unavailable wireguard tooling is reported without failing the helper", async () => {
  const unavailable = await collectMeshStatus({ interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" }, {
    now: () => collectedAt,
    firewall: async () => enforced,
    run: async () => { throw new HelperError("COMMAND_FAILED", "failed"); },
  });
  assert.equal(unavailable.collectionStatus, "unavailable");
  assert.equal(unavailable.interface, null);
  assert.deepEqual(unavailable.peers, []);
  assert.equal(unavailable.warnings.length, 1);

  const timedOut = await collectMeshStatus({ interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" }, {
    now: () => collectedAt,
    firewall: async () => enforced,
    run: async () => { throw new HelperError("COMMAND_TIMEOUT", "timeout"); },
  });
  assert.deepEqual(timedOut.warnings, ["wg show timed out"]);

  const responses = await handleRequest(JSON.stringify({ operation: "status" }), {
    config: { interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" },
    status: async () => parseInterfaceDump("wg0", dump({ peers: [peer()] }), collectedAt, enforced),
  });
  assert.equal(responses.ok, true);
  assert.equal(NetworkMeshStatusDataSchema.safeParse(responses.data).success, true);
});

test("a host whose nft table is missing reports the overlay whitelist as unenforced", async () => {
  const status = await collectMeshStatus({ interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" }, {
    now: () => collectedAt,
    run: async (executable) => {
      if (executable === "/usr/sbin/nft") throw new HelperError("COMMAND_FAILED", "nft is missing");
      return { stdout: dump({ peers: [peer()] }), stderr: "" };
    },
    mtu: async () => 1420,
  });
  assert.deepEqual(status.firewall, { enforced: false, dataPlanePort: 18_080 });
  assert.equal(status.collectionStatus, "partial");
  assert.equal(status.peers.length, 1);
  assert.ok(status.warnings.some((warning) => /whitelist is not installed/.test(warning)));
  assert.equal(NetworkMeshStatusDataSchema.safeParse(status).success, true);
});

test("the fixed protocol accepts only the parameterless status operation", async () => {
  const injected = async () => parseInterfaceDump("wg0", dump(), collectedAt, enforced);
  assert.equal((await handleRequest(JSON.stringify({ operation: "status" }), { status: injected })).ok, true);
  for (const raw of [
    "{",
    JSON.stringify({ operation: "apply", configuration: "..." }),
    JSON.stringify({ operation: "status", path: "/etc/wireguard/wg0.conf" }),
    JSON.stringify({ operation: "status", command: "wg-quick up wg0" }),
    JSON.stringify([]),
  ]) {
    const response = await handleRequest(raw, { status: injected });
    assert.equal(response.ok, false, raw);
    assert.equal(response.errorCode, "INVALID_REQUEST", raw);
  }
});

test("one socket activation per request yields exactly one JSON line", async () => {
  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  await serve(Readable.from([`${JSON.stringify({ operation: "status" })}\n`]), sink);
  const lines = chunks.join("").split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]);
  assert.equal(response.ok, true);
  assert.equal(response.operation, "status");
  assert.ok(["complete", "partial", "unavailable"].includes(response.data.collectionStatus));

  const duplicate = [];
  const duplicateSink = new Writable({ write(chunk, _encoding, callback) { duplicate.push(chunk.toString()); callback(); } });
  await serve(Readable.from([`${JSON.stringify({ operation: "status" })}\n${JSON.stringify({ operation: "status" })}\n`]), duplicateSink);
  assert.equal(JSON.parse(duplicate.join("")).errorCode, "INVALID_REQUEST");
});

test("mesh helper configuration rejects unsafe interface names and state directories", () => {
  assert.deepEqual(loadConfig({}), { interfaceName: "wg0", stateRoot: "/var/lib/stackpilot-mesh" });
  assert.equal(loadConfig({ STACKPILOT_MESH_INTERFACE: "wg1" }).interfaceName, "wg1");
  assert.throws(() => loadConfig({ STACKPILOT_MESH_INTERFACE: "wg0;rm -rf /" }), /interface name/);
  assert.throws(() => loadConfig({ STACKPILOT_MESH_STATE_DIR: "var/lib/stackpilot-mesh" }), /absolute path/);
});
