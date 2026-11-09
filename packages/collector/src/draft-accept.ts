/**
 * Pure decision logic for accepting a knowledge draft, factored out of the
 * route handlers in server.ts so it can be unit tested without a database
 * or a filesystem.
 *
 * The merge-vs-replace choice is the single most important requirement in
 * phase-7.md's Step 5: the first real bootstrap run showed a regenerated
 * draft is usually a *supplement* to what a human wrote, not a replacement
 * for it, so accept must never silently overwrite when `replaces_slug` is
 * set. `resolveAcceptMode` is where that default lives.
 */

export type AcceptMode = "merge" | "replace";

/**
 * What accept should actually do with a draft.
 *
 * Returns null when there is nothing to decide — a first-bootstrap draft
 * (no replaces_slug) always just moves the file, and "merge" or "replace"
 * would be a meaningless distinction for a doc that isn't overwriting
 * anything. Callers should treat null as "plain accept" rather than an
 * error.
 *
 * Any requested mode other than the literal string "replace" resolves to
 * "merge" — an unrecognised or missing value defaults to the safe choice
 * rather than the destructive one.
 */
export function resolveAcceptMode(
  replacesSlug: string | undefined,
  requestedMode: string | undefined
): AcceptMode | null {
  if (!replacesSlug) return null;
  return requestedMode === "replace" ? "replace" : "merge";
}

/**
 * Whether a pending draft is safe for accept-all to sweep up without asking
 * first. Two things stay in the human's hands even under accept-all:
 * anything that would overwrite existing work (replaces_slug set) and
 * anything the adversarial verifier disputed. Accept-all silently taking
 * either would defeat the point of having a human review step at all.
 */
export function isAcceptAllEligible(draft: {
  replacesSlug?: string;
  verdict: string;
}): boolean {
  return !draft.replacesSlug && draft.verdict !== "disputed";
}
