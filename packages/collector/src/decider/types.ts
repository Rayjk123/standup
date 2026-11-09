import type { DeciderBackendId, DeciderFallbackReason, DecisionKind } from "@standup/shared";

/**
 * The Decider port: the one interface Standup's small decisions go through.
 *
 * A decision is a single choice among a few named options, made from a block
 * of state text. A backend implements `Decider`; a caller never talks to a
 * backend directly but goes through `runDecision` (run.ts), which routes the
 * decision to its configured backend and records the outcome for audit.
 *
 * Adding a decision:
 * 1. Add its kind to DECISION_KINDS (@standup/shared decider.ts).
 * 2. Build a `DecisionRequest` and a `claude` backend for it — `claudeDecider`
 *    with the decision's own prompt and parser.
 * 3. Call `runDecision(ctx, request, { claude })`.
 */

/** One decision to make. */
export interface DecisionRequest {
  kind: DecisionKind;
  /** The text the decision is made from: the task, a transcript tail. */
  state: string;
  /** The question, phrased for a decision model ("Which project does this task belong to?"). */
  question: string;
  /** Option key → one-line description. A backend's answer is always one of these keys. */
  options: Record<string, string>;
}

/** A backend's answer. */
export interface DeciderAnswer {
  /** One of the request's option keys. */
  choice: string;
  /** The backend's confidence in [0, 1]; null when it reports none (claude reports none). */
  confidence: number | null;
  /** A short free-text reason, when the backend gives one (the turn-end classifier does). */
  reason?: string;
}

/** Why a backend produced no answer. */
export class DeciderError extends Error {
  constructor(
    readonly reason: DeciderFallbackReason,
    detail: string
  ) {
    super(detail);
    this.name = "DeciderError";
  }
}

/** A decision backend. */
export interface Decider {
  readonly backend: DeciderBackendId;
  /**
   * Answers `req`, or rejects with a DeciderError. Must settle within
   * `timeoutMs` (rejecting with reason `timeout`) and stop work when `signal`
   * aborts.
   */
  decide(req: DecisionRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<DeciderAnswer>;
}

/** A one-line, bounded form of an error, safe for a log line or an audit row. */
export function shortError(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  const text = e?.message ? `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}` : String(err);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
