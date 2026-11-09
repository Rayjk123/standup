import { statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { join } from "path";

/*
 * Cache headers for the console's production build (see serve.ts). Every file
 * under /assets/ is content-hashed by `vite build`, so an existing one is
 * served `immutable` for a year: a reload or a tab switch never re-fetches a
 * chunk the browser already has. Everything else (index.html, the SPA
 * fallback for a deep link, public/ files, a missing asset's 404) is
 * `no-cache`, so a rebuild is picked up on the next load. Compression is vite
 * preview's own.
 */

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "no-cache";

/** The Cache-Control for a request path, given whether `<outDir>/assets/<name>` is a file. */
export function cacheControlFor(path: string, outDir: string): string {
  if (!path.startsWith("/assets/")) return REVALIDATE;
  let name: string;
  try {
    name = decodeURIComponent(path.slice("/assets/".length));
  } catch {
    return REVALIDATE;
  }
  // One plain file name: no separators, no "..", nothing hidden.
  if (!/^[\w-][\w.-]*$/.test(name) || name.includes("..")) return REVALIDATE;
  try {
    return statSync(join(outDir, "assets", name)).isFile() ? IMMUTABLE : REVALIDATE;
  } catch {
    return REVALIDATE;
  }
}

/** Paths the server proxies or answers itself: their responses keep their own caching. */
const PASS_THROUGH = ["/api/", "/ws", "/__standup/"];

/**
 * Connect middleware that sets Cache-Control (see cacheControlFor) on GET and
 * HEAD requests for the build's files and hands them on to vite preview's
 * static handler, which leaves the header alone. A missing /assets/ file is a
 * 404 here: the SPA fallback would answer it with index.html, which a lazy
 * import can't tell from a broken chunk. `outDir` is the build directory being
 * served.
 */
export function cacheHeaders(outDir: () => string) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0]!;
    if ((method === "GET" || method === "HEAD") && !PASS_THROUGH.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p))) {
      const cacheControl = cacheControlFor(path, outDir());
      res.setHeader("Cache-Control", cacheControl);
      if (path.startsWith("/assets/")) {
        if (cacheControl !== IMMUTABLE) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // Compressed or not by the browser's Accept-Encoding (vite preview's compression).
        res.setHeader("Vary", "Accept-Encoding");
      }
    }
    next();
  };
}
