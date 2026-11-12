# Versioning and Compatibility

Current version: `0.3.0-preview.41`. StackPilot uses Semantic Versioning, but this is preview software and not a stable production release. `0.x` minor releases may contain breaking changes; prerelease labels do not carry a support SLA.

Controller and Web versions must match. Controller-Agent compatibility is explicitly negotiated: Controller `0.3.x` accepts legacy protocol `1.0` Agents and database-capable protocol `1.1` Agents, but database capabilities require the latter. Database schema 10 can be upgraded directly from schemas 1 through 9. There is no automatic down migration.

The normative platform, browser, Agent and schema table is [compatibility.md](compatibility.md). Tags and GitHub release artifacts are authoritative; a package version in an untagged checkout is not a release.
