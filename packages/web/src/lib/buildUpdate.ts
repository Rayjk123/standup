/*
 * An open page stays on the build it loaded. serve.ts rebuilds the console
 * when its sources change (a merge into the install), but nothing tells a
 * page already open: a tab added or changed by the merge isn't there until
 * the page reloads. A production build's index.html names its entry chunk by
 * content hash, so the page compares the entry it loaded with the one the
 * server's index.html names now; when they differ the page is on an older
 * build. The dev server's entry (/src/main.tsx) never changes, so under it
 * the check never fires.
 */

/** How often a visible page asks which build the server is on. */
export const BUILD_CHECK_INTERVAL_MS = 60_000;

/** How long one check may take before it is abandoned. */
export const BUILD_CHECK_TIMEOUT_MS = 10_000;

/** A built entry chunk's path: `/assets/<name>-<hash>.js`. */
const BUILT_ENTRY = /^\/assets\/[\w.-]+\.js$/;

/** The path of a module script `src`, if it is a built entry chunk. */
function builtEntryPath(src: string | null | undefined, base: string): string | undefined {
  if (!src) return undefined;
  let path: string;
  try {
    path = new URL(src, base).pathname;
  } catch {
    return undefined;
  }
  return BUILT_ENTRY.test(path) ? path : undefined;
}

/** The built entry chunk this page loaded; undefined under the dev server. */
export function loadedEntry(doc: Document = document): string | undefined {
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const path = builtEntryPath(script.getAttribute("src"), doc.baseURI);
    if (path) return path;
  }
  return undefined;
}

/** The built entry chunk an index.html names; undefined when it names none. */
export function servedEntry(html: string, base = "http://console/"): string | undefined {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const path = builtEntryPath(src, base);
    if (path) return path;
  }
  return undefined;
}

/**
 * Whether the server now serves a build other than `loaded`: it reads the
 * index.html, uncached. Any failure (a restart, a timeout, a page without a
 * built entry) answers false, so a check never claims an update it didn't see.
 */
export async function newerBuildServed(
  loaded: string | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS
): Promise<boolean> {
  if (!loaded) return false;
  try {
    const res = await fetchImpl("/", { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const served = servedEntry(await res.text());
    return served !== undefined && served !== loaded;
  } catch {
    return false;
  }
}
