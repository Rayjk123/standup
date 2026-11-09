import type { Database } from "bun:sqlite";

/**
 * The publish fact-check's per-doc state (`knowledge_verifications`, created by
 * KnowledgeStore): attempts spent on the doc's current body, the checkout it
 * was written against, and the last outcome. Keyed on the body's hash, so an
 * edited body starts over.
 */

export interface VerificationState {
  attempts: number;
  repoPath?: string;
  lastOutcome?: string;
}

function hasTable(db: Database): boolean {
  return !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_verifications'")
    .get();
}

/** A doc body's hash, the key attempts are counted against. */
export function bodyHash(body: string): string {
  return Bun.hash(body).toString(16);
}

/** The state for the doc's current body (a different body reads as fresh). */
export function getVerificationState(db: Database, projectId: string, slug: string, body: string): VerificationState {
  if (!hasTable(db)) return { attempts: 0 };
  const row = db
    .query("SELECT body_hash, attempts, repo_path, last_outcome FROM knowledge_verifications WHERE id = ?")
    .get(`${projectId}/${slug}`) as
    | { body_hash: string; attempts: number; repo_path: string | null; last_outcome: string | null }
    | null;
  if (!row) return { attempts: 0 };
  const sameBody = row.body_hash === bodyHash(body);
  return {
    attempts: sameBody ? row.attempts : 0,
    ...(row.repo_path ? { repoPath: row.repo_path } : {}),
    ...(sameBody && row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
  };
}

/** Remembers the checkout a doc was written against, without counting an attempt. */
export function recordVerificationRepo(db: Database, projectId: string, slug: string, body: string, repoPath: string): void {
  if (!hasTable(db)) return;
  const prior = getVerificationState(db, projectId, slug, body);
  db.run(
    `INSERT OR REPLACE INTO knowledge_verifications (id, project_id, slug, body_hash, attempts, repo_path, last_outcome, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`${projectId}/${slug}`, projectId, slug, bodyHash(body), prior.attempts, repoPath, prior.lastOutcome ?? null, new Date().toISOString()]
  );
}

/** Counts one completed attempt on the doc's current body, with its outcome. */
export function recordVerificationAttempt(
  db: Database,
  projectId: string,
  slug: string,
  body: string,
  outcome: string,
  repoPath?: string
): void {
  if (!hasTable(db)) return;
  const prior = getVerificationState(db, projectId, slug, body);
  db.run(
    `INSERT OR REPLACE INTO knowledge_verifications (id, project_id, slug, body_hash, attempts, repo_path, last_outcome, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${projectId}/${slug}`,
      projectId,
      slug,
      bodyHash(body),
      prior.attempts + 1,
      repoPath ?? prior.repoPath ?? null,
      outcome,
      new Date().toISOString(),
    ]
  );
}
