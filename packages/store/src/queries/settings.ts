import type { Database } from "bun:sqlite";

/** Small global key/value store for UI-toggleable switches. See migration 006. */

// Reserved key holding the monotonic settings version. It lives in the same
// key/value table (no schema migration) and is bumped on every write, so a
// poller can tell whether a fetched snapshot already reflects its own last write.
// Never surfaced as a user setting: callers read explicit keys, never enumerate.
const SETTINGS_VERSION_KEY = "__settingsVersion__";

export function getSetting(db: Database, key: string): string | null {
  const row = db
    .query("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
  bumpSettingsVersion(db);
}

/**
 * The current monotonic settings version — 0 before any write, incremented by one
 * on every setSetting. Durable across restarts (it is a persisted row), so it
 * never rewinds. A client that records the version its own write was assigned can
 * adopt any later snapshot whose version is at least that (see the Slack adapter's
 * settings reconcile), which is how a stale poll is told apart from a fresh one.
 */
export function getSettingsVersion(db: Database): number {
  const row = db
    .query("SELECT value FROM settings WHERE key = ?")
    .get(SETTINGS_VERSION_KEY) as { value: string } | null;
  const n = row ? Number.parseInt(row.value, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Increment the monotonic settings version by one (atomic upsert). */
function bumpSettingsVersion(db: Database): void {
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    [SETTINGS_VERSION_KEY]
  );
}
