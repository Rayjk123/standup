import { describe, expect, test } from "bun:test";
import { COPY_PAIR_GRACE_MS, WorkerCopyTracker } from "./worker-copies.js";

describe("WorkerCopyTracker", () => {
  const T = 1_000_000;

  test("a tokenless copy paired with a token copy, in either order, is the worker's", () => {
    const t = new WorkerCopyTracker();
    t.noteTokenless("s", T);
    t.noteToken("s", T + 20);
    expect(t.handCopySeen("s", T + 60_000)).toBe(false);

    t.noteToken("s", T + 100_000);
    t.noteTokenless("s", T + 100_010);
    expect(t.handCopySeen("s", T + 200_000)).toBe(false);
  });

  test("a tokenless copy with no token copy near it is a copy outside the launch, once it is old enough", () => {
    const t = new WorkerCopyTracker();
    t.noteToken("s", T);
    t.noteTokenless("s", T + 60_000);
    expect(t.handCopySeen("s", T + 60_000 + COPY_PAIR_GRACE_MS - 1)).toBe(false);
    expect(t.handCopySeen("s", T + 60_000 + COPY_PAIR_GRACE_MS)).toBe(true);

    const never = new WorkerCopyTracker();
    never.noteTokenless("n", T);
    expect(never.handCopySeen("n", T + COPY_PAIR_GRACE_MS)).toBe(true);
  });

  test("nothing noted, or forgotten, is no copy", () => {
    const t = new WorkerCopyTracker();
    expect(t.handCopySeen("s", T)).toBe(false);
    t.noteTokenless("s", T);
    t.forget("s");
    expect(t.handCopySeen("s", T + 60_000)).toBe(false);
  });
});
