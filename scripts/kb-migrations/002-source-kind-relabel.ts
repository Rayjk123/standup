/**
 * 002-source-kind-relabel — stops plan docs and unlabeled docs from reading as
 * code facts.
 *
 *  1. Docs the project-docs ingest mirrored from a repo's `plan/` dir become
 *     `source_kind: spec`; their files also gain `origin_class: owner` when
 *     unasserted (the class the loader already reads them as), the stamps that
 *     ingest now writes.
 *  2. Docs whose markdown asserts no `source_kind` and whose row was defaulted
 *     to `code` become `unclassified`, the default the loader now applies.
 *
 * Signals, by mode:
 *  - With a knowledge dir, each file decides: an `ingested_from` marker is (1);
 *    a file with no `source_kind` key is (2). (1) splices the file's
 *    `source_kind` / `origin_class` lines as well as updating the row (and its
 *    vec mirror rows), since the sync reconciles the column from the file; (2) needs no file change — the loader already reads an unasserted
 *    kind as `unclassified`, so the row now matches what the next sync writes.
 *  - DB-only, the row holds neither the marker nor the file's front matter (the
 *    loader drops both), so (2) has no signal and is left alone. (1) needs proof
 *    the row IS a plan file's mirror, not a hand-written doc that happens to
 *    share a basename and the legacy stamps (`code`, `owner`, no session, no
 *    generated sha): for a project given a plan dir (`planDirs`), the row's body
 *    must equal the body the ingest renders from the plan file of that basename
 *    — its front matter stripped, raw or redacted. A plan file edited since it
 *    was ingested no longer matches and its row is left for the next ingest.
 */

import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { redactOptionsFor, redactSecrets, spliceFrontmatter } from "@standup/knowledge";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";
import { fmValue, listDocFiles, readDocText, writeDocText, type DocFileRef } from "./markdown.ts";
import { applyVecRefresh, planVecRefresh, type VecEdit } from "./db-edits.ts";

interface Row {
  id: string;
  project_id: string;
  slug: string;
  body: string;
  scope: string | null;
  owner_user: string | null;
  source_kind: string;
  origin_class: string;
  source_session_id: string | null;
  generated_from_sha: string | null;
}

/** basename (no `.md`) → path of every markdown file under `dir`, recursively; first seen wins. */
function markdownFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile() && e.name.endsWith(".md") && !out.has(basename(e.name, ".md"))) {
        out.set(basename(e.name, ".md"), join(d, e.name));
      }
    }
  };
  walk(dir);
  return out;
}

const stripFrontmatter = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/** Whether `row` holds the body the project-docs ingest renders from `source`. */
function mirrorsPlanFile(row: Row, source: string): boolean {
  const raw = stripFrontmatter(source);
  const redacted = redactSecrets(raw, redactOptionsFor({ projectId: row.project_id, slug: row.slug, sourceKind: "spec" }));
  const body = row.body.trim();
  return body === raw.trim() || body === redacted.trim();
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const rows = db
    .query(
      "SELECT id, project_id, slug, body, scope, owner_user, source_kind, origin_class, source_session_id, generated_from_sha FROM knowledge ORDER BY project_id, slug"
    )
    .all() as Row[];
  const byRef = new Map(rows.map((r) => [`${r.project_id}/${r.slug}`, r]));

  const toSpec: Row[] = [];
  const toUnclassified: Row[] = [];
  const filePatches: Array<{ ref: DocFileRef; raw: string }> = [];
  const changes: Change[] = [];
  const notes: string[] = [];

  if (options.knowledgeDir) {
    for (const ref of await listDocFiles(options.knowledgeDir)) {
      const file = await readDocText(options.knowledgeDir, ref);
      if (!file) continue;
      const fm = file.data;
      const docRef = `${ref.projectId}/${ref.slug}`;
      const row = byRef.get(docRef);
      if (fm.ingested_from != null) {
        const patch: Record<string, string> = {};
        if (fm.source_kind !== "spec") patch.source_kind = "spec";
        if (fm.origin_class == null) patch.origin_class = "owner";
        if (Object.keys(patch).length > 0) {
          filePatches.push({ ref, raw: spliceFrontmatter(file.raw, patch) });
          for (const [field, after] of Object.entries(patch)) {
            changes.push({ ref: docRef, target: "file", field, action: "set", before: fmValue(fm[field]), after: String(after) });
          }
        }
        if (row && row.source_kind !== "spec") toSpec.push(row);
      } else if (fm.source_kind == null && row?.source_kind === "code") {
        toUnclassified.push(row);
      }
    }
  } else {
    const legacyIngestStamps = (r: Row) =>
      r.source_kind === "code" && r.origin_class === "owner" && !r.source_session_id && !r.generated_from_sha;
    let unmatched = 0;
    for (const [projectId, dir] of options.planDirs ?? new Map<string, string>()) {
      const sources = markdownFiles(dir);
      for (const r of rows) {
        const sourcePath = r.project_id === projectId ? sources.get(r.slug) : undefined;
        if (!sourcePath || !legacyIngestStamps(r)) continue;
        if (mirrorsPlanFile(r, readFileSync(sourcePath, "utf-8"))) toSpec.push(r);
        else unmatched++;
      }
    }
    notes.push("DB-only: unclassified relabel needs the markdown front matter and was skipped");
    if (unmatched > 0) notes.push(`DB-only: ${unmatched} row(s) share a plan file's name but not its content; left alone`);
  }

  const vecEdits: VecEdit[] = [];
  for (const [rows, kind] of [
    [toSpec, "spec"],
    [toUnclassified, "unclassified"],
  ] as const) {
    for (const r of rows) {
      const docRef = `${r.project_id}/${r.slug}`;
      changes.push({ ref: docRef, target: "db", field: "source_kind", action: "set", before: r.source_kind, after: kind });
      vecEdits.push(
        ...planVecRefresh(db, r.id, docRef, { project_id: r.project_id, scope: r.scope, owner_user: r.owner_user, source_kind: kind }, changes)
      );
    }
  }

  const counts: Record<string, number> = {
    toSpec: toSpec.length,
    toUnclassified: toUnclassified.length,
    ...(options.knowledgeDir ? { specFilesPatched: filePatches.length } : {}),
  };

  return {
    counts,
    changes,
    files: filePatches.map((p) => p.ref.rel),
    notes,
    async applyFiles() {
      const dir = options.knowledgeDir;
      if (!dir) return;
      for (const { ref, raw } of filePatches) await writeDocText(dir, ref, raw);
    },
    applyDb() {
      db.transaction(() => {
        for (const r of toSpec) db.run("UPDATE knowledge SET source_kind = 'spec' WHERE id = ?", [r.id]);
        for (const r of toUnclassified) db.run("UPDATE knowledge SET source_kind = 'unclassified' WHERE id = ?", [r.id]);
        applyVecRefresh(db, vecEdits);
      })();
    },
  };
}

export const migration: KbMigration = {
  id: "002-source-kind-relabel",
  description: "Relabel ingested plan docs as spec and docs with no front-matter kind from code to unclassified",
  plan,
};
