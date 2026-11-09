import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { PersonaFloorDecision } from "@standup/shared";

/** The fields of a floor allow as Persona's answer_ask records it (migrations 072 and 073). */
export type RecordPersonaFloorDecisionInput = Omit<PersonaFloorDecision, "id" | "createdAt">;

interface Row {
  id: string;
  owner: string;
  ask_id: string;
  session_id: string;
  job_id: string | null;
  thread_id: string | null;
  gate: string;
  category: string | null;
  call: string;
  reason: string;
  decided_by: string;
  check_flag: string | null;
  created_at: string;
}

function toDecision(row: Row): PersonaFloorDecision {
  return {
    id: row.id,
    owner: row.owner,
    askId: row.ask_id,
    sessionId: row.session_id,
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    gate: row.gate,
    ...(row.category ? { category: row.category } : {}),
    call: row.call,
    reason: row.reason,
    decidedBy: row.decided_by,
    ...(row.check_flag ? { checkFlag: row.check_flag } : {}),
    createdAt: row.created_at,
  };
}

/** Records one safety-floor hold Persona allowed once; returns it. */
export function recordPersonaFloorDecision(db: Database, input: RecordPersonaFloorDecisionInput): PersonaFloorDecision {
  const id = randomUUID();
  db.run(
    `INSERT INTO persona_floor_decisions
       (id, owner, ask_id, session_id, job_id, thread_id, gate, category, call, reason, decided_by, check_flag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.askId,
      input.sessionId,
      input.jobId ?? null,
      input.threadId ?? null,
      input.gate,
      input.category ?? null,
      input.call,
      input.reason,
      input.decidedBy,
      input.checkFlag ?? null,
      new Date().toISOString(),
    ]
  );
  return toDecision(db.query("SELECT * FROM persona_floor_decisions WHERE id = ?").get(id) as Row);
}

/** The owner's floor allows, newest first, optionally for one job. */
export function listPersonaFloorDecisions(
  db: Database,
  owner: string,
  opts: { jobId?: string; limit?: number } = {}
): PersonaFloorDecision[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const rows = opts.jobId
    ? (db
        .query(
          "SELECT * FROM persona_floor_decisions WHERE owner = ? AND job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
        )
        .all(owner, opts.jobId, limit) as Row[])
    : (db
        .query("SELECT * FROM persona_floor_decisions WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(owner, limit) as Row[]);
  return rows.map(toDecision);
}
