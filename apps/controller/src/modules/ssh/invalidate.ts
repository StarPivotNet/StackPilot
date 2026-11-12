import type Database from "better-sqlite3";
import { SshCredentialSchema, SshSessionSchema } from "@stackpilot/contracts";

/** Called inside the owning identity transaction; never reports host execution. */
export function invalidateSshUser(db: Database.Database, userId: string) {
  const now = new Date().toISOString();
  for (const row of db.prepare("SELECT payload FROM ssh_credentials WHERE user_id=?").all(userId) as { payload: string }[]) {
    const value = SshCredentialSchema.parse(JSON.parse(row.payload));
    value.revokedAt ??= now;
    db.prepare("UPDATE ssh_credentials SET payload=? WHERE id=?").run(JSON.stringify(value), value.id);
  }
  for (const row of db.prepare("SELECT payload FROM ssh_sessions WHERE user_id=?").all(userId) as { payload: string }[]) {
    const value = SshSessionSchema.parse(JSON.parse(row.payload));
    if (!value.terminatedAt) value.terminationRequestedAt ??= now;
    db.prepare("UPDATE ssh_sessions SET payload=? WHERE id=?").run(JSON.stringify(value), value.id);
  }
}
