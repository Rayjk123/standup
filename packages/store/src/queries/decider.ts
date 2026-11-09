import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  DECIDER_BACKENDS,
  DECISION_KINDS,
  type DeciderBackendId,
  type DeciderBackendPrefs,
  type DeciderDecisionRecord,
  type DeciderFallbackReason,
  type DecisionKind,
  type UserDeciderPrefs,
} from "@standup/shared";
import { getSetting, setSetting } from "./settings.js";

/**
 * Storage for the small-decision port (migration 074): the per-user and global
 * backend choices, and the audit log of every decision.
 */

/** The settings key holding the global backend choices, as DeciderBackendPrefs JSON. */
const GLOBAL_DECIDER_KEY = "decider_backends";

/**
 * Keeps only known kinds mapped to known backends, so a hand-edited or stale
 * blob never routes a decision to a backend that doesn't exist.
 */
export function sanitizeDeciderPrefs(raw: unknown): DeciderBackendPrefs {
  const out: DeciderBackendPrefs = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const kind of DECISION_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (typeof value === "string" && (DECIDER_BACKENDS as readonly string[]).includes(value)) {
      out[kind] = value as DeciderBackendId;
    }
  }
  return out;
}

function parsePrefs(json: string | null): DeciderBackendPrefs {
  if (!json) return {};
  try {
    return sanitizeDeciderPrefs(JSON.parse(json));
  } catch {
    // A corrupt blob reads as "no choices" — decisions keep their defaults.
    return {};
  }
}

/** The global backend choices (the layer under every user's). */
export function getGlobalDeciderPrefs(db: Database): DeciderBackendPrefs {
  return parsePrefs(getSetting(db, GLOBAL_DECIDER_KEY));
}

/** Replaces the global backend choices. */
export function putGlobalDeciderPrefs(db: Database, prefs: DeciderBackendPrefs): DeciderBackendPrefs {
  const clean = sanitizeDeciderPrefs(prefs);
  setSetting(db, GLOBAL_DECIDER_KEY, JSON.stringify(clean));
  return clean;
}

/** `alias`'s backend choices; an empty layer when they have never saved one. */
export function getUserDeciderPrefs(db: Database, alias: string): UserDeciderPrefs {
  const row = db
    .query("SELECT backends_json, updated_at FROM user_decider_prefs WHERE alias = ?")
    .get(alias) as { backends_json: string; updated_at: string } | null;
  return row
    ? { alias, backends: parsePrefs(row.backends_json), updatedAt: row.updated_at }
    : { alias, backends: {} };
}

/** Replaces `alias`'s backend choices (a PUT: a kind left out inherits the global layer again). */
export function putUserDeciderPrefs(
  db: Database,
  alias: string,
  backends: DeciderBackendPrefs
): UserDeciderPrefs {
  const clean = sanitizeDeciderPrefs(backends);
  db.run(
    `INSERT INTO user_decider_prefs (alias, backends_json, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(alias) DO UPDATE SET backends_json = excluded.backends_json, updated_at = excluded.updated_at`,
    [alias, JSON.stringify(clean)]
  );
  return getUserDeciderPrefs(db, alias);
}

/** A decision to record; the id and timestamp are assigned here. */
export type DeciderDecisionInput = Omit<DeciderDecisionRecord, "id" | "createdAt">;

interface DecisionRow {
  id: string;
  kind: string;
  backend: string;
  routed_to: string;
  choice: string | null;
  confidence: number | null;
  latency_ms: number;
  fallback_reason: string | null;
  detail: string | null;
  alias: string | null;
  session_id: string | null;
  launch_id: string | null;
  created_at: string;
}

function toRecord(row: DecisionRow): DeciderDecisionRecord {
  return {
    id: row.id,
    kind: row.kind as DecisionKind,
    backend: row.backend as DeciderBackendId,
    routedTo: row.routed_to as DeciderBackendId,
    choice: row.choice,
    confidence: row.confidence,
    latencyMs: row.latency_ms,
    fallbackReason: row.fallback_reason as DeciderFallbackReason | null,
    detail: row.detail,
    alias: row.alias,
    sessionId: row.session_id,
    launchId: row.launch_id,
    createdAt: row.created_at,
  };
}

/** How long a decision stays in the audit log, and how often the log is pruned. */
export const DECIDER_DECISION_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const lastPruned = new WeakMap<Database, number>();

/** Deletes decisions older than the retention window; returns how many went. */
export function pruneDeciderDecisions(db: Database, now: number = Date.now()): number {
  const cutoff = new Date(now - DECIDER_DECISION_RETENTION_MS).toISOString();
  return db.run("DELETE FROM decider_decisions WHERE created_at < ?", [cutoff]).changes;
}

/** Appends one decision to the audit log and returns it, pruning expired rows at most hourly. */
export function recordDeciderDecision(db: Database, input: DeciderDecisionInput): DeciderDecisionRecord {
  const id = randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  if (now - (lastPruned.get(db) ?? 0) >= PRUNE_INTERVAL_MS) {
    lastPruned.set(db, now);
    pruneDeciderDecisions(db, now);
  }
  db.run(
    `INSERT INTO decider_decisions
       (id, kind, backend, routed_to, choice, confidence, latency_ms,
        fallback_reason, detail, alias, session_id, launch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.kind,
      input.backend,
      input.routedTo,
      input.choice,
      input.confidence,
      Math.round(input.latencyMs),
      input.fallbackReason,
      input.detail,
      input.alias,
      input.sessionId,
      input.launchId,
      createdAt,
    ]
  );
  return { ...input, id, createdAt };
}

/** The most recent decisions, newest first; `alias` narrows to that user's. */
export function listDeciderDecisions(
  db: Database,
  { alias, kind, limit = 50 }: { alias?: string; kind?: DecisionKind; limit?: number } = {}
): DeciderDecisionRecord[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (alias !== undefined) {
    where.push("alias = ?");
    params.push(alias);
  }
  if (kind !== undefined) {
    where.push("kind = ?");
    params.push(kind);
  }
  params.push(Math.max(1, Math.min(500, Math.floor(limit))));
  const rows = db
    .query(
      `SELECT * FROM decider_decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...params) as DecisionRow[];
  return rows.map(toRecord);
}
