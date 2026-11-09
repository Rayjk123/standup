// A bounded, insertion-ordered LRU of processed inbound-message ids. Slack
// redelivers an event whose socket ack it missed, so the same message
// (identified by client_msg_id, else channel:ts) can arrive more than once; a
// side-effecting handler must act on it only the first time.
//
// This is shared state: the message router records an id ONCE, before it forks
// a thread reply into the ask-answer path vs. the steer path, so a redelivery
// can't slip across that fork (e.g. the first delivery answers-and-clears an
// ask, then the redelivery — now finding no pending ask — falls to steer and
// injects the answer as a spurious live turn). Owning the guard at the fork,
// not per-path, is what closes that gap.

/** Bound so a long-lived adapter can't grow the set unbounded. */
const DEFAULT_CAP = 500;

export class InboundDedup {
  // Insertion-ordered; the oldest id is evicted once the set exceeds the cap.
  private readonly ids = new Set<string>();

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  /** Whether this id was already recorded (a redelivery). */
  has(key: string): boolean {
    return this.ids.has(key);
  }

  /** Record an id, evicting the oldest once over the cap. */
  remember(key: string): void {
    this.ids.add(key);
    if (this.ids.size > this.cap) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  /**
   * Check-and-record in one step: returns true if the id was already seen (the
   * caller should drop the event), false on first sight (now recorded).
   */
  seen(key: string): boolean {
    if (this.ids.has(key)) return true;
    this.remember(key);
    return false;
  }
}
