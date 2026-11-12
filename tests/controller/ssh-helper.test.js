import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { request } from "node:https";
import test from "node:test";
import selfsigned from "selfsigned";
import { agentSignaturePayload, sshHelperSignaturePayload } from "@stackpilot/contracts";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { IdentityService } from "../../apps/controller/dist/identity/identityService.js";
import { SshHelperService } from "../../apps/controller/dist/modules/ssh/sshHelperService.js";
import { createStackPilotAgentServer, createStackPilotServer } from "../../apps/controller/dist/server.js";
import { FakePlatformAdapter } from "./support/fakePlatform.js";

const password = "correct horse battery staple";
function pair() {
  const keys = generateKeyPairSync("ed25519");
  return { privateKey: keys.privateKey, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
}
async function fixture(action) {
  const db = openDatabase(":memory:"); const identity = new IdentityService(db, Buffer.alloc(32, 8));
  await identity.createInitialAdministrator("admin", "Administrator", password);
  const principal = (await identity.login("admin", password, "test", "test")).principal;
  const nodeId = randomUUID(); db.prepare("INSERT INTO agent_nodes(node_id,payload,updated_at) VALUES(?,?,?)").run(nodeId, "{}", new Date().toISOString());
  let time = Date.now(); const service = new SshHelperService(db, identity.audit, () => time);
  try { await action({ db, identity, principal, nodeId, service, now: () => time, advance: ms => { time += ms; } }); } finally { db.close(); }
}
function signed(identity, keys, now, request, overrides = {}) {
  const auth = { ...identity, timestamp: new Date(now).toISOString(), nonce: randomBytes(18).toString("base64url"), ...overrides };
  return { ...auth, signature: sign(null, Buffer.from(sshHelperSignaturePayload({ ...auth, ...request })), keys.privateKey).toString("base64url") };
}
const empty = { method: "GET", path: "/api/ssh-helper/test", bodySha256: createHash("sha256").update("").digest("hex") };

test("helper enrollment is independently scoped, digest-only, expiring and single use", async () => fixture(({ db, service, nodeId, now, advance }) => {
  const keys = pair(); const enrollment = service.createEnrollment(nodeId, "admin");
  assert.equal(db.prepare("SELECT actor_type FROM audit_events WHERE action='ssh.helper.enrollment.created'").get().actor_type, "user");
  assert.equal(Date.parse(enrollment.expiresAt) - now(), 300_000);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM ssh_helper_enrollments").all()), new RegExp(enrollment.token));
  assert.throws(() => service.enroll(randomBytes(32).toString("base64url"), keys.publicKey));
  const enrolled = service.enroll(enrollment.token, keys.publicKey); assert.equal(enrolled.nodeId, nodeId);
  assert.throws(() => service.enroll(enrollment.token, keys.publicKey));
  const expired = service.createEnrollment(nodeId, "admin"); advance(300_000);
  assert.throws(() => service.enroll(expired.token, keys.publicKey));
}));
test("replacement enrollment revokes unused enrollments, RSA keys and revoked nodes are rejected", async () => fixture(({ db, service, nodeId }) => {
  const keys = pair(); const first = service.createEnrollment(nodeId, "admin"); const second = service.createEnrollment(nodeId, "admin");
  assert.throws(() => service.enroll(first.token, keys.publicKey));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => service.enroll(second.token, rsa));
  db.prepare("UPDATE agent_nodes SET revoked_at=? WHERE node_id=?").run(new Date().toISOString(), nodeId);
  assert.throws(() => service.enroll(second.token, keys.publicKey));
  assert.throws(() => service.createEnrollment(nodeId, "admin"));
}));
test("helper signatures bind purpose, node, credential, method, query and exact body bytes", async () => fixture(({ service, nodeId, now }) => {
  const keys = pair(); const enrolled = service.enroll(service.createEnrollment(nodeId, "admin").token, keys.publicKey);
  const auth = signed(enrolled, keys, now(), empty);
  const wrongPurpose = sign(null, Buffer.from(agentSignaturePayload({ ...auth, ...empty, protocolVersion: "1.1" })), keys.privateKey).toString("base64url");
  assert.throws(() => service.authenticate({ ...auth, signature: wrongPurpose }, empty));
  for (const request of [{ ...empty, method: "POST" }, { ...empty, path: `${empty.path}?other=1` }, { ...empty, bodySha256: "0".repeat(64) }]) assert.throws(() => service.authenticate(auth, request));
  assert.throws(() => service.authenticate({ ...auth, nodeId: randomUUID() }, empty));
  assert.throws(() => service.authenticate({ ...auth, credentialId: randomUUID() }, empty));
  assert.deepEqual(service.authenticate(auth, empty), { nodeId, credentialId: enrolled.credentialId });
  assert.throws(() => service.authenticate(auth, empty), error => error.status === 409);
}));
test("invalid and stale signatures do not reserve nonces; future request replay stays blocked", async () => fixture(({ service, nodeId, now, advance }) => {
  const keys = pair(); const enrolled = service.enroll(service.createEnrollment(nodeId, "admin").token, keys.publicKey);
  const auth = signed(enrolled, keys, now(), empty);
  assert.throws(() => service.authenticate({ ...auth, signature: randomBytes(64).toString("base64url") }, empty));
  service.authenticate(auth, empty);
  assert.throws(() => service.authenticate(signed(enrolled, keys, now() - 300_001, empty), empty));
  const future = signed(enrolled, keys, now() + 300_000, empty); service.authenticate(future, empty);
  advance(300_000); assert.throws(() => service.authenticate(future, empty), error => error.status === 409);
}));
test("credential replacement and revocation invalidate the old helper identity and host verification", async () => fixture(({ db, service, nodeId, now }) => {
  const first = pair(); const identity = service.enroll(service.createEnrollment(nodeId, "admin").token, first.publicKey);
  const host = { nodeId, state: "managed", available: true, reason: "", address: "192.0.2.1", port: 22, fingerprints: ["SHA256:test"], collectedAt: new Date(now()).toISOString() };
  db.prepare("INSERT INTO ssh_hosts(node_id,payload,verification_id) VALUES(?,?,?)").run(nodeId, JSON.stringify(host), randomUUID());
  const second = pair(); const replacement = service.enroll(service.createEnrollment(nodeId, "admin").token, second.publicKey);
  assert.throws(() => service.authenticate(signed(identity, first, now(), empty), empty));
  assert.equal(db.prepare("SELECT verification_id FROM ssh_hosts WHERE node_id=?").get(nodeId).verification_id, null);
  service.authenticate(signed(replacement, second, now(), empty), empty);
  service.revoke(nodeId, "admin"); assert.throws(() => service.authenticate(signed(replacement, second, now(), empty), empty));
}));
test("signed readiness reports never establish SSH takeover verification", async () => fixture(({ db, service, nodeId, now }) => {
  const keys = pair(); const identity = service.enroll(service.createEnrollment(nodeId, "admin").token, keys.publicKey);
  service.report(identity, { supported: true, collectedAt: new Date(now()).toISOString(), reason: "", platform: "ubuntu-24.04", version: "test" });
  assert.equal(db.prepare("SELECT * FROM ssh_hosts WHERE node_id=?").get(nodeId), undefined);
  assert.throws(() => service.report(identity, { supported: true, collectedAt: new Date(now() + 300_001).toISOString(), reason: "", platform: "ubuntu-24.04", version: "test" }));
}));

function httpsJson(base, path, raw, ca, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = request(new URL(path, base), { method: "POST", ca, signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json", "Content-Length": raw.length, ...headers } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    }); call.on("error", reject); call.end(raw);
  });
}
test("actual TLS listener separates helper, browser and Agent identities and rejects plaintext", async () => fixture(async ({ db, identity, service, nodeId }) => {
  const cert = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048, extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const wrong = await selfsigned.generate([{ name: "commonName", value: "wrong" }], { days: 1, keySize: 2048 });
  const options = { database: db, identity, platform: new FakePlatformAdapter(), env: { STACKPILOT_COOKIE_SECURE: "0" } };
  const tls = createStackPilotAgentServer({ cert: cert.cert, key: cert.private }, options); const http = createStackPilotServer(options);
  tls.listen(0, "127.0.0.1"); http.listen(0, "127.0.0.1"); await Promise.all([once(tls, "listening"), once(http, "listening")]);
  const base = `https://127.0.0.1:${tls.address().port}`;
  try {
    const keys = pair(); const enrollment = service.createEnrollment(nodeId, "admin");
    const raw = Buffer.from(JSON.stringify({ enrollmentToken: enrollment.token, publicKey: keys.publicKey }));
    await assert.rejects(httpsJson(base, "/api/ssh-helper/enroll", raw, wrong.cert), /certificate|verify|issuer/i);
    assert.equal((await fetch(`http://127.0.0.1:${http.address().port}/api/ssh-helper/enroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw })).status, 426);
    const enrolled = await httpsJson(base, "/api/ssh-helper/enroll", raw, cert.cert); assert.equal(enrolled.status, 201);
    const path = "/api/ssh-helper/report";
    const report = Buffer.from(JSON.stringify({ supported: false, platform: "unsupported", reason: "native executor pending", collectedAt: new Date().toISOString(), version: "test" }));
    assert.equal((await httpsJson(base, path, report, cert.cert, { Cookie: "stackpilot_session=not-a-helper" })).status, 401);
    assert.equal((await httpsJson(base, path, report, cert.cert, { "X-StackPilot-Protocol": "1.1", "X-StackPilot-Node-Id": nodeId })).status, 401);
    const auth = signed(enrolled.body, keys, Date.now(), { method: "POST", path, bodySha256: createHash("sha256").update(report).digest("hex") });
    const headers = { "X-StackPilot-Ssh-Protocol": "1", "X-StackPilot-Ssh-Node": nodeId, "X-StackPilot-Ssh-Credential": auth.credentialId, "X-StackPilot-Ssh-Time": auth.timestamp, "X-StackPilot-Ssh-Nonce": auth.nonce, "X-StackPilot-Ssh-Signature": auth.signature };
    assert.equal((await httpsJson(base, path, report, cert.cert, headers)).status, 200);
    assert.equal((await httpsJson(base, path, report, cert.cert, headers)).status, 409);
    assert.equal((await httpsJson(base, "/api/ssh/workspace", Buffer.from("{}"), cert.cert)).status, 404);
  } finally { tls.close(); http.close(); await Promise.all([once(tls, "close"), once(http, "close")]); }
}));
