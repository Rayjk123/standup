import { Database } from "bun:sqlite";
import {
  allMigrations,
  pendingMigrations,
  recordedSchemaVersions,
  runMigrations,
  type VersionedMigration,
} from "./migrations.js";
import { assertNotLiveDbInTest } from "./live-db-guard.js";
import {
  backupBeforeMigrate,
  preMigrateBackupTempPath,
  removeStaleBackupTemp,
  restoreHint,
  type PreMigrateBackup,
} from "./backup.js";

export interface Store {
  db: Database;
  close(): void;
}

export interface StoreOptions {
  /**
   * Copy the database to `<db>.pre-migrate.bak` before applying a pending
   * migration (see backup.ts), and refuse to migrate when the copy fails.
   */
  backupBeforeMigrate?: boolean;
  /** Where the backup lines go; defaults to console.log and console.error. */
  log?: (line: string) => void;
  /** The migration list to apply; defaults to this code's (a test replays others). */
  migrations?: VersionedMigration[];
  /**
   * Told when the pre-migration copy starts, when migrations start, and
   * (undefined) when both are done; called only when a migration is pending.
   */
  onBootPhase?: (phase: "pre-migrate-backup" | "migrating" | undefined) => void;
}

export function createStore(dbPath: string = ":memory:", options: StoreOptions = {}): Store {
  assertNotLiveDbInTest(dbPath);
  const db = new Database(dbPath, { create: true });
  const log = options.log ?? ((line: string) => console.log(line));
  const logError = options.log ?? ((line: string) => console.error(line));
  const migrations = options.migrations ?? allMigrations();

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const pending = pendingMigrations(db, migrations).length;
  let taken: PreMigrateBackup | undefined;
  if (options.backupBeforeMigrate === true && dbPath !== ":memory:") {
    try {
      if (removeStaleBackupTemp(dbPath)) {
        log(`[store] Deleted ${preMigrateBackupTempPath(dbPath)}, an unfinished backup an earlier boot left`);
      }
    } catch (err) {
      // The copy below deletes it again, and refuses to migrate if it can't.
      logError(`[store] Could not delete ${preMigrateBackupTempPath(dbPath)}: ${(err as Error).message}`);
    }
    // A database with no recorded schema is new: there is nothing to lose.
    if (pending > 0 && recordedSchemaVersions(db).size > 0) {
      const started = performance.now();
      options.onBootPhase?.("pre-migrate-backup");
      try {
        taken = backupBeforeMigrate(db, dbPath);
      } catch (err) {
        db.close();
        throw new Error(
          `Could not back up ${dbPath} before applying ${pending} pending migration(s), so none was applied: ` +
            `${(err as Error).message}. Fix the cause (often disk space or the directory's permissions), then start Standup again.`,
          { cause: err }
        );
      }
      if (taken.kept) {
        const hours = (Date.now() - taken.takenAt.getTime()) / 3_600_000;
        log(
          `[store] ${taken.path} already holds this schema (written ${hours.toFixed(1)} h ago, at ` +
            `${taken.takenAt.toISOString()}, likely before an earlier attempt at these migrations); keeping it as the backup`
        );
      } else {
        log(`[store] Backed up the database before ${pending} pending migration(s) to ${taken.path} (${Math.round(performance.now() - started)} ms)`);
      }
    }
  }

  try {
    if (pending > 0) options.onBootPhase?.("migrating");
    runMigrations(db, migrations);
    if (pending > 0) options.onBootPhase?.(undefined);
  } catch (err) {
    if (taken) logError(`[store] ERROR: Migration failed: ${(err as Error).message}. ${restoreHint(dbPath, taken)}`);
    db.close();
    throw err;
  }

  return {
    db,
    close() {
      db.close();
    },
  };
}
