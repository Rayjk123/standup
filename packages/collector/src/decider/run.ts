import type { Database } from "bun:sqlite";
import type {
  DeciderBackendId,
  DeciderBackendPrefs,
  DeciderDecisionRecord,
  DeciderFallbackReason,
} from "@standup/shared";
import { getGlobalDeciderPrefs, getUserDeciderPrefs, recordDeciderDecision } from "@standup/store";
import { resolveKindConfig } from "./config.js";
import { DeciderError, shortError, type Decider, type DeciderAnswer, type DecisionRequest } from "./types.js";

/** Who and what a decision is for; every field is optional. Without `db` nothing is recorded and only defaults route. */
export interface DecisionContext {
  db?: Database;
  /** The user whose routing applies, and who the audit row is attributed to. */
  alias?: string | null;
  sessionId?: string | null;
  launchId?: string | null;
}

export interface DecisionBackends {
  /** The claude backend, always present. */
  claude: Decider;
  claudeTimeoutMs: number;
}

export interface DecisionOutcome {
  /** The answer used, or null when no backend answered (the caller keeps its default). */
  answer: DeciderAnswer | null;
  /** The backend whose answer was used — or, with no answer, the one tried. */
  backend: DeciderBackendId;
  routedTo: DeciderBackendId;
  latencyMs: number;
  fallbackReason: DeciderFallbackReason | null;
  /** A short failure detail from the backend that failed. */
  detail: string | null;
  record: DeciderDecisionRecord | null;
}

/**
 * Makes one decision: routes it to its configured backend and records the
 * outcome when a db is given. A backend that fails leaves the answer null, so
 * the caller keeps its own default. Never throws.
 */
export async function runDecision(
  ctx: DecisionContext,
  req: DecisionRequest,
  backends: DecisionBackends
): Promise<DecisionOutcome> {
  const started = performance.now();
  let user: DeciderBackendPrefs = {};
  let global: DeciderBackendPrefs = {};
  try {
    if (ctx.db && ctx.alias) user = getUserDeciderPrefs(ctx.db, ctx.alias).backends;
    if (ctx.db) global = getGlobalDeciderPrefs(ctx.db);
  } catch (err) {
    // An unreadable settings layer routes on the defaults rather than failing the decision.
    console.log(`[decider] routing settings unreadable, using defaults: ${shortError(err)}`);
  }
  const config = resolveKindConfig(req.kind, user, global);
  const decider = backends.claude;
  // With one backend there is nothing to fall back to; the field stays in the audit shape.
  const fallbackReason = null;
  let detail: string | null = null;
  let answer: DeciderAnswer | null = null;

  try {
    answer = await decider.decide(req, { timeoutMs: backends.claudeTimeoutMs });
  } catch (err) {
    detail = err instanceof DeciderError ? err.message : shortError(err);
  }
  const backend = decider.backend;

  const latencyMs = performance.now() - started;
  console.log(
    `[decider] ${req.kind} backend=${backend} routed=${config.backend} choice=${answer?.choice ?? "-"} ` +
      `confidence=${answer?.confidence ?? "-"} latencyMs=${Math.round(latencyMs)}` +
      (detail ? ` detail="${detail}"` : "")
  );

  let record: DeciderDecisionRecord | null = null;
  if (ctx.db) {
    try {
      record = recordDeciderDecision(ctx.db, {
        kind: req.kind,
        backend,
        routedTo: config.backend,
        choice: answer?.choice ?? null,
        confidence: answer?.confidence ?? null,
        latencyMs,
        fallbackReason,
        detail,
        alias: ctx.alias ?? null,
        sessionId: ctx.sessionId ?? null,
        launchId: ctx.launchId ?? null,
      });
    } catch (err) {
      // The audit row is best-effort: a decision is never lost to a write failure.
      console.log(`[decider] audit write failed: ${shortError(err)}`);
    }
  }

  return { answer, backend, routedTo: config.backend, latencyMs, fallbackReason, detail, record };
}
