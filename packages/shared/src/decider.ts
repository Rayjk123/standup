/**
 * Shared types for Standup's small-decision port (packages/collector/src/decider).
 *
 * A "decision" is a one-shot classification — which project a launch belongs
 * to, how a turn ended, a suggested effort or model — answered by a decision
 * backend. The built-in backend is `claude` (a headless `claude -p` call); the
 * port routes, records and audits every decision so another backend can be
 * added behind it.
 */

/** The decisions that go through the port. */
export const DECISION_KINDS = ["project", "turn_end", "effort", "model"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** The backends a decision can be answered by. */
export const DECIDER_BACKENDS = ["claude"] as const;
export type DeciderBackendId = (typeof DECIDER_BACKENDS)[number];

/**
 * Decisions whose answer is only ever shown as a suggestion and never applied to
 * a launch: a human or Persona still chooses the effort and the model.
 */
export const SUGGESTION_ONLY_KINDS: readonly DecisionKind[] = ["effort", "model"];

/** One layer of backend choices: a kind left out inherits from the layer below. */
export type DeciderBackendPrefs = Partial<Record<DecisionKind, DeciderBackendId>>;

/** A user's decider preferences, as the You tab edits them. */
export interface UserDeciderPrefs {
  alias: string;
  backends: DeciderBackendPrefs;
  updatedAt?: string;
}

/**
 * Why a backend produced no answer: the failure classes a backend reports
 * (DeciderError). A decision records one as its fallbackReason only when it
 * fell back from the backend it was routed to; with `claude` the only backend
 * there is nothing to fall back to, so the record's fallbackReason stays null.
 */
export type DeciderFallbackReason = "timeout" | "error" | "invalid_answer";

/** The resolved decider configuration for one decision kind, as the API reports it. */
export interface DeciderKindConfig {
  kind: DecisionKind;
  /** The backend this kind is routed to after every layer. */
  backend: DeciderBackendId;
  /** Where the routed backend came from. */
  source: "user" | "global" | "default";
  /** The built-in backend, used when neither layer sets one. */
  defaultBackend: DeciderBackendId;
  suggestionOnly: boolean;
}

/** GET /api/decider/config: the viewer's resolved routing. */
export interface DeciderConfigView {
  alias: string;
  /** Whether the viewer is the owner, who alone may change the global layer. */
  isOwner: boolean;
  kinds: DeciderKindConfig[];
  user: DeciderBackendPrefs;
  global: DeciderBackendPrefs;
}

/** One recorded decision, for audit. */
export interface DeciderDecisionRecord {
  id: string;
  kind: DecisionKind;
  /** The backend whose answer was used. */
  backend: DeciderBackendId;
  /** The backend the decision was routed to before any fallback. */
  routedTo: DeciderBackendId;
  choice: string | null;
  confidence: number | null;
  /** Wall time of the whole decision, fallback included. */
  latencyMs: number;
  fallbackReason: DeciderFallbackReason | null;
  /** A short failure detail (an HTTP status, an error message), never a prompt. */
  detail: string | null;
  alias: string | null;
  sessionId: string | null;
  launchId: string | null;
  createdAt: string;
}

/** POST /api/decider/suggest: effort and model suggestions for a task, never applied. */
export interface LaunchSuggestion {
  effort: { choice: string | null; confidence: number | null; backend: DeciderBackendId; latencyMs: number } | null;
  model: { choice: string | null; confidence: number | null; backend: DeciderBackendId; latencyMs: number } | null;
}
