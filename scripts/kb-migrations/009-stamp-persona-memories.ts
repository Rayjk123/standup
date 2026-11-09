/**
 * 009-stamp-persona-memories — OPT-IN. Records the host user's existing
 * Persona memories as Persona's own writes.
 *
 * The owner profile and worker briefs trust a `persona-…` doc as one of the
 * owner's memories only when its `writer_stamp` says Persona wrote it as it
 * stands (the collector's persona/memory-trust.ts). Memories saved before the
 * column existed carry no stamp, so they are left out until Persona saves them
 * again. This migration stamps the ones that look as Persona's writes looked —
 * a `persona-…` slug, scope=user owned by the host user, the `persona` tag,
 * agent origin, no source session, not a native-memory mirror — which is an
 * owner decision, since none of that proves who wrote them: review the dry
 * run's list and apply only with `--only 009-stamp-persona-memories`.
 *
 * DB-only: the stamp is a DB column with no file counterpart.
 */

import type { Database } from "bun:sqlite";
import { WRITER_STAMP_COLUMNS, writerStampFor, type WriterStampRow } from "@standup/knowledge";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";

/** The writer name the collector stamps Persona's own knowledge writes with (persona/memory-trust.ts). */
export const PERSONA_WRITER = "persona";

type Row = WriterStampRow & { id: string; writer_stamp: string | null };

function hasPersonaTag(tagsJson: string | null): boolean {
  if (!tagsJson) return false;
  try {
    const tags = JSON.parse(tagsJson);
    return Array.isArray(tags) && tags.some((t) => typeof t === "string" && t.trim().toLowerCase() === "persona");
  } catch {
    return false;
  }
}

/** Why `r` is not consistent with one of Persona's own writes, or null when it is. */
function refusal(r: Row): string | null {
  if (r.origin_class !== "agent") return `origin_class is ${r.origin_class ?? "unset"}, not agent`;
  if (r.source_session_id) return "written from a session";
  if (r.source_kind === "native-memory") return "a native-memory mirror";
  if (!hasPersonaTag(r.tags_json)) return "no persona tag";
  return null;
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const columns = new Set((db.query("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>).map((c) => c.name));
  const candidates = columns.has("writer_stamp")
    ? (db
        .query(
          `SELECT id, ${WRITER_STAMP_COLUMNS} FROM knowledge
            WHERE slug LIKE 'persona-%' AND scope = 'user' AND owner_user = ? AND writer_stamp IS NULL
            ORDER BY project_id, slug`
        )
        .all(options.hostUser) as Row[])
    : [];
  const rows = candidates.filter((r) => refusal(r) === null);
  const stamps = rows.map((r) => ({ id: r.id, stamp: writerStampFor(PERSONA_WRITER, r) }));
  const changes: Change[] = rows.map((r, i) => ({
    ref: `${r.project_id}/${r.slug}`,
    target: "db",
    field: "writer_stamp",
    action: "set",
    before: null,
    after: stamps[i]!.stamp,
  }));
  // Every candidate with its provenance, so the owner reviews exactly what is
  // stamped and what is refused.
  const notes = candidates.map((r) => {
    const why = refusal(r);
    const provenance = `origin_class=${r.origin_class ?? "unset"} source_session_id=${r.source_session_id ?? "none"}`;
    return `${r.project_id}/${r.slug} ${provenance}: ${why ? `refused (${why})` : "stamp"}`;
  });
  return {
    counts: { stamped: rows.length, refused: candidates.length - rows.length },
    changes,
    files: [],
    notes,
    async applyFiles() {},
    applyDb() {
      db.transaction(() => {
        for (const { id, stamp } of stamps) db.run("UPDATE knowledge SET writer_stamp = ? WHERE id = ?", [stamp, id]);
      })();
    },
  };
}

export const migration: KbMigration = {
  id: "009-stamp-persona-memories",
  description: "Opt-in: stamp the host user's existing Persona memories as Persona's writes",
  optIn: true,
  plan,
};
