// Owner-aware ntfy routing: with no owner-topic map configured, every push
// broadcasts to the default topic exactly as before; with one configured, an
// owned event routes to the owner's own topic, an owner we can't map falls back
// to the default topic, and an owner-less event is SUPPRESSED rather than
// blasted to everyone. The routing decision is a pure function, asserted here
// with no env or network.

import { describe, expect, test } from "bun:test";
import { hasPrivatePushTopic, parseOwnerTopics, resolvePushTopic } from "./push.js";

describe("parseOwnerTopics", () => {
  test("parses alias:topic pairs, dropping malformed entries", () => {
    const m = parseOwnerTopics("alice:alice-phone, carol:carol-phone, bogus, :x, y:");
    expect(m.get("alice")).toBe("alice-phone");
    expect(m.get("carol")).toBe("carol-phone");
    expect(m.size).toBe(2);
  });

  test("empty / undefined yields an empty map", () => {
    expect(parseOwnerTopics(undefined).size).toBe(0);
    expect(parseOwnerTopics("").size).toBe(0);
  });
});

describe("resolvePushTopic — owner routing off (no owner-topic map)", () => {
  const noMap = new Map<string, string>();

  test("broadcasts to the default topic regardless of owner (today's behavior)", () => {
    expect(resolvePushTopic("alice", "default", noMap)).toBe("default");
  });

  test("an owner-less event still broadcasts to the default topic when routing is off", () => {
    expect(resolvePushTopic(null, "default", noMap)).toBe("default");
    expect(resolvePushTopic(undefined, "default", noMap)).toBe("default");
  });

  test("no default topic configured → nothing to push", () => {
    expect(resolvePushTopic("alice", undefined, noMap)).toBeNull();
  });
});

describe("resolvePushTopic — owner routing on (owner-topic map configured)", () => {
  const map = parseOwnerTopics("alice:alice-phone");

  test("routes an owned event to the owner's own topic, not the shared default", () => {
    expect(resolvePushTopic("alice", "default", map)).toBe("alice-phone");
  });

  test("an owner we can't map falls back to the default topic", () => {
    expect(resolvePushTopic("stranger", "default", map)).toBe("default");
  });

  test("an owner-less event is suppressed rather than blasted to everyone", () => {
    expect(resolvePushTopic(null, "default", map)).toBeNull();
    expect(resolvePushTopic(undefined, "default", map)).toBeNull();
  });
});

describe("hasPrivatePushTopic", () => {
  test("with no owner-topic map, only the host has one: the default topic is theirs", () => {
    const noMap = parseOwnerTopics(undefined);
    expect(hasPrivatePushTopic("alice", "alice", noMap)).toBe(true);
    expect(hasPrivatePushTopic("bob", "alice", noMap)).toBe(false);
  });

  test("with a map, exactly the users listed in it have one, the host included only when listed", () => {
    const map = parseOwnerTopics("bob:bob-phone");
    expect(hasPrivatePushTopic("bob", "alice", map)).toBe(true);
    expect(hasPrivatePushTopic("alice", "alice", map)).toBe(false);
    expect(hasPrivatePushTopic("carol", "alice", map)).toBe(false);
    const both = parseOwnerTopics("bob:bob-phone,alice:b-phone");
    expect(hasPrivatePushTopic("alice", "alice", both)).toBe(true);
  });
});
