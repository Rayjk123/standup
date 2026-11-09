/**
 * Retiring a doc in favor of another, as the duplicate-collapsing migrations
 * plan it: the doc keeps its row, file, chunks and body, but its verdict
 * becomes `superseded` with a tombstone dispute naming the kept doc (the same
 * shape the contradiction resolver writes), and its confidence drops to
 * DISPUTED_CONFIDENCE so it reads as retired in every ranking. Findings the doc
 * already carried (a `disputed` / `contradicted` verdict's disputes) are kept
 * ahead of the tombstone. Reverting is editing the doc, or a rollback.
 *
 * The verdict is DB-only (the sync never writes it); the confidence is
 * file-authoritative, so with a knowledge dir the file's `confidence` line is
 * spliced too. File work is derived from the files and the DB together — a
 * file whose row a DB-only run already retired is still spliced — so a re-run
 * with the knowledge dir converges.
 */

import type { Database } from "bun:sqlite";
import { DISPUTED_CONFIDENCE, spliceFrontmatter } from "@standup/knowledge";
import type { Change, MigrationOptions } from "./runner.ts";
import { docRel, fmValue, readDocText, writeDocText, type DocFileRef } from "./markdown.ts";

/** A row's validity interval fields (temporal.ts), as a supersede closes them. */
export interface ValidityRow {
  project_id: string;
  verdict: string | null;
  valid_to: string | null;
  superseded_by: string | null;
}

export interface SupersedeRow extends ValidityRow {
  id: string;
  slug: string;
  disputes_json: string | null;
  confidence: number | null;
}

/** One planned retirement: the row's new verdict, disputes and confidence. */
export interface SupersedeEdit {
  id: string;
  disputes: string;
}

/** The tombstone claim prefix the resolver's supersede writes (knowledge-resolve.ts). */
export const SUPERSEDED_PREFIX = "Superseded by ";

/** Whitespace-collapsed body, the identity the collapsing migrations compare. */
export const collapsed = (body: string) => body.replace(/\s+/g, " ").trim();

/** How the kept doc is named from `loser`: its bare slug in the same project, else `project/slug`. */
export function winnerName(loser: { project_id: string }, winner: { project_id: string; slug: string }): string {
  return loser.project_id === winner.project_id ? winner.slug : `${winner.project_id}/${winner.slug}`;
}

function parseDisputes(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Plans retiring `row` in favor of `winner`, recording each changed field in
 * `changes`. `finding` / `evidence` fill the tombstone.
 */
export function planSupersede(
  row: SupersedeRow,
  winner: string,
  finding: string,
  evidence: string,
  changes: Change[]
): SupersedeEdit {
  const ref = `${row.project_id}/${row.slug}`;
  const kept = row.verdict === "disputed" || row.verdict === "contradicted" ? parseDisputes(row.disputes_json) : [];
  const disputes = JSON.stringify([...kept, { claim: `${SUPERSEDED_PREFIX}${winner}`, finding, evidence }]);
  changes.push({ ref, target: "db", field: "verdict", action: "set", before: row.verdict, after: "superseded" });
  if (disputes !== row.disputes_json) changes.push({ ref, target: "db", field: "disputes_json", action: "rewrite" });
  planValidityClose(ref, row, disputes, changes);
  if (row.confidence !== DISPUTED_CONFIDENCE) {
    changes.push({
      ref,
      target: "db",
      field: "confidence",
      action: "set",
      before: row.confidence === null ? null : String(row.confidence),
      after: String(DISPUTED_CONFIDENCE),
    });
  }
  return { id: row.id, disputes };
}

/**
 * Records the validity close the store's supersede trigger makes when `row`'s
 * verdict becomes `superseded` under `disputes`: valid_to is stamped unless the
 * row already carries one, and superseded_by takes the `project/slug` the first
 * tombstone names (a bare slug is in the row's project), else stays.
 */
export function planValidityClose(ref: string, row: ValidityRow, disputes: string | null, changes: Change[]): void {
  if (row.verdict === "superseded") return;
  if (row.valid_to === null) changes.push({ ref, target: "db", field: "valid_to", action: "rewrite" });
  let named: string | null = null;
  for (const d of parseDisputes(disputes)) {
    const claim = (d as { claim?: unknown } | null)?.claim;
    if (typeof claim !== "string" || !claim.startsWith(SUPERSEDED_PREFIX)) continue;
    const target = claim.slice(SUPERSEDED_PREFIX.length).trim();
    if (target !== "") named = target.includes("/") ? target : `${row.project_id}/${target}`;
    break;
  }
  if (named !== null && named !== row.superseded_by) {
    changes.push({ ref, target: "db", field: "superseded_by", action: "rewrite" });
  }
}

export function applySupersede(db: Database, edits: readonly SupersedeEdit[]): void {
  for (const e of edits) {
    db.run("UPDATE knowledge SET verdict = 'superseded', disputes_json = ?, confidence = ? WHERE id = ?", [
      e.disputes,
      DISPUTED_CONFIDENCE,
      e.id,
    ]);
  }
}

/** A planned file splice: the file and its new text. */
export interface FilePatch {
  ref: DocFileRef;
  raw: string;
}

/**
 * Plans the file half for the docs `refs` names (`project/slug`): each file
 * whose `confidence` is not yet DISPUTED_CONFIDENCE gets that line spliced.
 * Without a knowledge dir there is no file work.
 */
export async function planConfidenceFiles(
  options: MigrationOptions,
  refs: Iterable<{ project_id: string; slug: string }>,
  changes: Change[]
): Promise<FilePatch[]> {
  const dir = options.knowledgeDir;
  if (!dir) return [];
  const patches: FilePatch[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const key = `${r.project_id}/${r.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref: DocFileRef = { projectId: r.project_id, slug: r.slug, rel: docRel(r.project_id, r.slug) };
    const file = await readDocText(dir, ref).catch(() => null);
    if (!file || file.data.confidence === DISPUTED_CONFIDENCE) continue;
    patches.push({ ref, raw: spliceFrontmatter(file.raw, { confidence: DISPUTED_CONFIDENCE }) });
    changes.push({
      ref: key,
      target: "file",
      field: "confidence",
      action: "set",
      before: fmValue(file.data.confidence),
      after: String(DISPUTED_CONFIDENCE),
    });
  }
  return patches;
}

export async function applyFilePatches(options: MigrationOptions, patches: readonly FilePatch[]): Promise<void> {
  const dir = options.knowledgeDir;
  if (!dir) return;
  for (const { ref, raw } of patches) await writeDocText(dir, ref, raw);
}

/** Rows a migration already retired (its tombstone evidence names it), for the file half's convergence. */
export function rowsRetiredBy(db: Database, migrationId: string): Array<{ project_id: string; slug: string }> {
  return db
    .query(
      "SELECT project_id, slug FROM knowledge WHERE verdict = 'superseded' AND disputes_json LIKE ? ORDER BY project_id, slug"
    )
    .all(`%kb-migration ${migrationId}%`) as Array<{ project_id: string; slug: string }>;
}
