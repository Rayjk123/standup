/**
 * 003-demote-scratch-globals — OPT-IN. Demotes agent-written scope=global docs
 * homed in the scratch project to scope=project.
 *
 * Scratch is where a session lands when no project matched, so an agent's
 * "global" doc from there is unanchored work that reaches every project's
 * search and launch injection with no project to own or correct it (the propose route
 * now refuses such a write). Docs already in that state stay global until an
 * owner decides; this migration is that decision, so it never runs unless named
 * (`--only 003-demote-scratch-globals`). Demoted docs stay in scratch, findable
 * by browsing, and a human can re-promote any of them.
 *
 * With a knowledge dir the files decide which docs qualify (`scope: global`,
 * `origin_class: agent`, homed in scratch) and their `scope` line is spliced
 * first; the rows and their vec mirror rows are re-scoped in one transaction.
 */

import type { Database } from "bun:sqlite";
import { spliceFrontmatter } from "@standup/knowledge";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";
import { listDocFiles, readDocText, writeDocText, type DocFileRef } from "./markdown.ts";
import { applyVecRefresh, planVecRefresh, type VecEdit } from "./db-edits.ts";

export const SCRATCH_PROJECT_ID = "scratch";

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const changes: Change[] = [];
  const filePatches: Array<{ ref: DocFileRef; raw: string }> = [];
  if (options.knowledgeDir) {
    for (const ref of await listDocFiles(options.knowledgeDir)) {
      if (ref.projectId !== SCRATCH_PROJECT_ID) continue;
      const file = await readDocText(options.knowledgeDir, ref);
      if (!file || file.data.scope !== "global" || file.data.origin_class !== "agent") continue;
      filePatches.push({ ref, raw: spliceFrontmatter(file.raw, { scope: "project" }) });
      changes.push({ ref: `${ref.projectId}/${ref.slug}`, target: "file", field: "scope", action: "set", before: "global", after: "project" });
    }
  }
  const rows = db
    .query(
      "SELECT id, project_id, slug, owner_user, source_kind FROM knowledge WHERE project_id = ? AND scope = 'global' AND origin_class = 'agent' ORDER BY slug"
    )
    .all(SCRATCH_PROJECT_ID) as Array<{ id: string; project_id: string; slug: string; owner_user: string | null; source_kind: string }>;
  const vecEdits: VecEdit[] = [];
  for (const r of rows) {
    const docRef = `${r.project_id}/${r.slug}`;
    changes.push({ ref: docRef, target: "db", field: "scope", action: "set", before: "global", after: "project" });
    vecEdits.push(
      ...planVecRefresh(db, r.id, docRef, { project_id: r.project_id, scope: "project", owner_user: r.owner_user, source_kind: r.source_kind }, changes)
    );
  }

  return {
    counts: { demoted: rows.length, ...(options.knowledgeDir ? { filesPatched: filePatches.length } : {}) },
    changes,
    files: filePatches.map((p) => p.ref.rel),
    notes: [],
    async applyFiles() {
      const dir = options.knowledgeDir;
      if (!dir) return;
      for (const { ref, raw } of filePatches) await writeDocText(dir, ref, raw);
    },
    applyDb() {
      db.transaction(() => {
        for (const r of rows) db.run("UPDATE knowledge SET scope = 'project' WHERE id = ?", [r.id]);
        applyVecRefresh(db, vecEdits);
      })();
    },
  };
}

export const migration: KbMigration = {
  id: "003-demote-scratch-globals",
  description: "Opt-in: demote agent-written scope=global docs homed in scratch to scope=project",
  optIn: true,
  plan,
};
