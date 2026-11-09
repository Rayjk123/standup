import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "./store.js";
import { LATEST_SCHEMA_VERSION, allMigrations, type VersionedMigration } from "./migrations.js";
import { backupBeforeMigrate, preMigrateBackupPath, preMigrateBackupTempPath } from "./backup.js";

let dir: string;
let dbPath: string;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "standup-backup-"));
  dbPath = join(dir, "standup.db");
  lines = [];
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

/** This code's migrations plus test ones after them, each creating table `t<n>`. */
function withExtra(...extra: Array<number | VersionedMigration>): VersionedMigration[] {
  return [
    ...allMigrations(),
    ...extra.map((m) =>
      typeof m === "number" ? { version: LATEST_SCHEMA_VERSION + m, apply: `CREATE TABLE t${m} (x INTEGER)` } : m
    ),
  ];
}

function open(migrations: VersionedMigration[]): void {
  createStore(dbPath, { backupBeforeMigrate: true, migrations, log: (line) => lines.push(line) }).close();
}

/** The backup's tables named `t<n>` and its rows of `marker`. */
function backupContents(): { tables: string[]; markers: string[] } {
  const db = new Database(preMigrateBackupPath(dbPath), { readonly: true });
  try {
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 't[0-9]*' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const markers = (db.query("SELECT label FROM marker ORDER BY label").all() as Array<{ label: string }>).map((r) => r.label);
    return { tables, markers };
  } finally {
    db.close();
  }
}

function addMarker(label: string): void {
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS marker (label TEXT)");
  db.run("INSERT INTO marker (label) VALUES (?)", [label]);
  db.close();
}

/** The files beside the database other than the database itself and its WAL and shm. */
function backupFiles(): string[] {
  return readdirSync(dir).filter((name) => !/^standup\.db(-wal|-shm)?$/.test(name)).sort();
}

describe("pre-migration backup", () => {
  test("a pending migration on an existing database writes one backup holding the database as it was", () => {
    open(allMigrations());
    addMarker("before");
    open(withExtra(1));
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
    expect(backupContents()).toEqual({ tables: [], markers: ["before"] });
    expect(lines.some((l) => l.includes("Backed up the database before 1 pending migration(s)"))).toBe(true);
  });

  test("no pending migration takes no backup and writes nothing", () => {
    open(allMigrations());
    lines = [];
    open(allMigrations());
    expect(backupFiles()).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("a new database takes no backup: it has nothing to lose", () => {
    open(allMigrations());
    expect(backupFiles()).toEqual([]);
  });

  test("the boot phases name the copy, then the migrations, then their end; with nothing pending there are none", () => {
    const phases: Array<string | undefined> = [];
    const openReporting = (migrations: VersionedMigration[]) =>
      createStore(dbPath, { backupBeforeMigrate: true, migrations, log: (line) => lines.push(line), onBootPhase: (p) => phases.push(p) }).close();
    // A new database migrates without a copy.
    openReporting(allMigrations());
    expect(phases).toEqual(["migrating", undefined]);
    phases.length = 0;
    openReporting(allMigrations());
    expect(phases).toEqual([]);
    openReporting(withExtra(1));
    expect(phases).toEqual(["pre-migrate-backup", "migrating", undefined]);
  });

  test("a second migration replaces the first backup, leaving one file", () => {
    open(allMigrations());
    addMarker("v1");
    open(withExtra(1));
    addMarker("v2");
    open(withExtra(1, 2));
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
    expect(backupContents()).toEqual({ tables: ["t1"], markers: ["v1", "v2"] });
  });

  test("a failed copy leaves the previous backup intact and applies no migration", () => {
    if (process.getuid?.() === 0) return; // root writes into a read-only directory
    open(allMigrations());
    addMarker("v1");
    open(withExtra(1));
    addMarker("v2");
    // An open connection keeps the WAL and shm files, so the database still
    // opens once no new file can be created beside it — the copy can't.
    const holder = new Database(dbPath);
    holder.query("SELECT 1 FROM marker").get();
    chmodSync(dir, 0o500);
    try {
      expect(() => open(withExtra(1, 2))).toThrow(/Could not back up .* so none was applied: .*the previous backup is unchanged/);
    } finally {
      chmodSync(dir, 0o700);
      holder.close();
    }
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
    expect(backupContents()).toEqual({ tables: [], markers: ["v1"] });
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 't2'").get()).toBeNull();
    db.close();
  });

  test("a copy that throws reports the previous backup unchanged, and it is", () => {
    open(allMigrations());
    addMarker("v1");
    open(withExtra(1));
    const closed = new Database(dbPath);
    closed.close();
    expect(() => backupBeforeMigrate(closed, dbPath)).toThrow(/the previous backup is unchanged/);
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
    expect(backupContents()).toEqual({ tables: [], markers: ["v1"] });
  });

  test("a temp file an interrupted backup left is deleted on the next start, whether or not a migration is pending", () => {
    open(allMigrations());
    writeFileSync(preMigrateBackupTempPath(dbPath), "partial copy");
    open(allMigrations());
    expect(backupFiles()).toEqual([]);
    expect(lines.some((l) => l.includes("an unfinished backup an earlier boot left"))).toBe(true);

    writeFileSync(preMigrateBackupTempPath(dbPath), "partial copy");
    open(withExtra(1));
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
  });

  /** A migration that writes a row, then fails before its version is recorded. */
  const half: VersionedMigration = {
    version: LATEST_SCHEMA_VERSION + 1,
    apply: (db) => {
      db.exec("INSERT INTO marker (label) VALUES ('half-migrated')");
      throw new Error("boom");
    },
  };

  test("a retry after a migration failed partway keeps the backup taken before the first attempt", () => {
    open(allMigrations());
    addMarker("clean");
    expect(() => open(withExtra(half))).toThrow("boom");
    expect(lines.some((l) => l.includes("Migration failed: boom") && l.includes("To restore"))).toBe(true);
    lines = [];
    expect(() => open(withExtra(half))).toThrow("boom");
    expect(lines.some((l) => /already holds this schema .* h ago, at \d{4}-\d{2}-\d{2}T.*keeping it/.test(l))).toBe(true);
    expect(backupContents()).toEqual({ tables: [], markers: ["clean"] });
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
  });

  test("rolled-back code, then the fixed migration, keeps the clean backup", () => {
    open(allMigrations());
    addMarker("clean");
    expect(() => open(withExtra(half))).toThrow("boom");
    // The rolled-back code doesn't know the failed migration, so nothing is pending for it.
    open(allMigrations());
    open(withExtra(1));
    expect(backupContents()).toEqual({ tables: [], markers: ["clean"] });
  });

  test("the next migration after a success replaces the backup", () => {
    open(allMigrations());
    addMarker("clean");
    expect(() => open(withExtra(half))).toThrow("boom");
    open(withExtra(1));
    addMarker("after-1");
    lines = [];
    open(withExtra(1, 2));
    expect(lines.some((l) => l.includes("Backed up the database before 1 pending migration(s)"))).toBe(true);
    expect(backupContents()).toEqual({ tables: ["t1"], markers: ["after-1", "clean", "half-migrated"] });
    expect(backupFiles()).toEqual(["standup.db.pre-migrate.bak"]);
  });

  test("an unreadable or corrupt backup is replaced", () => {
    open(allMigrations());
    addMarker("now");
    writeFileSync(preMigrateBackupPath(dbPath), "not a database");
    open(withExtra(1));
    expect(backupContents()).toEqual({ tables: [], markers: ["now"] });

    writeFileSync(preMigrateBackupPath(dbPath), "");
    open(withExtra(1, 2));
    expect(backupContents()).toEqual({ tables: ["t1"], markers: ["now"] });
  });
});
