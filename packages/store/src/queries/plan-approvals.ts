import type { Database } from "bun:sqlite";
import type { PlanApproval, PlanApprovalStatus } from "@standup/shared";
import { createHash, randomUUID } from "crypto";

interface PlanApprovalRow {
  id: string;
  launch_id: string;
  project_id: string;
  worktree_path: string;
  status: PlanApprovalStatus;
  relevant_files: string | null;
  plan: string | null;
  acceptance_criterion: string | null;
  criterion_met: number;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
}

function toPlanApproval(row: PlanApprovalRow): PlanApproval {
  return {
    id: row.id,
    launchId: row.launch_id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    status: row.status,
    relevantFiles: row.relevant_files ? JSON.parse(row.relevant_files) : [],
    plan: row.plan ?? undefined,
    acceptanceCriterion: row.acceptance_criterion ?? undefined,
    criterionMet: row.criterion_met === 1,
    approvedBy: row.approved_by ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    submittedAt: row.submitted_at ? new Date(row.submitted_at) : undefined,
    approvedAt: row.approved_at ? new Date(row.approved_at) : undefined,
  };
}

/**
 * Opens a plan-approval gate for a launch — created in `awaiting_plan` the
 * moment a gated launch starts, so the gate exists before the agent has said
 * anything. The agent fills it in via submitPlan; a human resolves it via
 * approvePlan.
 */
export function createPlanApproval(
  db: Database,
  input: { launchId: string; projectId: string; worktreePath: string }
): PlanApproval {
  const id = randomUUID();
  db.run(
    `INSERT INTO plan_approvals (id, launch_id, project_id, worktree_path, status)
     VALUES (?, ?, ?, ?, 'awaiting_plan')`,
    [id, input.launchId, input.projectId, input.worktreePath]
  );
  return getPlanApproval(db, id)!;
}

export function getPlanApproval(db: Database, id: string): PlanApproval | null {
  const row = db
    .query("SELECT * FROM plan_approvals WHERE id = ?")
    .get(id) as PlanApprovalRow | null;
  return row ? toPlanApproval(row) : null;
}

export function getPlanApprovalByLaunch(
  db: Database,
  launchId: string
): PlanApproval | null {
  const row = db
    .query("SELECT * FROM plan_approvals WHERE launch_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(launchId) as PlanApprovalRow | null;
  return row ? toPlanApproval(row) : null;
}

/** Every plan awaiting a human's approval — the review queue for the gate. */
export function getPendingPlanApprovals(db: Database): PlanApproval[] {
  const rows = db
    .query(
      "SELECT * FROM plan_approvals WHERE status = 'awaiting_approval' ORDER BY submitted_at DESC"
    )
    .all() as PlanApprovalRow[];
  return rows.map(toPlanApproval);
}

/**
 * Records the agent's submitted plan and moves the gate awaiting_plan ->
 * awaiting_approval (where submit_plan blocks until a human approves). Resetting
 * a rejected gate back to awaiting_approval lets the agent resubmit a revised
 * plan after a rejection.
 */
export function submitPlan(
  db: Database,
  id: string,
  input: { relevantFiles: string[]; plan: string; acceptanceCriterion?: string }
): PlanApproval {
  db.run(
    `UPDATE plan_approvals
        SET relevant_files = ?, plan = ?, acceptance_criterion = ?,
            status = 'awaiting_approval', criterion_met = 0,
            submitted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    [
      JSON.stringify(input.relevantFiles),
      input.plan,
      input.acceptanceCriterion ?? null,
      id,
    ]
  );
  return getPlanApproval(db, id)!;
}

/**
 * A stable hash of what a plan asks to do (its text, acceptance criterion and
 * files), so an approval requested for one version can be refused once the
 * agent resubmits another.
 */
export function planApprovalHash(
  plan: Pick<PlanApproval, "plan" | "acceptanceCriterion" | "relevantFiles">
): string {
  return createHash("sha256")
    .update(JSON.stringify([plan.plan ?? "", plan.acceptanceCriterion ?? "", plan.relevantFiles ?? []]))
    .digest("hex")
    .slice(0, 32);
}

/** Thrown by approvePlan when the plan is no longer the version the approver saw. */
export class PlanChangedError extends Error {
  constructor(message = "plan changed since the approval was requested") {
    super(message);
    this.name = "PlanChangedError";
  }
}

/**
 * A human approves the plan, optionally editing the files / plan / acceptance
 * criterion first. Moves the gate to `approved`, which releases the paused run.
 * Edits are applied only when provided (undefined leaves the agent's value).
 *
 * With `expectedHash`, the approval is compare-and-set: it applies only while
 * the plan still awaits approval with exactly that content (planApprovalHash),
 * checked and written in one transaction so a resubmission can't land between
 * the check and the write. Otherwise it throws PlanChangedError.
 */
export function approvePlan(
  db: Database,
  id: string,
  edits?: {
    relevantFiles?: string[];
    plan?: string;
    acceptanceCriterion?: string;
    approvedBy?: string;
    expectedHash?: string;
  }
): PlanApproval {
  const sets = [
    "status = 'approved'",
    "approved_at = datetime('now')",
    "updated_at = datetime('now')",
  ];
  const params: (string | null)[] = [];
  if (edits?.relevantFiles !== undefined) {
    sets.push("relevant_files = ?");
    params.push(JSON.stringify(edits.relevantFiles));
  }
  if (edits?.plan !== undefined) {
    sets.push("plan = ?");
    params.push(edits.plan);
  }
  if (edits?.acceptanceCriterion !== undefined) {
    sets.push("acceptance_criterion = ?");
    params.push(edits.acceptanceCriterion);
  }
  if (edits?.approvedBy !== undefined) {
    sets.push("approved_by = ?");
    params.push(edits.approvedBy);
  }
  params.push(id);
  db.transaction(() => {
    if (edits?.expectedHash !== undefined) {
      const current = getPlanApproval(db, id);
      if (!current || current.status !== "awaiting_approval" || planApprovalHash(current) !== edits.expectedHash) {
        throw new PlanChangedError();
      }
    }
    db.run(`UPDATE plan_approvals SET ${sets.join(", ")} WHERE id = ?`, params);
  })();
  return getPlanApproval(db, id)!;
}

/** Rejects the plan, so submit_plan returns and the agent can revise. */
export function rejectPlan(
  db: Database,
  id: string,
  opts?: { approvedBy?: string }
): PlanApproval {
  db.run(
    `UPDATE plan_approvals
        SET status = 'rejected', approved_by = ?, updated_at = datetime('now')
      WHERE id = ?`,
    [opts?.approvedBy ?? null, id]
  );
  return getPlanApproval(db, id)!;
}

/** Records that the acceptance criterion has passed — unblocks mark_ready. */
export function setCriterionMet(db: Database, id: string): PlanApproval {
  db.run(
    "UPDATE plan_approvals SET criterion_met = 1, updated_at = datetime('now') WHERE id = ?",
    [id]
  );
  return getPlanApproval(db, id)!;
}

/**
 * Clears a cached acceptance-criterion pass so the gate re-verifies it. Called
 * when a reviewed change is sent back for rework (needs_review -> developing):
 * the criterion was checked against the prior work, and the reworked change must
 * satisfy it again before it can advance to review, so a broken rework can't
 * ride an earlier pass into review.
 */
export function resetCriterionMet(db: Database, id: string): PlanApproval {
  db.run(
    "UPDATE plan_approvals SET criterion_met = 0, updated_at = datetime('now') WHERE id = ?",
    [id]
  );
  return getPlanApproval(db, id)!;
}
