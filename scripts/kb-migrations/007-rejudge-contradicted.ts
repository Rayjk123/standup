/**
 * 007-rejudge-contradicted — queues every contradiction verdict no judge
 * outcome backs for re-judging, and un-hides the winner of each pair the old
 * judge flagged on both sides.
 *
 * The contradiction judge used to read every failure as "no contradiction" (so
 * it missed contradictions, but never invented one) and to flag BOTH sides of
 * each pair it confirmed, without recording any outcome. A `contradicted` doc
 * with no successful judgment in `knowledge_judgments` therefore keeps its
 * verdict — the finding is real — but gets a `queued` judgment row, which takes
 * it out of the nightly sweep's cooldown so it is judged again. Where both docs
 * of a pair carry the edge to each other, the deterministic loser rule the
 * judge now applies (knowledge-coherence.ts chooseLoser: owner over agent,
 * verified over unverified, higher confidence, newer) picks the side that stays
 * flagged; the winner's edge to it is removed, recomputing its verdict from what
 * it still carries. A pair the rule cannot separate is left as it is.
 *
 * DB-only, with or without a knowledge dir: verdicts and judgments live only in
 * the DB.
 */

import type { Database } from "bun:sqlite";
import { hasSuccessfulJudgment, judgmentId, parseContradictsClaim, type DraftDispute } from "@standup/knowledge";
import { chooseLoser } from "../../packages/collector/src/knowledge-coherence.ts";
import type { Change, KbMigration, MigrationPlan } from "./runner.ts";
import { SUPERSEDED_PREFIX, planValidityClose } from "./supersede.ts";

export const ID = "007-rejudge-contradicted";
const QUEUE_REASON = "verdict from a judge run with no recorded outcome; re-judge";

interface Row {
  id: string;
  project_id: string;
  slug: string;
  verdict: string | null;
  disputes_json: string | null;
  updated_at: string | null;
  origin_class: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  generated_at: string | null;
  valid_to: string | null;
  superseded_by: string | null;
}

function disputesOf(row: Row): DraftDispute[] {
  try {
    const parsed = JSON.parse(row.disputes_json ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as DraftDispute[]) : [];
  } catch {
    return [];
  }
}

const claimOf = (d: { claim?: unknown }) => (typeof d.claim === "string" ? d.claim : "");

/** The verdict a doc's remaining disputes amount to. */
function verdictFor(disputes: DraftDispute[]): string | null {
  if (disputes.some((d) => claimOf(d).startsWith(SUPERSEDED_PREFIX))) return "superseded";
  if (disputes.some((d) => parseContradictsClaim(claimOf(d)) === null)) return "disputed";
  return disputes.length > 0 ? "contradicted" : null;
}

function stateOf(row: Row) {
  return {
    verdict: row.verdict ?? undefined,
    disputes: disputesOf(row),
    originClass: row.origin_class ?? undefined,
    confidence: row.confidence ?? undefined,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    halfLifeDays: row.half_life_days ?? undefined,
    generatedAt: row.generated_at ?? undefined,
  };
}

/** A fixed clock for the loser rule's confidence decay, so a plan is the same
 *  on every run (dry run and apply). */
const RULE_NOW = new Date("2026-01-01T00:00:00.000Z");

interface Edit {
  id: string;
  verdict: string | null;
  disputes: string | null;
}

async function plan(db: Database): Promise<MigrationPlan> {
  const changes: Change[] = [];
  const hasTable = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_judgments'").get();
  const rows = db
    .query(
      `SELECT id, project_id, slug, verdict, disputes_json, updated_at, origin_class, confidence, last_verified_at,
              half_life_days, generated_at, valid_to, superseded_by
         FROM knowledge WHERE verdict = 'contradicted' ORDER BY project_id, slug`
    )
    .all() as Row[];
  const bySlug = new Map(rows.map((r) => [`${r.project_id}/${r.slug}`, r]));
  const queuedQuery = hasTable ? db.query("SELECT 1 FROM knowledge_judgments WHERE id = ?") : null;
  const queue: Array<{ id: string; projectId: string; slug: string; judgedAt: string }> = [];
  const edits: Edit[] = [];
  for (const r of rows) {
    if (hasSuccessfulJudgment(db, r.project_id, r.slug)) continue;
    const ref = `${r.project_id}/${r.slug}`;
    const qid = judgmentId(r.project_id, r.slug);
    if (hasTable && !queuedQuery!.get(qid)) {
      queue.push({ id: qid, projectId: r.project_id, slug: r.slug, judgedAt: r.updated_at ?? "1970-01-01T00:00:00.000Z" });
      changes.push({ ref, target: "db", field: "knowledge_judgments", action: "insert" });
    }
    // The edges this doc carries to a doc that carries one back: the old
    // judge's both-sides flag. The winner of each loses its edge.
    const disputes = disputesOf(r);
    const dropped = new Set<string>();
    for (const d of disputes) {
      const other = parseContradictsClaim(claimOf(d));
      if (!other) continue;
      const otherRow = bySlug.get(`${r.project_id}/${other}`);
      if (!otherRow || hasSuccessfulJudgment(db, otherRow.project_id, otherRow.slug)) continue;
      const mutual = disputesOf(otherRow).some((o) => parseContradictsClaim(claimOf(o)) === r.slug);
      if (!mutual) continue;
      const decision = chooseLoser(
        { slug: r.slug, state: stateOf(r) },
        { slug: other, state: stateOf(otherRow) },
        RULE_NOW
      );
      if (decision?.winner === r.slug) dropped.add(other);
    }
    if (dropped.size === 0) continue;
    const kept = disputes.filter((d) => !dropped.has(parseContradictsClaim(claimOf(d)) ?? ""));
    const verdict = verdictFor(kept);
    // A winner still contradicting another doc keeps its verdict; only its disputes change.
    if (verdict !== "contradicted") {
      changes.push({ ref, target: "db", field: "verdict", action: "set", before: "contradicted", after: verdict });
    }
    changes.push({ ref, target: "db", field: "disputes_json", action: "rewrite" });
    const disputesJson = kept.length > 0 ? JSON.stringify(kept) : null;
    if (verdict === "superseded") planValidityClose(ref, r, disputesJson, changes);
    edits.push({ id: r.id, verdict, disputes: disputesJson });
  }

  return {
    counts: { queued: queue.length, winnersCleared: edits.length },
    changes,
    files: [],
    notes: hasTable ? [] : ["knowledge_judgments is missing; nothing could be queued"],
    async applyFiles() {},
    applyDb() {
      db.transaction(() => {
        for (const e of edits) {
          db.run("UPDATE knowledge SET verdict = ?, disputes_json = ? WHERE id = ?", [e.verdict, e.disputes, e.id]);
        }
        for (const q of queue) {
          db.run(
            `INSERT INTO knowledge_judgments (id, project_id, subject_slug, outcome, reason, attempts, judged_at)
             VALUES (?, ?, ?, 'queued', ?, 0, ?)`,
            [q.id, q.projectId, q.slug, QUEUE_REASON, q.judgedAt]
          );
        }
      })();
    },
  };
}

export const migration: KbMigration = {
  id: ID,
  description: "Queue contradiction verdicts with no recorded judge outcome for re-judging; un-hide the winner of each both-sides pair",
  plan,
};
