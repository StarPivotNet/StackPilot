# SSH access implementation status

The Controller, root helper and independent verifier are connected through real APIs. Basic end-to-end takeover and passive native installation have passed on disposable Debian 12 and Ubuntu 24.04 systemd VMs. Web integration, drift repair and the full fault/profile acceptance matrix are **not yet complete**. No production host has been changed; software upgrades never take over hosts automatically.

## Available management API

All paths below use the existing authenticated management API. GET requires `ssh:read`; write operations require a browser/user session, CSRF protection, the corresponding SSH permission and a fresh single-use `X-Reauth-Proof` obtained from `POST /api/auth/reauthenticate`. Normal account login remains `POST /api/auth/login`. Personal API tokens cannot substitute for reauthentication.

| Method and path | Behavior |
| --- | --- |
| `GET /api/ssh/workspace` | Scope-filtered hosts, policies, credential metadata and sessions, plus backend `collectedAt` |
| `GET /api/ssh/{hosts,policies,credentials,sessions}` | The corresponding collection with backend `collectedAt` |
| `POST /api/ssh/policies` | Create or replace a user's policy for one node; requires `ssh:manage` on that node |
| `POST /api/ssh/credentials` | Request the current user's credential; requires `ssh:connect`, explicit applied policy and a verified, fresh host adapter |
| `POST /api/ssh/credentials/:id/revoke` | Revoke own credentials, or another user's with `ssh:manage`; node scope always applies |
| `POST /api/ssh/sessions/:id/terminate` | Request termination with `ssh:sessions:terminate`; ownership or management permission and node scope apply |
| `GET /api/ssh/takeover-plans` | Scope-filtered durable plans and backend `collectedAt`; detail is available at `/:id` |
| `POST /api/ssh/takeover-plans` | Create an idempotent, node-locked preflight plan; requires `ssh:manage`, an enrolled helper and an explicit operator policy |
| `POST /api/ssh/takeover-plans/:id/apply` | Prepare a temporary probe key, verify the legacy path, switch authentication under a local rollback deadline and run independent verification before commit |
| `POST /api/ssh/takeover-plans/:id/rollback` | Request host-confirmed restoration of an uncommitted trial; committed hosts never reopen old authentication |

Policy input: `nodeId`, `userId`, `profile`, `enabled`, optional `services` and `sessionSeconds` (60–28800, default 28800). The `service-operator` profile requires a nonempty list of service unit identifiers; other profiles require an empty service list. This stores desired policy only and does not change a server. All policy changes clear the applied revision and invalidate earlier credentials.

Credential request: `nodeId`, `purpose` and optional `sessionSeconds`. Requests cannot override the Linux account, user or profile. The effective duration cannot exceed the policy maximum. Successful response: `credential`, `password`, `address`, `port`, `fingerprints`. The password is returned once and never stored in clear text. Lost responses require a new request. At most five credentials may be issued per user per minute.

Credential metadata records `consumedAt` and `revokedAt`. Session metadata distinguishes `terminationRequestedAt` from `terminatedAt`; the Controller never infers a host acknowledgement from a submitted request or elapsed time. GET does not mutate stored state. Ordinary readers see their own records within their node scope; SSH managers see records across their authorized nodes.

## Required before enabling the capability

1. Controller enrollment, the root-side signed HTTPS client and passive native installer are implemented. Keys and registration files remain root-only and separate from Agent credentials. Explicit reenrollment generates a fresh key; normal installation preserves identity.
2. The native PAM authentication/account/session hooks and root-only local protocol are implemented. Actual sshd privilege-separated process binding, UID and SFTP access passed on both supported VMs; normal-client multiplexing/SCP and the complete profile matrix remain required.
3. Per-connection scopes, local boot-clock deadlines, whole-group termination, durable restart reconciliation and 10-second authorization checks are implemented. Real local transport expiry and online credential revocation passed on both VMs. The full partition/crash/restart acceptance matrix remains required. Offline sessions retain their original deadline; new authentication fails closed.
4. System-account ownership checks, the native service-operation wrapper, effective sudo inspection and acknowledged policy revisions/UIDs are implemented. Restricted services require explicit non-root isolation and no activation/lifecycle dependencies beyond `system.slice`; unsupported services fail application. Full root users are trusted and can bypass local controls.
5. Read-only preflight, all-listener discovery, effective configuration inspection, flat managed configuration, durable backups, local configuration transactions, an independent five-minute rollback timer and boot recovery are implemented. Actual switch/timeout/boot recovery and Controller-orchestrated commit have been exercised in both supported systemd VMs. Unsupported or unrecognized SSH entrances block takeover.
6. The independent verifier pins host fingerprints and checks PAM, actual UID/sudo, SFTP, disabled forwarding, negative authentication and a real local connection deadline before explicit commit and old-connection cleanup. Host reports alone cannot establish `verification_id`. Subsequent matching inventories refresh collection time; drift clears verification and pauses issuance. A repair/reverification workflow remains pending.
7. Integrate the existing SSH Web views with these actual services, replacing certificate drafts with OTP issuance and out-of-band recovery. Verify desktop/mobile rendering, access restrictions and a complete polling cycle.
8. Run Debian 12 and Ubuntu 24.04 systemd VM acceptance tests, including PAM, shell/SFTP/SCP, multiplexing, policy revocation, partitions, helper crashes, rollback and out-of-band recovery.

No public management endpoint writes host verification evidence or an applied revision. `SshService.authenticate` is reachable only through the signed HTTPS helper interface; browsers and Agent credentials cannot invoke it. It still refuses login unless an independently verified host and applied policy exist. Its direct unit tests use explicitly synthetic trusted-adapter fixtures; they are not evidence of Linux acceptance.

## Helper identity interface

`POST /api/ssh/helper-enrollments` accepts `{nodeId}` and requires a scoped `ssh:manage` permission, a user session, CSRF and one-use reauthentication. Its response includes a five-minute, single-use registration token, returned once. Creating a new enrollment cancels older unused enrollments on that node. `POST /api/ssh/helpers/:nodeId/revoke` uses the same authorization and revokes both active helper identity and unused enrollments.

The HTTPS machine listener accepts `POST /api/ssh-helper/enroll` with `{enrollmentToken,publicKey}`. Only Ed25519 public keys are allowed. Reenrollment revokes the previous key and clears SSH verification. The helper must store its private key locally with root-only access; the Controller stores its public key only.

All subsequent requests require `X-StackPilot-Ssh-Protocol: 1`, `X-StackPilot-Ssh-Node`, `X-StackPilot-Ssh-Credential`, `X-StackPilot-Ssh-Time`, `X-StackPilot-Ssh-Nonce`, and `X-StackPilot-Ssh-Signature`. Sign the shared contract's `sshHelperSignaturePayload` with Ed25519 and encode the signature as unpadded base64url. The five-minute timestamp window and persisted nonce ledger prevent replay; method, full path including query and SHA-256 of exact request bytes are covered. Agent signatures have a different purpose and cannot authenticate a helper.

## Native helper installation

From a verified, root-owned release on a supported native host, install the prerequisites `build-essential`, `libpam0g-dev`, `sudo` and `openssh-server`, plus Node 22/npm. The installer uses `npm ci --ignore-scripts --omit=dev` for the helper workspace and compiles the native PAM module/wrapper on that host. It requires registry access. Root-owned release inputs must not have group/other write permissions.

```sh
# Existing helper installations must be stopped explicitly before upgrading.
systemctl stop stackpilot-ssh-helper.service
node deploy/scripts/install-ssh-helper.mjs install
```

For a first installation where the helper service is not installed yet, omit the stop command. An unresolved takeover blocks installation. Versioned code goes under `/opt/stackpilot-ssh-helper/releases`; retries verify the protected release receipt before reusing it. Files and the `current` symlink are installed atomically. The installer never starts/enables services, performs enrollment or changes SSH/PAM authentication configuration. A failed installation keeps new managed logins unavailable until an administrator completes installation and starts the helper; existing independent scopes retain their deadlines.

Create `/etc/stackpilot-ssh-helper/helper.env` as a root-owned mode-0600 file:

```ini
STACKPILOT_SSH_CONTROLLER_URL=https://controller.example.com:8788
STACKPILOT_SSH_CA_FILE=/etc/stackpilot-ssh-helper/ca.pem
STACKPILOT_SSH_NODE_ID=existing-agent-node-uuid
STACKPILOT_SSH_ENROLLMENT_FILE=/etc/stackpilot-ssh-helper/enrollment-token
```

Replace the example origin/node ID with the actual machine listener and existing node. Save its trusted CA to the indicated root-owned, non-writable file and the freshly issued one-use token to a root-owned mode-0600 file; keep the containing directory mode 0700. No secret belongs in a shell command, URL or service argument. Omit `STACKPILOT_SSH_CA_FILE` only when the listener chains to the operating system's trusted CAs.

```sh
systemctl enable stackpilot-ssh-boot-recovery.service
systemctl start stackpilot-ssh-enroll.service
systemctl enable --now stackpilot-ssh-helper.service
```

Enrollment is a separate oneshot service and conflicts with the running helper. A failed/lost response requires a new token. Starting the helper applies desired accounts/policies but still does not switch SSH authentication. Verify policy acknowledgement and a working out-of-band console before creating a takeover plan. Both persistent `ssh.service.requires` and `ssh.socket.requires` recovery dependencies are checked again before application.

For an ordinary software upgrade, preserve the protected config/state, run the passive installer after stopping the helper, and start the helper again; skip enrollment. Explicit reenrollment rotates the host key, invalidates independent verification and pauses issuance pending separate revalidation.

`POST /api/ssh-helper/report` accepts bounded collection metadata (`collectedAt`, `supported`, `reason`, `platform`, `version`, `inventory`, `takeover`). Reports cannot mark a host managed or establish independent verification. After independently verified commit, an identical configuration digest can refresh host freshness; mismatches pause issuance. `POST /api/ssh-helper/authenticate` accepts `{account,password,connectionId}` and binds the target node to the authenticated helper identity. Plain HTTP, browser sessions and personal API tokens cannot access either machine endpoint.

`GET /api/ssh-helper/state` also returns the next fixed takeover command. The root helper accepts only bounded actions and bindings, with no caller-supplied shell, executable path or raw sudoers content. `POST /api/ssh-helper/takeover-receipts` records the exact current command result idempotently. Independent verifier credentials are internal, one-use and limited to a live matching plan; public issuance cannot request this credential kind. Controller restart requests recovery of unfinished plans and retains verified committed state.

## Current VM acceptance evidence

The November 13 development run used two disposable QEMU VMs with native systemd/cgroup v2 and a separate serial recovery console. A private isolated Controller used actual HTTP login, CSRF and one-use reauthentication, HTTPS helper enrollment/signatures and fresh pinned SSH connections. Existing Agent node rows were fixture seeds; non-root Agent coexistence remains a separate acceptance item.

Both VMs completed preflight, probe-key authentication, application, all required independent checks, commit and probe cleanup. Normal credential API issuance then passed concurrent use (exactly one successful connection), actual UID 10000, SFTP, forwarding refusal and host-confirmed revocation. Observed revoke-to-confirm times were approximately 6.0 seconds on Debian and 8.5 seconds on Ubuntu. The 60-second verification session ended through its local systemd scope; this is not an eight-hour soak test. Cross-node binding was checked at the authenticated Controller boundary; a second-host negative SSH trial remains part of the broader matrix.

`GET /api/ssh-helper/state` derives current authorization and termination requirements without mutating stored session state. `POST /api/ssh-helper/sessions/ack` accepts `{sessionId,connectionId}` only for the authenticated node, records backend receipt time after a helper-confirmed close, and is idempotent. The helper retains pending receipts if delivery fails; requests and actual closure remain distinct. See the [root helper workspace](../apps/ssh-helper/README.md) for its native build and validation limits.
