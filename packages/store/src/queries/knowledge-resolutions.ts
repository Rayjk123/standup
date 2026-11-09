import type { Database } from "bun:sqlite";

/**
 * The contradiction-resolver ledger. One row per resolution the
 * resolver attempted over a flagged doc↔doc pair: an auto-applied,
 * non-destructive resolution (status `applied`), or a withheld destructive one
 * recorded as the durable human-review queue entry (status `needs_review`).
 *
 * The type is defined here rather than in @standup/shared because the ledger is
 * a collector-internal record — nothing on the web wire reads it yet — and
 * keeping it local avoids widening the shared surface for a purely-durable log.
 */
export type ResolutionType = "rescope" | "merge" | "supersede" | "delete";
export type ResolutionStatus = "applied" | "needs_review";

export interface KnowledgeResolution {
  id: string;
  projectId: string;
  /** The claim kept as canonical. */
  winnerSlug: string;
  /** The claim superseded/tombstoned (or, for rescope, the second narrowed claim). */
  loserSlug: string;
  type: ResolutionType;
  status: ResolutionStatus;
  autoApplied: boolean;
  rationale: string;
  /** JSON of the proposal specifics (rescope qualifiers, merge note) + the
   *  classifier's reason a resolution was applied or withheld. */
  detail?: string;
  createdAt: Date;
}

interface KnowledgeResolutionRow {
  id: string;
  project_id: string;
  winner_slug: string;
  loser_slug: string;
  type: ResolutionType;
  status: ResolutionStatus;
  auto_applied: number;
  rationale: string;
  detail: string | null;
  created_at: string;
}

function toResolution(row: KnowledgeResolutionRow): KnowledgeResolution {
  return {
    id: row.id,
    projectId: row.project_id,
    winnerSlug: row.winner_slug,
    loserSlug: row.loser_slug,
    type: row.type,
    status: row.status,
    autoApplied: row.auto_applied === 1,
    rationale: row.rationale,
    detail: row.detail ?? undefined,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Persists a contradiction resolution. INSERT OR IGNORE on the stable id makes a
 * redelivered record a no-op, mirroring createKnowledgeChange — the resolver
 * fires fire-and-forget and a retry must not stack duplicate ledger rows.
 */
export function createKnowledgeResolution(
  db: Database,
  record: {
    id: string;
    projectId: string;
    winnerSlug: string;
    loserSlug: string;
    type: ResolutionType;
    status: ResolutionStatus;
    autoApplied: boolean;
    rationale: string;
    detail?: string;
  }
): void {
  db.run(
    `INSERT OR IGNORE INTO knowledge_resolutions
       (id, project_id, winner_slug, loser_slug, type, status, auto_applied, rationale, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.projectId,
      record.winnerSlug,
      record.loserSlug,
      record.type,
      record.status,
      record.autoApplied ? 1 : 0,
      record.rationale,
      record.detail ?? null,
    ]
  );
}

/** Resolutions for a project (or all), newest first. */
export function getKnowledgeResolutions(
  db: Database,
  projectId?: string
): KnowledgeResolution[] {
  const rows = (
    projectId
      ? db
          .query(
            "SELECT * FROM knowledge_resolutions WHERE project_id = ? ORDER BY created_at DESC"
          )
          .all(projectId)
      : db
          .query("SELECT * FROM knowledge_resolutions ORDER BY created_at DESC")
          .all()
  ) as KnowledgeResolutionRow[];
  return rows.map(toResolution);
}

/** The still-open human-review queue: resolutions withheld for a human to accept. */
export function getPendingResolutions(
  db: Database,
  projectId?: string
): KnowledgeResolution[] {
  return getKnowledgeResolutions(db, projectId).filter(
    (r) => r.status === "needs_review"
  );
}

/** A single resolution by id, or null. */
export function getKnowledgeResolution(
  db: Database,
  id: string
): KnowledgeResolution | null {
  const row = db
    .query("SELECT * FROM knowledge_resolutions WHERE id = ?")
    .get(id) as KnowledgeResolutionRow | null;
  return row ? toResolution(row) : null;
}

/**
 * Marks a withheld (needs_review) resolution as applied because a human accepted
 * it. `auto_applied` stays 0 — the row records that a human, not the autonomy
 * gate, released it. A no-op for an id that doesn't exist or isn't pending.
 */
export function markResolutionApplied(db: Database, id: string): void {
  db.run(
    `UPDATE knowledge_resolutions SET status = 'applied'
     WHERE id = ? AND status = 'needs_review'`,
    [id]
  );
}

/**
 * Marks a withheld (needs_review) resolution as applied by the autonomy gate —
 * re-evaluated on the current claims, it no longer needed a human. A no-op for
 * an id that doesn't exist or isn't pending.
 */
export function markResolutionAutoApplied(db: Database, id: string): void {
  db.run(
    `UPDATE knowledge_resolutions SET status = 'applied', auto_applied = 1
     WHERE id = ? AND status = 'needs_review'`,
    [id]
  );
}

/**
 * Rewrites a resolution's winner/loser columns because a human confirmed it with
 * the roles reversed (the "swap winner" action). The id is keyed on the UNORDERED
 * pair, so a swap keeps the same row — only which claim is recorded as canonical
 * flips, keeping the ledger honest about what was actually applied.
 */
export function updateResolutionWinnerLoser(
  db: Database,
  id: string,
  winnerSlug: string,
  loserSlug: string
): void {
  db.run(
    "UPDATE knowledge_resolutions SET winner_slug = ?, loser_slug = ? WHERE id = ?",
    [winnerSlug, loserSlug, id]
  );
}

/**
 * Voids a resolution row. Used when a human REJECTS a withheld proposal without
 * superseding either claim: the contradiction edges are cleared separately and
 * the ledger entry is removed. Because the dedup guard keys off an existing row,
 * deleting it means re-detection may later re-surface the same pair — the
 * accepted v1 behavior for a dismissed proposal.
 */
export function deleteKnowledgeResolution(db: Database, id: string): void {
  db.run("DELETE FROM knowledge_resolutions WHERE id = ?", [id]);
}
