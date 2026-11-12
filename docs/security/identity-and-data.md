# Identity, Data and Audit Operations

StackPilot Step 7 uses SQLite for a single-machine self-hosted Controller. SQLite provides transactions, constraints, WAL mode, online backup and a simple restore boundary without requiring another service. Migrations are monotonic SQL files recorded in `schema_migrations` and applied transactionally.

## Master key and initialization

Generate a 32-byte key outside the repository and inject it as `STACKPILOT_MASTER_KEY`; production deployments should instead use `STACKPILOT_MASTER_KEY_FILE` through a Docker secret or systemd credential. The key is never stored in SQLite. A missing or invalid key prevents Controller startup. For local HTTP only, set `STACKPILOT_COOKIE_SECURE=0`; production mode rejects insecure cookies.

```powershell
$env:STACKPILOT_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
$env:STACKPILOT_COOKIE_SECURE = "0"
npm run build --workspace @stackpilot/controller
npm run db:init --workspace @stackpilot/controller
```

`db:init` requires a local interactive TTY, hides password input, accepts no password argument, and succeeds only while no administrator exists. There is no remote first-user registration endpoint. Passwords are 12 to 128 characters with no arbitrary composition rule and are hashed with Argon2id.

## Sessions, authorization and tokens

Browser login creates a fresh 256-bit session identifier. Only its SHA-256 digest is stored. The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, expiring, and `Secure` by default. Cookie writes require a session-bound CSRF token and exact allowed Origin. Login uses a uniform error plus exponential failure backoff.

Authorization checks explicit permissions, then an optional node scope. Built-in roles are `administrator`, `operator`, and `audit-reader`; role names never replace permission checks. Node revocation, user/role changes, API Token creation and remote-task creation require a short-lived, one-use password reauthentication proof.

API Tokens are random, shown only by the creation response, and stored as SHA-256 digests. Each token has a name, explicit permissions, explicit all-node or selected-node scope, expiry, last-use time and revocation time. An API Token can never exceed its owner's effective permissions or node scope.

## Encryption and audit

Decryptable secrets use AES-256-GCM with a unique 96-bit nonce. A random internal audit-chain key is encrypted by the master key. Rotate encrypted material using separate old and new environment variables:

```powershell
$env:STACKPILOT_MASTER_KEY = "<current key>"
$env:STACKPILOT_NEW_MASTER_KEY = "<new 32-byte key>"
npm run secrets:rotate --workspace @stackpilot/controller
```

After success, replace the Controller's master-key secret and restart. Do not discard the old key until the Controller has started and `audit:verify` succeeds. Audit rows are append-only through normal paths and database triggers reject update/delete. Verify the HMAC chain with:

```bash
npm run audit:verify --workspace @stackpilot/controller
```

## Migration, import, backup and restore

```bash
npm run db:migrate --workspace @stackpilot/controller
npm run db:import-legacy --workspace @stackpilot/controller
npm run db:backup --workspace @stackpilot/controller -- .stackpilot/backups/stackpilot.sqlite3
npm run db:restore --workspace @stackpilot/controller -- .stackpilot/backups/stackpilot.sqlite3
```

Legacy import validates the JSON, hashes the source and records an idempotency marker in the same transaction. It never deletes or rewrites `.stackpilot/controller-agent-state.json`. Restore first checks SQLite integrity and schema version, then atomically installs the candidate while preserving the prior database as `.before-restore`. Stop the Controller before restore. Keep the database, backup and master key in separate protected backup locations; a database backup without its matching master key cannot recover encrypted values.

Production retention and isolated restore drills are documented in [backup and restore](../backup-restore/README.md). Schema 12 cannot be down-migrated; rollback to an older schema restores the verified pre-upgrade backup with the matching prior application version.
