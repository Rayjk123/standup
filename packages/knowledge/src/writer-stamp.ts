import { createHash } from "crypto";

/**
 * A writer stamp: which trusted in-process writer last wrote a knowledge row,
 * bound to the content it wrote. It lives in the `knowledge.writer_stamp`
 * column only — never in a doc's file, front matter or tags — and only a
 * server-side caller that has established the writer sets it
 * (KnowledgeStore.stampWriter). Every other write leaves the row unstamped:
 * upsertDoc drops a stamp whose content no longer matches what it is writing,
 * so a file edit, a draft publish, an import or a re-sync of changed text all
 * clear it, and a raw rewrite that goes around upsertDoc (a data migration)
 * leaves a stamp that no longer verifies (stampedWriter).
 *
 * Format: `<writer>:<sha256 of the row's content columns>`.
 */

/** The row columns a writer stamp is bound to: everything a reader trusts the writer for. */
export interface WriterStampRow {
  project_id: string;
  slug: string;
  title: string;
  body: string;
  tags_json: string | null;
  scope: string | null;
  owner_user: string | null;
  origin_class: string | null;
  source_kind: string | null;
  source_session_id: string | null;
  generated_at: string | null;
}

/** The columns a writer stamp is bound to, as a SELECT list. */
export const WRITER_STAMP_COLUMNS =
  "project_id, slug, title, body, tags_json, scope, owner_user, origin_class, source_kind, source_session_id, generated_at, writer_stamp";

/** Hex digest of the content a stamp is bound to. */
export function writerStampDigest(row: WriterStampRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.project_id,
        row.slug,
        row.title,
        row.body,
        row.tags_json ?? null,
        row.scope ?? null,
        row.owner_user ?? null,
        row.origin_class ?? null,
        row.source_kind ?? null,
        row.source_session_id ?? null,
        row.generated_at ?? null,
      ])
    )
    .digest("hex");
}

/** The stamp recording that `writer` wrote `row` as it stands. */
export function writerStampFor(writer: string, row: WriterStampRow): string {
  if (!/^[a-z][a-z0-9-]*$/.test(writer)) throw new Error(`invalid writer name: ${writer}`);
  return `${writer}:${writerStampDigest(row)}`;
}

/**
 * The writer that wrote `row` as it now stands, or null when the row carries
 * no stamp or its content changed since it was stamped.
 */
export function stampedWriter(row: WriterStampRow & { writer_stamp?: string | null }): string | null {
  const stamp = row.writer_stamp;
  if (!stamp) return null;
  const at = stamp.indexOf(":");
  if (at <= 0) return null;
  return stamp.slice(at + 1) === writerStampDigest(row) ? stamp.slice(0, at) : null;
}
