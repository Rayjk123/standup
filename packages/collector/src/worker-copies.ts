/*
 * Telling a launched session's own worker from a copy resumed by hand.
 *
 * While a launch's hook token is enforced, every event its worker sends
 * reaches /hook twice: the global hook's tokenless copy (dropped with a 202)
 * and the worker's own copy with the token, a moment apart in either order.
 * A copy of the session resumed by hand outside the launch sends only the
 * tokenless copy, and those are dropped unrecorded. A tokenless copy with no
 * token copy near it is therefore the only trace such a process leaves. In
 * memory only: a restart forgets it, and the next tokenless copy notes it
 * again.
 */

/** How close a token copy must land to a tokenless one to count as its pair. */
export const COPY_PAIR_GRACE_MS = 5_000;

export class WorkerCopyTracker {
  private readonly tokenless = new Map<string, number>();
  private readonly token = new Map<string, number>();

  /** A tokenless copy for `sessionId` was dropped because its launch's token is enforced. */
  noteTokenless(sessionId: string, at = Date.now()): void {
    this.tokenless.set(sessionId, at);
  }

  /** An event for `sessionId` arrived with its launch's token. */
  noteToken(sessionId: string, at = Date.now()): void {
    this.token.set(sessionId, at);
  }

  /**
   * Whether the latest tokenless copy for `sessionId` has had no token copy
   * within COPY_PAIR_GRACE_MS of it, and is at least that old: something other
   * than the launch's worker is running the session.
   */
  handCopySeen(sessionId: string, now = Date.now()): boolean {
    const tokenlessAt = this.tokenless.get(sessionId);
    if (tokenlessAt === undefined || now - tokenlessAt < COPY_PAIR_GRACE_MS) return false;
    const tokenAt = this.token.get(sessionId);
    return tokenAt === undefined || Math.abs(tokenlessAt - tokenAt) > COPY_PAIR_GRACE_MS;
  }

  forget(sessionId: string): void {
    this.tokenless.delete(sessionId);
    this.token.delete(sessionId);
  }
}

/** The collector's tracker: the hook route notes copies, the pane reaper reads them. */
export const workerCopies = new WorkerCopyTracker();
