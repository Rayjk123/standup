// Reconnect scheduling for the collector WebSocket clients (the Slack adapter's
// CollectorClient and the web app's useWebSocket). A fixed 3 s retry hammers the
// collector at a steady beat while it is down and lines every client up on the
// same instant once it returns; this spreads and paces the attempts instead:
// exponential growth so a persistently-down collector is polled ever less often,
// a cap so the delay never grows unbounded, and jitter so many clients waking
// together don't retry in lockstep. Pure (no timers, injectable RNG) so the
// schedule is asserted directly in a unit test.

export interface BackoffConfig {
  /** Delay target for the first reconnect (attempt 1), before jitter. */
  baseMs: number;
  /** Upper bound on the (pre-jitter) target — growth stops here. */
  maxMs: number;
  /** Growth per attempt; defaults to 2 (double each time). */
  factor?: number;
}

/**
 * Delay in ms to wait before reconnect `attempt` (1-based: the first reconnect
 * after a drop is attempt 1). The un-jittered target is
 * `baseMs * factor^(attempt-1)` clamped to `maxMs`; the returned delay applies
 * *equal jitter* — half the target plus a random point across the other half —
 * so it lands in `[target/2, target]`. That keeps a floor (reconnects never
 * stampede at ~0 ms the way full jitter allows) while still de-synchronizing
 * clients that dropped at the same moment. `rand` is injectable for tests.
 */
export function reconnectDelayMs(
  attempt: number,
  config: BackoffConfig,
  rand: () => number = Math.random,
): number {
  const factor = config.factor ?? 2;
  const exp = config.baseMs * Math.pow(factor, Math.max(0, attempt - 1));
  const target = Math.min(exp, config.maxMs);
  const half = target / 2;
  return Math.round(half + rand() * half);
}

/** Civilized default schedule: 1 s base, doubling, capped at 30 s. */
export const DEFAULT_RECONNECT_BACKOFF: BackoffConfig = {
  baseMs: 1000,
  maxMs: 30000,
  factor: 2,
};
