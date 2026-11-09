import type { Database } from "bun:sqlite";
import type { NotifyOverride } from "@standup/shared";

/**
 * Notification routing persistence (ensureNotifyShape): each user's prefs
 * layers, and the brief slots each user's brief has fired for.
 */

interface PrefsRow {
  owner: string;
  project_id: string;
  override_json: string;
  updated_at: string;
}

/** The project_id a layer is stored under: '' is the user's global layer. */
function layerKey(projectId: string | null | undefined): string {
  return projectId ?? "";
}

function parseOverride(raw: string): NotifyOverride {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as NotifyOverride) : {};
  } catch {
    // A malformed blob reads as an empty layer rather than failing the read.
    return {};
  }
}

/** The user's layer for `projectId` (null or omitted: the global layer), or null when unset. */
export function getNotifyPrefs(db: Database, owner: string, projectId?: string | null): NotifyOverride | null {
  const row = db
    .query("SELECT * FROM notify_prefs WHERE owner = ? AND project_id = ?")
    .get(owner, layerKey(projectId)) as PrefsRow | null;
  return row ? parseOverride(row.override_json) : null;
}

/** Replaces the user's layer for `projectId` (null: the global layer). */
export function setNotifyPrefs(db: Database, owner: string, projectId: string | null, override: NotifyOverride): void {
  db.run(
    `INSERT INTO notify_prefs (owner, project_id, override_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner, project_id) DO UPDATE SET override_json = excluded.override_json, updated_at = excluded.updated_at`,
    [owner, layerKey(projectId), JSON.stringify(override), new Date().toISOString()]
  );
}

/** Removes the user's layer for `projectId`; true when one existed. */
export function deleteNotifyPrefs(db: Database, owner: string, projectId: string | null): boolean {
  return db.run("DELETE FROM notify_prefs WHERE owner = ? AND project_id = ?", [owner, layerKey(projectId)]).changes > 0;
}

/** The projects the user has a layer for. */
export function listNotifyPrefProjects(db: Database, owner: string): string[] {
  const rows = db
    .query("SELECT project_id FROM notify_prefs WHERE owner = ? AND project_id <> '' ORDER BY project_id")
    .all(owner) as Array<{ project_id: string }>;
  return rows.map((r) => r.project_id);
}

export type PersonaBriefRunStatus = "queued" | "sent" | "silent" | "skipped";

export interface PersonaBriefRun {
  owner: string;
  /** The brief slot's ISO instant. */
  slot: string;
  status: PersonaBriefRunStatus;
  inboxId?: string;
  detail?: string;
  createdAt: string;
}

interface BriefRunRow {
  owner: string;
  slot: string;
  status: string;
  inbox_id: string | null;
  detail: string | null;
  created_at: string;
}

function toBriefRun(row: BriefRunRow): PersonaBriefRun {
  return {
    owner: row.owner,
    slot: row.slot,
    status: row.status as PersonaBriefRunStatus,
    ...(row.inbox_id ? { inboxId: row.inbox_id } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    createdAt: row.created_at,
  };
}

/**
 * Claims the user's brief slot `slot`: true when this call recorded it, false
 * when it was already claimed (the slot has fired).
 */
export function claimPersonaBriefSlot(
  db: Database,
  owner: string,
  slot: string,
  status: PersonaBriefRunStatus,
  now: string,
  detail?: string
): boolean {
  return (
    db.run(
      `INSERT OR IGNORE INTO persona_brief_runs (owner, slot, status, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
      [owner, slot, status, detail ?? null, now]
    ).changes > 0
  );
}

/** Records how a claimed slot ended. */
export function settlePersonaBriefSlot(
  db: Database,
  owner: string,
  slot: string,
  update: { status: PersonaBriefRunStatus; inboxId?: string; detail?: string }
): void {
  db.run("UPDATE persona_brief_runs SET status = ?, inbox_id = ?, detail = ? WHERE owner = ? AND slot = ?", [
    update.status,
    update.inboxId ?? null,
    update.detail ?? null,
    owner,
    slot,
  ]);
}

/** The user's most recent brief run with status `sent`, or null. */
export function lastSentPersonaBrief(db: Database, owner: string): PersonaBriefRun | null {
  const row = db
    .query("SELECT * FROM persona_brief_runs WHERE owner = ? AND status = 'sent' ORDER BY slot DESC LIMIT 1")
    .get(owner) as BriefRunRow | null;
  return row ? toBriefRun(row) : null;
}

/** The user's brief run for the newest slot, whatever its status, or null. */
export function latestPersonaBriefRun(db: Database, owner: string): PersonaBriefRun | null {
  const row = db
    .query("SELECT * FROM persona_brief_runs WHERE owner = ? ORDER BY slot DESC LIMIT 1")
    .get(owner) as BriefRunRow | null;
  return row ? toBriefRun(row) : null;
}

/** The user's most recent brief runs, newest first. */
export function listPersonaBriefRuns(db: Database, owner: string, limit = 10): PersonaBriefRun[] {
  const rows = db
    .query("SELECT * FROM persona_brief_runs WHERE owner = ? ORDER BY slot DESC LIMIT ?")
    .all(owner, limit) as BriefRunRow[];
  return rows.map(toBriefRun);
}
