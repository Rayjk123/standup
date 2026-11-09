/**
 * 006-unverified-confidence — drops agent docs that were auto-published at full
 * confidence, with nothing ever having checked them, to the unverified
 * starting confidence.
 *
 * The propose route used to publish every agent proposal at confidence 1 with
 * last_verified_at stamped at publish time, so an unchecked claim read exactly
 * like a verified one to ranking, injection and the contradiction resolver's
 * autonomy gate. A doc qualifies when it is `origin_class: agent`, holds
 * confidence 1, carries no `clean` verdict, and its last_verified_at is unset or
 * within two minutes of its generated_at (the publish-time stamp, not a later
 * re-verification). It becomes confidence UNVERIFIED_CONFIDENCE with
 * last_verified_at removed — the state a fresh proposal is published in now, out
 * of which only a passing fact-check lifts it.
 *
 * Needs a knowledge dir: each file is judged on its own front matter (and its
 * row's verdict — a retired, superseded doc is left to its retirement), its
 * `confidence` / `last_verified_at` lines are spliced, and the rows of exactly
 * those files are updated to match. Without one it changes nothing — the next
 * sync would rewrite the row from the unchanged file.
 */

import type { Database } from "bun:sqlite";
import { spliceFrontmatter } from "@standup/knowledge";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";
import { fmValue, listDocFiles, readDocText, writeDocText, type DocFileRef } from "./markdown.ts";

export const ID = "006-unverified-confidence";

/** The confidence an unverified agent doc is published at (draft-verify.ts's
 *  UNVERIFIED_CONFIDENCE, restated so this script does not load the collector's
 *  spawn helpers). */
export const UNVERIFIED_CONFIDENCE = 0.6;

/** A last_verified_at this close to generated_at is the publish-time stamp. */
const PUBLISH_STAMP_WINDOW_MS = 120_000;

function timeOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Whether a last_verified_at is no evidence of a verification. */
function unverifiedStamp(lastVerifiedAt: unknown, generatedAt: unknown): boolean {
  const verified = timeOf(lastVerifiedAt);
  const generated = timeOf(generatedAt);
  if (verified === null || generated === null) return true;
  return Math.abs(verified - generated) < PUBLISH_STAMP_WINDOW_MS;
}

interface Row {
  id: string;
  project_id: string;
  slug: string;
  verdict: string | null;
  last_verified_at: string | null;
  generated_at: string | null;
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const changes: Change[] = [];
  const filePatches: Array<{ ref: DocFileRef; raw: string }> = [];
  // The file is the source of truth for confidence: the next sync rewrites the
  // row from it, and the publish fact-check decides "pending" from it. So this
  // changes nothing without the files, and the rows it changes are exactly the
  // files it patches.
  if (!options.knowledgeDir) {
    return {
      counts: { downgraded: 0 },
      changes,
      files: [],
      notes: [`${ID} needs --knowledge-dir: confidence lives in the doc files, and a DB-only change would be reverted by the next sync`],
      async applyFiles() {},
      applyDb() {},
    };
  }
  {
    const verdictOf = db.query("SELECT verdict FROM knowledge WHERE project_id = ? AND slug = ?");
    for (const ref of await listDocFiles(options.knowledgeDir)) {
      const file = await readDocText(options.knowledgeDir, ref);
      if (!file || file.data.origin_class !== "agent" || file.data.confidence !== 1) continue;
      if (!unverifiedStamp(file.data.last_verified_at, file.data.generated_at)) continue;
      const row = verdictOf.get(ref.projectId, ref.slug) as { verdict: string | null } | null;
      // A clean verdict is a verification; a retired doc's confidence belongs to
      // its retirement (004/005), which may already have spliced it this run.
      if (row?.verdict === "clean" || row?.verdict === "superseded") continue;
      filePatches.push({
        ref,
        raw: spliceFrontmatter(file.raw, { confidence: UNVERIFIED_CONFIDENCE, last_verified_at: null }),
      });
      const docRef = `${ref.projectId}/${ref.slug}`;
      changes.push({ ref: docRef, target: "file", field: "confidence", action: "set", before: "1", after: String(UNVERIFIED_CONFIDENCE) });
      if (file.data.last_verified_at !== undefined) {
        changes.push({
          ref: docRef,
          target: "file",
          field: "last_verified_at",
          action: "set",
          before: fmValue(file.data.last_verified_at instanceof Date ? file.data.last_verified_at.toISOString() : file.data.last_verified_at),
          after: null,
        });
      }
    }
  }

  const patched = new Set(filePatches.map((p) => `${p.ref.projectId}/${p.ref.slug}`));
  const rows = (
    db
      .query(
        `SELECT id, project_id, slug, verdict, confidence, last_verified_at, generated_at FROM knowledge
          ORDER BY project_id, slug`
      )
      .all() as Array<Row & { confidence: number | null }>
  ).filter(
    (r) =>
      patched.has(`${r.project_id}/${r.slug}`) &&
      (r.confidence !== UNVERIFIED_CONFIDENCE || r.last_verified_at !== null)
  );
  for (const r of rows) {
    const ref = `${r.project_id}/${r.slug}`;
    if (r.confidence !== UNVERIFIED_CONFIDENCE) {
      changes.push({
        ref,
        target: "db",
        field: "confidence",
        action: "set",
        before: r.confidence === null ? null : String(r.confidence),
        after: String(UNVERIFIED_CONFIDENCE),
      });
    }
    if (r.last_verified_at !== null) changes.push({ ref, target: "db", field: "last_verified_at", action: "rewrite" });
  }

  return {
    counts: { downgraded: filePatches.length, rows: rows.length },
    changes,
    files: filePatches.map((p) => p.ref.rel),
    notes: [],
    async applyFiles() {
      for (const { ref, raw } of filePatches) await writeDocText(options.knowledgeDir!, ref, raw);
    },
    applyDb() {
      db.transaction(() => {
        for (const r of rows) {
          db.run("UPDATE knowledge SET confidence = ?, last_verified_at = NULL WHERE id = ?", [UNVERIFIED_CONFIDENCE, r.id]);
        }
      })();
    },
  };
}

export const migration: KbMigration = {
  id: ID,
  description: "Drop unchecked auto-published agent docs from full to unverified confidence",
  plan,
};
