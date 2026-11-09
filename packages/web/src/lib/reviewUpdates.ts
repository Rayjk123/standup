import type { ReviewUpdatedPayload } from "@standup/shared";

/** A review update, or null for "anything may have changed: re-read it all". */
type Listener = (update: ReviewUpdatedPayload | null) => void;

const listeners = new Set<Listener>();

/**
 * Fans a `review:updated` WebSocket frame out to every mounted review view.
 * App owns the socket and calls this per frame; the Review tab subscribes here
 * instead of threading a signal prop through the console shell.
 */
export function publishReviewUpdate(update: ReviewUpdatedPayload): void {
  for (const listener of [...listeners]) listener(update);
}

/**
 * Tells every mounted review view to re-read its list and open packet.
 * `review:updated` frames are addressed to one viewer, so they carry no seq
 * and are never replayed: App calls this on every (re)connect and resync,
 * since frames sent while the socket was down or dead are gone. It also calls
 * it on each reviews:pending frame, which reaches a socket review:updated
 * skips, and when the catch-up finds the pending count moved.
 */
export function publishReviewResync(): void {
  for (const listener of [...listeners]) listener(null);
}

/** Calls `listener` for each review update (null: a resync) until the returned function is called. */
export function subscribeReviewUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
