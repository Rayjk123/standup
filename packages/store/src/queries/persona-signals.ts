import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  NOISY_HOLD_MIN_APPROVE_RATE,
  NOISY_HOLD_MIN_SAMPLES,
  holdRuleExclusion,
  inferHoldRule,
  isRetiredHoldRule,
  type PersonaApprovalStatus,
  type PersonaAudience,
  type PersonaHoldReport,
  type PersonaHoldReportRow,
} from "@standup/shared";
import { getSetting } from "./settings.js";

/**
 * Kinds of preference signal (migration 056). `approval`, `option_reply` and
 * `persona_action` are captured; the rest are reserved kinds that nothing
 * records yet.
 */
export const PERSONA_SIGNAL_KINDS = [
  "approval",
  "option_reply",
  "correction",
  "rewrite",
  "ignored",
  "routing",
  "activity",
  "style_feedback",
  "owner_length",
  "request",
  "persona_action",
] as const;

export type PersonaSignalKind = (typeof PERSONA_SIGNAL_KINDS)[number];

/** Who produced a signal: the owner, or the system observing Persona. Never a worker. */
export type PersonaSignalActor = "owner" | "system";

export interface PersonaSignal {
  id: string;
  owner: string;
  kind: PersonaSignalKind;
  actor: PersonaSignalActor;
  /** What the signal is about: an action name, a hold rule, a project id. */
  subject?: string;
  /** Kind-specific structured fields; never free text. */
  value: Record<string, unknown>;
  threadId?: string;
  jobId?: string;
  messageId?: string;
  approvalId?: string;
  audience: PersonaAudience;
  channel?: string;
  occurredAt: string;
  createdAt: string;
}

/** Setting that turns signal capture off when set to `off`. */
export const PERSONA_SIGNAL_CAPTURE_SETTING = "persona.preferences.capture";

/** Whether preference signals are being captured (on unless the setting says `off`). */
export function personaSignalCaptureEnabled(db: Database): boolean {
  return getSetting(db, PERSONA_SIGNAL_CAPTURE_SETTING)?.trim().toLowerCase() !== "off";
}

export interface RecordPersonaSignalInput {
  owner: string;
  kind: PersonaSignalKind;
  actor: PersonaSignalActor;
  subject?: string;
  value: Record<string, unknown>;
  threadId?: string;
  jobId?: string;
  messageId?: string;
  approvalId?: string;
  audience?: PersonaAudience;
  channel?: string;
  occurredAt?: string;
}

interface SignalRow {
  id: string;
  owner: string;
  kind: string;
  actor: string;
  subject: string | null;
  value_json: string;
  thread_id: string | null;
  job_id: string | null;
  message_id: string | null;
  approval_id: string | null;
  audience: string;
  channel: string | null;
  occurred_at: string;
  created_at: string;
}

function toSignal(row: SignalRow): PersonaSignal {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.value_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch {
    // A malformed row reads as an empty value.
  }
  return {
    id: row.id,
    owner: row.owner,
    kind: row.kind as PersonaSignalKind,
    actor: row.actor as PersonaSignalActor,
    ...(row.subject ? { subject: row.subject } : {}),
    value,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    audience: row.audience as PersonaAudience,
    ...(row.channel ? { channel: row.channel } : {}),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/**
 * Records one signal and returns it, or null when capture is off. The table's
 * CHECKs refuse an unknown kind or an actor other than the owner or the system.
 */
export function recordPersonaSignal(db: Database, input: RecordPersonaSignalInput): PersonaSignal | null {
  if (!personaSignalCaptureEnabled(db)) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO persona_signals
       (id, owner, kind, actor, subject, value_json, thread_id, job_id, message_id, approval_id, audience, channel, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.kind,
      input.actor,
      input.subject ?? null,
      JSON.stringify(input.value),
      input.threadId ?? null,
      input.jobId ?? null,
      input.messageId ?? null,
      input.approvalId ?? null,
      input.audience ?? "private",
      input.channel ?? null,
      input.occurredAt ?? now,
      now,
    ]
  );
  const row = db.query("SELECT * FROM persona_signals WHERE id = ?").get(id) as SignalRow;
  return toSignal(row);
}

/**
 * The owner's signals, oldest first, optionally of one kind (or all but `excludeKind`), from `since` (an
 * ISO time, inclusive) on, and strictly after the signal `afterId` in that
 * order — a cursor that pages past signals sharing a time. An unknown
 * `afterId` matches nothing.
 */
export function listPersonaSignals(
  db: Database,
  owner: string,
  opts: { kind?: PersonaSignalKind; excludeKind?: PersonaSignalKind; since?: string; afterId?: string; limit?: number } = {}
): PersonaSignal[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const where = ["owner = ?"];
  const params: string[] = [owner];
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.excludeKind) {
    where.push("kind != ?");
    params.push(opts.excludeKind);
  }
  if (opts.since) {
    where.push("occurred_at >= ?");
    params.push(opts.since);
  }
  if (opts.afterId) {
    where.push("(occurred_at, rowid) > (SELECT occurred_at, rowid FROM persona_signals WHERE id = ? AND owner = ?)");
    params.push(opts.afterId, owner);
  }
  const rows = db
    .query(`SELECT * FROM persona_signals WHERE ${where.join(" AND ")} ORDER BY occurred_at ASC, rowid ASC LIMIT ?`)
    .all(...params, limit) as SignalRow[];
  return rows.map(toSignal);
}

/**
 * Whether the owner was at the keyboard within `windowMs` of `at`: they sent
 * Persona a message, or decided another approval, in that window. Separates
 * "was away" from "had to think" in a hold's time to decide.
 */
export function personaOwnerActiveNear(
  db: Database,
  owner: string,
  at: string,
  windowMs: number,
  excludeApprovalId?: string
): boolean {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  const from = new Date(t - windowMs).toISOString();
  const to = new Date(t + windowMs).toISOString();
  const message = db
    .query(
      `SELECT 1 FROM persona_messages m JOIN persona_threads t ON t.id = m.thread_id
        WHERE t.owner = ? AND m.role = 'user' AND m.created_at BETWEEN ? AND ? LIMIT 1`
    )
    .get(owner, from, to);
  if (message) return true;
  const decision = db
    .query(
      `SELECT 1 FROM persona_approvals
        WHERE owner = ? AND decided_by = ? AND id != ? AND decided_at BETWEEN ? AND ? LIMIT 1`
    )
    .get(owner, owner, excludeApprovalId ?? "", from, to);
  return !!decision;
}

/** Whether an `option_reply` signal already answers the Persona message `messageId`. */
export function personaOptionReplyRecorded(db: Database, owner: string, messageId: string): boolean {
  return !!db
    .query("SELECT 1 FROM persona_signals WHERE owner = ? AND kind = 'option_reply' AND message_id = ? LIMIT 1")
    .get(owner, messageId);
}

// ── Noisy-hold report ───────────────────────────────────────────────────────

const APPROVED_STATUSES: ReadonlySet<PersonaApprovalStatus> = new Set<PersonaApprovalStatus>(["approved", "executed", "failed"]);

/** The middle value of `values` (the mean of the two middle ones for an even count); null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface ReportApprovalRow {
  action: string;
  reason: string | null;
  hold_rule: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
}

/**
 * The owner's held actions grouped by the policy rule they were held under:
 * how many the owner decided, how many of those they approved, the approve
 * rate, the median time to decide, and what never got a decision. A row is
 * `noisy` when it has at least NOISY_HOLD_MIN_SAMPLES decisions, at least
 * NOISY_HOLD_MIN_APPROVE_RATE of them approvals, and its rule is a current
 * one that may be loosened (holdRuleExclusion). Approvals stored without a
 * rule are attributed by their reason text and the row marked `inferred`.
 *
 * Read-only: it suggests where holds look like noise and changes nothing.
 * Pending, expired and superseded approvals are counted but are not
 * decisions, so they never move the approve rate.
 */
export function personaHoldReport(db: Database, owner: string, opts: { since?: string } = {}): PersonaHoldReport {
  const rows = (
    opts.since
      ? db
          .query(
            "SELECT action, reason, hold_rule, status, created_at, decided_at FROM persona_approvals WHERE owner = ? AND created_at >= ? ORDER BY created_at ASC"
          )
          .all(owner, opts.since)
      : db
          .query("SELECT action, reason, hold_rule, status, created_at, decided_at FROM persona_approvals WHERE owner = ? ORDER BY created_at ASC")
          .all(owner)
  ) as ReportApprovalRow[];

  interface Group {
    row: PersonaHoldReportRow;
    decideMs: number[];
    actions: Map<string, { decided: number; approved: number }>;
  }
  const groups = new Map<string, Group>();
  let unattributed = 0;

  for (const a of rows) {
    const stored = a.hold_rule?.trim() || null;
    const rule = stored ?? inferHoldRule(a.action, a.reason);
    if (!rule) {
      unattributed++;
      continue;
    }
    let group = groups.get(rule);
    if (!group) {
      const excluded = holdRuleExclusion(rule);
      group = {
        row: {
          holdRule: rule,
          inferred: false,
          retired: isRetiredHoldRule(rule),
          ...(excluded ? { excluded } : {}),
          decided: 0,
          approved: 0,
          denied: 0,
          approveRate: null,
          medianDecideMs: null,
          pending: 0,
          expired: 0,
          superseded: 0,
          noisy: false,
          actions: [],
          lastAt: a.created_at,
        },
        decideMs: [],
        actions: new Map(),
      };
      groups.set(rule, group);
    }
    const { row } = group;
    if (!stored) row.inferred = true;
    if (a.created_at > row.lastAt) row.lastAt = a.created_at;
    const status = a.status as PersonaApprovalStatus;
    const approved = APPROVED_STATUSES.has(status);
    if (approved || status === "denied") {
      row.decided++;
      if (approved) row.approved++;
      else row.denied++;
      const perAction = group.actions.get(a.action) ?? { decided: 0, approved: 0 };
      perAction.decided++;
      if (approved) perAction.approved++;
      group.actions.set(a.action, perAction);
      if (a.decided_at) {
        const ms = Date.parse(a.decided_at) - Date.parse(a.created_at);
        if (Number.isFinite(ms) && ms >= 0) group.decideMs.push(ms);
      }
    } else if (status === "pending") row.pending++;
    else if (status === "expired") row.expired++;
    else if (status === "superseded") row.superseded++;
  }

  const report: PersonaHoldReportRow[] = [];
  for (const { row, decideMs, actions } of groups.values()) {
    row.approveRate = row.decided > 0 ? row.approved / row.decided : null;
    row.medianDecideMs = median(decideMs);
    row.actions = [...actions.entries()]
      .map(([action, n]) => ({ action, ...n }))
      .sort((x, y) => y.decided - x.decided || x.action.localeCompare(y.action));
    row.noisy =
      !row.retired &&
      !row.excluded &&
      row.decided >= NOISY_HOLD_MIN_SAMPLES &&
      row.approveRate !== null &&
      row.approveRate >= NOISY_HOLD_MIN_APPROVE_RATE;
    report.push(row);
  }
  report.sort((x, y) => Number(y.noisy) - Number(x.noisy) || y.decided - x.decided || x.holdRule.localeCompare(y.holdRule));

  return {
    ...(opts.since ? { since: opts.since } : {}),
    minSamples: NOISY_HOLD_MIN_SAMPLES,
    minApproveRate: NOISY_HOLD_MIN_APPROVE_RATE,
    rows: report,
    unattributed,
  };
}
