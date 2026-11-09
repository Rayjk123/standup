/**
 * The target id of a change signal (`{ sessionId | projectId, n }`) that means
 * "every target": bumped after a full-snapshot reconnect, when frames for any
 * session or project may have been missed while the socket was down.
 */
export const ALL_TARGETS = "*";

/** Whether a change signal aimed at `signalId` applies to `id`. */
export function signalTargets(signalId: string, id: string): boolean {
  return signalId === ALL_TARGETS || signalId === id;
}
