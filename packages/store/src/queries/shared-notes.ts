import type { Database } from "bun:sqlite";
import type { SharedNote } from "@standup/shared";
import { randomUUID } from "crypto";

interface SharedNoteRow {
  id: string;
  project_id: string | null;
  from_session_id: string | null;
  from_label: string | null;
  body: string;
  done: number;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: SharedNoteRow): SharedNote {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    fromSessionId: row.from_session_id ?? undefined,
    fromLabel: row.from_label ?? undefined,
    body: row.body,
    done: row.done === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Appends a line to the shared task-list every coordinating agent reads. A note
 * with no `projectId` lands on the global board; one with a project is scoped to
 * that project's coordinating agents. `fromSessionId` / `fromLabel` attribute it
 * to the posting session.
 */
export function postSharedNote(
  db: Database,
  input: {
    projectId?: string;
    fromSessionId?: string;
    fromLabel?: string;
    body: string;
  }
): SharedNote {
  const id = randomUUID();

  db.run(
    `INSERT INTO shared_notes (id, project_id, from_session_id, from_label, body)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId ?? null,
      input.fromSessionId ?? null,
      input.fromLabel ?? null,
      input.body,
    ]
  );

  return {
    id,
    projectId: input.projectId,
    fromSessionId: input.fromSessionId,
    fromLabel: input.fromLabel,
    body: input.body,
    done: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * The shared task-list, newest first. A `projectId` returns that project's
 * board plus the global (project-less) notes so a project agent sees both
 * scopes; omitting it returns the GLOBAL board only — never every project's
 * notes, which would leak one tenant's board to another. Reads are scoped to
 * the caller's standing in the server layer, so a projectId is only ever passed
 * for a project the caller belongs to. `done` lines are included by default
 * (struck-through in the UI); pass `openOnly` to hide the finished ones.
 */
export function getSharedNotes(
  db: Database,
  options: { projectId?: string; openOnly?: boolean; limit?: number } = {}
): SharedNote[] {
  const { projectId, openOnly = false, limit = 100 } = options;

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (projectId) {
    where.push("(project_id = ? OR project_id IS NULL)");
    params.push(projectId);
  } else {
    // No project scope means the shared, project-less board only. It must not
    // fall through to a bare SELECT that returns every project's notes — that is
    // the cross-tenant leak this scoping closes.
    where.push("project_id IS NULL");
  }
  if (openOnly) where.push("done = 0");

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  // rowid breaks a created_at tie deterministically — datetime('now') has only
  // second resolution, so notes posted in the same second would otherwise sort
  // unstably. rowid DESC keeps the true insertion order (newest first).
  const rows = db
    .query(`SELECT * FROM shared_notes ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params) as SharedNoteRow[];

  return rows.map(rowToNote);
}

/** A single note by id, or null when it's gone — used to resolve a note's
 * project scope before authorizing an update against it. */
export function getSharedNote(db: Database, noteId: string): SharedNote | null {
  const row = db
    .query("SELECT * FROM shared_notes WHERE id = ?")
    .get(noteId) as SharedNoteRow | null;
  return row ? rowToNote(row) : null;
}

/** Marks a note done/undone. Returns the updated note, or null if it's gone. */
export function setSharedNoteDone(
  db: Database,
  noteId: string,
  done: boolean
): SharedNote | null {
  db.run(
    "UPDATE shared_notes SET done = ?, updated_at = datetime('now') WHERE id = ?",
    [done ? 1 : 0, noteId]
  );
  const row = db
    .query("SELECT * FROM shared_notes WHERE id = ?")
    .get(noteId) as SharedNoteRow | null;
  return row ? rowToNote(row) : null;
}
