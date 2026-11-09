import type { Database } from "bun:sqlite";

/**
 * The reviewer's feedback (a rejection) or note (an approval) for a plan, kept
 * until the worker's submit_plan call has carried it back. `delivered` is set
 * once a reply has carried it; the row stays so a worker retrying a call it
 * gave up on still gets it. Durable, so a remark written before a collector
 * restart reaches the call the worker re-sends to the next collector.
 */
export interface PlanReviewRemark {
  feedback?: string;
  note?: string;
  delivered: boolean;
}

interface PlanReviewRemarkRow {
  plan_id: string;
  feedback: string | null;
  note: string | null;
  delivered: number;
  updated_at: string;
}

/** How long a remark is kept after it was written. */
export const PLAN_REVIEW_REMARK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Records the remark of a plan decision, replacing any earlier one for the
 * plan (a note replaces a stale feedback and vice versa) as undelivered.
 */
export function setPlanReviewRemark(
  db: Database,
  planId: string,
  remark: { feedback?: string; note?: string }
): void {
  db.run(
    `INSERT INTO plan_review_remarks (plan_id, feedback, note, delivered, updated_at)
       VALUES (?, ?, ?, 0, datetime('now'))
     ON CONFLICT(plan_id) DO UPDATE SET
       feedback = excluded.feedback,
       note = excluded.note,
       delivered = 0,
       updated_at = excluded.updated_at`,
    [planId, remark.feedback ?? null, remark.note ?? null]
  );
}

/**
 * The plan's remark, or null when it has none or it is older than
 * PLAN_REVIEW_REMARK_TTL_MS (an expired row is deleted on the way).
 */
export function getPlanReviewRemark(db: Database, planId: string): PlanReviewRemark | null {
  const row = db
    .query("SELECT * FROM plan_review_remarks WHERE plan_id = ?")
    .get(planId) as PlanReviewRemarkRow | null;
  if (!row) return null;
  const writtenMs = Date.parse(`${row.updated_at.replace(" ", "T")}Z`);
  if (Number.isFinite(writtenMs) && Date.now() - writtenMs > PLAN_REVIEW_REMARK_TTL_MS) {
    deletePlanReviewRemark(db, planId);
    return null;
  }
  return {
    ...(row.feedback !== null ? { feedback: row.feedback } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
    delivered: row.delivered === 1,
  };
}

/** Marks the plan's remark as carried by a reply; the row is kept for retries. */
export function markPlanReviewRemarkDelivered(db: Database, planId: string): void {
  db.run("UPDATE plan_review_remarks SET delivered = 1 WHERE plan_id = ?", [planId]);
}

export function deletePlanReviewRemark(db: Database, planId: string): void {
  db.run("DELETE FROM plan_review_remarks WHERE plan_id = ?", [planId]);
}

/** Ids of plans whose remark no reply has carried yet. */
export function listUndeliveredPlanReviewRemarks(db: Database): string[] {
  return (
    db.query("SELECT plan_id FROM plan_review_remarks WHERE delivered = 0 ORDER BY updated_at").all() as Array<{
      plan_id: string;
    }>
  ).map((r) => r.plan_id);
}
