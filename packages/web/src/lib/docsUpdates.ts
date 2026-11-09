import type { DocsChangedPayload } from "@standup/shared";

/** A docs change, or null for "anything may have changed: re-read it all". */
type Listener = (change: DocsChangedPayload | null) => void;

const listeners = new Set<Listener>();

/**
 * Fans a `docs:changed` WebSocket frame out to every mounted docs view. App
 * owns the socket and calls this per frame; the Docs tab subscribes here
 * instead of threading a signal prop through the console shell.
 */
export function publishDocsChanged(change: DocsChangedPayload): void {
  for (const listener of [...listeners]) listener(change);
}

/**
 * Tells every mounted docs view to re-read its tree and open doc.
 * `docs:changed` frames are addressed to the owner, so they carry no seq and
 * are never replayed: App calls this on every (re)connect, resume and gap,
 * and from the visible-page catch-up, since frames sent while the socket was
 * down or dead are gone.
 */
export function publishDocsResync(): void {
  for (const listener of [...listeners]) listener(null);
}

/** Calls `listener` for each docs change (null: a resync) until the returned function is called. */
export function subscribeDocsUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
