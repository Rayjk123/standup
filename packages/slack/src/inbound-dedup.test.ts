// InboundDedup — the shared, bounded LRU that the message router uses to guard
// actionable thread replies before the ask-vs-steer precedence fork. No live
// Slack/HTTP here; this exercises the guard's semantics in isolation.

import { describe, expect, test } from "bun:test";
import { InboundDedup } from "./inbound-dedup.js";

describe("InboundDedup", () => {
  test("seen() is false on first sight and true on redelivery", () => {
    const d = new InboundDedup();
    expect(d.seen("cm-1")).toBe(false);
    expect(d.seen("cm-1")).toBe(true);
  });

  test("distinct ids are independent", () => {
    const d = new InboundDedup();
    expect(d.seen("cm-a")).toBe(false);
    expect(d.seen("cm-b")).toBe(false);
    expect(d.seen("cm-a")).toBe(true);
    expect(d.seen("cm-b")).toBe(true);
  });

  test("has() reflects recorded ids without recording", () => {
    const d = new InboundDedup();
    expect(d.has("cm-x")).toBe(false);
    d.remember("cm-x");
    expect(d.has("cm-x")).toBe(true);
  });

  test("cross-path: an id recorded once (ask path) drops a redelivery that would fall to steer", () => {
    // One shared instance stands in for the router's guard: delivery 1 answers
    // an ask, delivery 2 (same id) would otherwise fork to steer. The single
    // recorded id catches it regardless of which path each delivery chose.
    const router = new InboundDedup();
    expect(router.seen("cm-answer")).toBe(false); // delivery 1 → ask path runs
    expect(router.seen("cm-answer")).toBe(true); // delivery 2 → dropped, never reaches steer
  });

  test("evicts the oldest id once over the cap", () => {
    const d = new InboundDedup(2);
    d.seen("a");
    d.seen("b");
    d.seen("c"); // evicts "a"
    expect(d.has("a")).toBe(false);
    expect(d.has("b")).toBe(true);
    expect(d.has("c")).toBe(true);
  });
});
