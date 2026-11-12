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

1. Implement root `ssh-helper` enrollment using an independent node key, verified HTTPS and replay-resistant authentication, separate from user and Agent credentials.
2. Implement the native PAM authentication and session hooks, securely binding a credential to an actual sshd connection across privilege separation and process forks.
3. Implement independent per-connection systemd scopes, local monotonic expiry, descendant-process termination, restart reconciliation and 10-second online authorization checks. Offline sessions retain their original deadline; new authentication fails closed.
4. Implement system-account ownership checks, root-owned service-operation wrappers, sudo policy validation and acknowledged policy revisions. Full root users are trusted and can bypass local controls.
5. Implement supported-host preflight, all-listener discovery, effective configuration inspection, durable backups and an independent five-minute systemd rollback timer. Unsupported or unrecognized SSH entrances block takeover.
6. Implement the Controller's independent SSH verifier with pinned host fingerprints, positive and negative authentication tests, explicit commit and old-connection cleanup. Host reports alone must never set `verification_id` or mark a host managed.
7. Integrate the existing SSH Web views with these actual services, replacing certificate drafts with OTP issuance and out-of-band recovery. Verify desktop/mobile rendering, access restrictions and a complete polling cycle.
8. Run Debian 12 and Ubuntu 24.04 systemd VM acceptance tests, including PAM, shell/SFTP/SCP, multiplexing, policy revocation, partitions, helper crashes, rollback and out-of-band recovery.

No public management endpoint currently writes host verification evidence or an applied revision. The internal `SshService.authenticate` entry point is reserved for a future authenticated host adapter and is not routed as a public API. Its direct unit tests use explicitly synthetic trusted-adapter fixtures; they are not evidence of Linux acceptance.
