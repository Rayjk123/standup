import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { PersonaKnowledgeDecision } from "@standup/shared";

/** The fields of a decision as Persona's tool records it (migration 057). */
export type RecordPersonaKnowledgeDecisionInput = Omit<PersonaKnowledgeDecision, "id" | "createdAt">;

interface Row {
  id: string;
  owner: string;
  project_id: string;
  draft_slug: string;
  target_slug: string | null;
  title: string;
  decision: string;
  mode: string;
  edited: number;
  edited_body: string | null;
  reason: string;
  verdict: string | null;
  generated_by_launch_id: string | null;
  thread_id: string | null;
  job_id: string | null;
  created_at: string;
}

function toDecision(row: Row): PersonaKnowledgeDecision {
  return {
    id: row.id,
    owner: row.owner,
    projectId: row.project_id,
    draftSlug: row.draft_slug,
    ...(row.target_slug ? { targetSlug: row.target_slug } : {}),
    title: row.title,
    decision: row.decision as PersonaKnowledgeDecision["decision"],
    mode: row.mode as PersonaKnowledgeDecision["mode"],
    edited: row.edited === 1,
    ...(row.edited_body !== null ? { editedBody: row.edited_body } : {}),
    reason: row.reason,
    ...(row.verdict ? { verdict: row.verdict } : {}),
    ...(row.generated_by_launch_id ? { generatedByLaunchId: row.generated_by_launch_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    createdAt: row.created_at,
  };
}

/** Records one decision Persona made on a knowledge draft; returns it. */
export function recordPersonaKnowledgeDecision(
  db: Database,
  input: RecordPersonaKnowledgeDecisionInput
): PersonaKnowledgeDecision {
  const id = randomUUID();
  db.run(
    `INSERT INTO persona_knowledge_decisions
       (id, owner, project_id, draft_slug, target_slug, title, decision, mode, edited, edited_body, reason, verdict,
        generated_by_launch_id, thread_id, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.projectId,
      input.draftSlug,
      input.targetSlug ?? null,
      input.title,
      input.decision,
      input.mode,
      input.edited ? 1 : 0,
      input.editedBody ?? null,
      input.reason,
      input.verdict ?? null,
      input.generatedByLaunchId ?? null,
      input.threadId ?? null,
      input.jobId ?? null,
      new Date().toISOString(),
    ]
  );
  return toDecision(db.query("SELECT * FROM persona_knowledge_decisions WHERE id = ?").get(id) as Row);
}

/** The owner's knowledge-draft decisions, newest first, optionally for one project. */
export function listPersonaKnowledgeDecisions(
  db: Database,
  owner: string,
  opts: { projectId?: string; limit?: number } = {}
): PersonaKnowledgeDecision[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const rows = opts.projectId
    ? (db
        .query(
          "SELECT * FROM persona_knowledge_decisions WHERE owner = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
        )
        .all(owner, opts.projectId, limit) as Row[])
    : (db
        .query("SELECT * FROM persona_knowledge_decisions WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(owner, limit) as Row[]);
  return rows.map(toDecision);
}
