# Changelog

All notable changes follow Semantic Versioning. The project is currently prerelease software.

## 0.3.0-preview.57 - 2026-11-13

### Fixed

- Keep audit result counts visible with backend freshness, bound audit and ACL modal surfaces to the viewport, and give ACL role/permission panels the intended borderless hierarchy. Align site monitoring browser checks with the current visible module heading.

## 0.3.0-preview.56 - 2026-11-13

### Fixed

- Restore the overview's live-workbench accessibility landmark and align browser E2E heading assertions with the current CloudPulse module headings. No SSH authorization or storage behavior changes.

## 0.3.0-preview.55 - 2026-11-13

### Fixed

- Audit rejected SSH authentication attempts with node, account and connection metadata while never storing submitted passwords or inferring an identity from invalid credentials.

## 0.3.0-preview.54 - 2026-11-13

### Fixed

- Normalize shell-script execute bits in the CI checkout before deployment contract tests, matching the repository's executable-file contract on hosted runners.

## 0.3.0-preview.53 - 2026-11-13

### Fixed

- Update the deployment contract to assert the refreshed Nginx Alpine 3.24 slim digest used by the Web image, keeping image provenance checks aligned with the scanned runtime.

## 0.3.0-preview.52 - 2026-11-13

### Fixed

- Keep the audited Node build image on the repository's required `22.22.0-bookworm-slim` tag while retaining its refreshed immutable digest. Deployment contract tests now remain compatible with the security refresh.

## 0.3.0-preview.51 - 2026-11-13

### Fixed

- Refresh pinned Node, Distroless Node and Nginx Alpine base images to current immutable digests so container OS security updates are included in production image scans.
- Preserve high/critical dependency audit success while retaining the moderate development-tool findings for follow-up.

## 0.3.0-preview.50 - 2026-11-13

### Fixed

- Update compatible dependency resolutions and minimum Vite, Vitest, tar and concurrently versions to clear the dependency audit's high/critical findings. Keep the existing audit threshold; unresolved moderate development-tool findings remain visible.
- Pin the Web runtime to the official Nginx 1.30.6 Alpine 3.24 slim image digest instead of the vulnerable older Alpine runtime. Container scanning remains mandatory.
- Resolve the native entrypoint test relative to its own module so workspace-local npm tests exercise the installed symlink correctly. Normalize the hosted runner's existing sudo grant to strict permissions before native boundary tests; production validation is unchanged.

## 0.3.0-preview.49 - 2026-11-13

### Added

- Connect SSH host, password/session, policy, enrollment, takeover, recovery and audit pages to scoped real APIs with single-use reauthentication and backend freshness. Replace certificate drafts with one-time passwords and out-of-band recovery guidance.
- Add explicit independent reverification after exact committed configuration restoration, requiring fresh signed inventory and preserving the original root commit proof. Failures never reopen legacy authentication.
- Exercise desktop/mobile Chromium issuance through an actual SSH connection and UI revocation, scoped read-only permissions, silent polling, stable details and long names. Aggregate all disk volumes and expose delayed keyboard-accessible details.

### Fixed

- Derive Agent version from its package manifest, prepare native CI's stock OpenSSH service explicitly and allow bounded account-creation time on slower hosts.
- Keep SSH controls available when the optional resource directory fails, refresh viewer permissions with workspace data and distinguish unavailable entrance inspection from confirmed configuration changes.

## 0.3.0-preview.48 - 2026-11-13

### Added

- Add a passive native SSH helper installer with protected versioned releases, production-only dependencies, target-host PAM/wrapper compilation and atomic installed files. Installation does not start services or switch SSH authentication.
- Add a separate explicit enrollment unit and atomically bind every newly generated enrollment key to its returned host credential. Preserve compatibility with existing enrolled keys until explicit reenrollment.
- Require persistent boot recovery dependencies for both SSH service and socket activation before a takeover trial; test refusal when either dependency is missing.

### Fixed

- Reject writable enrollment/CA parent directories and unprotected CA files. Refuse installation while the helper is active or a takeover requires recovery.

## 0.3.0-preview.47 - 2026-11-13

### Added

- Connect scoped, reauthenticated takeover APIs to signed helper commands and durable node-locked plans, with independent fresh SSH connections and pinned host keys before commit.
- Verify PAM login, actual UID/sudo profile, SFTP, disabled forwarding, rejected invalid credentials and a real local transport deadline; require every check before marking a host managed.
- Add protected temporary probe public keys, retryable step receipts and configuration drift detection that pauses credential issuance.
- Complete basic end-to-end takeovers on disposable Debian 12 and Ubuntu 24.04 VMs, including single-use concurrent login and host-confirmed credential revocation. Installer, UI and the full fault/profile acceptance matrix remain pending.

### Fixed

- Preserve IPv6 wildcard listening entrances when ss renders them as '*'; retain the root helper's sudo inspection capability in the Ubuntu systemd sandbox.
- Recognize unprivileged sudo listing denial without weakening the helper's independent effective-grant checks; retain completed verification checks on failure.
- Upgrade Zod to 4.6.7 and use pinned ssh2 1.17.0 for independent verification.

## 0.3.0-preview.46 - 2026-11-13

### Added

- Persist SSH takeover backups, immutable deadlines, legacy connection identities and explicit application/commit/rollback states under a shared kernel operation lock.
- Add a standalone suspend-aware systemd rollback timer and boot recovery before SSH startup, with verified restoration and explicit manual recovery on failure.
- Exercise actual five-minute authentication-switch recovery and interrupted-boot recovery on disposable Debian 12/Ubuntu 24.04 VMs; keep management takeover disabled until independent Controller verification is connected.

### Fixed

- Run helper/recovery entrypoints correctly through the installed current symlink; preserve exact file permissions under strict service umasks and tolerate rebooted/collected rollback timers.

## 0.3.0-preview.45 - 2026-11-13

### Added

- Inventory native SSH listeners, stock systemd startup/socket activation, SSH/PAM includes, Match conditions, authentication sources and host fingerprints without switching authentication.
- Build and verify flat managed SSH/PAM configurations that preserve exact entrances and host keys while disabling inherited authentication, forwarding and session hooks outside the helper.
- Test real systemd scope expiry/non-delegation and reject additional native or unrecognized SSH entrances in disposable Debian 12/Ubuntu 24.04 VMs.

### Fixed

- Reject root-only helper state placed below an unsafe writable ancestor. Normalize distribution-specific whitespace in effective OpenSSH output.

## 0.3.0-preview.44 - 2026-11-13

### Added

- Provision independent UUID-bound Linux accounts with durable creation intents, root-owned state and explicit shell, service-operator and host-admin sudo profiles.
- Add a native fixed service wrapper, service privilege/lifecycle inspection and effective sudo checks that reject inherited privileges or configuration drift.
- Synchronize desired policies over signed helper requests and acknowledge actual application/UID separately from stored intent; revoke old access before privilege changes.
- Add real disposable Linux account, sudo and service-operation tests alongside the PAM ABI checks. Full SSH takeover remains disabled while configuration transactions and independent verification are pending.

## 0.3.0-preview.43 - 2026-11-13

### Added

- Add the independent root SSH helper workspace, protected key/session storage, signed TLS client and root-only PAM socket boundary.
- Add native PAM authentication/account/session hooks and independent systemd connection scopes with durable deadlines, outage behavior and confirmed termination receipts.
- Add root Ubuntu CI checks for native PAM ABI and protected storage; full SSH takeover and VM acceptance remain incomplete and disabled.

### Fixed

- Extend Controller backup support through schema 12 and bind Compose smoke images to the actual release version. Enforce LF for Linux runtime/build inputs.

## 0.3.0-preview.42 - 2026-11-13

### Added

- Add node-bound independent SSH helper enrollment, Ed25519 signed HTTPS requests, persistent anti-replay checks and explicit credential revocation in schema 12.
- Keep readiness observations separate from independent takeover evidence; replacing a helper invalidates old verification, credentials and active-access authorization.

### Fixed

- Restore optional dependency entries missing from the npm lockfile so Node 22/npm 10 CI can pass clean dependency installation. Synchronize workspace versions and current schema documentation.

## 0.3.0-preview.41 - 2026-11-13

### Added

- Add the managed SSH Controller foundation: explicit permissions, user/node policies, transactional single-use credentials and durable session termination requests.
- Invalidate SSH credentials and request termination when identity or policy access changes. Keep host execution acknowledgements distinct from requests.
- Add schema 11 and scope-filtered read-only SSH APIs. Synchronize workspace versions and schema backup/upgrade metadata.
- Keep takeover and production credential issuance unavailable until the native PAM module, authenticated host executor, independent verifier and Web integration are implemented and accepted. No server SSH configuration is changed.

## 0.3.0-preview.40 - 2026-11-13

### Fixed

- Redeliver dispatched Agent tasks with the same attempt after lost responses, enforce the four-slot execution limit, and serialize site operations.
- Retry persisted result delivery independently, retain newer terminal receipts when an older acknowledgement arrives, and accept delayed signed results within task ownership and clock constraints.
- Enforce dedicated site workflows and terminal permissions for generic user task creation; filter terminal history by authorized node, requester and terminal key before pagination.
- Scope Agent control reads by section, node and task; update changed SQLite rows without rewriting unrelated encrypted history and commit state changes with both audit records atomically.

### Changed

- Synchronize workspace, runtime and documentation versions to `0.3.0-preview.40`. Database schema 10 and Agent protocol compatibility are unchanged.

## 0.3.0-preview.39 - 2026-11-12

### Changed

- Implemented the CloudPulse desktop and mobile layouts across existing workbenches, including one shared sidebar, readable typography, responsive tables and complete entity detail surfaces.
- Preserved real API data, permissions, automatic collection, stable selected identities and keyboard focus while removing misleading local-only settings success states.
- Added a frontend-only SSH management workspace with real authorized host discovery and editable local drafts; unavailable takeover, signing, download, revocation and recovery operations remain disabled.

### Fixed

- Kept monitoring failures and unavailable measurements distinct from collected zero values, and aggregated disk usage by volume capacity.
- Prevented sidebar collapse, long hostnames and off-screen accessibility text from overflowing the application tracks.
- Handled interrupted native view-transition animations without hiding actual update errors or repeating route updates.

### Compatibility

- Controller/Web package versions remain synchronized. Database schema 10 and Controller-Agent protocol compatibility are unchanged.
- This commit does not enable an SSH backend, deploy services or publish release artifacts.

## 0.3.0-preview.38 - 2026-07-18

### Changed

- Standardized backend freshness notes across host, site, database, deployment, firewall, schedule, systemd, file, terminal, access and audit workbenches.
- Removed redundant page context blocks while preserving route identity, operational state and responsive layout behavior.
- Expanded unit and browser coverage for freshness semantics, route transitions and mobile operational flows.

## 0.3.0-preview.37 - 2026-07-16

### Fixed

- Restored the complete npm lock graph required by strict `npm ci`, including CycloneDX optional dependencies used by release generation.
- Added the missing versioned upgrade notes required by the signed release workflow and linked the current release documentation.

### Changed

- Preserved the ACL, proxy and security settings refinements introduced in `0.3.0-preview.36` under a release that passes the repository deployment gates.

## 0.3.0-preview.36 - 2026-07-16

### Changed

- Refined ACL role surfaces so built-in roles show only granted permissions while custom roles retain complete editable permission coverage.
- Rebuilt proxy and security settings into route-scoped CloudPulse workbenches with stable summaries, focused sections and responsive detail drawers.
- Improved form hint actions and expanded ACL, settings and browser-level responsive coverage.

## 0.3.0-preview.35 - 2026-07-16

### Fixed

- Kept the real audit detail drawer fully inside desktop and mobile dynamic viewports, including its bottom edge, while preserving body-level portal stacking and scrollable detail content.

## 0.3.0-preview.34 - 2026-07-16

### Added

- Connected the audit-export workbench to persistent Controller APIs for real CSV and JSON snapshots, 10-second list polling, stable details, reauthentication and authenticated streaming downloads.
- Added schema 10 audit-export metadata, fixed high-water audit snapshots, SHA-256 evidence, seven-day expiry and bounded storage under the Controller state directory.

### Fixed

- Generated, verified and downloaded large audit snapshots through asynchronous chunks and streams so Controller health, login and Agent heartbeat requests remain responsive.
- Allowed failed exports to retry immediately without being blocked by their own creation timestamp, and isolated periodic maintenance failures with structured retryable logging.

### Security

- Added the separate high-risk `audit:export` permission and required it together with `audit:read`, a full-node user session, CSRF and one-time reauthentication.
- Verified the append-only audit chain before export, retained parameter redaction, exported the complete hash payload, prevented spreadsheet formula injection, bounded active exports and rejected API-token or scoped-session access.

## 0.3.0-preview.33 - 2026-07-16

### Fixed

- Made firewall action receipts durable before and after UFW mutations so a host power loss cannot silently reopen the side-effect replay window.
- Added the exact xtables runtime lock to the firewall helper sandbox and tmpfiles setup so active UFW mutations remain functional under `ProtectSystem=strict`.
- Validated managed firewall rule IDs before consuming one-time reauthentication and expanded Controller mutation tests for delete, replay and scoped access.

### Security

- Kept UFW access limited to the dedicated Controller-only socket, fixed command grammar and explicit runtime lock files while preserving inactive-state and default-policy boundaries.

## 0.3.0-preview.32 - 2026-07-16

### Added

- Added strict server-side audit filters for result, actor, source, action prefix and search, plus stable sequence-cursor pagination and complete filtered JSON export.
- Added SQLite schema 9 with indexed audit node ownership, historical ownership backfill and query-plan coverage for node-scoped polling.

### Changed

- Extended the real global, failed, database and export audit views with backend pagination while preserving 10-second visibility-aware polling, selected details and loaded history.
- Updated database backup, restore, preflight, release provenance and upgrade-drill gates to accept and verify schema 9.

### Security

- Applied node scope and every audit filter before result limits, rejected unknown, duplicate or malformed query parameters, and retained append-only hash verification across ownership backfill.

## 0.3.0-preview.31 - 2026-07-16

### Fixed

- Merged the parallel firewall backends onto the stable `/api/firewall/rules` contract and retained real listening-port and deny-record reads without fixture fallbacks.
- Made managed-rule deletion validate once before its persistent operation receipt is created, then delete the captured marker-bearing UFW rule instead of re-reading a mutable numbered position.
- Preserved the browser's current rules after background failures, kept mutation payloads and idempotency keys stable for safe retries, and replaced the visible data immediately after successful writes.

### Security

- Required `firewall:read`, `firewall:operate`, Controller node scope, a user session, CSRF and one-time reauthentication for every rule mutation.
- Kept UFW outside the general privileged command allowlist, denied native-rule deletion, persisted unknown operation results to prevent side-effect replay, and limited the helper to a Controller-only Unix socket and fixed UFW arguments.
- Left UFW activation, deactivation and default-policy management outside StackPilot.

## 0.3.0-preview.30 - 2026-07-16

### Added

- Connected the firewall rule workbench to the host's real UFW state through authenticated Controller APIs and a dedicated root-only Unix socket helper.
- Added real backend freshness, visibility-aware 10-second polling and permission-aware rule creation and deletion while preserving the real listening-port and deny-record workbenches.

### Security

- Required Controller node scope, `firewall:operate`, CSRF, one-time reauthentication, stable idempotency keys and optimistic rule versions for every UFW mutation.
- Kept external UFW rules read-only, rechecked rule identity immediately before numbered deletion, and excluded UFW activation and default-policy changes from the API.

## 0.3.0-preview.29 - 2026-07-16

### Fixed

- Replaced the schedule calendar's placeholder next-run text with a Controller-calculated ISO `nextRunAt` while preserving real cron and manual execution records.
- Sorted calendar entries by their real next execution time and kept disabled or unresolvable jobs explicitly labeled at the end of the timeline.
- Marked the automatically polled schedule read endpoint as `no-store` and validated schedule responses at the browser API boundary.

### Changed

- Added `cron-parser` as the bounded schedule-expression engine and tightened schedule collection timestamps to ISO datetime values in the shared contract.
- Preserved the fixed runner, command-versioned execution history, permission, reauthentication, mutation serialization and idempotency boundaries from `0.3.0-preview.28`.

## 0.3.0-preview.28 - 2026-07-16

### Fixed

- Classified `journalctl --grep` exit code 1 with empty stdout and stderr as a successful query with no matching firewall deny events, instead of reporting the kernel journal as unavailable.
- Preserved unavailable status for permission failures and all other probe errors while keeping probe diagnostics bounded and internal to the Agent.

## 0.3.0-preview.27 - 2026-07-16

### Fixed

- Made the database provisioner fixture use a non-root synthetic database identity when release tests run as root, preserving the production rejection of privileged database service users while keeping Linux release gates deterministic.

## 0.3.0-preview.26 - 2026-07-16

### Fixed

- Isolated the database authorization HTTP test from host systemd database discovery so Linux release gates remain deterministic on production-like hosts without changing Controller-local database collection behavior.

## 0.3.0-preview.25 - 2026-07-16

### Added

- Added bounded Controller-side execution records for automatic cron and immediate schedule runs, including source, timestamps, command revision, exit code, duration, stdout and stderr.
- Connected the failed-schedule workbench and task detail drawer to backend-recorded executions instead of inferring failure from browser state.

### Fixed

- Bound execution records to the SHA-256 revision of the scheduled command so late results from deleted or edited jobs cannot be attributed to a new command.
- Killed the complete derived process group when a scheduled command times out, preventing timed-out shell children from continuing side effects in the background.
- Preserved concurrent schedule edits and deletes when immediate execution completes, rejected overlapping runs of the same task, and retained user-scoped replay idempotency.

### Security

- Managed crontab rows invoke only the fixed StackPilot runner with encoded bounded input; execution records use private atomic files with bounded retention and invalid runner parameters are rejected before command execution.

## 0.3.0-preview.24 - 2026-07-15

### Added

- Added a bounded Agent firewall-deny snapshot collected from fixed read-only Linux kernel journal queries, negotiated through the Controller feature header and persisted with the existing signed heartbeat state.
- Added the authenticated `GET /api/firewall/deny-records` endpoint with dedicated `firewall:read` RBAC and node-scope filtering.
- Connected the firewall deny workbench to the real Controller API with visibility-aware 10-second polling, backend freshness, stable details, explicit unavailable states and responsive long-value handling.

### Security

- Removed demo deny records and browser-only allow, promote and export actions that previously reported success without a backend effect.
- Kept firewall collection read-only, bounded and free of raw kernel log output; the browser receives normalized event fields only.

## 0.3.0-preview.23 - 2026-07-15

### Changed

- Unified global, failed, database and export audit views on the authenticated Controller repository, with backend collection timestamps, visibility-aware 10-second polling, stable details and confirmed CSV downloads of current real results.
- Preserved the `0.3.0-preview.22` schedule idempotency and native cron deployment hardening while removing simulated audit export tasks and fixture fallback paths.

### Security

- Enforced strict shared audit event and query contracts, rejected duplicate or unknown query parameters, applied failed-result and action-prefix filters before the SQLite limit, and kept `audit:read` protection on API, navigation and direct rendering.
- Preserved backend parameter redaction and represented non-terminal outcomes such as `queued` as recorded rather than successful.

## 0.3.0-preview.22 - 2026-07-15

### Fixed

- Made the native Controller installer verify the distribution `cron` package contract before synchronizing units, and reapplied Controller sysusers membership during same-version unit updates.
- Extended production preflight to reject enabled crontab writes when the executable, system group, or spool directory is unavailable, while keeping the optional capability non-blocking when disabled.
- Restored complete registry resolution and integrity metadata in the workspace lockfile so clean release installs remain reproducible after concurrent version merges.

### Security

- Added user-scoped idempotency keys to schedule creation and immediate execution so a retried confirmation cannot duplicate a managed job or execute its command twice after a lost response.
- Added bounded replay caching and payload-conflict rejection for completed schedule side effects while preserving session, CSRF, permission, and one-time reauthentication checks.

## 0.3.0-preview.21 - 2026-07-15

### Changed

- Connected the global and failed-audit views to the authenticated Controller audit repository, with backend collection timestamps, visibility-aware 10-second polling, stable event details and real CSV export.
- Removed the Web audit fixture fallback and centralized the audit response and bounded read-filter schemas in the shared contracts package.

### Security

- Preserved the explicitly global `audit:read` enforcement on the API, hid audit navigation and search actions from principals without that permission, and applied failed-result and action-prefix filters before the SQLite limit.

## 0.3.0-preview.20 - 2026-07-15

### Fixed

- Classified the complete IPv4 `127.0.0.0/8` loopback range, including interface-scoped systemd-resolved listeners, as local-only instead of a specific-address binding.

### Added

- Added strict shared audit event/query contracts, backend collection timestamps and bounded action-prefix filtering before result limiting.
- Added desktop and mobile real-backend E2E coverage for authenticated audit loading, silent 10-second polling, detail inspection and CSV download.

### Changed

- Replaced the global, failed-operation and database audit fixtures with the authenticated Controller audit API while preserving filters and stable detail state.
- Replaced simulated export history and browser-only task mutations with a confirmed CSV download of the current real query result.
- Hid audit navigation and direct page rendering unless the signed-in user holds `audit:read`.

### Security

- Audit responses remain protected by session/RBAC, disable caching, preserve server-side sensitive-parameter redaction and strictly reject invalid or repeated query parameters.
- Non-terminal outcomes such as `queued` are shown as recorded states instead of being misrepresented as successful operations.

## 0.3.0-preview.19 - 2026-07-15

### Added

- Added an authenticated Controller API that reports real TCP and UDP listening sockets with stable identifiers, bind scope and backend collection time.
- Connected the firewall open-port workbench to the real API with strict shared contracts, explicit permission handling and visibility-aware 10-second polling.

### Fixed

- Allowed the hardened native Controller service to read and write its own crontab by granting only the operating system `crontab` supplementary group while retaining `NoNewPrivileges` and an empty capability set.
- Restored reproducible clean installs by synchronizing the lockfile with the committed CycloneDX dependency graph.

### Changed

- Exposed the server-side crontab mutation capability in the schedule read model and rendered the real schedule inventory as read-only when the dangerous write switch is disabled.
- Applied `schedules:read` and `schedules:write` permissions to schedule navigation and mutation controls while preserving the backend authorization checks.
- Replaced the `#firewall-open` fixture rule view with actual Controller host listeners while keeping the separate rule-management and deny-record workbenches unchanged.

### Security

- Required a user session and one-time reauthentication proof for every crontab mutation or immediate command execution; API tokens remain read-only for schedules.
- Serialized schedule read-modify-write operations and switched task identifiers to UUIDs so concurrent mutations cannot overwrite or alias managed jobs.
- Open-port collection runs through a fixed `/usr/bin/ss -H -lntu` invocation without a shell, requires `firewall:read`, and exposes no process identity or arbitrary command input.
- The Web surface states that a listening socket does not prove upstream network reachability and does not offer unsafe UFW mutations on hosts where UFW is inactive.

## 0.3.0-preview.18 - 2026-07-15

### Fixed

- Granted the hardened Controller service the existing system `crontab` group and the narrow cron-spool write path required for the real managed schedule backend.
- Repaired the workspace lockfile so clean `npm ci` installations include every optional release-scanning dependency.

### Security

- Kept schedule writes behind the existing `STACKPILOT_ENABLE_CRONTAB_WRITE=1`, session, CSRF and `schedules:write` permission boundaries while limiting filesystem access to the Controller state and user-crontab spool.

### Changed

- Rebuilt access-control, audit and settings workbenches with stable shared page framing, semantic user and permission states, complete detail surfaces and responsive long-value handling.
- Added guarded user access updates, clearer system-backup permission states and a confirmed audit-export workflow based on current filters.
- Split access, ACL, audit and settings CloudPulse styling into dedicated modules and expanded page-level test coverage.

## 0.3.0-preview.17 - 2026-07-15

### Changed

- Merged the Controller-host systemd helper path with the Agent node snapshot path, preserving bounded local journal and allowlisted lifecycle operations alongside node-scoped read-only monitoring.
- Kept the real deployment, rollback and schedule workflows from `0.3.0-preview.16` while aligning shared contracts, permissions and Web behavior across both systemd data sources.

### Security

- Preserved node-scoped `systemd:read` access for Agent snapshots and retained CSRF, RBAC, reauthentication, allowlist and audit enforcement for Controller-host lifecycle operations.

## 0.3.0-preview.16 - 2026-07-15

### Changed

- Added visibility-aware 10-second refresh, backend freshness display and explicit retry handling to the schedule workflow while preserving filters and open task details.
- Replaced schedule deletion with an accessible confirmation dialog and refined task details, empty states and source context for desktop and narrow layouts.
- Consolidated deployment and firewall surface overrides to retain CloudPulse hierarchy without decorative borders or unused action space.

## 0.3.0-preview.15 - 2026-07-15

### Fixed

- Removed settled database-runtime abort listeners after every collection interval, preventing the long-running Agent from accumulating listeners and emitting `MaxListenersExceededWarning`.
- Added regression coverage for repeated timer completion and an already-aborted shutdown signal.

## 0.3.0-preview.14 - 2026-07-15

### Fixed

- Extended Agent-side journal redaction to cover Basic authorization, cookies, OAuth client secrets, AWS secret keys, private keys and generic URI userinfo before systemd snapshots leave a node.
- Added systemd-specific regression coverage for 10-second polling, hidden-tab pause, non-overlapping requests, background failure retention, stable detail selection and strict read-only API validation.

### Changed

- Removed obsolete systemd lifecycle-action styles so the Web surface consistently represents the node-scoped read-only monitoring boundary.

## 0.3.0-preview.13 - 2026-07-15

### Fixed

- Serialized same-process site-helper lock contenders and tolerated lock handoff races while reading owner metadata, preventing concurrent activations from failing when the previous lock disappears between inspection and `readlink`.

## 0.3.0-preview.12 - 2026-07-15

### Security

- Revalidated the current principal node scope before returning an idempotent site-plan result, preventing a previously authorized plan from bypassing a later scope reduction.

## 0.3.0-preview.11 - 2026-07-15

### Added

- Added authenticated, node-scoped site rollback history and execution APIs backed by the existing Controller, RemoteTask, Agent and root-only site-helper boundary.
- Added strict rollback contracts, release/plan ownership checks, optimistic site versions, idempotency, protected-site guards and atomic success reconciliation.
- Added a real rollback workbench with backend freshness, visibility-aware 10-second polling, stable detail selection, permission-aware actions and reauthentication.

### Security

- Rollback execution requires a current user session, CSRF, `sites:deploy`, node scope and a one-time reauthentication proof; API tokens cannot execute rollbacks.
- The site helper accepts only opaque plan and release identities, validates immutable commit markers, serializes site changes and restores the previous release after a failed health check.

## 0.3.0-preview.10 - 2026-07-15

### Fixed

- Added explicit production/staging environments to site deployment plans and schema 8, preserving legacy staging refs during migration while preventing staging plans from switching production traffic.
- Made operation polling read-only, aligned it to the 10-second monitoring interval, and marked scoped deployment responses as `no-store`.
- Added an indexed, integrity-checked deployment projection and stabilized filters and detail selection across route and operation changes.

## 0.3.0-preview.9 - 2026-07-15

### Fixed

- Updated the disposable systemd installer verification fixture to include the Web entry required by a complete Controller release, preserving the production installer's fail-closed integrity check while restoring the Linux hardening gate.

### Changed

- Promoted the deployment workbench real-backend release to a new preview version after `0.3.0-preview.8` had already been published to `main`, keeping package, Agent runtime, lockfile and release-document versions traceable to the corrected CI revision.

## 0.3.0-preview.8 - 2026-07-15

### Added

- Added an authenticated, node-scoped deployment query API that projects real site plans, operations, managed releases and backend collection time.
- Added typed deployment contracts and a visibility-aware 10-second Web polling path with stable operation and release identities.

### Changed

- Replaced the deployment workbench's fixture queue, generated logs and simulated completion, redeploy and rollback mutations with real Controller state, explicit empty/error handling and release history.
- Reused the existing reauthenticated Git deployment plan for creation, and contained long node and release identifiers across desktop tables, mobile cards and detail drawers.

### Security

- Deployment reads require `sites:read` and honor the principal node scope; unsupported rollback and arbitrary command execution remain unavailable.

## 0.3.0-preview.7 - 2026-07-15

### Fixed

- Extended Agent-side journal redaction to cover JSON secrets, URL query credentials and database connection strings before snapshots leave a node.
- Rejected option-like service names in legacy `service.status.read` tasks and marked systemd activating/reloading states as warnings instead of healthy services.
- Added bounded pagination for aggregated systemd rows and logs, mobile-safe long-text wrapping and `no-store` API responses.

## 0.3.0-preview.6 - 2026-07-15

### Fixed

- Removed uncancelled animation-frame and timer retries from shared dialog and drawer focus restoration, preventing callbacks from escaping the owning document lifecycle.
- Made animated modal focus restoration deterministic after React unmount and covered both restored and removed trigger paths in the Web test suite.

## 0.3.0-preview.5 - 2026-07-15

### Added

- Added authenticated Controller-host systemd inventory, bounded journal reads and allowlisted start, stop and restart operations through a dedicated Controller-only root helper socket.
- Added strict shared systemd response contracts and Controller routes with CSRF, RBAC, one-time reauthentication and audit enforcement.
- Added bounded Agent-side systemd service and journal snapshot collection with credential redaction, strict shared contracts and node-scoped `systemd:read` access.
- Added authenticated `GET /api/systemd/services` and a visibility-aware 10-second Web polling path backed by saved Agent snapshots.

### Changed

- Replaced the systemd workbench fixtures, synthetic journal output and browser-only mutations with real backend data, visible collection timestamps and silent visibility-aware 10-second polling.
- Preserved service filters and stable detail selection across refreshes, while loading journal entries only when an operator opens a service.
- Added the Agent service account to `systemd-journal` so native Linux deployments can read system journal entries without running the Agent as root.

### Security

- systemd actions accept only validated service, timer, socket and target unit names and an explicit deployment allowlist; the Agent cannot access the dedicated socket and arbitrary commands and paths remain unavailable.
- Journal results are line-bounded, size-bounded and redact common credential fields before crossing the helper boundary.
- systemd collection uses only fixed `systemctl` and `journalctl` argument forms, enforces response bounds, redacts common credential forms before upload and preserves RBAC node scope.

## 0.3.0-preview.4 - 2026-07-14

### Fixed

- Updated desktop and mobile browser motion coverage to assert the modal enter and exit contract used by the file creation dialog.
- Restored clean `npm ci` installation in Linux, Windows and container release jobs by completing the CycloneDX optional dependency lock graph.

### Documentation

- Added complete rollout, compatibility and rollback guidance for physical-host identity and schema 7 releases.

## 0.3.0-preview.3 - 2026-07-14

### Added

- Added feature-negotiated physical-host identity so a Controller and its uniquely matching co-located Agent share one monitoring row and one set of resource totals while preserving Agent UUID, RBAC, heartbeat, audit and task-routing identity.

### Changed

- Refined deployment and rollback workspaces with responsive layouts, semantic status icons, accessible logs and a body-level creation modal.
- Improved firewall rule and deny-record surfaces with stable responsive actions, clearer detail and confirmation hierarchy, and semantic allow/deny indicators.
- Hardened shared dialog and drawer focus restoration across animated exits, with focused deployment and firewall interaction coverage.
- Preserved co-located Agent control-channel health on the merged Controller row, including degraded status and stable risks for offline or stale telemetry.

### Repository

- Added explicit Git submission and push requirements to the repository agent guidance.

## 0.3.0-preview.2 - 2026-07-14

### Changed

- Refined firewall rule and deny-record workflows with accessible confirmation, semantic results, compact controls and complete detail surfaces.
- Added focused systemd service, journal and log-stream views with responsive drawer behavior and operational status context.
- Improved shared detail-drawer focus restoration and modal class handling, with expanded firewall and systemd page coverage.

## 0.3.0-preview.1 - 2026-07-14

### Added

- Added real PostgreSQL, MySQL and MariaDB inventory, sessions, slow-query metadata, local backup plans, restore points and asynchronous database operations across registered Agent nodes.
- Added strict database contracts, SQLite schema 6 persistence, seven-day encrypted full-SQL retention, node-scoped RBAC and short-lived two-stage confirmation plans.
- Added the root-only `database-helper` boundary with a fixed operation vocabulary, local Unix socket transport, multi-instance port allocation and systemd/OpenRC deployment definitions.

### Changed

- Upgraded the Agent protocol to `1.1` while retaining Controller compatibility with `1.0` Agents; database capabilities require the new protocol and Controller-first rollout order.
- Replaced database-page fixtures and simulated success states with typed APIs, visibility-aware 10-second polling, real empty/error states and actual CSV export.
- Moved Controller SQLite backup management to Settings / System Backup so it remains separate from managed PostgreSQL/MySQL/MariaDB backups.

### Security

- Database SQL, credentials and connection strings are excluded from heartbeat, normal logs and audit payloads; complete SQL is encrypted at rest and automatically purged after seven days.
- High-risk install, read-only, session termination, index and restore actions require a current user session, CSRF, explicit database permission, node scope, an expiring plan and an idempotency key.

## 0.2.0-preview.6 - 2026-07-13

### Changed

- Replaced the website demo inventory and simulated actions with authenticated Nginx discovery, loopback health probes, certificate metadata and silent 10-second polling from `GET /api/sites`.
- Made unavailable site traffic, certificate and latency data explicit, and removed unsupported create, start/stop, renewal and access-log success simulations.
- Refined database instance, backup and slow-query workflows with stable operational summaries, focused details and responsive action layouts.
- Added clearer file upload, recycle-bin and terminal-session interactions, including keyboard-accessible confirmation dialogs and complete terminal session drawers.
- Split database, file and terminal visual treatments into focused CloudPulse styles and expanded corresponding page-level UI tests.

## 0.2.0-preview.5 - 2026-07-12

### Changed

- Refined website inventory, active-runtime, certificate-risk and runtime-group views with semantic statuses, focused risk workflows and complete body-level detail drawers.
- Added certificate risk and renewal-mode filters, runtime health summaries and compact action controls while preserving responsive long-domain handling.
- Expanded site-page and theme coverage, and hardened shell monitoring fallbacks for incomplete overview responses.

## 0.2.0-preview.4 - 2026-07-12

### Changed

- Added silent 10-second monitoring refresh with visibility-aware recovery for Overview and host surfaces while preserving filters and open details.
- Aggregated local disk utilization across all detected volumes and exposed per-volume capacity details through accessible host and metric detail views.
- Refined CloudPulse overview, host, drawer and sidebar layouts for stable responsive scanning, long-hostname handling and clearer operational freshness states.

## 0.2.0-preview.3 - 2026-07-11

### Changed

- Rebuilt the Web console around the CloudPulse visual system with local variable fonts, persistent light/dark themes and responsive shared navigation.
- Consolidated legacy mobile routes and CSS into the desktop/mobile application shell while retaining routing compatibility and operational page behavior.
- Added theme coverage and updated routing tests, mock data and interface documentation for the refreshed control console.

## 0.2.0-preview.1 - 2026-07-11

### Added

- TypeScript monorepo with modular Web, Controller, Agent and shared runtime contracts.
- Cookie identity, RBAC/node scopes, API tokens, SQLite migrations, encrypted secrets and chained audit records.
- TLS Controller-Agent protocol with per-node identities and a closed read-only task registry.
- Hardened Docker Compose/systemd deployment, reverse proxy examples and production operations documentation.
- HTTPS desktop/mobile E2E, upgrade/restore drills, CycloneDX SBOM, checksums and keyless release signing workflow.

### Security

- Strict CORS, bounded JSON bodies, explicit dangerous capability switches and trusted-proxy CIDRs.
- Non-root containers/services, minimized network exposure and high/critical vulnerability release gates.

### Known Issues

- Preview maturity only; no SLA, arm64 production support, automated Firefox E2E or published stable upgrade source.
- Web main chunk is approximately 650 kB after minification.
