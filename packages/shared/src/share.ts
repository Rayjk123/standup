// ============================================================================
// Read-only share links, for every resource that can be shared (review
// packets, docs, and doc folders with everything below them): the page and
// API paths a share token rides on, and the token's shape. No imports at all:
// the web dev server's config loads this under Node (see
// packages/web/share-page.ts).
// ============================================================================

/** The kinds of resource a share grant can point at. */
export const SHARE_RESOURCE_TYPES = ["review", "doc", "folder"] as const;
export type ShareResourceType = (typeof SHARE_RESOURCE_TYPES)[number];

/** Whether `value` names a shareable resource type. */
export function isShareResourceType(value: unknown): value is ShareResourceType {
  return typeof value === "string" && (SHARE_RESOURCE_TYPES as readonly string[]).includes(value);
}

/** The console page a share link of each type opens; the token follows it. */
export const SHARE_PAGE_PREFIXES: Record<ShareResourceType, string> = {
  review: "/share/review/",
  doc: "/share/doc/",
  folder: "/share/folder/",
};

/** The public share API's root: `<root><segment>/<token>` reads a shared resource. */
export const SHARE_API_ROOT = "/api/share/";

/** The share API's path segment for each type. */
export const SHARE_API_SEGMENTS: Record<ShareResourceType, string> = {
  review: "reviews",
  doc: "docs",
  folder: "folders",
};

/** The public API a share page of `type` reads its resource (and media) from; the token follows it. */
export function shareApiPrefix(type: ShareResourceType): string {
  return `${SHARE_API_ROOT}${SHARE_API_SEGMENTS[type]}/`;
}

/** A share token as minted: 32 random bytes, base64url without padding. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The share page path for a resource of `type` shared under `token`. */
export function sharePagePath(type: ShareResourceType, token: string): string {
  return `${SHARE_PAGE_PREFIXES[type]}${token}`;
}

/**
 * The share page a path names: its type and token, `{ type, token: null }`
 * for a share-page path whose token is malformed, or null for any other path.
 */
export function sharePageFromPath(pathname: string): { type: ShareResourceType; token: string | null } | null {
  for (const type of SHARE_RESOURCE_TYPES) {
    const prefix = SHARE_PAGE_PREFIXES[type];
    if (!pathname.startsWith(prefix)) continue;
    const token = pathname.slice(prefix.length);
    return { type, token: SHARE_TOKEN.test(token) ? token : null };
  }
  return null;
}

/**
 * Whether a resource is shared read-only by link. `path` is the share page
 * (e.g. `/share/doc/<token>`) while sharing is on, else null.
 */
export interface ShareState {
  enabled: boolean;
  path: string | null;
  /**
   * For a doc or a folder: the path (`a/b`) of the nearest folder holding it
   * that is shared by link, which reaches it whatever `enabled` says; absent
   * when no folder holding it is shared.
   */
  viaFolder?: string;
}

// ── Review packets ──────────────────────────────────────────────────────────

/** The console page a review packet's share link opens; the token follows it. */
export const REVIEW_SHARE_PAGE_PREFIX = SHARE_PAGE_PREFIXES.review;
/** The public API a review share page reads its packet (and media) from; the token follows it. */
export const REVIEW_SHARE_API_PREFIX = shareApiPrefix("review");
/** A review share token; every share token has the same shape. */
export const REVIEW_SHARE_TOKEN = SHARE_TOKEN;

/** The share page path for a review packet shared under `token`. */
export function reviewSharePath(token: string): string {
  return sharePagePath("review", token);
}

/** The review share token a page path names, or null when it is not a review share page. */
export function reviewShareTokenFromPath(pathname: string): string | null {
  const page = sharePageFromPath(pathname);
  return page?.type === "review" ? page.token : null;
}
