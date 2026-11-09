import type { Database } from "bun:sqlite";

/**
 * The host's per-guest Persona access: whether the guest's Persona is enabled
 * and the projects it may launch workers into. See migration 059. A guest with
 * no row may launch nowhere.
 */
export interface PersonaUserAccess {
  alias: string;
  enabled: boolean;
  /** Project ids the guest's Persona may launch into; empty means none. */
  launchProjects: string[];
  /** The alias that last changed this row. */
  updatedBy?: string;
  updatedAt: string;
}

interface AccessRow {
  alias: string;
  enabled: number;
  launch_projects_json: string;
  updated_by: string | null;
  updated_at: string;
}

function parseProjects(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    // A corrupt blob reads as "no projects": the allowlist fails closed.
    return [];
  }
}

function toAccess(row: AccessRow): PersonaUserAccess {
  return {
    alias: row.alias,
    enabled: row.enabled !== 0,
    launchProjects: parseProjects(row.launch_projects_json),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
    updatedAt: row.updated_at,
  };
}

/** The access row for `alias`, or null when the host has set none. */
export function getPersonaUserAccess(db: Database, alias: string): PersonaUserAccess | null {
  const row = db.query("SELECT * FROM persona_user_access WHERE alias = ?").get(alias) as AccessRow | null;
  return row ? toAccess(row) : null;
}

/**
 * Upserts `alias`'s access. `launchProjects` replaces the stored list (trimmed,
 * blanks dropped, deduplicated in order); `enabled` keeps the stored value when
 * omitted, and defaults to true for a new row. Returns the stored row.
 */
export function putPersonaUserAccess(
  db: Database,
  input: { alias: string; launchProjects: string[]; enabled?: boolean; updatedBy?: string }
): PersonaUserAccess {
  const projects = [...new Set(input.launchProjects.map((p) => p.trim()).filter((p) => p.length > 0))];
  const enabled = input.enabled ?? getPersonaUserAccess(db, input.alias)?.enabled ?? true;
  db.run(
    `INSERT INTO persona_user_access (alias, enabled, launch_projects_json, updated_by, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(alias) DO UPDATE SET
         enabled = excluded.enabled,
         launch_projects_json = excluded.launch_projects_json,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`,
    [input.alias, enabled ? 1 : 0, JSON.stringify(projects), input.updatedBy?.trim() || null]
  );
  return getPersonaUserAccess(db, input.alias)!;
}

/** Every access row, by alias. */
export function listPersonaUserAccess(db: Database): PersonaUserAccess[] {
  const rows = db.query("SELECT * FROM persona_user_access ORDER BY alias").all() as AccessRow[];
  return rows.map(toAccess);
}
