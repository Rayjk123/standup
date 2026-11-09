import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { PersonaCommitment, PersonaCommitmentAssignee, PersonaCommitmentStatus } from "@standup/shared";

/** What opening a commitment takes (migration 076). */
export interface OpenPersonaCommitmentInput {
  owner: string;
  threadId?: string;
  jobId?: string;
  assignee: PersonaCommitmentAssignee;
  action: string;
  doneCheck: string;
  source?: "persona" | "auto";
  /** Keys an auto-opened commitment to its transition: one open row per key. */
  autoKey?: string;
  /** When it goes stale; omitted never goes stale. */
  staleAfter?: string;
  /** The opening time (defaults to now). */
  openedAt?: string;
}

interface Row {
  id: string;
  owner: string;
  thread_id: string | null;
  job_id: string | null;
  assignee: string;
  action: string;
  done_check: string;
  status: string;
  source: string;
  auto_key: string | null;
  opened_at: string;
  stale_after: string | null;
  closed_at: string | null;
  closed_evidence: string | null;
  nudged_at: string | null;
  hold_message_id: string | null;
}

function toCommitment(row: Row): PersonaCommitment {
  return {
    id: row.id,
    owner: row.owner,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    assignee: row.assignee as PersonaCommitmentAssignee,
    action: row.action,
    doneCheck: row.done_check,
    status: row.status as PersonaCommitmentStatus,
    source: row.source === "auto" ? "auto" : "persona",
    ...(row.auto_key ? { autoKey: row.auto_key } : {}),
    openedAt: row.opened_at,
    ...(row.stale_after ? { staleAfter: row.stale_after } : {}),
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.closed_evidence ? { closedEvidence: row.closed_evidence } : {}),
    ...(row.nudged_at ? { nudgedAt: row.nudged_at } : {}),
    ...(row.hold_message_id ? { holdMessageId: row.hold_message_id } : {}),
  };
}

/** Whitespace-collapsed, lower-cased text, for telling one open commitment from a repeat of it. */
function sameText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function getPersonaCommitment(db: Database, id: string): PersonaCommitment | null {
  const row = db.query("SELECT * FROM persona_commitments WHERE id = ?").get(id) as Row | null;
  return row ? toCommitment(row) : null;
}

/**
 * Opens a commitment, unless the same one exists: a row with the same
 * `autoKey`, open or closed (a transition delivered again — a re-broadcast
 * after a restart — never reopens what was settled), or — for one without a
 * key — an open row with the same thread, job, assignee and action (the
 * thread too, so a thread other people read never learns of a private one).
 * Returns that commitment and whether this call created it.
 */
export function openPersonaCommitment(
  db: Database,
  input: OpenPersonaCommitmentInput
): { commitment: PersonaCommitment; created: boolean } {
  return db.transaction(() => {
    const existing = input.autoKey
      ? (db
          .query("SELECT * FROM persona_commitments WHERE owner = ? AND auto_key = ? ORDER BY status = 'open' DESC, rowid DESC LIMIT 1")
          .get(input.owner, input.autoKey) as Row | null)
      : ((
          db
            .query(
              `SELECT * FROM persona_commitments
                WHERE owner = ? AND status = 'open' AND assignee = ? AND COALESCE(job_id, '') = ? AND COALESCE(thread_id, '') = ?`
            )
            .all(input.owner, input.assignee, input.jobId ?? "", input.threadId ?? "") as Row[]
        ).find((r) => sameText(r.action) === sameText(input.action)) ?? null);
    if (existing) return { commitment: toCommitment(existing), created: false };
    const id = randomUUID();
    db.run(
      `INSERT INTO persona_commitments
         (id, owner, thread_id, job_id, assignee, action, done_check, status, source, auto_key, opened_at, stale_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      [
        id,
        input.owner,
        input.threadId ?? null,
        input.jobId ?? null,
        input.assignee,
        input.action,
        input.doneCheck,
        input.source ?? "persona",
        input.autoKey ?? null,
        input.openedAt ?? new Date().toISOString(),
        input.staleAfter ?? null,
      ]
    );
    return { commitment: getPersonaCommitment(db, id)!, created: true };
  })();
}

/**
 * The owner's commitments: open ones (the default) stalest first — by when
 * they go stale, those that never do last, then oldest first; closed ones
 * newest closed first. `threadId` narrows to one thread's, `jobId` to one
 * job's.
 */
export function listPersonaCommitments(
  db: Database,
  owner: string,
  opts: { status?: PersonaCommitmentStatus | "closed" | "all"; jobId?: string; threadId?: string; limit?: number } = {}
): PersonaCommitment[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const status = opts.status ?? "open";
  const where = ["owner = ?"];
  const params: Array<string | number> = [owner];
  if (status === "closed") where.push("status IN ('done', 'dropped')");
  else if (status !== "all") {
    where.push("status = ?");
    params.push(status);
  }
  if (opts.jobId) {
    where.push("job_id = ?");
    params.push(opts.jobId);
  }
  if (opts.threadId) {
    where.push("thread_id = ?");
    params.push(opts.threadId);
  }
  const order =
    status === "open"
      ? "stale_after IS NULL, stale_after ASC, opened_at ASC, rowid ASC"
      : "status = 'open' DESC, COALESCE(closed_at, opened_at) DESC, rowid DESC";
  params.push(limit);
  const rows = db
    .query(`SELECT * FROM persona_commitments WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .all(...params) as Row[];
  return rows.map(toCommitment);
}

/**
 * Closes the owner's open commitment `id` as done (with how its done-check
 * was verified) or dropped (with why). Null when it isn't the owner's or is
 * no longer open.
 */
export function closePersonaCommitment(
  db: Database,
  input: { id: string; owner: string; status: "done" | "dropped"; evidence: string; closedAt?: string }
): PersonaCommitment | null {
  const result = db.run(
    "UPDATE persona_commitments SET status = ?, closed_evidence = ?, closed_at = ? WHERE id = ? AND owner = ? AND status = 'open'",
    [input.status, input.evidence, input.closedAt ?? new Date().toISOString(), input.id, input.owner]
  );
  return result.changes > 0 ? getPersonaCommitment(db, input.id) : null;
}

/**
 * Hands the owner's open commitment `id` to `assignee` with a fresh stale
 * time, clearing its overdue nudge; `holdMessageId` is the ask_user question
 * that put it to the owner (cleared when omitted). Null when it isn't the
 * owner's or is no longer open.
 */
export function reassignPersonaCommitment(
  db: Database,
  input: { id: string; owner: string; assignee: PersonaCommitmentAssignee; staleAfter?: string; holdMessageId?: string }
): PersonaCommitment | null {
  const result = db.run(
    `UPDATE persona_commitments SET assignee = ?, stale_after = ?, nudged_at = NULL, hold_message_id = ?
      WHERE id = ? AND owner = ? AND status = 'open'`,
    [input.assignee, input.staleAfter ?? null, input.holdMessageId ?? null, input.id, input.owner]
  );
  return result.changes > 0 ? getPersonaCommitment(db, input.id) : null;
}

/**
 * Whether `owner` wrote in the thread of Persona message `messageId` after it
 * — their reply to an ask_user question. Other people's messages in a shared
 * thread are `user` messages too, so only the owner's (or an unattributed
 * console one) count, and a slash command they ran (`/state`) is no reply.
 * True when the message is gone, since nothing is left to wait on.
 */
export function personaOwnerRepliedAfter(db: Database, messageId: string, owner: string): boolean {
  const asked = db.query("SELECT thread_id, seq FROM persona_messages WHERE id = ?").get(messageId) as
    | { thread_id: string; seq: number }
    | null;
  if (!asked) return true;
  return !!db
    .query(
      "SELECT 1 FROM persona_messages WHERE thread_id = ? AND seq > ? AND role = 'user' AND (actor = ? OR actor IS NULL) AND command_json IS NULL LIMIT 1"
    )
    .get(asked.thread_id, asked.seq, owner);
}

/**
 * The owner's open commitments Persona owes that went stale by `now` and
 * that the collector has not woken Persona about since `renudgeBefore` (or
 * ever), stalest first.
 */
export function overduePersonaCommitmentsToNudge(
  db: Database,
  owner: string,
  now: string,
  renudgeBefore: string
): PersonaCommitment[] {
  const rows = db
    .query(
      `SELECT * FROM persona_commitments
        WHERE owner = ? AND status = 'open' AND assignee = 'persona'
          AND stale_after IS NOT NULL AND stale_after <= ?
          AND (nudged_at IS NULL OR nudged_at < ?)
        ORDER BY stale_after ASC, rowid ASC`
    )
    .all(owner, now, renudgeBefore) as Row[];
  return rows.map(toCommitment);
}

/**
 * Drops the owner's open commitments whose autoKey starts with `prefix`
 * other than `keep` — only `jobId`'s when given — with `evidence`; returns
 * how many.
 */
export function dropPersonaCommitmentsByKeyPrefix(
  db: Database,
  input: { owner: string; prefix: string; keep: string; evidence: string; jobId?: string; closedAt?: string }
): number {
  const pattern = `${input.prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return db.run(
    `UPDATE persona_commitments SET status = 'dropped', closed_evidence = ?, closed_at = ?
      WHERE owner = ? AND status = 'open' AND auto_key LIKE ? ESCAPE '\\' AND auto_key != ?
        AND (? IS NULL OR job_id = ?)`,
    [
      input.evidence,
      input.closedAt ?? new Date().toISOString(),
      input.owner,
      pattern,
      input.keep,
      input.jobId ?? null,
      input.jobId ?? null,
    ]
  ).changes;
}

/** Deletes the owner's commitments closed before `before`; returns how many. */
export function prunePersonaCommitments(db: Database, owner: string, before: string): number {
  return db.run("DELETE FROM persona_commitments WHERE owner = ? AND status != 'open' AND closed_at < ?", [owner, before]).changes;
}

/** Records that Persona was woken about commitments `ids` being overdue at `at`. */
export function markPersonaCommitmentsNudged(db: Database, ids: readonly string[], at: string): void {
  if (ids.length === 0) return;
  db.transaction(() => {
    for (const id of ids) db.run("UPDATE persona_commitments SET nudged_at = ? WHERE id = ?", [at, id]);
  })();
}
