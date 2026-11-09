import type { Database } from "bun:sqlite";
import { createHash } from "crypto";

/**
 * The contradiction judge's outcome ledger (`knowledge_judgments`, created by
 * KnowledgeStore). A judged pair keeps its latest outcome; a judge that could
 * not answer is recorded as `judge_error` so it is counted and retried rather
 * than read as "no contradiction". A `queued` row marks a doc whose verdict
 * must be re-judged.
 */

/**
 * A pair's outcome. The judge answers one of four relations: `contradicts`
 * (both cannot be true), `supersedes` (the newer doc updates the older — a
 * timeline, not a conflict), `complementary` (different facets of one subject)
 * or `consistent`. Only `contradicts` becomes a contradiction edge.
 */
export type JudgmentOutcome =
  | "contradicts"
  | "supersedes"
  | "complementary"
  | "consistent"
  | "judge_error"
  | "queued";

/** The outcomes that are a judge's answer (as opposed to an error or a queue marker). */
export const ANSWERED_OUTCOMES: readonly JudgmentOutcome[] = ["contradicts", "supersedes", "complementary", "consistent"];

const OUTCOME_CHECK = `CHECK (outcome IN (${[...ANSWERED_OUTCOMES, "judge_error", "queued"].map((o) => `'${o}'`).join(", ")}))`;

/** Databases whose judgment schema is already current this process. */
const schemaReady = new WeakSet<Database>();

function hasKnowledgeTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Brings the judgment schema up to date, idempotently:
 *
 * - widens `knowledge_judgments`' outcome CHECK to every JudgmentOutcome
 *   (rebuilding the table, rows and index kept, when it predates `supersedes`);
 * - creates `knowledge_verdict_history`, one row per change of an accepted
 *   doc's verdict, filled by a trigger on `knowledge` so every writer is
 *   covered. verdictFlipRate reads it.
 *
 * A no-op for a database without the knowledge tables.
 */
export function ensureJudgmentSchema(db: Database): void {
  if (schemaReady.has(db)) return;
  const hasJudgments = hasKnowledgeTable(db, "knowledge_judgments");
  const hasDocs = hasKnowledgeTable(db, "knowledge");
  if (hasJudgments) {
    const row = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_judgments'")
      .get() as { sql: string } | null;
    if (row && !row.sql.includes("'supersedes'")) {
      db.transaction(() => {
        db.run(`CREATE TABLE knowledge_judgments_widened (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          subject_slug TEXT NOT NULL,
          candidate_project_id TEXT,
          candidate_slug TEXT,
          outcome TEXT NOT NULL ${OUTCOME_CHECK},
          method TEXT,
          reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 1,
          judged_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.run(`INSERT INTO knowledge_judgments_widened
                  (id, project_id, subject_slug, candidate_project_id, candidate_slug, outcome, method, reason, attempts, judged_at)
                SELECT id, project_id, subject_slug, candidate_project_id, candidate_slug, outcome, method, reason, attempts, judged_at
                  FROM knowledge_judgments`);
        db.run("DROP TABLE knowledge_judgments");
        db.run("ALTER TABLE knowledge_judgments_widened RENAME TO knowledge_judgments");
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_knowledge_judgments_subject ON knowledge_judgments(project_id, subject_slug)"
        );
      })();
    }
  }
  if (hasDocs) {
    db.run(`CREATE TABLE IF NOT EXISTS knowledge_verdict_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      old_verdict TEXT,
      new_verdict TEXT,
      changed_at TEXT NOT NULL
    )`);
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_knowledge_verdict_history_at ON knowledge_verdict_history(changed_at)"
    );
    db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_verdict_history_log
      AFTER UPDATE OF verdict ON knowledge
      WHEN OLD.verdict IS NOT NEW.verdict
      BEGIN
        INSERT INTO knowledge_verdict_history (project_id, slug, old_verdict, new_verdict, changed_at)
        VALUES (NEW.project_id, NEW.slug, OLD.verdict, NEW.verdict, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      END`);
  }
  // Re-checked on a later call until both tables exist.
  if (hasJudgments && hasDocs) schemaReady.add(db);
}

/** Verdicts that mean "not checked yet": leaving one is a check landing, not a flip. */
const UNCHECKED = new Set(["unverified", "unverifiable"]);

export interface VerdictFlipRate {
  windowDays: number;
  /** Docs whose verdict changed at least once in the window. */
  changedDocs: number;
  /** Of those, docs whose verdict changed more than once. */
  flippedDocs: number;
  /** flippedDocs / changedDocs, 0 when nothing changed. */
  flipRate: number;
}

/**
 * The verdict flip rate over the last `windowDays`: the share of docs whose
 * verdict changed more than once, among the docs whose verdict changed at all.
 * A change is one checked verdict replaced by a different one. Neither a clear
 * (verdict set to NULL, e.g. a human edit) nor a doc's first check landing
 * (from no verdict, `unverified` or `unverifiable`) is a change, so
 * unverified → clean is none, disputed → (edit) → disputed is none, and
 * disputed → clean → disputed is two. A stable fact-check keeps this near 0; a
 * noisy one flips docs back and forth between runs.
 */
export function verdictFlipRate(
  db: Database,
  options: { windowDays?: number; projectId?: string; now?: Date } = {}
): VerdictFlipRate {
  const windowDays = options.windowDays ?? 30;
  const empty: VerdictFlipRate = { windowDays, changedDocs: 0, flippedDocs: 0, flipRate: 0 };
  if (!hasKnowledgeTable(db, "knowledge_verdict_history")) return empty;
  const since = new Date((options.now ?? new Date()).getTime() - windowDays * 86_400_000).toISOString();
  const rows = db
    .query(
      `SELECT project_id, slug, old_verdict, new_verdict FROM knowledge_verdict_history
        WHERE changed_at >= ?${options.projectId ? " AND project_id = ?" : ""}
        ORDER BY id`
    )
    .all(...(options.projectId ? [since, options.projectId] : [since])) as Array<{
    project_id: string;
    slug: string;
    old_verdict: string | null;
    new_verdict: string | null;
  }>;
  const perDoc = new Map<string, { last: string | null; changes: number }>();
  for (const r of rows) {
    const key = `${r.project_id}/${r.slug}`;
    const doc = perDoc.get(key) ?? { last: r.old_verdict, changes: 0 };
    if (r.new_verdict !== null) {
      if (doc.last !== null && !UNCHECKED.has(doc.last) && doc.last !== r.new_verdict) doc.changes++;
      doc.last = r.new_verdict;
    }
    perDoc.set(key, doc);
  }
  let changedDocs = 0;
  let flippedDocs = 0;
  for (const doc of perDoc.values()) {
    if (doc.changes >= 1) changedDocs++;
    if (doc.changes > 1) flippedDocs++;
  }
  return { windowDays, changedDocs, flippedDocs, flipRate: changedDocs === 0 ? 0 : flippedDocs / changedDocs };
}

export interface JudgmentRecord {
  projectId: string;
  subjectSlug: string;
  candidateProjectId?: string;
  candidateSlug?: string;
  outcome: JudgmentOutcome;
  /** How it was decided: `llm` (the model judge) or `git` (checked against the repo). */
  method?: string;
  reason?: string;
  attempts?: number;
}

/** The row id of a judged pair (order-independent) or a doc's re-judge marker. */
export function judgmentId(
  projectId: string,
  subjectSlug: string,
  candidateProjectId?: string,
  candidateSlug?: string
): string {
  if (!candidateSlug) return `queued:${projectId}/${subjectSlug}`;
  const pair = [`${projectId}/${subjectSlug}`, `${candidateProjectId ?? projectId}/${candidateSlug}`]
    .sort()
    .join(" ");
  return createHash("sha1").update(pair).digest("hex");
}

function hasTable(db: Database): boolean {
  return !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_judgments'")
    .get();
}

/** Records a pair's outcome, replacing its previous one. A successful judgment
 *  also settles the subject's re-judge marker (see settleRejudge). */
export function recordJudgment(db: Database, r: JudgmentRecord): void {
  if (!hasTable(db)) return;
  ensureJudgmentSchema(db);
  db.run(
    `INSERT OR REPLACE INTO knowledge_judgments
       (id, project_id, subject_slug, candidate_project_id, candidate_slug, outcome, method, reason, attempts, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      judgmentId(r.projectId, r.subjectSlug, r.candidateProjectId, r.candidateSlug),
      r.projectId,
      r.subjectSlug,
      r.candidateSlug ? (r.candidateProjectId ?? r.projectId) : null,
      r.candidateSlug ?? null,
      r.outcome,
      r.method ?? null,
      r.reason ?? null,
      r.attempts ?? 1,
      new Date().toISOString(),
    ]
  );
  if (ANSWERED_OUTCOMES.includes(r.outcome)) {
    settleRejudge(db, r.projectId, r.subjectSlug);
  }
}

/** A pair's latest recorded outcome, or null when it was never judged. */
export function pairJudgment(
  db: Database,
  projectId: string,
  slug: string,
  otherProjectId: string,
  otherSlug: string
): JudgmentOutcome | null {
  if (!hasTable(db)) return null;
  const row = db
    .query("SELECT outcome FROM knowledge_judgments WHERE id = ?")
    .get(judgmentId(projectId, slug, otherProjectId, otherSlug)) as { outcome: JudgmentOutcome } | null;
  return row?.outcome ?? null;
}

/** Clears a doc's re-judge marker once none of its pairs is left at judge_error. */
export function settleRejudge(db: Database, projectId: string, slug: string): void {
  if (!hasTable(db)) return;
  const unjudged = db
    .query(
      "SELECT 1 FROM knowledge_judgments WHERE project_id = ? AND subject_slug = ? AND outcome = 'judge_error' LIMIT 1"
    )
    .get(projectId, slug);
  if (!unjudged) dequeueRejudge(db, projectId, slug);
}

/** Marks a doc for re-judging. Idempotent. */
export function queueRejudge(db: Database, projectId: string, slug: string, reason: string): void {
  if (!hasTable(db)) return;
  db.run(
    `INSERT OR IGNORE INTO knowledge_judgments (id, project_id, subject_slug, outcome, reason, attempts, judged_at)
     VALUES (?, ?, ?, 'queued', ?, 0, ?)`,
    [judgmentId(projectId, slug), projectId, slug, reason, new Date().toISOString()]
  );
}

export function dequeueRejudge(db: Database, projectId: string, slug: string): void {
  if (!hasTable(db)) return;
  db.run("DELETE FROM knowledge_judgments WHERE id = ?", [judgmentId(projectId, slug)]);
}

export function isRejudgeQueued(db: Database, projectId: string, slug: string): boolean {
  if (!hasTable(db)) return false;
  return !!db.query("SELECT 1 FROM knowledge_judgments WHERE id = ?").get(judgmentId(projectId, slug));
}

/** Whether any judge ever answered (any ANSWERED_OUTCOMES) for a pair involving the doc. */
export function hasSuccessfulJudgment(db: Database, projectId: string, slug: string): boolean {
  if (!hasTable(db)) return false;
  return !!db
    .query(
      `SELECT 1 FROM knowledge_judgments
        WHERE outcome IN ('contradicts', 'supersedes', 'complementary', 'consistent')
          AND ((project_id = ? AND subject_slug = ?) OR (candidate_project_id = ? AND candidate_slug = ?))
        LIMIT 1`
    )
    .get(projectId, slug, projectId, slug);
}

/** Outcome counts across the ledger, optionally for one project. */
export function judgmentCounts(db: Database, projectId?: string): Record<JudgmentOutcome, number> {
  const counts: Record<JudgmentOutcome, number> = {
    contradicts: 0,
    supersedes: 0,
    complementary: 0,
    consistent: 0,
    judge_error: 0,
    queued: 0,
  };
  if (!hasTable(db)) return counts;
  const rows = (
    projectId === undefined
      ? db.query("SELECT outcome, COUNT(*) AS n FROM knowledge_judgments GROUP BY outcome").all()
      : db
          .query("SELECT outcome, COUNT(*) AS n FROM knowledge_judgments WHERE project_id = ? GROUP BY outcome")
          .all(projectId)
  ) as Array<{ outcome: JudgmentOutcome; n: number }>;
  for (const r of rows) counts[r.outcome] = r.n;
  return counts;
}
