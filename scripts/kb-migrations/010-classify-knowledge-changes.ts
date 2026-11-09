/**
 * 010-classify-knowledge-changes — records which existing change-feed rows are
 * about a personal-layer doc, and whose.
 *
 * knowledge_changes rows written before the `personal` / `owner_user` columns
 * existed carry neither. The reader classifies such a row from its doc while
 * the doc is indexed (scope=user, or a home CLAUDE.md / rules mirror), so it is
 * shown only to the doc's owner — but once that doc is deleted nothing marks
 * the row personal and its title becomes visible to everyone. This migration
 * writes the classification onto the rows while the docs still exist: a row
 * whose doc is personal now gets `personal = 1` and, when it records no owner,
 * the doc's owner (a home mirror with no owner stamp belongs to the host user,
 * as the collector's retrieval telemetry reads it). Every other row is left as
 * it is: a row whose doc is gone keeps the reader's slug rule, and a row of a
 * shared doc stays shared.
 *
 * DB-only: the classification is a DB column with no file counterpart.
 */

import type { Database } from "bun:sqlite";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";

interface Row {
  id: string;
  project_id: string;
  slug: string;
  personal: number | null;
  owner_user: string | null;
  doc_scope: string | null;
  doc_source_kind: string | null;
  doc_owner: string | null;
}

/** The home CLAUDE.md / rules mirror slug stem (the knowledge layer rules'). */
const HOME_MIRROR_PREFIX = "native-mem-home-";

function isHomeMirror(r: Row): boolean {
  return r.doc_source_kind === "native-memory" && r.slug.startsWith(HOME_MIRROR_PREFIX);
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const table = (name: string) =>
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  const columns = table("knowledge_changes")
    ? new Set((db.query("PRAGMA table_info(knowledge_changes)").all() as Array<{ name: string }>).map((c) => c.name))
    : new Set<string>();
  const ready = table("knowledge") && columns.has("personal") && columns.has("owner_user");
  const rows = ready
    ? (db
        .query(
          `SELECT kc.id, kc.project_id, kc.slug, kc.personal, kc.owner_user,
                  k.scope AS doc_scope, k.source_kind AS doc_source_kind, k.owner_user AS doc_owner
             FROM knowledge_changes kc
             JOIN knowledge k ON k.project_id = kc.project_id AND k.slug = kc.slug
            ORDER BY kc.project_id, kc.slug, kc.created_at, kc.id`
        )
        .all() as Row[])
    : [];

  const updates: Array<{ id: string; personal: number; owner: string | null }> = [];
  const changes: Change[] = [];
  let unowned = 0;
  for (const r of rows) {
    const home = isHomeMirror(r);
    if (r.doc_scope !== "user" && !home) continue;
    const owner = r.owner_user ?? r.doc_owner ?? (home ? options.hostUser : null);
    if (owner === null) unowned++;
    if (r.personal === 1 && r.owner_user === owner) continue;
    const ref = `${r.project_id}/${r.slug}#change:${r.id}`;
    if (r.personal !== 1) {
      changes.push({
        ref,
        target: "db",
        field: "change.personal",
        action: "set",
        before: r.personal === null ? null : String(r.personal),
        after: "1",
      });
    }
    if (r.owner_user !== owner) {
      changes.push({ ref, target: "db", field: "change.owner_user", action: "set", before: r.owner_user, after: owner });
    }
    updates.push({ id: r.id, personal: 1, owner });
  }

  const notes: string[] = [];
  if (!ready) {
    notes.push(
      table("knowledge_changes")
        ? "knowledge_changes has no personal/owner_user columns or there is no knowledge index; nothing to classify"
        : "no knowledge_changes table"
    );
  }
  if (unowned > 0) {
    notes.push(`${unowned} personal change(s) whose doc records no owner stay visible to nobody`);
  }
  return {
    counts: { classified: updates.length, unowned },
    changes,
    files: [],
    notes,
    async applyFiles() {},
    applyDb() {
      db.transaction(() => {
        for (const u of updates) {
          db.run("UPDATE knowledge_changes SET personal = ?, owner_user = ? WHERE id = ?", [u.personal, u.owner, u.id]);
        }
      })();
    },
  };
}

export const migration: KbMigration = {
  id: "010-classify-knowledge-changes",
  description: "Record which change-feed rows are about a personal-layer doc, and its owner, while the docs exist",
  plan,
};
