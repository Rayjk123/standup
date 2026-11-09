import { describe, expect, test } from "bun:test";
import { createFrameLoop, type FrameLoopDeps } from "./frameLoop";

/** A hand-cranked requestAnimationFrame and a document whose visibility the test sets. */
function fakeDeps() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  const deps: FrameLoopDeps = {
    requestFrame: (cb) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void pending.delete(id),
    doc: doc as unknown as FrameLoopDeps["doc"],
  };
  return {
    deps,
    pending,
    listeners,
    /** Runs the frames scheduled so far at time `now`. */
    frame(now: number) {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, cb] of due) cb(now);
    },
    setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const fn of listeners) fn();
    },
  };
}

describe("createFrameLoop", () => {
  test("schedules nothing until started, and nothing after stop", () => {
    const f = fakeDeps();
    const ticks: number[] = [];
    const loop = createFrameLoop((t) => ticks.push(t), 12, f.deps);
    expect(f.pending.size).toBe(0);
    expect(loop.running).toBe(false);
    loop.start();
    expect(loop.running).toBe(true);
    f.frame(0);
    expect(ticks).toEqual([0]);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(f.pending.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    f.frame(1000);
    expect(ticks).toEqual([0]);
  });

  test("draws at most fps times a second", () => {
    const f = fakeDeps();
    let draws = 0;
    const loop = createFrameLoop(() => draws++, 12, f.deps);
    loop.start();
    // 60 display frames over one second.
    for (let i = 0; i < 60; i++) f.frame(i * (1000 / 60));
    expect(draws).toBeGreaterThanOrEqual(11);
    expect(draws).toBeLessThanOrEqual(12);
    loop.stop();
  });

  test("stops scheduling while the tab is hidden and resumes when it shows", () => {
    const f = fakeDeps();
    let draws = 0;
    const loop = createFrameLoop(() => draws++, 12, f.deps);
    loop.start();
    f.frame(0);
    f.setVisibility("hidden");
    expect(loop.running).toBe(false);
    expect(f.pending.size).toBe(0);
    f.frame(500);
    expect(draws).toBe(1);
    f.setVisibility("visible");
    expect(loop.running).toBe(true);
    f.frame(5000);
    expect(draws).toBe(2);
    loop.stop();
  });

  test("a frame already queued when the tab hides draws nothing and schedules no other", () => {
    const f = fakeDeps();
    let draws = 0;
    const loop = createFrameLoop(() => draws++, 12, f.deps);
    loop.start();
    // The tab hides before its visibilitychange is handled.
    (f.deps.doc as { visibilityState: string }).visibilityState = "hidden";
    f.frame(0);
    expect(draws).toBe(0);
    expect(f.pending.size).toBe(0);
    loop.stop();
  });

  test("starting a hidden loop waits for the tab to show", () => {
    const f = fakeDeps();
    (f.deps.doc as { visibilityState: string }).visibilityState = "hidden";
    const loop = createFrameLoop(() => {}, 12, f.deps);
    loop.start();
    expect(loop.running).toBe(false);
    f.setVisibility("visible");
    expect(loop.running).toBe(true);
    loop.stop();
  });

  test("start twice keeps one frame in flight", () => {
    const f = fakeDeps();
    const loop = createFrameLoop(() => {}, 12, f.deps);
    loop.start();
    loop.start();
    expect(f.pending.size).toBe(1);
    expect(f.listeners.size).toBe(1);
    loop.stop();
  });
});
