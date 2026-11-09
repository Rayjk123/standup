import type { IncomingMessage, ServerResponse } from "http";
import { shareApiPrefix, sharePageFromPath, type ShareResourceType } from "@standup/shared/share";
import { palettes } from "./src/components/theme";

/*
 * The HTTP status of a share page (`/share/review/<token>`, `/share/doc/<token>`).
 * The console is a single-page app whose fallback answers every path with
 * index.html and 200, so before that fallback runs this middleware asks the
 * collector whether the token is live for that page's type: a malformed,
 * unknown or revoked one gets a plain 404 page that names nothing, and a live
 * one is handed on to the app with headers that keep the token out of caches,
 * referrers and search indexes.
 */

/** Whether a share token of `type` is live, as the collector answers its share route. */
export type ShareTokenCheck = (type: ShareResourceType, token: string) => Promise<"live" | "missing" | "unknown">;

/** Headers every share page response carries. */
export const SHARE_PAGE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const { dark, light } = palettes;

/**
 * The 404 page runs no script, so it can't read the console's stored theme
 * pick: it is dark, and light for a viewer whose OS asks for light.
 */
const NOT_FOUND_CSS =
  `body{background:${dark.ground};color:${dark.text};font-family:system-ui,sans-serif;text-align:center;padding:64px 24px}` +
  `p{color:${dark.dim}}` +
  `@media (prefers-color-scheme: light){body{background:${light.ground};color:${light.text}}p{color:${light.dim}}}`;

const NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
  `<meta name="robots" content="noindex, nofollow"><title>Not found</title><style>${NOT_FOUND_CSS}</style></head>` +
  "<body><h1>404 — Not found</h1><p>This link doesn't lead anywhere. It may have been mistyped or turned off.</p>" +
  "</body></html>";

/** Asks the collector at `collectorOrigin` whether a token is live; "unknown" when it can't tell. */
export function collectorShareCheck(collectorOrigin: string, fetchImpl: typeof fetch = fetch): ShareTokenCheck {
  return async (type, token) => {
    try {
      const res = await fetchImpl(`${collectorOrigin}${shareApiPrefix(type)}${token}`, { method: "HEAD" });
      if (res.status === 200) return "live";
      if (res.status === 404) return "missing";
      return "unknown";
    } catch {
      return "unknown";
    }
  };
}

/**
 * The share page a request path names: its type and token (null for a
 * share-page path that names no well-formed token), or undefined for any
 * other path. A query or hash is ignored.
 */
export function sharePageRequest(url: string | undefined): { type: ShareResourceType; token: string | null } | undefined {
  const path = (url ?? "/").split("?")[0]!.split("#")[0]!;
  return sharePageFromPath(path) ?? undefined;
}

/**
 * Connect middleware for share pages: a 404 for a token the collector says is
 * not live (or a path that names no token), the app for a live one. When the
 * collector can't be asked the app is served, and its own read shows what it
 * finds. Other paths fall through untouched.
 */
export function sharePageMiddleware(check: ShareTokenCheck) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const page = sharePageRequest(req.url);
    if (page === undefined) return next();
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return next();
    for (const [name, value] of Object.entries(SHARE_PAGE_HEADERS)) res.setHeader(name, value);
    const notFound = () => {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(method === "HEAD" ? undefined : NOT_FOUND_HTML);
    };
    if (page.token === null) return notFound();
    check(page.type, page.token).then(
      (state) => (state === "missing" ? notFound() : next()),
      () => next()
    );
  };
}
