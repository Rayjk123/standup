import type { KnowledgeDoc } from "./types.js";

/** Half-life of a doc's confidence when it declares none of its own. */
export const DEFAULT_HALF_LIFE_DAYS = 90;

/** Below this derived confidence a doc is withheld from ask_expert and injection. */
export const CONFIDENCE_FLOOR = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 0.5 ^ (elapsedDays / halfLifeDays). */
export function decayFactor(elapsedDays: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  if (elapsedDays <= 0) return 1;
  return Math.pow(0.5, elapsedDays / halfLifeDays);
}

/**
 * The confidence a doc carries right now: its stored confidence decayed from
 * last_verified_at. A doc with no stored confidence has no opinion and is
 * returned as undefined, which callers treat as exempt from the floor (this is
 * every owner-authored doc that never set one).
 */
export function deriveConfidence(doc: KnowledgeDoc, now: Date = new Date()): number | undefined {
  if (doc.confidence === undefined) return undefined;
  if (!doc.lastVerifiedAt) return doc.confidence;
  const elapsed = (now.getTime() - Date.parse(doc.lastVerifiedAt)) / DAY_MS;
  return doc.confidence * decayFactor(elapsed, doc.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS);
}

export function passesConfidenceFloor(doc: KnowledgeDoc, now: Date = new Date()): boolean {
  const c = deriveConfidence(doc, now);
  return c === undefined || c >= CONFIDENCE_FLOOR;
}
