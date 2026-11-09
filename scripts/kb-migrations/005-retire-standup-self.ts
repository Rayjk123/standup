/**
 * 005-retire-standup-self — OPT-IN. Retires the frozen `standup-self` copy
 * project's docs in favor of the live `standup` docs they copy.
 *
 * `standup-self` is a one-time copy of the `standup` project's docs that is
 * never refreshed: its docs are byte copies or near-copies of live ones and
 * already diverge from them as `standup` is edited, so a search that returns
 * both spends two slots on one fact and may serve the stale one. A
 * `standup-self` doc is retired (see supersede.ts) when `standup` has a doc of
 * the same slug whose body is identical (whitespace aside) or lexically
 * near-identical (knowledge-dedup.ts's isLexicalNearDup over title + body).
 * One without such a counterpart is kept and listed. Whether to retire the
 * copy project is an owner decision, so this runs only when named
 * (`--only 005-retire-standup-self`).
 */

import type { Database } from "bun:sqlite";
import { isLexicalNearDup } from "../../packages/collector/src/knowledge-dedup.ts";
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

export const ID = "005-retire-standup-self";
export const COPY_PROJECT_ID = "standup-self";
export const LIVE_PROJECT_ID = "standup";

interface Row extends SupersedeRow {
  title: string;
  body: string;
}

async function plan(db: Database, options: MigrationOptions): Promise<MigrationPlan> {
  const changes: Change[] = [];
  const select = (projectId: string, extra = "") =>
    db
      .query(
        `SELECT id, project_id, slug, title, body, verdict, disputes_json, confidence, valid_to, superseded_by
           FROM knowledge WHERE project_id = ? ${extra} ORDER BY slug`
      )
      .all(projectId) as Row[];
  const copies = select(COPY_PROJECT_ID, "AND verdict IS NOT 'superseded'");
  const live = new Map(select(LIVE_PROJECT_ID).map((r) => [r.slug, r]));
  const edits: SupersedeEdit[] = [];
  const retired: Row[] = [];
  const kept: string[] = [];
  for (const copy of copies) {
    const original = live.get(copy.slug);
    const same =
      !!original &&
      (collapsed(copy.body) === collapsed(original.body) ||
        isLexicalNearDup(`${copy.title}\n${copy.body}`, `${original.title}\n${original.body}`));
    if (!original || !same) {
      kept.push(copy.slug);
      continue;
    }
    edits.push(
      planSupersede(
        copy,
        winnerName(copy, original),
        `Copy of ${LIVE_PROJECT_ID}/${original.slug} in the frozen ${COPY_PROJECT_ID} project; retired in favor of the live doc.`,
        `kb-migration ${ID} — revive by editing the doc`,
        changes
      )
    );
    retired.push(copy);
  }
  const files = await planConfidenceFiles(options, [...retired, ...rowsRetiredBy(db, ID)], changes);

  return {
    counts: { superseded: edits.length, kept: kept.length, ...(options.knowledgeDir ? { filesPatched: files.length } : {}) },
    changes,
    files: files.map((f) => f.ref.rel),
    notes: kept.length > 0 ? [`kept (no matching ${LIVE_PROJECT_ID} doc): ${kept.join(", ")}`] : [],
    applyFiles: () => applyFilePatches(options, files),
    applyDb() {
      db.transaction(() => applySupersede(db, edits))();
    },
  };
}

export const migration: KbMigration = {
  id: ID,
  description: "Opt-in: retire standup-self docs that copy a standup doc of the same slug",
  optIn: true,
  plan,
};
