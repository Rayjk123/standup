// ============================================================================
// Code reviews (pull requests) — the review a change goes through before its
// owner signs off: the delivery pipeline's code_review stage records one, a
// review packet links it, and the board shows it. Which review tool a project
// uses is the collector's CodeReviewAdapter; this file reads review links in
// the shape every adapter shares. No node imports: the web bundles this file.
// ============================================================================

import type { ReviewLink } from "./review.js";

/** The pipeline stage kind (and the default pipeline's stage id) that records a change's code review. */
export const CODE_REVIEW_STAGE_KIND = "code_review";

/** The review-packet link kind that names the change's code review. */
export const CODE_REVIEW_LINK_KIND = "code_review";

/** A code review a link or a stage's evidence names: its id and its page. */
export interface CodeReviewRef {
  id: string;
  url: string;
}

/**
 * How a review tool's links read. Every field is optional: without any, a
 * code_review link names its review by its http(s) URL, the id read from the
 * URL's path (reviewIdFromUrl).
 */
export interface CodeReviewLinkFormat {
  /**
   * A regex source matched (case-insensitively) against a link's URL, its
   * first group the review id. Set, it also finds the review among links of
   * other kinds, and a code_review link whose URL doesn't match names none.
   */
  urlPattern?: string;
  /** A regex source matching a bare review id in a code_review link's label or URL (e.g. `PR-\d+`). */
  idPattern?: string;
  /** The page of a bare review id, `{id}` replaced by it (e.g. `https://review.example/{id}`). */
  urlTemplate?: string;
}

/** Path segments after which a review URL carries the review's id (`/pull/12`, `/merge_requests/7`, `/reviews/R-3`). */
const REVIEW_COLLECTIONS = new Set(["pull", "pulls", "merge_requests", "reviews", "review", "changes", "diffs"]);

/**
 * The review id an http(s) review URL names: the path segment after a review
 * collection (REVIEW_COLLECTIONS), else the URL's last path segment, else its
 * host. Null for anything that isn't an http(s) URL.
 */
export function reviewIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  for (let i = 0; i < segments.length - 1; i++) {
    if (REVIEW_COLLECTIONS.has(segments[i]!.toLowerCase())) return segments[i + 1]!;
  }
  return segments.at(-1) ?? parsed.hostname;
}

function compile(source: string | undefined, flags = "i"): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The review a URL names under `format`, or null. */
export function codeReviewOfUrl(url: string, format: CodeReviewLinkFormat = {}): CodeReviewRef | null {
  const value = text(url);
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  if (format.urlPattern) {
    // A pattern that doesn't compile matches nothing: it never widens to any URL.
    const pattern = compile(format.urlPattern);
    const m = pattern ? value.match(pattern) : null;
    return m ? { id: m[1] ?? m[0], url: value } : null;
  }
  const id = reviewIdFromUrl(value);
  return id ? { id, url: value } : null;
}

/** The review a bare id (in a label or a non-URL value) names under `format`: only with both idPattern and urlTemplate. */
export function codeReviewOfId(value: string, format: CodeReviewLinkFormat = {}): CodeReviewRef | null {
  const idPattern = compile(format.idPattern);
  if (!idPattern || !format.urlTemplate) return null;
  const m = text(value).match(idPattern);
  if (!m) return null;
  const id = m[1] ?? m[0];
  return { id, url: format.urlTemplate.split("{id}").join(encodeURIComponent(id)) };
}

/**
 * Every code review a packet's links name, once each (by id), most telling
 * first: code_review links by their URL, then — with a urlPattern — other
 * links whose URL matches it, then code_review links that carry only a bare
 * id (idPattern + urlTemplate).
 */
export function reviewPacketCodeReviews(links: readonly ReviewLink[], format: CodeReviewLinkFormat = {}): CodeReviewRef[] {
  const usable = links.filter((link) => !!link && typeof link === "object");
  const review = usable.filter((l) => l.kind === CODE_REVIEW_LINK_KIND);
  const found = [
    ...review.map((l) => codeReviewOfUrl(l.url, format)),
    ...(format.urlPattern ? usable.filter((l) => l.kind !== CODE_REVIEW_LINK_KIND).map((l) => codeReviewOfUrl(l.url, format)) : []),
    ...review.map((l) => codeReviewOfId(l.label, format) ?? codeReviewOfId(l.url, format)),
  ];
  const out: CodeReviewRef[] = [];
  for (const ref of found) if (ref && !out.some((o) => o.id === ref.id)) out.push(ref);
  return out;
}

/** The code review a packet's links name first (see reviewPacketCodeReviews), or null. */
export function reviewPacketCodeReview(links: readonly ReviewLink[], format: CodeReviewLinkFormat = {}): CodeReviewRef | null {
  return reviewPacketCodeReviews(links, format)[0] ?? null;
}

/**
 * The review a code_review stage's evidence names: its `url` (the id read
 * from it, so it compares with a packet link's), else a bare `reviewId`
 * under `format`; null when neither names one.
 */
export function codeReviewOfEvidence(evidence: unknown, format: CodeReviewLinkFormat = {}): CodeReviewRef | null {
  const e = (evidence ?? {}) as { url?: unknown; reviewId?: unknown };
  const url = text(e.url);
  const byUrl = url ? codeReviewOfUrl(url, format) : null;
  if (byUrl) return byUrl;
  const reviewId = text(e.reviewId);
  return reviewId ? codeReviewOfId(reviewId, format) : null;
}
