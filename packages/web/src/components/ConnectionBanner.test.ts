import { describe, expect, test } from "bun:test";
import { RECONNECTING_AFTER_MS, reconnectingLabel } from "./ConnectionBanner";

describe("reconnectingLabel", () => {
  test("nothing while connected or during a short blip", () => {
    expect(reconnectingLabel(null, 10_000)).toBeNull();
    expect(reconnectingLabel(10_000, 10_000 + RECONNECTING_AFTER_MS - 1)).toBeNull();
  });

  test("says how long live updates have been paused", () => {
    expect(reconnectingLabel(0, 4_200)).toBe("Reconnecting to Standup… live updates paused for 4s");
    expect(reconnectingLabel(0, 95_000)).toBe("Reconnecting to Standup… live updates paused for 1m 35s");
    expect(reconnectingLabel(0, 6_100, "connection lost (1006)")).toBe(
      "Reconnecting to Standup… live updates paused for 6s — connection lost (1006)"
    );
  });
});
