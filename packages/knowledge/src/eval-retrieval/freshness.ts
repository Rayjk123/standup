import type { Database } from "bun:sqlite";
import {
  belowFloorSince,
  deriveConfidence,
  isConfidenceEligibleForInjection,
  MIN_INJECTION_CONFIDENCE,
  withConfidenceDefaults,
  type ConfidenceInputs,
} from "../confidence.js";
import { layerOf } from "../types.js";

/**
 * The freshness gate as the eval fixture can see it: a mirror of collector
 * `knowledge-freshness.ts` freshnessGate and demoteStale.
 *
 * freshnessGate derives each doc's confidence inputs from its stored row
 * (withConfidenceDefaults over body, generated_at, content_first_seen,
 * updated_at), caps them by the evidence pass's findings, and treats a doc as
 * recoverable when its project's model re-verification is on. The fixture runs
 * no evidence pass and no fixture project opts into model re-verification, so
 * here there is never a cap, an anchor date or a recovery path: decay alone
 * decides `eligible` and `staleSince`. Swap this module for the real gate once
 * it is importable without the collector.
 */

/** The fields of a hit the gate reads (collector FreshnessHit). */
export interface FreshnessHit {
  projectId: string;
  slug: string;
  scope?: string;
  sourceKind?: string;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
}

export interface FreshnessMirror {
  inputs(hit: FreshnessHit): ConfidenceInputs;
  currentConfidence(hit: FreshnessHit): number | undefined;
  eligible(hit: FreshnessHit): boolean;
  staleSince(hit: FreshnessHit): string | undefined;
}

interface StoredFields {
  body: string;
  generated_at: string | null;
  updated_at: string | null;
  content_first_seen: string | null;
  scope: string | null;
  source_kind: string | null;
}

/** A stored timestamp (ISO or SQLite `YYYY-MM-DD HH:MM:SS`, UTC) as ISO, or undefined. */
function storedIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.includes("T") || !value.includes(" ") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function decayOnlyFreshnessGate(db: Database, now: Date): FreshnessMirror {
  const query = db.query(
    "SELECT body, generated_at, updated_at, content_first_seen, scope, source_kind FROM knowledge WHERE project_id = ? AND slug = ?"
  );
  const lookup = (projectId: string, slug: string) => (query.get(projectId, slug) as StoredFields | null) ?? null;
  const memo = new Map<string, ConfidenceInputs>();

  const inputs = (hit: FreshnessHit): ConfidenceInputs => {
    const key = `${hit.projectId}/${hit.slug}`;
    const known = memo.get(key);
    if (known) return known;
    const row = lookup(hit.projectId, hit.slug);
    const asserted: ConfidenceInputs = {
      confidence: hit.confidence,
      lastVerifiedAt: hit.lastVerifiedAt,
      halfLifeDays: hit.halfLifeDays,
    };
    const out = row
      ? withConfidenceDefaults({
          ...asserted,
          body: row.body,
          generatedAt: storedIso(row.generated_at),
          contentFirstSeen: storedIso(row.content_first_seen),
          updatedAt: storedIso(row.updated_at),
        })
      : asserted;
    memo.set(key, out);
    return out;
  };

  /** Personal docs and activity notes never decay. */
  const decays = (hit: FreshnessHit): boolean => {
    const row = lookup(hit.projectId, hit.slug);
    const layer = layerOf({ scope: row?.scope ?? hit.scope, sourceKind: row?.source_kind ?? hit.sourceKind, slug: hit.slug });
    return layer !== "personal" && layer !== "activity";
  };

  return {
    inputs,
    currentConfidence: (hit) => deriveConfidence(inputs(hit), now),
    eligible: (hit) => isConfidenceEligibleForInjection(inputs(hit), { reverifyActive: false, now }),
    staleSince: (hit) => {
      if (!decays(hit)) return undefined;
      const i = inputs(hit);
      const current = deriveConfidence(i, now);
      if (current === undefined || current >= MIN_INJECTION_CONFIDENCE) return undefined;
      return belowFloorSince(i);
    },
  };
}

/**
 * `items` with each stale one moved just after the last fresh item from the
 * same project that ranked below it; every other item keeps its place
 * (collector `knowledge-freshness.ts` demoteStale).
 */
export function demoteStale<T extends { projectId: string }>(
  items: readonly T[],
  staleSince: (item: T) => string | undefined
): T[] {
  const out = [...items];
  const stale = out.map((item) => !!staleSince(item));
  for (let i = out.length - 1; i >= 0; i--) {
    if (!stale[i]) continue;
    let j = -1;
    for (let k = out.length - 1; k > i; k--) {
      if (!stale[k] && out[k].projectId === out[i].projectId) {
        j = k;
        break;
      }
    }
    if (j === -1) continue;
    const [item] = out.splice(i, 1);
    const [flag] = stale.splice(i, 1);
    out.splice(j, 0, item);
    stale.splice(j, 0, flag);
  }
  return out;
}
