import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createServer } from "node:https";
import { once } from "node:events";
import test from "node:test";
import selfsigned from "selfsigned";
import { sshHelperSignaturePayload } from "@stackpilot/contracts";
import { ControllerClient } from "../../apps/ssh-helper/dist/controllerClient.js";

test("helper client requires an HTTPS origin and fixed-purpose paths", async () => {
  for (const address of ["http://localhost", "https://user:password@localhost", "https://localhost/path", "https://localhost?query", "https://localhost#fragment"]) assert.throws(() => new ControllerClient(address));
  const client = new ControllerClient("https://localhost");
  for (const path of ["https://other.invalid/", "//other.invalid/", "/api/ssh-helper/../auth/login"]) await assert.rejects(client.call(path, "GET"));
});
test("actual TLS client validates certificates, signs exact bytes and validates returned session binding", async () => {
  const cert = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { days: 1, keySize: 2048, extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }] });
  const keys = generateKeyPairSync("ed25519"); const identity = { nodeId: randomUUID(), credentialId: randomUUID(), privateKey: keys.privateKey }; let changeNode = false; let requests = 0; const failures = [];
  const server = createServer({ cert: cert.cert, key: cert.private }, async (req, res) => {
    try {
      requests++; const chunks = []; for await (const chunk of req) chunks.push(chunk); const raw = Buffer.concat(chunks);
      const auth = { nodeId: req.headers["x-stackpilot-ssh-node"], credentialId: req.headers["x-stackpilot-ssh-credential"], timestamp: req.headers["x-stackpilot-ssh-time"], nonce: req.headers["x-stackpilot-ssh-nonce"] };
      assert.equal(req.headers["x-stackpilot-ssh-protocol"], "1"); assert.equal(auth.nodeId, identity.nodeId);
      assert(verify(null, Buffer.from(sshHelperSignaturePayload({ ...auth, method: req.method, path: req.url, bodySha256: createHash("sha256").update(raw).digest("hex") })), keys.publicKey, Buffer.from(req.headers["x-stackpilot-ssh-signature"], "base64url")));
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/ssh-helper/redirect") { res.writeHead(302, { Location: "/api/ssh-helper/state" }); res.end("{}"); return; }
      if (req.url === "/api/ssh-helper/state") { assert.equal(raw.length, 0); res.end(JSON.stringify({ controllerTime: new Date().toISOString(), sessions: [] })); return; }
      const body = JSON.parse(raw.toString()); const start = Date.now();
      res.end(JSON.stringify({ id: randomUUID(), credentialId: randomUUID(), nodeId: changeNode ? randomUUID() : identity.nodeId, userId: randomUUID(), account: body.account, connectionId: body.connectionId, startedAt: new Date(start).toISOString(), expiresAt: new Date(start + 60_000).toISOString(), terminationRequestedAt: null, terminatedAt: null }));
    } catch (error) { failures.push(error); res.writeHead(500); res.end("{}"); }
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `https://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(new ControllerClient(url).state(identity), /certificate|verify|issuer/i);
    const client = new ControllerClient(url, cert.cert); assert.equal((await client.state(identity)).sessions.length, 0);
    const before = requests; await assert.rejects(client.call("/api/ssh-helper/redirect", "POST", {}, identity)); assert.equal(requests, before + 1);
    assert.equal((await client.authenticate(identity, "sp_test", "x".repeat(43), "trusted-connection-instance")).nodeId, identity.nodeId);
    changeNode = true; await assert.rejects(client.authenticate(identity, "sp_test", "x".repeat(43), "trusted-connection-instance"), /binding/);
    assert.deepEqual(failures, []);
  } finally { server.close(); await once(server, "close"); }
});
