/**
 * Evidence that moves a doc's confidence, as opposed to the clock (confidence.ts
 * decays the base with age). Each kind of finding caps the base: the doc is
 * judged on the lowest of its base and the cap of every finding that holds
 * now. Findings are recomputed on every pass and stored apart from the doc's
 * own base, never folded into it, so a finding that stops holding (the file
 * comes back, the contradiction is resolved) stops capping on the next pass.
 *
 * The deterministic kinds are computed from the repo without a model (the
 * collector's evidence pass): a path or symbol the doc names that existed when
 * it was last verified and is gone at HEAD, commits to the doc's own files
 * since then, a provenance sha no default branch contains. The contradiction
 * kind reads the doc↔doc verdict the coherence pass recorded, judged on the
 * docs' content dates.
 */

/** The findings the evidence pass reports against a doc. */
export type ConfidenceEvidenceKind =
  /** A file the doc names existed at its anchor commit and is gone at HEAD. */
  | "missing-path"
  /** A code symbol the doc names was in the tree at its anchor commit and is gone at HEAD. */
  | "missing-symbol"
  /** The doc's own files took at least the file-scoped drift threshold of commits since its anchor (priority only). */
  | "file-drift"
  /** The doc's generated_from_sha is on no default branch, or a symbol it names exists only on an unmerged branch. */
  | "unmerged"
  /** A doc with a later content date is recorded as contradicting this one. */
  | "contradicted-by-newer";

export interface ConfidenceEvidence {
  kind: ConfidenceEvidenceKind;
  /** What was found, for a human reading the log: the paths, symbols, counts or slugs. */
  detail: string;
}

/**
 * Base confidence a doc distilled on a branch no default branch contains is
 * held to: its claims describe code that may never land, so it is
 * provisional — above the injection floor, but on a lower base that decays
 * below it sooner.
 */
export const PROVISIONAL_CONFIDENCE = 0.6;

/**
 * The cap each finding puts on a doc's base. A file the doc is about being
 * deleted is the strongest code-side signal short of a model refuting it; a
 * vanished symbol is a little weaker (it may have moved to a path outside the
 * search). A newer doc contradicting this one caps it just above the injection
 * floor, so the decay clock takes it out within weeks unless it is re-verified
 * or the contradiction is resolved in its favor. Churn on the doc's files caps
 * nothing: a design doc that names a busy file is not wrong for it, so drift
 * only raises the doc's re-verification priority. Every cap stays above
 * DISPUTED_CONFIDENCE: none of these is a refutation.
 */
export const EVIDENCE_CONFIDENCE_CAPS: Readonly<Partial<Record<ConfidenceEvidenceKind, number>>> = {
  "missing-path": 0.5,
  "missing-symbol": 0.6,
  unmerged: PROVISIONAL_CONFIDENCE,
  "contradicted-by-newer": 0.3,
};

/** The lowest cap among `evidence`'s findings, or undefined when none of them caps. */
export function evidenceCap(evidence: readonly ConfidenceEvidence[]): number | undefined {
  let cap: number | undefined;
  for (const e of evidence) {
    const c = EVIDENCE_CONFIDENCE_CAPS[e.kind];
    if (c !== undefined) cap = cap === undefined ? c : Math.min(cap, c);
  }
  return cap;
}

/** The base confidence a doc holds under `evidence`: the lowest of its base and every finding's cap. */
export function confidenceUnderEvidence(
  base: number,
  evidence: readonly ConfidenceEvidence[]
): number {
  const out = Number.isFinite(base) ? Math.max(0, Math.min(1, base)) : 0;
  const cap = evidenceCap(evidence);
  return cap === undefined ? out : Math.min(out, cap);
}
