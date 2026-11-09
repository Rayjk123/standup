// Per-channel toggle grammar + resolution. Pure, no I/O: verify the fail-open
// parse, the quiet-default resolution (asks on; mirror, feed/kinds off), the
// WS-type → feed-kind map, the command parser's mapping to mutations, and that
// mutating one channel never leaks into another.

import { describe, expect, test } from "bun:test";
import {
  parseChannelFeatures,
  isFeatureEnabled,
  isFeedKindEnabled,
  feedKindForType,
  setFeature,
  setFeedKind,
  clearChannel,
  featurePatch,
  feedKindPatch,
  clearChannelPatch,
  describeChannel,
  parseChannelCommand,
  ChannelFeatureStore,
  FeedChannelSync,
  type ChannelFeatureMap,
} from "./channel-features.js";

describe("parseChannelFeatures — fail open", () => {
  test("absent / empty ⇒ empty map (every channel takes the quiet default)", () => {
    expect(parseChannelFeatures(undefined)).toEqual({});
    expect(parseChannelFeatures(null)).toEqual({});
    expect(parseChannelFeatures("")).toEqual({});
    expect(parseChannelFeatures("   ")).toEqual({});
  });

  test("malformed JSON ⇒ empty map, never throws", () => {
    expect(parseChannelFeatures("{not json")).toEqual({});
    expect(parseChannelFeatures("[1,2,3]")).toEqual({}); // array is not a channel map
    expect(parseChannelFeatures("42")).toEqual({});
  });

  test("well-formed JSON round-trips", () => {
    const json = JSON.stringify({ C1: { feed: false, feedKinds: { launched: false } } });
    expect(parseChannelFeatures(json)).toEqual({ C1: { feed: false, feedKinds: { launched: false } } });
  });
});

describe("resolution — quiet default (asks on; mirror, feed/kinds off)", () => {
  // C1 has the feed master ON but mirror off and one kind explicitly off.
  const map: ChannelFeatureMap = {
    C1: { feed: true, mirror: false, feedKinds: { launched: false } },
    C2: { mirror: true },
  };

  test("a channel with no entry: asks on, mirror off, feed off, every kind off", () => {
    expect(isFeatureEnabled(map, "CX", "feed")).toBe(false);
    expect(isFeatureEnabled(map, "CX", "mirror")).toBe(false);
    expect(isFeatureEnabled(map, "CX", "asks")).toBe(true);
    expect(isFeedKindEnabled(map, "CX", "launched")).toBe(false);
    expect(isFeedKindEnabled(map, "CX", "finished")).toBe(false);
  });

  test("feed explicitly on ⇒ every unset kind is on (feed on delivers all lines)", () => {
    expect(isFeatureEnabled(map, "C1", "feed")).toBe(true);
    expect(isFeedKindEnabled(map, "C1", "finished")).toBe(true); // unset kind, feed on
    expect(isFeatureEnabled(map, "C1", "asks")).toBe(true); // unset flag ⇒ quiet default (on)
  });

  test("an explicitly-false flag/kind is off; only that channel/kind", () => {
    expect(isFeatureEnabled(map, "C1", "mirror")).toBe(false);
    expect(isFeedKindEnabled(map, "C1", "launched")).toBe(false);
  });

  test("`mirror on` turns the mirror on for that channel only", () => {
    expect(isFeatureEnabled(map, "C2", "mirror")).toBe(true);
    expect(isFeatureEnabled(map, "CX", "mirror")).toBe(false);
  });

  test("allowlist: enabling one kind leaves the other kinds off", () => {
    const allow: ChannelFeatureMap = { C2: { feed: true, feedKinds: { launched: true } } };
    expect(isFeedKindEnabled(allow, "C2", "launched")).toBe(true);
    expect(isFeedKindEnabled(allow, "C2", "finished")).toBe(false); // only allowlisted kinds show
  });

  test("an undefined channel id resolves to the quiet default", () => {
    expect(isFeatureEnabled(map, undefined, "feed")).toBe(false);
    expect(isFeatureEnabled(map, undefined, "mirror")).toBe(false);
    expect(isFeedKindEnabled(map, undefined, "launched")).toBe(false);
  });

  test("digest is OFF by default and opt-in: `feed digest on` alone, or `feed on`", () => {
    // A channel with no entry — feed off — gets no daily digest.
    expect(isFeedKindEnabled(map, "CX", "digest")).toBe(false);
    // `feed digest on` turns on just the digest, feed master off.
    const digestOnly: ChannelFeatureMap = { C4: { feedKinds: { digest: true } } };
    expect(isFeedKindEnabled(digestOnly, "C4", "digest")).toBe(true);
    expect(isFeedKindEnabled(digestOnly, "C4", "launched")).toBe(false);
    // `feed on` delivers every kind, the digest included.
    expect(isFeedKindEnabled({ C5: { feed: true } }, "C5", "digest")).toBe(true);
    // A channel that allowlisted only `launched` gets no digest unless it asks.
    const allow: ChannelFeatureMap = { C2: { feed: true, feedKinds: { launched: true } } };
    expect(isFeedKindEnabled(allow, "C2", "digest")).toBe(false);
    // `feed digest on` doesn't flip the loud kinds into allowlist mode.
    const both: ChannelFeatureMap = { C6: { feed: true, feedKinds: { digest: true } } };
    expect(isFeedKindEnabled(both, "C6", "finished")).toBe(true);
    // An explicit `feed digest off` mutes it.
    const muted: ChannelFeatureMap = { C3: { feed: true, feedKinds: { digest: false } } };
    expect(isFeedKindEnabled(muted, "C3", "digest")).toBe(false);
    // An undefined channel id still has nowhere to deliver.
    expect(isFeedKindEnabled(map, undefined, "digest")).toBe(false);
  });
});

describe("feedKindForType", () => {
  test("maps the feed event types to their kind toggles", () => {
    expect(feedKindForType("launch:started")).toBe("launched");
    expect(feedKindForType("session:status")).toBe("finished");
    expect(feedKindForType("checkpoint:new")).toBe("checkpoint");
    expect(feedKindForType("stall:detected")).toBe("stall");
    expect(feedKindForType("knowledge:change")).toBe("knowledge");
    expect(feedKindForType("ask:new")).toBe("ask");
    expect(feedKindForType("digest:posted")).toBe("digest");
  });

  test("a type with no per-kind toggle (launch stop) returns undefined", () => {
    expect(feedKindForType("launch:stopped")).toBeUndefined();
    expect(feedKindForType("event:new")).toBeUndefined();
  });
});

describe("pure mutations — isolated per channel", () => {
  test("setFeature / setFeedKind don't mutate the input and only touch one channel", () => {
    const base: ChannelFeatureMap = { CB: { feed: true } };
    const a = setFeature(base, "CA", "mirror", false);
    expect(a.CA).toEqual({ mirror: false });
    expect(a.CB).toEqual({ feed: true }); // sibling untouched
    expect(base.CA).toBeUndefined(); // input not mutated

    const k = setFeedKind(a, "CA", "launched", false);
    expect(k.CA).toEqual({ mirror: false, feedKinds: { launched: false } });
    expect(a.CA).toEqual({ mirror: false }); // prior map not mutated
  });

  test("clearChannel drops one channel's overrides and only that channel; input not mutated", () => {
    const base: ChannelFeatureMap = { CA: { feed: true, mirror: false }, CB: { feed: true } };
    const cleared = clearChannel(base, "CA");
    expect(cleared.CA).toBeUndefined(); // fully unset — resolves to the quiet default
    expect(cleared.CB).toEqual({ feed: true }); // sibling untouched
    expect(base.CA).toEqual({ feed: true, mirror: false }); // input not mutated

    // A channel with no entry: returns the map unchanged (no-op, safe to persist).
    expect(clearChannel(base, "CX")).toBe(base);
  });
});

describe("channel setup / teardown reset — the `feed here` / `standup off` contract", () => {
  // These pin the pure resolution the index.ts handlers now depend on: after a
  // channel is cleared, its EFFECTIVE toggles are the quiet default — mirror and
  // feed lines off — no matter what override it carried before, so `feed here`
  // and `standup off` can't be silently contradicted by a stale override.
  test("clearing a LOUD channel (feed on) returns it to feed-off quiet default", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "C", "feed", true));
    expect(store.feedEnabled("C")).toBe(true); // loud
    expect(store.feedKindEnabled("C", "launched")).toBe(true);

    store.set(clearChannel(store.snapshot(), "C"));
    expect(store.feedEnabled("C")).toBe(false); // quiet again
    expect(store.feedKindEnabled("C", "launched")).toBe(false);
    expect(store.mirrorEnabled("C")).toBe(false);
    // Persisted blob no longer carries a dead entry for C.
    expect(JSON.parse(store.toJson()).C).toBeUndefined();
  });

  test("clearing a MIRROR-ON channel turns the mirror back off (`feed here` stays quiet)", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "C", "mirror", true));
    expect(store.mirrorEnabled("C")).toBe(true); // mirroring

    store.set(clearChannel(store.snapshot(), "C"));
    expect(store.mirrorEnabled("C")).toBe(false);
    expect(store.feedEnabled("C")).toBe(false);
  });
});

describe("describeChannel", () => {
  test("an unset channel reflects the quiet default (feed/mirror off, asks on, kinds off)", () => {
    const desc = describeChannel({}, "CX");
    expect(desc).toContain("feed: off");
    expect(desc).toContain("mirror: off");
    expect(desc).toContain("asks: on");
    expect(desc).toContain("launched off");
    expect(desc).toContain("finished off");
  });

  test("feed on ⇒ kinds show on; explicit mirror off + launched off are reflected", () => {
    const map = setFeedKind(
      setFeature(setFeature({}, "C1", "feed", true), "C1", "mirror", false),
      "C1",
      "launched",
      false,
    );
    const desc = describeChannel(map, "C1");
    expect(desc).toContain("mirror: off");
    expect(desc).toContain("feed: on");
    expect(desc).toContain("asks: on");
    expect(desc).toContain("launched off");
    expect(desc).toContain("finished on"); // feed on ⇒ an unset kind shows
  });
});

describe("parseChannelCommand", () => {
  test("feed here sets the standup channel; standup off / off unset it", () => {
    expect(parseChannelCommand("<@U0BOT> feed here")).toEqual({ kind: "feed-here" });
    expect(parseChannelCommand("standup off")).toEqual({ kind: "standup-off" });
    expect(parseChannelCommand("off")).toEqual({ kind: "standup-off" });
    expect(parseChannelCommand("<@U0BOT> off")).toEqual({ kind: "standup-off" });
  });

  test("a bare `off` must stand alone — a multi-word mention starting with 'off' is NOT a teardown", () => {
    // Destructive teardown from a single stray word is the footgun: a mention like
    // "off you go" or "off now" must fall through to help, not tear the channel down.
    expect(parseChannelCommand("off you go")).toBeNull();
    expect(parseChannelCommand("off now")).toBeNull();
    expect(parseChannelCommand("<@U0BOT> off topic")).toBeNull();
    // The explicit `standup off` verb is unaffected.
    expect(parseChannelCommand("standup off")).toEqual({ kind: "standup-off" });
  });

  test("feed on/off/stop toggle this channel's feed LINES (a coarse feature)", () => {
    expect(parseChannelCommand("feed on")).toEqual({ kind: "feature", feature: "feed", on: true });
    expect(parseChannelCommand("feed off")).toEqual({ kind: "feature", feature: "feed", on: false });
    expect(parseChannelCommand("feed stop")).toEqual({ kind: "feature", feature: "feed", on: false });
  });

  test("coarse feature on/off for mirror/asks", () => {
    expect(parseChannelCommand("mirror off")).toEqual({ kind: "feature", feature: "mirror", on: false });
    expect(parseChannelCommand("asks on")).toEqual({ kind: "feature", feature: "asks", on: true });
  });

  test("per-event-type feed <kind> on/off", () => {
    expect(parseChannelCommand("feed launched off")).toEqual({ kind: "feed-kind", feedKind: "launched", on: false });
    expect(parseChannelCommand("feed digest on")).toEqual({ kind: "feed-kind", feedKind: "digest", on: true });
    expect(parseChannelCommand("<@U0BOT> feed checkpoint on")).toEqual({ kind: "feed-kind", feedKind: "checkpoint", on: true });
  });

  test("feed status", () => {
    expect(parseChannelCommand("feed status")).toEqual({ kind: "status" });
  });

  test("unrecognized input ⇒ null (caller shows help)", () => {
    expect(parseChannelCommand("hello there")).toBeNull();
    expect(parseChannelCommand("feed bogus off")).toBeNull();
    expect(parseChannelCommand("mirror maybe")).toBeNull();
    expect(parseChannelCommand("")).toBeNull();
  });
});

describe("ChannelFeatureStore — version-guarded poll safety", () => {
  test("load + query + serialize round-trip; fails open to the quiet default", () => {
    const store = new ChannelFeatureStore();
    // Untouched → quiet default: mirror off, feed off.
    expect(store.mirrorEnabled("C1")).toBe(false);
    expect(store.feedEnabled("C1")).toBe(false);

    store.set(setFeature(store.snapshot(), "C1", "mirror", true));
    expect(store.mirrorEnabled("C1")).toBe(true);
    expect(store.mirrorEnabled("C2")).toBe(false); // other channel unaffected

    const json = store.toJson();
    const reloaded = new ChannelFeatureStore();
    reloaded.load(json);
    expect(reloaded.mirrorEnabled("C1")).toBe(true);

    reloaded.load("{broken");
    expect(reloaded.mirrorEnabled("C1")).toBe(false); // fail open to the quiet default
    expect(reloaded.feedEnabled("C1")).toBe(false);
  });

  // (2) A just-issued `mirror off` is NEVER reverted by a racing poll. Approach V:
  // the poll's blob is stale (version < the mutation's) so the local value is kept.
  test("a stale poll (lower version) never reverts a just-issued `mirror off`", () => {
    const store = new ChannelFeatureStore();
    // The command mutes C's mirror; the collector assigns the persist version 5.
    store.set(setFeature(store.snapshot(), "C", "mirror", false));
    store.recordPersistedVersion(5, ["C"]);
    const persisted = store.toJson();
    expect(store.mirrorEnabled("C")).toBe(false);

    // A poll whose getSettings() predates the persist returns the OLD blob at an
    // earlier version. reconcile must KEEP the local mutation — no transient revert.
    store.reconcile("{}", 4);
    expect(store.mirrorEnabled("C")).toBe(false);
    // Even an in-flight mutation (version not yet recorded) is protected unconditionally.
    const inflight = new ChannelFeatureStore();
    inflight.set(setFeature(inflight.snapshot(), "C", "mirror", false));
    inflight.reconcile("{}", 999);
    expect(inflight.mirrorEnabled("C")).toBe(false);

    // The poll that reaches the persist version adopts our own blob and clears the
    // pending record; a later external edit is then picked up again.
    store.reconcile(persisted, 5);
    expect(store.mirrorEnabled("C")).toBe(false);
    store.reconcile(JSON.stringify(setFeature({}, "C", "mirror", true)), 6);
    expect(store.mirrorEnabled("C")).toBe(true); // external change now adopted
  });

  test("reconcile with no pending local mutation adopts the fetched blob (external edits win)", () => {
    const store = new ChannelFeatureStore();
    store.reconcile(JSON.stringify(setFeature({}, "C", "mirror", false)), 1);
    expect(store.mirrorEnabled("C")).toBe(false);
  });

  // (4) A reconnect/open load() is authoritative — it drops any pending mutation and
  // adopts the fetched blob outright.
  test("an authoritative load() clears pending (reconnect adopts the persisted blob)", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "C", "mirror", true)); // pending local mutation
    store.recordPersistedVersion(5, ["C"]);
    store.load("{}"); // reconnect/open — authoritative reload drops it
    expect(store.mirrorEnabled("C")).toBe(false);
    // No pending record: a following poll simply adopts, at any version.
    store.reconcile(JSON.stringify(setFeature({}, "C", "asks", false)), 1);
    expect(store.asksEnabled("C")).toBe(false);
  });

  // (1) The core requirement: an external edit during a pending local mutation is
  // ALWAYS eventually adopted — an unrelated channel immediately, and the mutated
  // channel once its persist round-trips — with NO permanently-stuck state.
  test("external edits are adopted: unrelated channel immediately, mutated channel after round-trip", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "A", "mirror", false)); // pending on A
    store.recordPersistedVersion(5, ["A"]);

    // A fresh poll (version ≥ 5) carries A's persisted mutation AND an unrelated
    // external edit to B. B is adopted immediately; A keeps its (now round-tripped)
    // value. Nothing about A's pending state freezes B.
    store.reconcile(JSON.stringify({ A: { mirror: false }, B: { feed: true } }), 5);
    expect(store.mirrorEnabled("A")).toBe(false);
    expect(store.feedEnabled("B")).toBe(true); // unrelated external edit adopted

    // A later external edit to the MUTATED channel A (after round-trip) is adopted.
    store.reconcile(JSON.stringify({ A: { mirror: true }, B: { feed: true } }), 6);
    expect(store.mirrorEnabled("A")).toBe(true);
  });

  test("a same-channel external edit that FLIPS the mutated leaf is adopted (no stuck-dirty)", () => {
    // The regression a byte/value-match dirty flag hit: `mirror off` (local) races
    // an external `mirror on` for the SAME channel. A value-match guard would keep
    // waiting to see mirror:false, freezing the channel until reconnect. The version
    // guard adopts any blob whose version reached the mutation's, so the external
    // edit always eventually wins.
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "C", "mirror", false));
    store.recordPersistedVersion(5, ["C"]);
    expect(store.mirrorEnabled("C")).toBe(false);

    // A stale poll (version 4) still protects the local mutation.
    store.reconcile(JSON.stringify({ C: { mirror: false } }), 4);
    expect(store.mirrorEnabled("C")).toBe(false);

    // A fresh poll (version 6) carrying the opposite external value is adopted —
    // never frozen — even though it never matched the locally-set value.
    store.reconcile(JSON.stringify({ C: { mirror: true } }), 6);
    expect(store.mirrorEnabled("C")).toBe(true);
  });

  test("a pending mutation on one channel doesn't freeze external edits to OTHER channels", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "C", "mirror", false)); // pending on C only
    store.recordPersistedVersion(5, ["C"]);
    // A stale poll (version 4) that predates C's persist but carries a fresh external
    // edit for D: C keeps its local mutation; D is adopted immediately.
    store.reconcile(JSON.stringify({ D: { feed: true } }), 4);
    expect(store.mirrorEnabled("C")).toBe(false); // C protected
    expect(store.feedEnabled("D")).toBe(true); // D's external edit flowed
  });

  test("a pending feed-kind mutation is protected until its version, then external edits win", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeedKind(store.snapshot(), "C", "launched", false));
    store.recordPersistedVersion(5, ["C"]);
    // Stale poll re-enabling the kind: protected.
    store.reconcile(JSON.stringify({ C: { feed: true, feedKinds: { launched: true } } }), 4);
    expect(store.feedKindEnabled("C", "launched")).toBe(false);
    // Fresh poll (version 5) with an external re-enable of that kind is adopted.
    store.reconcile(JSON.stringify({ C: { feed: true, feedKinds: { launched: true } } }), 5);
    expect(store.feedKindEnabled("C", "launched")).toBe(true);
  });

  // (3-analog for the blob) `standup off` clears a channel's overrides; a stale poll
  // must not resurrect them, and once the version reaches the teardown it adopts.
  test("a pending clearChannel (standup off) isn't resurrected by a stale poll, then adopts", () => {
    const store = new ChannelFeatureStore();
    store.load(JSON.stringify({ C: { feed: true } })); // C was loud
    store.set(clearChannel(store.snapshot(), "C")); // teardown
    store.recordPersistedVersion(5, ["C"]);
    expect(store.feedEnabled("C")).toBe(false); // quiet default

    // Stale poll still carrying the old loud blob must NOT resurrect C.
    store.reconcile(JSON.stringify({ C: { feed: true } }), 4);
    expect(store.feedEnabled("C")).toBe(false);

    // Teardown round-tripped (version 5, C absent) ⇒ pending clears; a later web-UI
    // re-add of C is then adopted.
    store.reconcile("{}", 5);
    store.reconcile(JSON.stringify({ C: { feed: true } }), 6);
    expect(store.feedEnabled("C")).toBe(true);
  });

  test("a failed persist (no version) drops the in-flight protection so the collector wins", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "C", "mirror", true));
    store.recordPersistedVersion(undefined, ["C"]); // PUT failed — nothing persisted
    // The very next poll (any version) adopts the collector's value rather than
    // freezing on a mutation that never landed.
    store.reconcile("{}", 1);
    expect(store.mirrorEnabled("C")).toBe(false);
  });

  // Two OVERLAPPING commands: recordPersistedVersion must stamp ONLY the channel the
  // returning command persisted, not every pending channel. Command0 (`asks off E`)
  // persists at version 4; Command1 (`mirror off C`) is still in flight. A poll that
  // observes version 4 (carrying E but not yet C) must NOT revert C — C is still
  // unstamped, so it stays protected until ITS own persist round-trips.
  test("stamping one command's channel does not drop a concurrent command's in-flight channel", () => {
    const store = new ChannelFeatureStore();
    // Command0 mutates E; Command1 interleaves and mutates C — both pending, unstamped.
    store.set(setFeature(store.snapshot(), "E", "asks", false));
    store.set(setFeature(store.snapshot(), "C", "mirror", false));
    expect(store.asksEnabled("E")).toBe(false);
    expect(store.mirrorEnabled("C")).toBe(false);

    // Command0's PUT returns version 4 — stamp ONLY E (the channel it persisted).
    store.recordPersistedVersion(4, ["E"]);

    // A poll at version 4 carrying E's persisted mutation but NOT C's (C's PUT hasn't
    // committed). E adopts (round-tripped); C must stay muted — it is still unstamped.
    store.reconcile(JSON.stringify({ E: { asks: false } }), 4);
    expect(store.asksEnabled("E")).toBe(false);
    expect(store.mirrorEnabled("C")).toBe(false); // NOT reverted by the v4 poll

    // Command1's PUT finally returns version 5 — stamp C. A poll at 5 carrying both
    // (the collector merged, so C survives too) adopts the collector truth for C.
    store.recordPersistedVersion(5, ["C"]);
    store.reconcile(JSON.stringify({ E: { asks: false }, C: { mirror: false } }), 5);
    expect(store.mirrorEnabled("C")).toBe(false);
  });

  // recordPersistedVersion is scoped: passing a channel that ISN'T what this command
  // mutated must not stamp (nor resurrect) the other pending channel.
  test("recordPersistedVersion only touches the channels it is given", () => {
    const store = new ChannelFeatureStore();
    store.set(setFeature(store.snapshot(), "A", "mirror", false)); // pending A (unstamped)
    store.set(setFeature(store.snapshot(), "B", "mirror", false)); // pending B (unstamped)
    store.recordPersistedVersion(4, ["A"]); // stamp only A

    // A poll at 4 that predates B's persist: A round-trips (stamped 4), B is protected.
    store.reconcile(JSON.stringify({ A: { mirror: false } }), 4);
    expect(store.mirrorEnabled("A")).toBe(false);
    expect(store.mirrorEnabled("B")).toBe(false); // B still guarded — never stamped

    // A failed persist for A alone must not drop B's protection either.
    store.recordPersistedVersion(undefined, ["A"]);
    store.reconcile(JSON.stringify({ A: { mirror: false } }), 5);
    expect(store.mirrorEnabled("B")).toBe(false);
  });

  // Version floor: a poll can resolve OUT OF ORDER — issued (during an outage)
  // before a newer edit, but arriving after it. Its blob predates the newer version,
  // so it must be DROPPED, not adopted, even for a channel with NO pending mutation
  // (the per-channel pending guard alone doesn't cover that channel).
  test("an out-of-order reconcile below the last applied version is ignored (newer edit survives)", () => {
    const store = new ChannelFeatureStore();
    // A newer external edit is adopted at version 9 (no pending local mutation).
    store.reconcile(JSON.stringify({ C: { mirror: false } }), 9);
    expect(store.mirrorEnabled("C")).toBe(false);
    // A poll from BEFORE that edit (version 6) resolves late, carrying the older
    // blob (mirror on). It is strictly lower than 9, so it is dropped — the v9 edit
    // survives rather than being transiently reverted until the next poll.
    store.reconcile(JSON.stringify({ C: { mirror: true } }), 6);
    expect(store.mirrorEnabled("C")).toBe(false);
    // A genuinely newer edit (version 10) is still adopted.
    store.reconcile(JSON.stringify({ C: { mirror: true } }), 10);
    expect(store.mirrorEnabled("C")).toBe(true);
  });

  test("an authoritative load() sets the floor so a stale poll issued during the outage is dropped", () => {
    const store = new ChannelFeatureStore();
    // Reconnect load adopts the current blob at version 9.
    store.load(JSON.stringify({ C: { asks: false } }), 9);
    expect(store.asksEnabled("C")).toBe(false);
    // A getSettings poll issued during the outage (older, version 6) resolves after
    // the load; the floor drops it so it can't revert the authoritative state.
    store.reconcile(JSON.stringify({ C: { asks: true } }), 6);
    expect(store.asksEnabled("C")).toBe(false);
  });
});

describe("persist deltas (patch builders)", () => {
  test("featurePatch sets one coarse flag on one channel", () => {
    expect(featurePatch("C", "mirror", false)).toEqual({ set: { C: { mirror: false } } });
    expect(featurePatch("C", "feed", true)).toEqual({ set: { C: { feed: true } } });
  });

  test("feedKindPatch sets one feed-kind on one channel", () => {
    expect(feedKindPatch("C", "launched", false)).toEqual({ set: { C: { feedKinds: { launched: false } } } });
  });

  test("clearChannelPatch drops one channel's entry", () => {
    expect(clearChannelPatch("C")).toEqual({ clear: ["C"] });
  });
});

describe("FeedChannelSync — version-guarded feed-channel poll safety", () => {
  test("initial load adopts the seed channel and returns it", () => {
    const sync = new FeedChannelSync();
    expect(sync.load("C-feed")).toBe("C-feed");
    expect(sync.current()).toBe("C-feed");
    expect(sync.load(undefined)).toBe(""); // absent seed ⇒ off
  });

  // (3) A just-issued `standup off` (feed channel → "") is NOT reverted by a racing
  // poll whose GET predates the persist; once the version reaches it, it adopts.
  test("`standup off` teardown is not reverted by a stale poll, then re-stabilizes", () => {
    const sync = new FeedChannelSync();
    sync.load("C-feed"); // channel was set
    sync.setLocal("", 5); // standup off — persisted at version 5
    expect(sync.current()).toBe("");

    // Stale poll (version 4) still carrying the old channel must NOT resurrect it.
    expect(sync.reconcile("C-feed", 4)).toBe("");
    expect(sync.current()).toBe("");

    // The poll that reaches the teardown version adopts "" (stays off).
    expect(sync.reconcile("", 5)).toBe("");
  });

  test("a `feed here` set is protected from a stale poll, then external edits win", () => {
    const sync = new FeedChannelSync();
    sync.setLocal("C-new", 5); // feed here → C-new at version 5
    expect(sync.reconcile("C-old", 4)).toBe("C-new"); // stale poll can't revert
    // A fresh poll reaching version 5 (or a newer external move) is adopted.
    expect(sync.reconcile("C-old", 6)).toBe("C-old");
  });

  test("no pending mutation ⇒ any poll is adopted (external edits flow)", () => {
    const sync = new FeedChannelSync();
    sync.load("C-a");
    expect(sync.reconcile("C-b", 1)).toBe("C-b"); // web-UI move adopted
  });

  // (4) A reconnect/open load() is authoritative even over a pending mutation.
  test("authoritative load() clears the pending version", () => {
    const sync = new FeedChannelSync();
    sync.setLocal("C-new", 5); // pending
    expect(sync.load("C-persisted")).toBe("C-persisted"); // reconnect adopts outright
    expect(sync.reconcile("C-other", 1)).toBe("C-other"); // no lingering protection
  });

  test("a failed persist (no version) leaves no protection so the collector wins", () => {
    const sync = new FeedChannelSync();
    sync.load("C-a");
    sync.setLocal("C-new", undefined); // PUT failed
    expect(sync.reconcile("C-a", 1)).toBe("C-a"); // collector value adopted next poll
  });

  test("an out-of-order reconcile below the last applied version is ignored (newer move survives)", () => {
    const sync = new FeedChannelSync();
    sync.reconcile("C-new", 9); // newer external move adopted (no pending mutation)
    expect(sync.current()).toBe("C-new");
    // A late poll from before the move (version 6) carrying the old channel is dropped.
    expect(sync.reconcile("C-old", 6)).toBe("C-new");
    // A genuinely newer move (version 10) is still adopted.
    expect(sync.reconcile("C-older", 10)).toBe("C-older");
  });
});
