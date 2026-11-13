import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import ssh2 from "ssh2";
import { connectSshProbe } from "../../apps/controller/dist/modules/ssh/sshProbeClient.js";

const { Server, utils } = ssh2;
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const publicKey = utils.parseKey(key).getPublicSSH();
const fingerprint = `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}`;
const secret = 'x'.repeat(43);
async function fixture(action, { echo = false, large = false } = {}) {
  const clients = new Set(), attempts = [];
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => undefined); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      attempts.push(context.method);
      if (context.method !== 'keyboard-interactive') { context.reject(['keyboard-interactive']); return; }
      context.prompt([{ prompt: 'Temporary password: ', echo }], answers => { if (answers[0] === secret) context.accept(); else context.reject(['keyboard-interactive']); });
    });
    client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptCommand, _reject, info) => {
      const channel = acceptCommand(); channel.on('error', () => undefined);
      if (info.command === '/usr/bin/id -u') { channel.write(large ? Buffer.alloc(70_000, 120) : '10000\n'); channel.exit(0); }
      else { channel.stderr.write('denied\n'); channel.exit(1); }
      channel.end();
    })));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = { address: '127.0.0.1', port: server.address().port, account: 'sp_probe', fingerprints: [fingerprint] };
  try { await action({ endpoint, attempts }); } finally { for (const client of clients) client.end(); server.close(); await once(server, 'close'); }
}
test('independent SSH client pins the real host key and uses only PAM keyboard authentication', async () => fixture(async ({ endpoint, attempts }) => {
  const connection = await connectSshProbe(endpoint, { method: 'keyboard-interactive', password: secret });
  assert.deepEqual(await connection.exec('identity'), { code: 0, stdout: '10000\n', stderr: '' });
  assert.equal((await connection.exec('sudoIdentity')).code, 1); assert.deepEqual(attempts, ['keyboard-interactive']);
  connection.close(); assert.equal(typeof await connection.closed, 'number');
}));
test('wrong host keys fail before credentials are presented; SSH errors never echo the secret', async () => fixture(async ({ endpoint, attempts }) => {
  await assert.rejects(connectSshProbe({ ...endpoint, fingerprints: [`SHA256:${'A'.repeat(43)}`] }, { method: 'keyboard-interactive', password: secret }), { code: 'SSH_HOST_KEY_MISMATCH' });
  assert.equal(attempts.length, 0);
  await assert.rejects(connectSshProbe(endpoint, { method: 'password', password: secret }), error => error.code === 'SSH_AUTH_REJECTED' && !error.message.includes(secret));
  assert.deepEqual(attempts, ['password']);
}));
test('interactive prompts cannot expose secrets through echoed or repeated challenges', async () => fixture(async ({ endpoint }) => {
  await assert.rejects(connectSshProbe(endpoint, { method: 'keyboard-interactive', password: secret }), { code: 'SSH_AUTH_REJECTED' });
}, { echo: true }));
test('diagnostic output is bounded and caller-selected commands are rejected', async () => fixture(async ({ endpoint }) => {
  const connection = await connectSshProbe(endpoint, { method: 'keyboard-interactive', password: secret });
  for (const command of ['arbitrary shell', 'constructor', '__proto__']) assert.throws(() => connection.exec(command), { code: 'SSH_COMMAND_FAILED' });
  await assert.rejects(connection.exec('identity'), { code: 'SSH_OUTPUT_TOO_LARGE' }); await connection.closed;
}, { large: true }));
