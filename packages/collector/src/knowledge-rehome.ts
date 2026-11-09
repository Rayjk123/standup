import type { Database } from "bun:sqlite";
import { join } from "path";
import {
  KnowledgeStore,
  formatContradictsClaim,
  listKnowledgeFiles,
  moveDocFile,
  parseContradictsClaim,
} from "@standup/knowledge";
import { getProject } from "@standup/store";
import type { KnowledgeSync } from "./knowledge-sync.js";

/**
 * Carrying a session's knowledge along when the session is re-homed out of
 * `scratch`.
 *
 * A session that starts homed in scratch (e.g. from `$HOME`) and is resolved to
 * its real project later may already have published docs; those landed in the
 * scratch corpus, where the project's searches never see them. Once the session
 * moves, the accepted docs it or its subagent children authored
 * (`source_session_id` in the doc's frontmatter) and that are still in scratch
 * move with it. Only scratch is ever a source, and only a registered,
 * non-reserved project is ever a target, so a doc never moves between two real
 * projects.
 *
 * The doc file is moved byte-for-byte, so its scope, owner and provenance are
 * unchanged — a global-scope doc stays global, only its home changes. The
 * scratch and target indexes are then resynced from disk, which is how every
 * other accepted-doc file change reaches search.
 *
 * The doc's trust state is not in the file: its verdict, disputes and
 * verdict checkout, its fact-check attempts, freshness and contradiction
 * judgments live only in the DB, keyed by project and slug, and its graph
 * edges, chunks and FTS row are keyed by its row id. A resync alone would
 * index the moved file as a new, never-checked row — a disputed or
 * contradicted scratch doc would land in the project injectable. So the
 * existing row is re-homed in place (same id, project changed) together with
 * every project-and-slug keyed record, inside one transaction run right after
 * the file move; when that transaction fails the file is moved back, leaving
 * the doc and its state in scratch.
 *
 * No knowledge_changes row is written: its kinds (accepted, removed,
 * reconciled, contradiction, distilled) describe corpus content changes, and a
 * re-home changes none — recording one as `accepted` or `removed` would put a
 * false line in the feed.
 */

const SCRATCH = "scratch";
const GLOBAL = "global";

export interface KnowledgeRehomeResult {
  /** Slugs moved from scratch into the target project. */
  moved: string[];
  /** Slugs left in scratch because the target already has a doc at that slug. */
  collisions: string[];
  /** Slugs left in scratch because their DB state could not be re-homed. */
  failed: string[];
}

/** Tables holding a doc's DB-only state keyed by `(project_id, slug)`. */
const PROJECT_SLUG_TABLES = ["knowledge_freshness", "knowledge_reverify_attempts"] as const;

function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Re-points `Contradicts <target>` disputes so each still names the same doc
 * once `slug` has moved from scratch to `projectId`. A bare target resolves to
 * the source doc's own project first, so: another scratch doc's bare claim on
 * the moved slug, and any explicit `scratch/<slug>` claim, now name
 * `<projectId>/<slug>`; the moved doc's bare claims on a doc still in scratch
 * now name `scratch/<target>`.
 */
function rewriteContradictionTargets(db: Database, movedId: string, slug: string, projectId: string): void {
  const rows = db
    .query("SELECT id, project_id, disputes_json FROM knowledge WHERE disputes_json IS NOT NULL")
    .all() as Array<{ id: string; project_id: string; disputes_json: string }>;
  const scratchSlugs = new Set(
    (db.query("SELECT slug FROM knowledge WHERE project_id = ?").all(SCRATCH) as Array<{ slug: string }>).map(
      (r) => r.slug
    )
  );
  for (const row of rows) {
    let disputes: unknown;
    try {
      disputes = JSON.parse(row.disputes_json);
    } catch {
      continue;
    }
    if (!Array.isArray(disputes)) continue;
    let changed = false;
    const next = disputes.map((d: unknown) => {
      const claim = (d as { claim?: unknown } | null)?.claim;
      if (typeof claim !== "string") return d;
      const target = parseContradictsClaim(claim);
      if (target === null) return d;
      let rewritten: string | null = null;
      if (row.id === movedId) {
        if (!target.includes("/") && scratchSlugs.has(target)) rewritten = `${SCRATCH}/${target}`;
      } else if (target === `${SCRATCH}/${slug}` || (row.project_id === SCRATCH && target === slug)) {
        rewritten = `${projectId}/${slug}`;
      }
      if (rewritten === null) return d;
      changed = true;
      return { ...(d as object), claim: formatContradictsClaim(rewritten) };
    });
    if (changed) db.run("UPDATE knowledge SET disputes_json = ? WHERE id = ?", [JSON.stringify(next), row.id]);
  }
}

/**
 * Moves the DB state of `scratch/<slug>` to `<projectId>/<slug>` in one
 * transaction: the knowledge row keeps its id (so its chunks, FTS row and
 * graph edges stay attached) and its DB-only verdict, disputes, verdict
 * checkout and content clock; the fact-check, freshness, re-verify and
 * judgment records keyed by project and slug follow it. A target row left at
 * the slug with no file behind it (the file move already proved there is
 * none) is dropped first, along with its records, so it cannot shadow the
 * moved doc.
 */
function rehomeDocState(db: Database, knowledgeDir: string, slug: string, projectId: string): void {
  if (!tableExists(db, "knowledge")) return;
  db.transaction(() => {
    const row = db.query("SELECT id FROM knowledge WHERE project_id = ? AND slug = ?").get(SCRATCH, slug) as {
      id: string;
    } | null;
    if (db.query("SELECT 1 FROM knowledge WHERE project_id = ? AND slug = ?").get(projectId, slug)) {
      new KnowledgeStore(db).deleteDoc(projectId, slug);
    }
    if (row) {
      db.run("UPDATE knowledge SET project_id = ?, file_path = ? WHERE id = ?", [
        projectId,
        join(knowledgeDir, projectId, `${slug}.md`),
        row.id,
      ]);
    }
    if (tableExists(db, "knowledge_verifications")) {
      db.run("DELETE FROM knowledge_verifications WHERE id = ?", [`${projectId}/${slug}`]);
      db.run("UPDATE knowledge_verifications SET id = ?, project_id = ? WHERE id = ?", [
        `${projectId}/${slug}`,
        projectId,
        `${SCRATCH}/${slug}`,
      ]);
    }
    for (const table of PROJECT_SLUG_TABLES) {
      if (!tableExists(db, table)) continue;
      db.run(`DELETE FROM ${table} WHERE project_id = ? AND slug = ?`, [projectId, slug]);
      db.run(`UPDATE ${table} SET project_id = ? WHERE project_id = ? AND slug = ?`, [projectId, SCRATCH, slug]);
    }
    if (tableExists(db, "knowledge_judgments")) {
      db.run("DELETE FROM knowledge_judgments WHERE project_id = ? AND subject_slug = ?", [projectId, slug]);
      db.run("UPDATE knowledge_judgments SET project_id = ? WHERE project_id = ? AND subject_slug = ?", [
        projectId,
        SCRATCH,
        slug,
      ]);
      db.run(
        "UPDATE knowledge_judgments SET candidate_project_id = ? WHERE candidate_project_id = ? AND candidate_slug = ?",
        [projectId, SCRATCH, slug]
      );
    }
    if (row) rewriteContradictionTargets(db, row.id, slug, projectId);
  })();
}

/** The given sessions plus every session whose parent is one of them. */
function authoringSessionIds(db: Database, sessionIds: string[]): Set<string> {
  const ids = new Set(sessionIds);
  if (sessionIds.length === 0) return ids;
  const placeholders = sessionIds.map(() => "?").join(", ");
  const children = db
    .query(`SELECT id FROM sessions WHERE parent_session_id IN (${placeholders})`)
    .all(...sessionIds) as Array<{ id: string }>;
  for (const { id } of children) ids.add(id);
  return ids;
}

/**
 * Moves the scratch docs authored by `sessionIds` (or their child sessions)
 * into `projectId`. A no-op for a scratch, global, reserved or unregistered
 * target.
 *
 * A slug that already exists in the target is left in scratch rather than
 * overwriting the target's doc or becoming a review draft over it: the target
 * doc may be a human's or another session's, and a replacing draft would
 * clobber it on accept. Leaving it in scratch loses nothing, and the collision
 * is reported so the caller can log it.
 */
export async function rehomeSessionKnowledge(
  db: Database,
  knowledgeDir: string,
  sessionIds: string[],
  projectId: string,
  knowledgeSync?: KnowledgeSync
): Promise<KnowledgeRehomeResult> {
  const result: KnowledgeRehomeResult = { moved: [], collisions: [], failed: [] };
  if (!knowledgeDir || sessionIds.length === 0) return result;
  if (projectId === SCRATCH || projectId === GLOBAL) return result;
  const target = getProject(db, projectId);
  if (!target || target.reserved) return result;

  const authors = authoringSessionIds(db, sessionIds);
  const docs = await listKnowledgeFiles(knowledgeDir, SCRATCH);
  for (const doc of docs) {
    if (!doc.sourceSessionId || !authors.has(doc.sourceSessionId)) continue;
    const outcome = await moveDocFile(knowledgeDir, SCRATCH, projectId, doc.slug);
    if (outcome === "exists") result.collisions.push(doc.slug);
    if (outcome !== "moved") continue;
    try {
      rehomeDocState(db, knowledgeDir, doc.slug, projectId);
      result.moved.push(doc.slug);
    } catch (err) {
      // The transaction rolled back, so the state is still in scratch; the
      // file goes back with it.
      console.warn(`[knowledge] Re-homing ${doc.slug} into ${projectId} failed, left in scratch:`, err);
      await moveDocFile(knowledgeDir, projectId, SCRATCH, doc.slug);
      result.failed.push(doc.slug);
    }
  }

  if (result.moved.length > 0 && knowledgeSync) {
    await knowledgeSync.syncProject(SCRATCH);
    await knowledgeSync.syncProject(projectId);
  }
  return result;
}
