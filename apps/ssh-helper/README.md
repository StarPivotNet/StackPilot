# StackPilot SSH helper

Independent root boundary for managed SSH, using a fixed PAM Unix socket and node-bound signed HTTPS requests. The Agent remains non-root. The workspace contains enrollment, TLS, native PAM hooks, local lifetime supervision and account/sudo policy application; complete takeover and its installer are still pending. Installing files does not change authentication.

Supported execution target: native Debian 12 or Ubuntu 24.04, x86_64, systemd, unified cgroup v2. The entry point rejects containers, non-root users and unsupported platforms. Do not start a second instance from inside an SSH connection it is supervising.

## Build and test

From the repository root:

```sh
npm run build --workspace @stackpilot/contracts
npm run build --workspace @stackpilot/ssh-helper
npm run test --workspace @stackpilot/ssh-helper
# Linux build dependencies: build-essential libpam0g-dev
npm run build:pam --workspace @stackpilot/ssh-helper
```

Windows can run TypeScript, TLS and isolated state-machine tests. Permission/symlink tests require Linux. The native tests must run as root in an explicitly disposable native systemd environment with `STACKPILOT_DISPOSABLE_SYSTEMD_TEST=1`. They create and remove a unique Linux account, sudo grants and a temporary service, and refuse to overwrite an installed service wrapper. The PAM ABI harness uses an isolated PAM configuration and a test-only root Unix server. These checks do not change `/etc/pam.d/sshd` or prove complete SSH authentication.

## Configuration

Root service configuration lives in `/etc/stackpilot-ssh-helper/helper.env`. Set `STACKPILOT_SSH_CONTROLLER_URL` to an HTTPS origin on the Controller's machine listener and optionally `STACKPILOT_SSH_CA_FILE` to a trusted CA file. Certificate and hostname verification are always enabled. Credentials, errors and logs never include the private key or submitted login password.

For explicit enrollment, set `STACKPILOT_SSH_NODE_ID` to the intended existing Agent node and `STACKPILOT_SSH_ENROLLMENT_FILE` to a regular root-owned mode-0600 registration file. Run the compiled entry point with `enroll`. A response lost after registration requires a new administrator-issued token; do not retry a consumed token or manufacture an identity file. Enrollment leaves SSH configuration unchanged.

State defaults to `/var/lib/stackpilot-ssh-helper` (`STACKPILOT_SSH_STATE_DIR`), with a fixed PAM socket at `/run/stackpilot-ssh-helper/pam.sock`. PAM does not accept a caller-supplied socket path or command. The native module accepts only platform-managed `sp_` accounts. Its authentication hook supplies the PAM fork and monitor PIDs directly; the helper independently checks the live privileged sshd ancestry and attaches the connection to its scope before returning success.

The `run` entry point restores the root-owned session journal and reconciles every 10 seconds after the previous cycle settles. Online authorization is read through signed `GET /api/ssh-helper/state`; actual completion receipts are separate signed POSTs. Local scopes enforce the original lease even if the helper or Controller fails. Accepted sessions are never automatically renewed or recreated. Unacknowledged termination receipts survive restart. At most 1024 active/pending local records and 16 concurrent PAM socket requests are admitted; excess requests fail closed.

The signed policy loop applies separate accounts and verifies real UID, private group, protected sudo files and effective grants before acknowledging a revision. Unchanged policies do not terminate sessions. Restricted operations require root-owned binaries/units, an isolated non-root service user, no capabilities, `NoNewPrivileges=yes`, `DefaultDependencies=no` and no lifecycle propagation or additional dependencies beyond `system.slice`. Control services are denied. The non-setuid wrapper accepts only exact start/stop/restart calls for root-owned allowlisted units.

Full root users are trusted and can disable local controls. Killing a scope does not roll back already-completed operations or tasks explicitly handed to other system services. Host takeover must not enable `pam_systemd` or another hook that moves accepted SSH session processes outside the supervised scope. Effective configuration inspection, rollback and independent fresh-connection verification are required before enabling this module in sshd.
