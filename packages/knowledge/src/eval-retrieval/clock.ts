/**
 * Pins the wall clock for the duration of an eval run. Search ranking, decay
 * and freshness all read `Date.now()` / `new Date()` internally (activity
 * decay, confidence half-lives, contradiction tie-breaks), so a run is only
 * reproducible when every one of those reads sees the same instant. While
 * installed, `Date.now()` and an argument-less `new Date()` return `nowMs`;
 * every other Date use is unchanged, and `instanceof Date` still holds for
 * dates made before or after. SQLite's own `datetime('now')` defaults are not
 * affected; nothing the eval measures reads them.
 */
export function installFixedClock(nowMs: number): () => void {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(nowMs);
      else super(...(args as [string | number | Date]));
    }
    static now(): number {
      return nowMs;
    }
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof RealDate;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
