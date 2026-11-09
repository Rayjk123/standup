/**
 * 001-personal-layer — moves the home `~/.claude` CLAUDE.md / rules mirrors into
 * the personal layer and scrubs secrets out of stored text.
 *
 *  1. Re-scopes every home mirror homed in the reserved global corpus
 *     (`global/native-mem-home-*`) that is not yet an owned scope=user doc to
 *     scope=user, owned by the host user — the shape the native-memory ingest
 *     now writes.
 *  2. Deletes home-mirror copies homed in any other project
 *     (`<project>/native-mem-home-*`): stale copies from an earlier ingest
 *     routing that nothing refreshes or reclaims. Only a copy that carries the
 *     native-memory marker goes — the file, and its row with every chunk, FTS
 *     and vec row of it — or a row whose file is already gone. A curated copy
 *     (no marker) is kept in both places, and DB-only mode, which cannot see the
 *     marker, deletes nothing.
 *  3. Re-redacts the title and body (and, in the DB, the FTS row and chunk
 *     texts) of every doc with the shared redactor, at the tier the doc's
 *     placement calls for (redactOptionsFor, after step 1) — the stricter of
 *     its row's and its file's placements, on both: the signature tier in
 *     every doc, the full tier (heuristic credential shapes and account ids)
 *     only in the personal layer and global content. A project runbook's
 *     account ids are never touched. Chunk vectors are kept: they are not
 *     invertible to the text.
 *
 * With a knowledge dir, the file work is derived from the files on disk (so a
 * DB-only run, or a crash between phases, never hides it) and written first,
 * as splices of the `scope`/`owner_user`/`title` lines and the body; the DB
 * work is derived from the rows and applied in one transaction, including the
 * vec mirror rows a re-scope moves. A rewritten file's newer mtime makes the
 * next sync re-index and re-embed it.
 */

import type { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import {
  NATIVE_MEMORY_HOME_SLUG_PREFIX,
  applyRedactions,
  findRedactions,
  redactOptionsFor,
  spliceBody,
  stricterRedactOptions,
  type RedactOptions,
  spliceFrontmatter,
} from "@standup/knowledge";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";
import { deleteDocFile, docRel, fmValue, listDocFiles, readDocText, writeDocText } from "./markdown.ts";
import {
  applyDocDelete,
  applyVecRefresh,
  planDocDelete,
  planVecRefresh,
  vecMirrorUnreadable,
  type DocDelete,
  type VecEdit,
} from "./db-edits.ts";

interface Row {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  scope: string;
  owner_user: string | null;
  source_kind: string;
}

const isHomeSlug = (slug: string) => slug.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX);

/** Whether a row is a native-memory mirror of the home `~/.claude` config. */
const isHomeMirror = (r: Row) => r.source_kind === "native-memory" && isHomeSlug(r.slug);

/** Whether a home mirror in the global corpus still needs the personal-layer stamp. */
const needsRescope = (scope: unknown, owner: unknown) => scope !== "user" || typeof owner !== "string" || owner === "";

/** What a stale home-mirror copy's file says about deleting its row. */
type StaleFile = "marked" | "curated" | "absent";

/** A doc's placement for redaction (redactOptionsFor), keyed by `<project>/<slug>`. */
type PlacementOptions = Map<string, RedactOptions>;

async function planFiles(
  knowledgeDir: string,
  options: MigrationOptions,
  changes: Change[],
  files: string[],
  writes: Array<() => Promise<void>>,
  dbPlacements: ReadonlyMap<string, RedactOptions>,
  filePlacements: PlacementOptions
): Promise<Record<string, number>> {
  const counts = { filesRescoped: 0, filesDeleted: 0, filesRedacted: 0, fileRedactions: 0 };
  for (const ref of await listDocFiles(knowledgeDir)) {
    const file = await readDocText(knowledgeDir, ref);
    if (!file) continue;
    const ownMirror = isHomeSlug(ref.slug) && file.data.native_memory_from != null;
    const docRef = `${ref.projectId}/${ref.slug}`;

    if (ownMirror && ref.projectId !== GLOBAL_PROJECT_ID) {
      changes.push({ ref: docRef, target: "file", field: "file", action: "delete" });
      files.push(ref.rel);
      writes.push(() => deleteDocFile(knowledgeDir, ref));
      counts.filesDeleted++;
      continue;
    }

    const patch: Record<string, string> = {};
    let scope = typeof file.data.scope === "string" ? file.data.scope : undefined;
    if (ownMirror && needsRescope(file.data.scope, file.data.owner_user)) {
      changes.push({ ref: docRef, target: "file", field: "scope", action: "set", before: fmValue(file.data.scope), after: "user" });
      changes.push({
        ref: docRef,
        target: "file",
        field: "owner_user",
        action: "set",
        before: fmValue(file.data.owner_user),
        after: options.hostUser,
      });
      patch.scope = "user";
      patch.owner_user = options.hostUser;
      scope = "user";
      counts.filesRescoped++;
    }

    const own = redactOptionsFor({
      projectId: ref.projectId,
      slug: ref.slug,
      scope,
      sourceKind: typeof file.data.source_kind === "string" ? file.data.source_kind : undefined,
    });
    filePlacements.set(docRef, own);
    const opts = stricterRedactOptions(own, dbPlacements.get(docRef) ?? own);
    const bodySpans = findRedactions(file.body, opts);
    if (bodySpans.length > 0) changes.push({ ref: docRef, target: "file", field: "body", action: "redact", spans: bodySpans });
    const title = typeof file.data.title === "string" ? file.data.title : undefined;
    const titleSpans = title !== undefined ? findRedactions(title, opts) : [];
    if (title !== undefined && titleSpans.length > 0) {
      changes.push({ ref: docRef, target: "file", field: "title", action: "redact", spans: titleSpans });
      patch.title = applyRedactions(title, titleSpans);
    }
    const redactions = bodySpans.length + titleSpans.length;
    if (redactions > 0) {
      counts.filesRedacted++;
      counts.fileRedactions += redactions;
    }

    if (Object.keys(patch).length > 0 || bodySpans.length > 0) {
      let raw = Object.keys(patch).length > 0 ? spliceFrontmatter(file.raw, patch) : file.raw;
      if (bodySpans.length > 0) raw = spliceBody(raw, applyRedactions(file.body, bodySpans));
      files.push(ref.rel);
      writes.push(() => writeDocText(knowledgeDir, ref, raw));
    }
  }
  return counts;
}

/** Whether the file behind a stale home-mirror copy carries the marker, is curated, or is gone. */
async function staleFileState(knowledgeDir: string, r: Row): Promise<StaleFile> {
  const file = await readDocText(knowledgeDir, { projectId: r.project_id, slug: r.slug, rel: docRel(r.project_id, r.slug) });
  if (!file) return "absent";
  return file.data.native_memory_from != null ? "marked" : "curated";
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const changes: Change[] = [];
  const files: string[] = [];
  const fileWrites: Array<() => Promise<void>> = [];
  const notes: string[] = [];

  const rows = db
    .query("SELECT id, project_id, slug, title, body, scope, owner_user, source_kind FROM knowledge ORDER BY project_id, slug")
    .all() as Row[];
  // A doc is redacted under the stricter of its row's and its file's
  // placements, on both sides: the sync later rewrites the row from the file,
  // and the file must not keep what its row's placement removes.
  const dbPlacements: PlacementOptions = new Map();
  for (const r of rows) {
    const rescoped = isHomeMirror(r) && r.project_id === GLOBAL_PROJECT_ID && needsRescope(r.scope, r.owner_user);
    const placement = { projectId: r.project_id, slug: r.slug, scope: rescoped ? "user" : r.scope, sourceKind: r.source_kind };
    dbPlacements.set(`${r.project_id}/${r.slug}`, redactOptionsFor(placement));
  }
  const filePlacements: PlacementOptions = new Map();

  const fileCounts = options.knowledgeDir
    ? await planFiles(options.knowledgeDir, options, changes, files, fileWrites, dbPlacements, filePlacements)
    : {};
  if (!options.knowledgeDir) notes.push("DB-only: markdown files were not touched");
  if (vecMirrorUnreadable(db)) notes.push("sqlite-vec is not loadable here: vec mirror rows were not planned or touched");
  const ftsQuery = db.query("SELECT title, body FROM knowledge_fts WHERE id = ?");
  const chunkQuery = db.query("SELECT id, text FROM knowledge_chunks WHERE knowledge_id = ? ORDER BY rowid");

  const rescope: Row[] = [];
  const deletes: DocDelete[] = [];
  const vecEdits: VecEdit[] = [];
  const docEdits: Array<{ id: string; title: string; body: string }> = [];
  const ftsEdits: Array<{ id: string; title: string; body: string }> = [];
  const chunkEdits: Array<{ id: string; text: string }> = [];
  let redactions = 0;
  let chunkRedactions = 0;
  let curatedStale = 0;
  let unconfirmedStale = 0;
  for (const r of rows) {
    const docRef = `${r.project_id}/${r.slug}`;
    const homeMirror = isHomeMirror(r);
    if (homeMirror && r.project_id !== GLOBAL_PROJECT_ID) {
      const state = options.knowledgeDir ? await staleFileState(options.knowledgeDir, r) : null;
      if (state === "marked" || state === "absent") {
        deletes.push(planDocDelete(db, r.id, docRef, changes));
        continue;
      }
      if (state === "curated") curatedStale++;
      else unconfirmedStale++;
    }
    let scope = r.scope;
    let owner = r.owner_user;
    if (homeMirror && r.project_id === GLOBAL_PROJECT_ID && needsRescope(r.scope, r.owner_user)) {
      rescope.push(r);
      changes.push({ ref: docRef, target: "db", field: "scope", action: "set", before: r.scope, after: "user" });
      changes.push({ ref: docRef, target: "db", field: "owner_user", action: "set", before: r.owner_user, after: options.hostUser });
      scope = "user";
      owner = options.hostUser;
      vecEdits.push(
        ...planVecRefresh(db, r.id, docRef, { project_id: r.project_id, scope, owner_user: owner, source_kind: r.source_kind }, changes)
      );
    }
    const own = dbPlacements.get(docRef)!;
    const opts = stricterRedactOptions(own, filePlacements.get(docRef) ?? own);
    const titleSpans = findRedactions(r.title, opts);
    const bodySpans = findRedactions(r.body, opts);
    if (titleSpans.length > 0) changes.push({ ref: docRef, target: "db", field: "title", action: "redact", spans: titleSpans });
    if (bodySpans.length > 0) changes.push({ ref: docRef, target: "db", field: "body", action: "redact", spans: bodySpans });
    if (titleSpans.length + bodySpans.length > 0) {
      docEdits.push({ id: r.id, title: applyRedactions(r.title, titleSpans), body: applyRedactions(r.body, bodySpans) });
      redactions += titleSpans.length + bodySpans.length;
    }
    for (const fts of ftsQuery.all(r.id) as Array<{ title: string; body: string }>) {
      const ftsTitle = findRedactions(fts.title, opts);
      const ftsBody = findRedactions(fts.body, opts);
      if (ftsTitle.length > 0) changes.push({ ref: docRef, target: "db", field: "fts.title", action: "redact", spans: ftsTitle });
      if (ftsBody.length > 0) changes.push({ ref: docRef, target: "db", field: "fts.body", action: "redact", spans: ftsBody });
      if (ftsTitle.length + ftsBody.length > 0) {
        ftsEdits.push({ id: r.id, title: applyRedactions(fts.title, ftsTitle), body: applyRedactions(fts.body, ftsBody) });
      }
    }
    for (const c of chunkQuery.all(r.id) as Array<{ id: string; text: string }>) {
      const spans = findRedactions(c.text, opts);
      if (spans.length === 0) continue;
      changes.push({ ref: `${docRef}#${c.id}`, target: "db", field: "chunk.text", action: "redact", spans });
      chunkEdits.push({ id: c.id, text: applyRedactions(c.text, spans) });
      chunkRedactions += spans.length;
    }
  }
  if (curatedStale > 0) notes.push(`${curatedStale} home-mirror copy(ies) outside global carry no ingest marker (curated); kept`);
  if (unconfirmedStale > 0) {
    notes.push(`DB-only: ${unconfirmedStale} home-mirror copy(ies) outside global kept — deleting one needs its file's ingest marker`);
  }

  const counts: Record<string, number> = {
    rescoped: rescope.length,
    staleDeleted: deletes.length,
    redactedDocs: docEdits.length,
    redactions,
    redactedChunks: chunkEdits.length,
    chunkRedactions,
    ...fileCounts,
  };

  return {
    counts,
    changes,
    files,
    notes,
    async applyFiles() {
      for (const write of fileWrites) await write();
    },
    applyDb() {
      db.transaction(() => {
        for (const r of rescope) {
          db.run("UPDATE knowledge SET scope = 'user', owner_user = ? WHERE id = ?", [options.hostUser, r.id]);
        }
        for (const e of docEdits) db.run("UPDATE knowledge SET title = ?, body = ? WHERE id = ?", [e.title, e.body, e.id]);
        for (const e of ftsEdits) db.run("UPDATE knowledge_fts SET title = ?, body = ? WHERE id = ?", [e.title, e.body, e.id]);
        for (const e of chunkEdits) db.run("UPDATE knowledge_chunks SET text = ? WHERE id = ?", [e.text, e.id]);
        applyVecRefresh(db, vecEdits);
        for (const d of deletes) applyDocDelete(db, d);
      })();
    },
  };
}

export const migration: KbMigration = {
  id: "001-personal-layer",
  description:
    "Re-scope home CLAUDE.md/rules mirrors to scope=user for the host user, delete stale home-mirror copies " +
    "outside global, redact secrets everywhere and account ids in personal/global docs",
  plan,
};
