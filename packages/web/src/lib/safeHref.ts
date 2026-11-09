/**
 * `url` when it is an absolute http(s) URL, else null. Links built from
 * agent- or server-recorded strings (review URLs, code review evidence) go through this
 * so a `javascript:` or `data:` value renders as text instead of a live href.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
