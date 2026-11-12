import assert from "node:assert/strict";
import test from "node:test";
import { parseListeners, effectiveConfiguration } from "../../apps/ssh-helper/dist/preflight.js";

test("preflight retains every native listener address and process owner", () => {
  assert.deepEqual(parseListeners('LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=498,fd=3))\nLISTEN 0 128 [::]:2222 [::]:* users:(("sshd",pid=498,fd=4),("systemd",pid=1,fd=5))'), [{ address: "0.0.0.0", port: 22, pids: [498] }, { address: "::", port: 2222, pids: [498, 1] }]);
  for (const line of ['LISTEN 0 128 attacker.test:22 0.0.0.0:*', 'LISTEN 0 128 127.0.0.1:0 0.0.0.0:*', 'garbage']) assert.throws(() => parseListeners(line));
  assert.equal(parseListeners('LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*')[0].address, '127.0.0.53');
});
test("effective configuration preserves repeated host keys and refuses malformed output", () => {
  assert.deepEqual(effectiveConfiguration('hostkey /etc/ssh/key1\nhostkey /etc/ssh/key2\nusepam yes\n'), { hostkey: ['/etc/ssh/key1', '/etc/ssh/key2'], usepam: ['yes'] });
  assert.throws(() => effectiveConfiguration('invalid'));
  assert.deepEqual(effectiveConfiguration('subsystem sftp internal-sftp  \nusepam yes\n'), { subsystem: ['sftp internal-sftp'], usepam: ['yes'] });
});
