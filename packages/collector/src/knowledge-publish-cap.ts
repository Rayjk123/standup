/**
 * The per-session daily cap on proposals that publish without review. A
 * proposing session averages under three proposals; one that keeps proposing
 * past the cap is more likely narrating its work than recording durable facts,
 * so its further proposals still land, as review drafts a human accepts.
 *
 * Counted in memory per collector process, keyed by session and UTC day: a
 * collector restart resets the count, which at worst allows one more cap's
 * worth of publishes that day.
 */

/** Proposals one session may auto-publish per UTC day; the rest become review drafts. */
export const AUTO_PUBLISH_DAILY_CAP_PER_SESSION = 8;

/** The UTC calendar day of `now`, as YYYY-MM-DD. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class AutoPublishCap {
  private readonly counts = new Map<string, number>();

  constructor(private readonly cap: number = AUTO_PUBLISH_DAILY_CAP_PER_SESSION) {}

  /** Whether `sessionId` has used up today's auto-publishes. */
  reached(sessionId: string, now: Date = new Date()): boolean {
    return (this.counts.get(`${sessionId}|${utcDay(now)}`) ?? 0) >= this.cap;
  }

  /** Records one auto-publish by `sessionId`, dropping counts from earlier days. */
  record(sessionId: string, now: Date = new Date()): void {
    const day = utcDay(now);
    for (const key of this.counts.keys()) {
      if (!key.endsWith(`|${day}`)) this.counts.delete(key);
    }
    const key = `${sessionId}|${day}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** The note a capped proposal's response carries. */
  message(): string {
    return (
      `This session has auto-published ${this.cap} knowledge docs today, the daily cap: this proposal was saved ` +
      "as a review draft and goes live when a human accepts it."
    );
  }
}
