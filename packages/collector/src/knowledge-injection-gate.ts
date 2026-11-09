import { isOriginEligibleForInjection, isVerdictAdmissible, type SearchResult } from "@standup/knowledge";
import type { FreshnessGate, FreshnessHit } from "./knowledge-freshness.js";

/** The fields of a hit the launch-injection trust gates read. */
export type InjectionGateHit = FreshnessHit & Pick<SearchResult, "originClass" | "verdict" | "contradiction">;

/** The trust gate that holds a hit out of launch injection. */
export type InjectionGateReason = "origin" | "verdict" | "freshness";

/**
 * The trust gate (origin, coherence verdict, freshness) that holds `r` out of
 * launch injection, or null when it passes all three. The relevance floor is
 * applied separately by each surface. A disputed doc's confidence is the
 * dispute's own write-down (DISPUTED_CONFIDENCE), below the freshness floor by
 * design; the verdict already carries that judgment — demoted in rank, marked
 * on every surface — so the freshness gate does not count it a second time.
 */
export function injectionGateReason(r: InjectionGateHit, freshness: FreshnessGate): InjectionGateReason | null {
  if (!isOriginEligibleForInjection(r.originClass)) return "origin";
  // A superseded doc, and a contradicted one unless it is the winning or an
  // undecided side, is held out. A disputed doc passes at the rank the
  // search's trust demotion gave it.
  if (!isVerdictAdmissible(r, "inject")) return "verdict";
  if (r.verdict !== "disputed" && !freshness.eligible(r)) return "freshness";
  return null;
}

/** When `r` went stale for injection's ranking and dating; never set for a disputed doc (see injectionGateReason). */
export function injectionStaleSince(r: InjectionGateHit, freshness: FreshnessGate): string | undefined {
  return r.verdict === "disputed" ? undefined : freshness.staleSince(r);
}
