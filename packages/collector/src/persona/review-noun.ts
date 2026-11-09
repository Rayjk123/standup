import { activeOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";

/** `text` with every regex metacharacter escaped, so a regex built from it matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The org profile's code-review noun (`codeReview.noun`: `CL`, `change
 * request`) as a regex source matching it and its plural, its words joined
 * by any run of whitespace (`(?:change\s+requests?)`); null when the profile
 * names none. Lowercased, so it matches the lowercased text the allow check
 * reads and, in a regex with the `i` flag, any case.
 */
export function reviewNounSource(profile: OrgProfile): string | null {
  const words = (profile.codeReview.noun ?? "").trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return null;
  return String.raw`(?:${words.map((w) => escapeRegExp(w.toLowerCase())).join(String.raw`\s+`)}s?)`;
}

/**
 * The review noun every profile reads, its own or not: "change request", a
 * name for a code review that review tools and change-management processes
 * share. Its abbreviation is left to a profile's `codeReview.noun`, since a
 * two-letter word reads as a review only in an org that uses it so.
 */
export const BUILT_IN_REVIEW_NOUN = String.raw`(?:change\s+requests?)`;

/**
 * The review nouns a profile reads: BUILT_IN_REVIEW_NOUN and the profile's
 * own (reviewNounSource), as one regex source.
 */
export function reviewNounsOf(profile: OrgProfile): string {
  const own = reviewNounSource(profile);
  return own ? `(?:${BUILT_IN_REVIEW_NOUN}|${own})` : BUILT_IN_REVIEW_NOUN;
}

/**
 * A value built once per org profile from its review nouns (reviewNounsOf).
 * The returned function reads the collector's active profile when it is
 * given none, so patterns that name a review follow the org's own word for
 * one.
 */
export function perReviewNoun<T>(build: (noun: string | null) => T): (profile?: OrgProfile) => T {
  const cache = new WeakMap<OrgProfile, T>();
  return (profile: OrgProfile = activeOrgProfile()): T => {
    if (cache.has(profile)) return cache.get(profile)!;
    const built = build(reviewNounsOf(profile));
    cache.set(profile, built);
    return built;
  };
}

/** `noun` as one more alternative after `|`, or nothing: for appending inside a group of review words. */
export function orNoun(noun: string | null): string {
  return noun ? `|${noun}` : "";
}
