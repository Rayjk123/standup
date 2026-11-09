/*
 * A page can outlive the build it was loaded from: serve.ts rebuilds the
 * console when its sources change and keeps an earlier build's chunks only
 * for a grace period. Past it, a tab such a page has not opened yet fails to
 * load. Opening it reloads the page onto the current build (see lazyNamed;
 * a background prefetch never reloads); the reload is rate limited so a chunk
 * that is missing for some other reason can't loop.
 */

const KEY = "standup:chunk-reload-at";
/** The least time between two reloads for a missing chunk. */
export const MIN_RELOAD_INTERVAL_MS = 30_000;

/** Whether a failed dynamic import looks like a chunk that could not be fetched, not a bug in the module. */
export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Failed to load module script/i.test(
    message
  );
}

interface ReloadDeps {
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: number;
  reload?: () => void;
  /** Whether the page holds text a reload would throw away; defaults to hasUnsavedInput(). */
  unsaved?: () => boolean;
}

/**
 * Whether any text field on the page holds typed text (a composer draft, a
 * reply), which a reload would lose. While a tab's chunk loads the previous
 * view stays mounted (navigations run in a transition), so it may be the one
 * holding the draft.
 */
export function hasUnsavedInput(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input:not([type]), input[type=text], input[type=search]"
  )) {
    if (el.value.trim()) return true;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[contenteditable=''], [contenteditable=true]")) {
    if (el.textContent?.trim()) return true;
  }
  return false;
}

/**
 * Reloads the page to pick up the current build, unless it already did so
 * within MIN_RELOAD_INTERVAL_MS or a reload would lose typed text (the view's
 * error boundary then offers the reload instead). Returns whether it reloaded.
 */
export function reloadForNewBuild(deps: ReloadDeps = {}): boolean {
  const now = deps.now ?? Date.now();
  const reload = deps.reload ?? (() => window.location.reload());
  try {
    if ((deps.unsaved ?? hasUnsavedInput)()) return false;
    const storage = deps.storage ?? window.sessionStorage;
    const last = Number(storage.getItem(KEY) ?? 0);
    if (now - last < MIN_RELOAD_INTERVAL_MS) return false;
    storage.setItem(KEY, String(now));
  } catch {
    // No session storage (a locked-down browser): without a guard, never auto-reload.
    return false;
  }
  reload();
  return true;
}
