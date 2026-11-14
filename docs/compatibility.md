# Compatibility Matrix

StackPilot `0.3.0-preview.70` is a preview release, not a stable production release. Support below means the release gates are designed for that target; it does not imply an SLA.

| Surface | Supported range | Evidence and limits |
| --- | --- | --- |
| Controller/Web OS | Debian 12 and Ubuntu 24.04 LTS, x86_64 | systemd units target these distributions; runtime validation is a Linux CI gate |
| Agent/database-helper OS | Not yet certified for `0.3.0-preview.70` | drivers target Debian 12, Ubuntu 24.04, Rocky/Alma 9, Fedora 42, Alpine 3.22 and Arch x86_64, but support remains blocked until pinned per-OS install, multi-instance, backup and restore CI gates pass |
| Containers | Docker Engine 27+ with Compose v2 on Linux x86_64 | images are built and scanned in CI; no arm64 claim yet |
| Node.js | `22.x`, release build pinned to `22.22.0` | Node 20 remains usable for development but is not a production release target |
| npm | 10 or 11 with committed lockfile | production installation uses `npm ci` |
| Controller state | embedded SQLite, schema `13` | direct upgrade from schemas 1 through 12; rollback to a schema 12 Controller requires the verified pre-upgrade backup |
| Managed databases | PostgreSQL, MySQL and MariaDB from supported distribution repositories | local backups only; in-place restore is limited to StackPilot-created managed instances |
| Controller | `0.3.0-preview.70` | must match Web release version |
| Agent | `0.1.x`/`0.2.x` protocol `1.0`, or `0.3.x` protocol `1.1` | Controller accepts both protocol versions; database capabilities require `0.3.x`/`1.1` and helper availability |
| Browser | current and previous major Chrome, Edge and Firefox | Chromium desktop/mobile E2E is automated; Firefox is a compatibility target, not yet an E2E gate |

Windows and macOS are development environments only. Native production deployment, database-helper and host-management capabilities are not supported there. Windows telemetry uses a CIM-backed equivalent load estimate rather than a native Unix Load Average; CI verifies that collection on a Windows runner, but this does not expand the native production support range. Safari, arm64 and clustered Controllers are not currently supported.

## Version Rules

StackPilot follows Semantic Versioning. During `0.x`, a minor version can contain breaking changes; patch versions preserve documented contracts within that minor. Prerelease suffixes (`preview`, `rc`) never imply stable support.

| Controller | Agent | Protocol | Database | Result |
| --- | --- | --- | --- | --- |
| `0.3.x` | `0.1.x` or `0.2.x` | `1.0` | 13 | accepted without database capabilities |
| `0.3.x` | `0.3.x` | `1.1` | 13 | supported database-capable preview combination |
| `0.3.x` | any | any version other than `1.0` or `1.1` | any | rejected before task processing |
| `0.3.x` | any | `1.0` or `1.1` | 1 through 12 | upgrade required; back up before migration |
| `0.3.x` | any | `1.0` or `1.1` | greater than 13 | refuse startup/upgrade; newer database cannot be opened safely |

Schema 13 adds the mesh observability tables (`mesh_peers`, `download_jobs`, `download_segments`). Schema 13 has no automatic down migration. Rollback to a Controller that only supports an older schema means restoring its verified pre-upgrade backup. Roll out Controller/Web first, then site/database helpers, then Agent; a protocol `1.1` Agent must not be connected to an older Controller.

Four response shapes grew in this release, and the Agent's status update gained an optional field. A `network.cache.fetch` result may carry an optional `parts` array naming the peer behind each part; a Controller tolerates an Agent that omits it and attributes nothing it was not told — a whole-object egress fill is attributed only through that result's own `viaEgress`/`egressNodeId`. The status update may carry a per-part `progress.parts` array, which the Controller turns into per-part rates; an Agent that omits it simply reports no part rates. A download job carries `parts` (empty when nothing is running), and because the job schema is strict an earlier Web rejects the whole object, so Controller and Web must be the same preview. The download job list response carries a required `traffic` block, so a Web build from an earlier preview cannot be paired with this Controller, which is why Controller and Web versions must match. The egress plan's node status gained `offline`, a liveness fact rather than a sample fact: a node whose process stopped heartbeating is reported as `offline` even when its samples are fresh, because selection already skips it. The node schema is strict, so an earlier Web rejects the quality table rather than mislabelling a dead node as `ready`; Controller and Web must again be the same preview. A disabled node also reports `disabledReason` — `revoked`, `no-overlay`, `not-allowed` or `not-declared` — so the panel names the piece that is missing instead of one vague word; the field is required by the same strict schema, so an earlier Web rejects the table rather than guessing a cause, and Controller and Web stay on one preview.
