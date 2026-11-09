import { describe, expect, test } from "bun:test";
import { createCatchUp, DEFAULT_CATCH_UP_INTERVAL_MS, DEFAULT_CATCH_UP_MAX_RUN_MS } from "./catchUp";
import type { WakeSource } from "./liveSocket";

/** The interval the timing tests run on, long enough to tell a tick from a wake. */
const INTERVAL = 30_000;

/** Manual clock and timers, a wake source, and a `run` whose calls can be held open; `intervalMs: undefined` takes the default. */
function harness(opts: { visible?: boolean; intervalMs?: number } = { intervalMs: INTERVAL }) {
  let now = 0;
  let nextId = 1;
  let visible = opts.visible ?? true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const source: WakeSource = {
    addEventListener: (t, l) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener: (t, l) => listeners.get(t)?.delete(l),
  };
  let runs = 0;
  let release: (() => void) | null = null;
  let hold = false;
  const catchUp = createCatchUp({
    run: () => {
      runs++;
      if (!hold) return Promise.resolve();
      return new Promise<void>((r) => {
        release = r;
      });
    },
    wakeOn: [{ source, events: ["visibilitychange", "focus"] }],
    intervalMs: "intervalMs" in opts ? opts.intervalMs : INTERVAL,
    isVisible: () => visible,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = until;
  };
  return {
    catchUp,
    advance,
    fire: (type: string) => listeners.get(type)?.forEach((l) => l()),
    runs: () => runs,
    setVisible: (v: boolean) => {
      visible = v;
    },
    holdRuns: () => {
      hold = true;
    },
    release: async () => {
      release?.();
      for (let i = 0; i < 3; i++) await Promise.resolve();
    },
    timers: () => timers.size,
    listeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** Lets a finished run's settle handlers clear the in-flight mark. */
const settle = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe("createCatchUp", () => {
  test("catches up every interval while visible", async () => {
    const h = harness();
    expect(h.runs()).toBe(0);
    for (let i = 1; i <= 3; i++) {
      h.advance(INTERVAL);
      expect(h.runs()).toBe(i);
      await settle();
    }
  });

  test("a hidden page never reads; coming back reads at once", () => {
    const h = harness({ visible: false });
    h.advance(INTERVAL * 4);
    expect(h.runs()).toBe(0);
    h.setVisible(true);
    h.fire("visibilitychange");
    expect(h.runs()).toBe(1);
  });

  test("focus and visibilitychange landing together read once", async () => {
    const h = harness();
    h.advance(5000);
    h.fire("visibilitychange");
    await settle();
    h.fire("focus");
    expect(h.runs()).toBe(1);
    h.advance(2000);
    h.fire("focus");
    expect(h.runs()).toBe(2);
  });

  test("a run a wake started restarts the interval, so a tick doesn't follow it moments later", async () => {
    const h = harness();
    h.advance(INTERVAL - 500);
    h.fire("focus");
    expect(h.runs()).toBe(1);
    await settle();
    h.advance(1000);
    expect(h.runs()).toBe(1);
    h.advance(INTERVAL - 1000);
    expect(h.runs()).toBe(2);
  });

  test("never runs two at once", async () => {
    const h = harness();
    h.holdRuns();
    h.advance(INTERVAL);
    h.advance(INTERVAL);
    h.advance(5000);
    h.fire("focus");
    expect(h.runs()).toBe(1);
    await h.release();
    h.advance(INTERVAL);
    expect(h.runs()).toBe(2);
  });

  test("a run stuck past a minute (a request on a dead connection) no longer holds the catch-up off", () => {
    const h = harness();
    h.holdRuns();
    h.advance(INTERVAL);
    expect(h.runs()).toBe(1);
    h.advance(INTERVAL);
    expect(h.runs()).toBe(1);
    h.advance(DEFAULT_CATCH_UP_MAX_RUN_MS);
    expect(h.runs()).toBe(2);
  });

  test("by default a visible page reads every 2s: a frame lost on a healthy-looking socket shows within 2s", async () => {
    expect(DEFAULT_CATCH_UP_INTERVAL_MS).toBeLessThanOrEqual(2_000);
    const h = harness({ intervalMs: undefined });
    for (let i = 1; i <= 3; i++) {
      h.advance(2_000);
      expect(h.runs()).toBe(i);
      await settle();
    }
  });

  test("dispose stops the timer and the listeners", () => {
    const h = harness();
    h.catchUp.dispose();
    expect(h.timers()).toBe(0);
    expect(h.listeners()).toBe(0);
    h.advance(INTERVAL * 3);
    expect(h.runs()).toBe(0);
  });
});
