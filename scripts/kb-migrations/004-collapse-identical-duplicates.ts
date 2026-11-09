/**
 * 004-collapse-identical-duplicates — retires byte-copies of a doc that reach
 * the same audience, keeping one canonical copy.
 *
 * Two live docs with the same body (whitespace aside) that the same agent can
 * retrieve fill two result slots with one fact and split its retrieval and
 * verification history. Docs share an audience when they are homed in the same
 * project, or either is `scope: global` or homed in the global corpus; a
 * `scope: user` doc only ever groups with docs of the same owner. Each group
 * keeps one canonical doc — owner-written over agent-written, then the older
 * (generated_at, else updated_at), then the shorter slug, then `project/slug`
 * — and every other member is retired in favor of it (see supersede.ts):
 * verdict `superseded` with a tombstone naming the canonical doc, confidence
 * DISPUTED_CONFIDENCE in the DB and, with a knowledge dir, in the file.
 */

import type { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import type { Change, KbMigration, MigrationOptions, MigrationPlan } from "./runner.ts";
import {
  applyFilePatches,
  applySupersede,
  collapsed,
  planConfidenceFiles,
  planSupersede,
  rowsRetiredBy,
  winnerName,
  type SupersedeEdit,
  type SupersedeRow,
} from "./supersede.ts";

export const ID = "004-collapse-identical-duplicates";

interface Row extends SupersedeRow {
  body: string;
  scope: string | null;
  owner_user: string | null;
  origin_class: string | null;
  generated_at: string | null;
  updated_at: string | null;
}

/** Whether two docs reach a common audience (see the file comment). */
function shareAudience(a: Row, b: Row): boolean {
  const userA = a.scope === "user";
  const userB = b.scope === "user";
  if (userA || userB) {
    if (!userA || !userB || !a.owner_user || a.owner_user !== b.owner_user) return false;
  }
  const wide = (r: Row) => r.scope === "global" || r.project_id === GLOBAL_PROJECT_ID;
  return a.project_id === b.project_id || wide(a) || wide(b);
}

const age = (r: Row) => {
  const at = Date.parse(r.generated_at ?? r.updated_at ?? "");
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

/** Canonical first: owner-written, older, shorter slug, then `project/slug`. */
function canonicalOrder(a: Row, b: Row): number {
  const owner = (r: Row) => (r.origin_class === "owner" ? 0 : 1);
  return (
    owner(a) - owner(b) ||
    age(a) - age(b) ||
    a.slug.length - b.slug.length ||
    `${a.project_id}/${a.slug}`.localeCompare(`${b.project_id}/${b.slug}`)
  );
}

/** Connected components of `rows` under shareAudience. */
function components(rows: Row[]): Row[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (shareAudience(rows[i], rows[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Row[]>();
  rows.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  return [...groups.values()].filter((g) => g.length > 1);
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const changes: Change[] = [];
  const rows = db
    .query(
      `SELECT id, project_id, slug, body, scope, owner_user, origin_class, generated_at, updated_at,
              verdict, disputes_json, confidence, valid_to, superseded_by
         FROM knowledge WHERE verdict IS NOT 'superseded' ORDER BY project_id, slug`
    )
    .all() as Row[];
  const byBody = new Map<string, Row[]>();
  for (const r of rows) {
    const key = collapsed(r.body);
    if (!key) continue;
    byBody.set(key, [...(byBody.get(key) ?? []), r]);
  }
  const edits: SupersedeEdit[] = [];
  const retired: Row[] = [];
  let groups = 0;
  for (const same of byBody.values()) {
    if (same.length < 2) continue;
    for (const group of components(same)) {
      groups++;
      const [winner, ...losers] = [...group].sort(canonicalOrder);
      for (const loser of losers.sort((a, b) => `${a.project_id}/${a.slug}`.localeCompare(`${b.project_id}/${b.slug}`))) {
        const name = winnerName(loser, winner);
        edits.push(
          planSupersede(
            loser,
            name,
            `Identical body to ${winner.project_id}/${winner.slug}; kept as the canonical copy.`,
            `kb-migration ${ID} — revive by editing the doc`,
            changes
          )
        );
        retired.push(loser);
      }
    }
  }
  const files = await planConfidenceFiles(options, [...retired, ...rowsRetiredBy(db, ID)], changes);

  return {
    counts: { groups, superseded: edits.length, ...(options.knowledgeDir ? { filesPatched: files.length } : {}) },
    changes,
    files: files.map((f) => f.ref.rel),
    notes: [],
    applyFiles: () => applyFilePatches(options, files),
    applyDb() {
      db.transaction(() => applySupersede(db, edits))();
    },
  };
}

export const migration: KbMigration = {
  id: ID,
  description: "Retire byte-identical copies of a doc within one audience, keeping a canonical copy",
  plan,
};
