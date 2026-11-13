import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { NetworkMeshStatusDataSchema } from "@stackpilot/contracts";
import { activeAgentCapabilities, AGENT_CAPABILITIES } from "../../apps/agent/dist/capabilities/index.js";
import { meshHelperAvailable, MeshHelperError, readMeshIdentity, readMeshLink, requestMeshApply, requestMeshIdentity, requestMeshStatus } from "../../apps/agent/dist/mesh/helperClient.js";
import { summarizeMeshLink } from "../../apps/agent/dist/mesh/link.js";
import { meshConfigureHandler } from "../../apps/agent/dist/tasks/handlers/meshConfigure.js";
import { meshStatusHandler } from "../../apps/agent/dist/tasks/handlers/meshStatus.js";
import { taskRegistry } from "../../apps/agent/dist/tasks/registry.js";

const publicKey = () => randomBytes(32).toString("base64");
const status = {
  collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [],
  interface: { name: "wg0", present: true, listenPort: 51820, mtu: null, publicKey: publicKey(), peerCount: 1 },
  peers: [{ publicKey: publicKey(), overlayAddress: "100.64.0.2", endpoint: "203.0.113.7:51820", latestHandshakeAt: new Date().toISOString(), handshakeAgeSeconds: 4, receivedBytes: 1024, sentBytes: 2048 }],
  firewall: { enforced: true, dataPlanePort: 18_080 },
};

test("mesh status task is a linux-only retryable read bound to the mesh capability", () => {
  const definition = taskRegistry["network.mesh.status.read"];
  assert.equal(definition.capability, "network.mesh.read");
  assert.deepEqual(definition.platforms, ["linux"]);
  assert.equal(definition.cancellable, true);
  assert.equal(definition.retryable, true);
  assert.ok(definition.timeoutMs <= 30_000);
  assert.doesNotThrow(() => definition.validate({}));
  for (const parameters of [{ path: "/etc/wireguard/wg0.conf" }, { command: "wg show" }, { interface: "wg0" }]) {
    assert.throws(() => definition.validate(parameters), parameters.toString());
  }
});

test("mesh status handler forwards the helper snapshot as the bounded task result", async () => {
  const result = await meshStatusHandler({}, new AbortController().signal, async () => status);
  assert.match(result.message, /1 peer/);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.data, status);
  assert.equal(NetworkMeshStatusDataSchema.safeParse(result.data).success, true);
  await assert.rejects(() => meshStatusHandler({}, new AbortController().signal, async () => { throw new MeshHelperError("MESH_HELPER_TIMEOUT"); }), /MESH_HELPER_TIMEOUT|Mesh helper/);

  const partial = await meshStatusHandler({}, new AbortController().signal, async () => ({ ...status, collectionStatus: "partial" }));
  assert.match(partial.message, /partial/);
});

test("mesh helper client maps the fixed protocol onto typed errors", async () => {
  const factory = (write) => () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setTimeout = (_ms, handler) => { socket.timeoutHandler = handler; };
    socket.end = () => { queueMicrotask(() => write(socket, socket.timeoutHandler)); };
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
  const respond = (payload) => factory((socket) => { socket.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`)); socket.emit("end"); });
  assert.equal((await requestMeshStatus(undefined, "/run/mesh.sock", respond({ ok: true, operation: "status", data: status }))).collectionStatus, "complete");
  await assert.rejects(() => requestMeshStatus(undefined, "/run/mesh.sock", respond({ ok: false, errorCode: "COMMAND_FAILED", message: "wg unavailable" })), (error) => error.code === "COMMAND_FAILED");
  await assert.rejects(() => requestMeshStatus(undefined, "/run/mesh.sock", respond({ ok: true, data: { peers: [] } })), (error) => error.code === "MESH_HELPER_INVALID_RESPONSE");
  await assert.rejects(() => requestMeshStatus(undefined, "/run/mesh.sock", factory((socket) => socket.timeoutHandler())), (error) => error.code === "MESH_HELPER_TIMEOUT");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => requestMeshStatus(aborted.signal, "/run/mesh.sock", respond({ ok: true })), (error) => error.code === "MESH_HELPER_CANCELLED");
  assert.equal(await meshHelperAvailable("/run/mesh.sock"), false);
});

test("mesh read capability is declared only for linux nodes with a reachable helper", async () => {
  assert.ok(AGENT_CAPABILITIES.includes("network.mesh.read"));
  assert.ok(activeAgentCapabilities("linux", false, false, false, false, true).includes("network.mesh.read"));
  assert.equal(activeAgentCapabilities("linux", false, false, false, false, false).includes("network.mesh.read"), false);
  assert.equal(activeAgentCapabilities("darwin", false, false, false, false, true).includes("network.mesh.read"), false);
  assert.equal(await meshHelperAvailable(`${process.cwd()}/tests/agent/missing-mesh-helper.sock`), false);
});

const configured = (revision) => ({
  revision,
  configuration: {
    sourceRevision: revision, address: "100.64.0.7", listenPort: 51820, mtu: 1420,
    peers: [{ publicKey: publicKey(), overlayAddress: "100.64.0.2", endpoint: "203.0.113.7:51820" }],
  },
});

const applied = () => ({ appliedRevision: 1, interfaceName: "wg0", publicKey: publicKey(), peerCount: 1, appliedAt: new Date().toISOString() });

test("mesh configure task is a linux-only single-attempt write bound to its own capability", () => {
  const definition = taskRegistry["network.mesh.configure"];
  assert.equal(definition.capability, "network.mesh.configure");
  assert.deepEqual(definition.platforms, ["linux"]);
  assert.equal(definition.cancellable, false);
  assert.equal(definition.retryable, false);
  assert.ok(definition.timeoutMs <= 60_000);
  assert.doesNotThrow(() => definition.validate(configured(1)));
  const base = configured(1).configuration;
  for (const parameters of [
    { ...configured(1), path: "/etc/wireguard/wg0.conf" },
    { ...configured(1), command: "wg-quick up wg0" },
    { revision: 2, configuration: base },
    { revision: 1, configuration: { ...base, peers: [{ ...base.peers[0], overlayAddress: "100.64.0.7" }] } },
    { revision: 1, configuration: { ...base, peers: [{ ...base.peers[0], endpoint: "203.0.113.7" }] } },
  ]) assert.throws(() => definition.validate(parameters), JSON.stringify(parameters));
});

test("mesh configure handler forwards the opaque revision to the helper and reports it back", async () => {
  const received = [];
  const result = await meshConfigureHandler(configured(3), new AbortController().signal, async (input) => { received.push(input.revision); return { ...applied(), appliedRevision: 3 }; });
  assert.deepEqual(received, [3]);
  assert.match(result.message, /revision 3 applied with 1 peer/);
  assert.equal(result.truncated, false);
  assert.equal(result.data.appliedRevision, 3);
  await assert.rejects(() => meshConfigureHandler(configured(1), new AbortController().signal, async () => { throw new MeshHelperError("COMMAND_FAILED"); }), /COMMAND_FAILED|Mesh helper/);
  await assert.rejects(() => meshConfigureHandler({ revision: 1 }, new AbortController().signal, async () => applied()), (error) => error.name === "ZodError");
});

test("mesh write capability follows the helper like the read capability", () => {
  assert.ok(AGENT_CAPABILITIES.includes("network.mesh.configure"));
  const linux = activeAgentCapabilities("linux", false, false, false, false, true);
  assert.ok(linux.includes("network.mesh.read"));
  assert.ok(linux.includes("network.mesh.configure"));
  assert.equal(activeAgentCapabilities("linux", false, false, false, false, false).includes("network.mesh.configure"), false);
  assert.equal(activeAgentCapabilities("win32", false, false, false, false, true).includes("network.mesh.configure"), false);
});

test("identity and apply requests reuse the fixed helper protocol", async () => {
  const factory = (write) => () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    socket.end = () => { queueMicrotask(() => write(socket)); };
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
  const respond = (payload) => factory((socket) => { socket.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`)); socket.emit("end"); });
  const identity = { interfaceName: "wg0", publicKey: publicKey(), configuredRevision: 2 };
  const parsed = await requestMeshIdentity("/run/mesh.sock", respond({ ok: true, operation: "identity", data: identity }));
  assert.deepEqual(parsed, identity);
  assert.equal(await readMeshIdentity(`${process.cwd()}/tests/agent/missing-mesh-helper.sock`), null);
  const helper = await requestMeshApply(configured(2), undefined, "/run/mesh.sock", respond({ ok: true, operation: "configure", data: applied() }));
  assert.equal(helper.appliedRevision, 1);
  await assert.rejects(() => requestMeshApply(configured(2), undefined, "/run/mesh.sock", respond({ ok: true, operation: "configure", data: { appliedRevision: 2 } })), (error) => error.code === "MESH_HELPER_INVALID_RESPONSE");
});

const meshPeer = (latestHandshakeAt) => ({
  publicKey: publicKey(), overlayAddress: "100.64.0.2", endpoint: "203.0.113.7:51820",
  latestHandshakeAt, handshakeAgeSeconds: latestHandshakeAt === null ? null : 0, receivedBytes: 0, sentBytes: 0,
});

const meshStatus = (peers, collectedAt) => ({ collectedAt, collectionStatus: "complete", warnings: [], interface: { name: "wg0", present: true, up: true, listenPort: 51820, mtu: 1420, publicKey: publicKey(), peerCount: peers.length }, peers, firewall: { enforced: true, dataPlanePort: 18_080 } });

test("the link summary keeps only fresher-than-timeout peers as active", () => {
  const now = new Date("2026-11-13T08:00:00.000Z");
  const collectedAt = "2026-11-13T07:59:58.000Z";
  const summary = summarizeMeshLink(meshStatus([
    meshPeer("2026-11-13T07:59:30.000Z"),
    meshPeer("2026-11-13T07:52:00.000Z"),
    meshPeer(null),
  ], collectedAt), now);
  assert.deepEqual(summary, { collectedAt, peerCount: 3, activePeerCount: 1, latestHandshakeAt: "2026-11-13T07:59:30.000Z", firewallEnforced: true, dataPlanePort: 18_080, interfaceUp: true });
  assert.deepEqual(summarizeMeshLink(meshStatus([], collectedAt), now), { collectedAt, peerCount: 0, activePeerCount: 0, latestHandshakeAt: null, firewallEnforced: true, dataPlanePort: 18_080, interfaceUp: true });
  assert.equal(summarizeMeshLink(meshStatus([meshPeer("2026-11-13T07:57:00.000Z")], collectedAt), now).activePeerCount, 1);
  assert.equal(summarizeMeshLink(meshStatus([meshPeer("2026-11-13T07:56:59.000Z")], collectedAt), now).activePeerCount, 0);
  assert.equal(summarizeMeshLink(meshStatus([meshPeer("2026-11-13T08:00:30.000Z")], collectedAt), now).activePeerCount, 1);
});

test("the link summary carries the whitelist verdict so the panel never assumes it", () => {
  const collectedAt = "2026-11-13T07:59:58.000Z";
  const unenforced = { ...meshStatus([meshPeer(collectedAt)], collectedAt), firewall: { enforced: false, dataPlanePort: 18_080 } };
  const summary = summarizeMeshLink(unenforced, new Date("2026-11-13T08:00:00.000Z"));
  assert.equal(summary.firewallEnforced, false);
  assert.equal(summary.dataPlanePort, 18_080);
  assert.equal(NetworkMeshStatusDataSchema.safeParse(unenforced).success, true);
});

test("a helper that predates the whitelist reports unknown instead of enforced", () => {
  const collectedAt = "2026-11-13T07:59:58.000Z";
  const legacy = { ...meshStatus([meshPeer(collectedAt)], collectedAt), firewall: undefined };
  const summary = summarizeMeshLink(legacy, new Date("2026-11-13T08:00:00.000Z"));
  assert.equal(summary.firewallEnforced, null);
  assert.equal(summary.dataPlanePort, null);
  assert.equal(NetworkMeshStatusDataSchema.safeParse(legacy).success, true);
});

test("a link taken down by the helper is reported as down, not as applied", () => {
  const collectedAt = "2026-11-13T07:59:58.000Z";
  const down = { ...meshStatus([meshPeer(collectedAt)], collectedAt), interface: { ...meshStatus([], collectedAt).interface, up: false } };
  assert.equal(summarizeMeshLink(down, new Date("2026-11-13T08:00:00.000Z")).interfaceUp, false);
  assert.equal(NetworkMeshStatusDataSchema.safeParse(down).success, true);
  const unknown = { ...down, interface: { ...down.interface, up: null } };
  assert.equal(summarizeMeshLink(unknown, new Date("2026-11-13T08:00:00.000Z")).interfaceUp, null);
});

test("a silent helper never blocks the heartbeat with a link error", async () => {
  assert.equal(await readMeshLink(`${process.cwd()}/tests/agent/missing-mesh-helper.sock`), null);
});
