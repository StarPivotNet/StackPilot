# SSH access implementation status

The Controller foundation is implemented. End-to-end SSH takeover is **not yet available**. The production UI continues to show the disabled SSH capability; no host has been taken over by this change.

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
| `POST /api/ssh/takeover-plans` | Returns `503 NOT_READY` until the real host executor and verifier are implemented |

Policy input: `nodeId`, `userId`, `profile`, `enabled`, optional `services` and `sessionSeconds` (60–28800, default 28800). The `service-operator` profile requires a nonempty list of service unit identifiers; other profiles require an empty service list. This stores desired policy only and does not change a server. All policy changes clear the applied revision and invalidate earlier credentials.

Credential request: `nodeId`, `purpose` and optional `sessionSeconds`. Requests cannot override the Linux account, user or profile. The effective duration cannot exceed the policy maximum. Successful response: `credential`, `password`, `address`, `port`, `fingerprints`. The password is returned once and never stored in clear text. Lost responses require a new request. At most five credentials may be issued per user per minute.

Credential metadata records `consumedAt` and `revokedAt`. Session metadata distinguishes `terminationRequestedAt` from `terminatedAt`; the Controller never infers a host acknowledgement from a submitted request or elapsed time. GET does not mutate stored state. Ordinary readers see their own records within their node scope; SSH managers see records across their authorized nodes.

## Required before enabling the capability

1. Controller enrollment and the root-side signed HTTPS client are implemented. Complete the installer; keys and registration files remain root-only and separate from Agent credentials.
2. The native PAM authentication/account/session hooks and root-only local protocol are implemented. Validate actual sshd process binding across privilege separation/forks in full SSH VM integration before enabling takeover.
3. Per-connection scopes, local boot-clock deadlines, whole-group termination, durable restart reconciliation and 10-second authorization checks are implemented with isolated runtime tests. Real systemd/SSH integration and both distribution acceptance gates remain required. Offline sessions retain their original deadline; new authentication fails closed.
4. System-account ownership checks, the native service-operation wrapper, effective sudo inspection and acknowledged policy revisions/UIDs are implemented. Restricted services require explicit non-root isolation and no activation/lifecycle dependencies beyond `system.slice`; unsupported services fail application. Full root users are trusted and can bypass local controls.
5. Read-only preflight, all-listener discovery, effective configuration inspection, flat managed configuration, durable backups, local configuration transactions, an independent five-minute rollback timer and boot recovery are implemented. Actual switch/timeout/boot recovery has been exercised in both supported systemd VMs. Controller orchestration remains pending; unsupported or unrecognized SSH entrances block takeover.
6. Implement the Controller's independent SSH verifier with pinned host fingerprints, positive and negative authentication tests, explicit commit and old-connection cleanup. Host reports alone must never set `verification_id` or mark a host managed.
7. Integrate the existing SSH Web views with these actual services, replacing certificate drafts with OTP issuance and out-of-band recovery. Verify desktop/mobile rendering, access restrictions and a complete polling cycle.
8. Run Debian 12 and Ubuntu 24.04 systemd VM acceptance tests, including PAM, shell/SFTP/SCP, multiplexing, policy revocation, partitions, helper crashes, rollback and out-of-band recovery.

No public management endpoint writes host verification evidence or an applied revision. `SshService.authenticate` is reachable only through the signed HTTPS helper interface; browsers and Agent credentials cannot invoke it. It still refuses login unless an independently verified host and applied policy exist. Its direct unit tests use explicitly synthetic trusted-adapter fixtures; they are not evidence of Linux acceptance.

## Helper identity interface

`POST /api/ssh/helper-enrollments` accepts `{nodeId}` and requires a scoped `ssh:manage` permission, a user session, CSRF and one-use reauthentication. Its response includes a five-minute, single-use registration token, returned once. Creating a new enrollment cancels older unused enrollments on that node. `POST /api/ssh/helpers/:nodeId/revoke` uses the same authorization and revokes both active helper identity and unused enrollments.

The HTTPS machine listener accepts `POST /api/ssh-helper/enroll` with `{enrollmentToken,publicKey}`. Only Ed25519 public keys are allowed. Reenrollment revokes the previous key and clears SSH verification. The helper must store its private key locally with root-only access; the Controller stores its public key only.

All subsequent requests require `X-StackPilot-Ssh-Protocol: 1`, `X-StackPilot-Ssh-Node`, `X-StackPilot-Ssh-Credential`, `X-StackPilot-Ssh-Time`, `X-StackPilot-Ssh-Nonce`, and `X-StackPilot-Ssh-Signature`. Sign the shared contract's `sshHelperSignaturePayload` with Ed25519 and encode the signature as unpadded base64url. The five-minute timestamp window and persisted nonce ledger prevent replay; method, full path including query and SHA-256 of exact request bytes are covered. Agent signatures have a different purpose and cannot authenticate a helper.

`POST /api/ssh-helper/report` accepts bounded collection metadata (`collectedAt`, `supported`, `reason`, `platform`, `version`). These observations cannot mark a host managed or refresh independent verification. `POST /api/ssh-helper/authenticate` accepts `{account,password,connectionId}` and binds the target node to the authenticated helper identity. Plain HTTP, browser sessions and personal API tokens cannot access either machine endpoint.

`GET /api/ssh-helper/state` derives current authorization and termination requirements without mutating stored session state. `POST /api/ssh-helper/sessions/ack` accepts `{sessionId,connectionId}` only for the authenticated node, records backend receipt time after a helper-confirmed close, and is idempotent. The helper retains pending receipts if delivery fails; requests and actual closure remain distinct. See the [root helper workspace](../apps/ssh-helper/README.md) for its native build and validation limits.
