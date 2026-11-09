import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "fs";
import { dirname } from "path";
import { recordedSchemaVersions } from "./migrations.js";
import { assertNotLiveDbInTest } from "./live-db-guard.js";

/**
 * The one pre-migration backup of the store's SQLite file, `<db>.pre-migrate.bak`
 * beside it. It is a `VACUUM INTO` copy — a consistent snapshot of the
 * committed state, WAL included — written to `<db>.pre-migrate.bak.tmp`,
 * synced, and renamed over the backup only once complete, so a failed or
 * interrupted copy never replaces the previous backup. Each new backup
 * replaces the last one; there is never more than one.
 *
 * Migrations are not transactional, and a migration's version is recorded only
 * once it succeeds. So a boot that retries a migration which failed partway
 * finds the database's recorded versions still equal to the backup's, and
 * keeps the backup rather than copying the half-migrated database over it. A
 * successful migration records its version, so the next migration takes a
 * fresh copy. When one boot applies several migrations and a later one fails,
 * the earlier ones are recorded: the retry then copies the database with the
 * failed migration's partial changes.
 */
export function preMigrateBackupPath(dbPath: string): string {
  return `${dbPath}.pre-migrate.bak`;
}

/** Where a backup is written before it is renamed over the backup. */
export function preMigrateBackupTempPath(dbPath: string): string {
  return `${preMigrateBackupPath(dbPath)}.tmp`;
}

/** Deletes the temp copy an interrupted backup left; returns whether there was one. */
export function removeStaleBackupTemp(dbPath: string): boolean {
  const temp = preMigrateBackupTempPath(dbPath);
  if (!existsSync(temp)) return false;
  rmSync(temp, { force: true });
  return true;
}

/** The pre-migration backup, when it was taken, and whether it was kept from an earlier boot. */
export interface PreMigrateBackup {
  path: string;
  takenAt: Date;
  kept: boolean;
}

/** Whether the backup at `path` records exactly the schema versions `db` does; false when it can't be read. */
function backupMatches(path: string, db: Database): boolean {
  if (!existsSync(path)) return false;
  let backup: Database | undefined;
  try {
    backup = new Database(path, { readonly: true });
    const kept = recordedSchemaVersions(backup);
    const live = recordedSchemaVersions(db);
    return kept.size > 0 && kept.size === live.size && [...kept].every((v) => live.has(v));
  } catch {
    // Unreadable or not a database: replace it.
    return false;
  } finally {
    backup?.close();
  }
}

/** Flushes `path` (a file or a directory) to disk. */
function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes sure `<db>.pre-migrate.bak` holds `db` as it is before this boot's
 * migrations: keeps the existing backup when it records the same schema
 * versions as `db` (an earlier attempt at these migrations took it), otherwise
 * copies `db`. `VACUUM INTO` does not sync its output, so the copy is flushed
 * before it is renamed over the backup. Throws when the copy fails, with the
 * previous backup unchanged.
 */
export function backupBeforeMigrate(db: Database, dbPath: string): PreMigrateBackup {
  assertNotLiveDbInTest(dbPath);
  const path = preMigrateBackupPath(dbPath);
  if (backupMatches(path, db)) return { path, takenAt: statSync(path).mtime, kept: true };
  const temp = preMigrateBackupTempPath(dbPath);
  rmSync(temp, { force: true });
  try {
    db.run("VACUUM INTO ?", [temp]);
    chmodSync(temp, 0o600);
    fsyncPath(temp);
    renameSync(temp, path);
    fsyncPath(dirname(path));
  } catch (err) {
    rmSync(temp, { force: true });
    throw new Error(`${(err as Error).message}; the previous backup is unchanged`, { cause: err });
  }
  return { path, takenAt: new Date(), kept: false };
}

/** The line logged when a migration fails after a pre-migration backup was taken. */
export function restoreHint(dbPath: string, backup: PreMigrateBackup): string {
  return (
    `The database as it was before migrating, at ${backup.takenAt.toISOString()}, is saved at ${backup.path}. ` +
    `Restoring it loses what was written since. To restore: stop Standup ` +
    `(systemctl --user stop standup.service, or stop bun run dev), delete ${dbPath}-wal and ${dbPath}-shm, ` +
    `then copy that file to ${dbPath}.`
  );
}
