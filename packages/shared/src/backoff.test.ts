import { expect, test, describe } from "bun:test";
import { reconnectDelayMs, DEFAULT_RECONNECT_BACKOFF } from "./backoff.js";

const CFG = { baseMs: 1000, maxMs: 30000, factor: 2 };

describe("reconnectDelayMs — schedule", () => {
  test("grows exponentially per attempt (target = base * 2^(n-1))", () => {
    // rand()=0 pins each delay to its floor (target/2), exposing the raw target.
    const floor = (n: number) => reconnectDelayMs(n, CFG, () => 0);
    expect(floor(1)).toBe(500); //  1000 / 2
    expect(floor(2)).toBe(1000); // 2000 / 2
    expect(floor(3)).toBe(2000); // 4000 / 2
    expect(floor(4)).toBe(4000); // 8000 / 2
    expect(floor(5)).toBe(8000); // 16000 / 2
  });

  test("caps at maxMs — the target never exceeds the ceiling", () => {
    // Attempt 6 would be 32000 > 30000, so it clamps; higher attempts stay clamped.
    const ceil = (n: number) => reconnectDelayMs(n, CFG, () => 1);
    expect(ceil(6)).toBe(30000); // min(32000, 30000)
    expect(ceil(7)).toBe(30000);
    expect(ceil(100)).toBe(30000);
  });

  test("jitter keeps the delay within [target/2, target]", () => {
    // Attempt 3 target is 4000: floor 2000 (rand 0), ceiling 4000 (rand ~1), and
    // the midpoint at rand 0.5 is 3000.
    expect(reconnectDelayMs(3, CFG, () => 0)).toBe(2000);
    expect(reconnectDelayMs(3, CFG, () => 0.5)).toBe(3000);
    expect(reconnectDelayMs(3, CFG, () => 1)).toBe(4000);
  });

  test("clamps the target BEFORE jitter, so a capped attempt still jitters", () => {
    // Attempt 10's raw target far exceeds the cap; jitter applies to the cap.
    expect(reconnectDelayMs(10, CFG, () => 0)).toBe(15000); // 30000 / 2
    expect(reconnectDelayMs(10, CFG, () => 1)).toBe(30000);
  });

  test("attempt <= 1 is treated as the first attempt (no negative exponent)", () => {
    expect(reconnectDelayMs(1, CFG, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, CFG, () => 0)).toBe(500);
  });

  test("default factor is 2 when omitted", () => {
    const noFactor = { baseMs: 1000, maxMs: 30000 };
    expect(reconnectDelayMs(3, noFactor, () => 0)).toBe(2000);
  });

  test("DEFAULT_RECONNECT_BACKOFF is the 1s→30s doubling schedule", () => {
    expect(DEFAULT_RECONNECT_BACKOFF).toEqual({ baseMs: 1000, maxMs: 30000, factor: 2 });
  });
});
