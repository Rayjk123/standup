import type { WakeSource } from "./liveSocket";

/**
 * How often a visible page catches up while it stays on screen: one small
 * read that normally returns nothing, so a frame lost on a socket that still
 * looks healthy, or posted while the socket is down, shows within 2s.
 */
export const DEFAULT_CATCH_UP_INTERVAL_MS = 2_000;

/** The least time between two resyncs a catch-up runs to see whether a refusal (Persona disabled, the viewer refused) still holds. */
export const REFUSED_RESYNC_INTERVAL_MS = 30_000;

/**
 * The least time between two catch-ups a wake event starts: focus and
 * visibilitychange land together, and a reader flicking between windows
 * shouldn't turn each switch into a read.
 */
export const DEFAULT_CATCH_UP_MIN_GAP_MS = 2_000;

/** How long a run may hold the next one off: one stuck on a dead connection doesn't stop the catch-up. */
export const DEFAULT_CATCH_UP_MAX_RUN_MS = 60_000;

export interface CatchUpOptions {
  /** One catch-up. The controller doesn't start another while one runs, for up to maxRunMs. */
  run: () => Promise<void>;
  intervalMs?: number;
  minGapMs?: number;
  maxRunMs?: number;
  /** Event sources and the events on each that catch up at once (tab shown, window focused, network up). */
  wakeOn?: Array<{ source: WakeSource; events: string[] }>;
  isVisible?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs `run` while the page is visible: when it comes back (shown, focused,
 * online) and every `intervalMs` while it stays on screen. A hidden page never
 * runs it; the next wake does. It is the safety net under the live socket: a
 * frame the socket lost, while it looked connected or between reconnects, is
 * read back within one interval of the reader looking.
 */
export function createCatchUp(opts: CatchUpOptions) {
  const intervalMs = opts.intervalMs ?? DEFAULT_CATCH_UP_INTERVAL_MS;
  const minGapMs = opts.minGapMs ?? DEFAULT_CATCH_UP_MIN_GAP_MS;
  const isVisible = opts.isVisible ?? (() => true);
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const maxRunMs = opts.maxRunMs ?? DEFAULT_CATCH_UP_MAX_RUN_MS;

  let disposed = false;
  // The run in flight, if any; a run outliving maxRunMs no longer holds the next one off.
  let running: object | null = null;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const runNow = (): boolean => {
    if (disposed || !isVisible()) return false;
    if (running && now() - lastRunAt < maxRunMs) return false;
    const run = {};
    running = run;
    lastRunAt = now();
    void opts
      .run()
      .catch(() => {
        // A failed read is retried on the next tick.
      })
      .finally(() => {
        if (running === run) running = null;
      });
    return true;
  };

  const schedule = () => {
    if (disposed) return;
    timer = setTimer(() => {
      timer = null;
      runNow();
      schedule();
    }, intervalMs);
  };

  // A run a wake started restarts the interval, so the next tick doesn't
  // follow it moments later.
  const wake = () => {
    if (now() - lastRunAt < minGapMs || !runNow()) return;
    if (timer !== null) clearTimer(timer);
    schedule();
  };
  for (const { source, events } of opts.wakeOn ?? []) for (const type of events) source.addEventListener(type, wake);
  schedule();

  return {
    /** Catches up now, unless one is running or the page is hidden; whether it started. */
    now: runNow,
    dispose(): void {
      disposed = true;
      for (const { source, events } of opts.wakeOn ?? []) for (const type of events) source.removeEventListener(type, wake);
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

export type CatchUp = ReturnType<typeof createCatchUp>;
