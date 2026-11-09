import type { Database } from "bun:sqlite";
import {
  DECISION_KINDS,
  SUGGESTION_ONLY_KINDS,
  type DeciderBackendId,
  type DeciderBackendPrefs,
  type DeciderKindConfig,
  type DecisionKind,
} from "@standup/shared";
import { getGlobalDeciderPrefs, getUserDeciderPrefs } from "@standup/store";

/**
 * How each decision is routed, layered most-specific-wins: the user's choice
 * (the You tab), then the global choice (the `decider_backends` setting), then
 * the built-in default below. A layer only ever names a backend in
 * DECIDER_BACKENDS (the store drops anything else).
 */

/** The built-in routing: every decision runs on claude. */
export const DEFAULT_DECIDER_BACKENDS: Record<DecisionKind, DeciderBackendId> = {
  project: "claude",
  turn_end: "claude",
  effort: "claude",
  model: "claude",
};

/** Resolves one kind's routing from the user and global layers. */
export function resolveKindConfig(
  kind: DecisionKind,
  user: DeciderBackendPrefs,
  global: DeciderBackendPrefs
): DeciderKindConfig {
  const [backend, source] =
    user[kind] !== undefined
      ? [user[kind]!, "user" as const]
      : global[kind] !== undefined
        ? [global[kind]!, "global" as const]
        : [DEFAULT_DECIDER_BACKENDS[kind], "default" as const];
  return {
    kind,
    backend,
    source,
    defaultBackend: DEFAULT_DECIDER_BACKENDS[kind],
    suggestionOnly: SUGGESTION_ONLY_KINDS.includes(kind),
  };
}

/** Every kind's routing for `alias` (or the global/default layers alone, with no alias or db). */
export function resolveDeciderConfig(db: Database | undefined, alias: string | null | undefined): DeciderKindConfig[] {
  const global = db ? getGlobalDeciderPrefs(db) : {};
  const user = db && alias ? getUserDeciderPrefs(db, alias).backends : {};
  return DECISION_KINDS.map((kind) => resolveKindConfig(kind, user, global));
}
