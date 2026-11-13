# Compatibility Matrix

StackPilot `0.3.0-preview.62` is a preview release, not a stable production release. Support below means the release gates are designed for that target; it does not imply an SLA.

| Surface | Supported range | Evidence and limits |
| --- | --- | --- |
| Controller/Web OS | Debian 12 and Ubuntu 24.04 LTS, x86_64 | systemd units target these distributions; runtime validation is a Linux CI gate |
| Agent/database-helper OS | Not yet certified for `0.3.0-preview.62` | drivers target Debian 12, Ubuntu 24.04, Rocky/Alma 9, Fedora 42, Alpine 3.22 and Arch x86_64, but support remains blocked until pinned per-OS install, multi-instance, backup and restore CI gates pass |
| Containers | Docker Engine 27+ with Compose v2 on Linux x86_64 | images are built and scanned in CI; no arm64 claim yet |
| Node.js | `22.x`, release build pinned to `22.22.0` | Node 20 remains usable for development but is not a production release target |
| npm | 10 or 11 with committed lockfile | production installation uses `npm ci` |
| Controller state | embedded SQLite, schema `12` | direct upgrade from schemas 1 through 11; rollback to a schema 11 Controller requires the verified pre-upgrade backup |
| Managed databases | PostgreSQL, MySQL and MariaDB from supported distribution repositories | local backups only; in-place restore is limited to StackPilot-created managed instances |
| Controller | `0.3.0-preview.62` | must match Web release version |
| Agent | `0.1.x`/`0.2.x` protocol `1.0`, or `0.3.x` protocol `1.1` | Controller accepts both protocol versions; database capabilities require `0.3.x`/`1.1` and helper availability |
| Browser | current and previous major Chrome, Edge and Firefox | Chromium desktop/mobile E2E is automated; Firefox is a compatibility target, not yet an E2E gate |

Windows and macOS are development environments only. Native production deployment, database-helper and host-management capabilities are not supported there. Windows telemetry uses a CIM-backed equivalent load estimate rather than a native Unix Load Average; CI verifies that collection on a Windows runner, but this does not expand the native production support range. Safari, arm64 and clustered Controllers are not currently supported.

## Version Rules

StackPilot follows Semantic Versioning. During `0.x`, a minor version can contain breaking changes; patch versions preserve documented contracts within that minor. Prerelease suffixes (`preview`, `rc`) never imply stable support.

| Controller | Agent | Protocol | Database | Result |
| --- | --- | --- | --- | --- |
| `0.3.x` | `0.1.x` or `0.2.x` | `1.0` | 12 | accepted without database capabilities |
| `0.3.x` | `0.3.x` | `1.1` | 12 | supported database-capable preview combination |
| `0.3.x` | any | any version other than `1.0` or `1.1` | any | rejected before task processing |
| `0.3.x` | any | `1.0` or `1.1` | 1 through 11 | upgrade required; back up before migration |
| `0.3.x` | any | `1.0` or `1.1` | greater than 12 | refuse startup/upgrade; newer database cannot be opened safely |

Schema 12 has no automatic down migration. Rollback to a Controller that only supports an older schema means restoring its verified pre-upgrade backup. Roll out Controller/Web first, then site/database helpers, then Agent; a protocol `1.1` Agent must not be connected to an older Controller.
