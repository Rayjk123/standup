import { describe, expect, test } from "bun:test";
import {
  parseChannelFeatureMap,
  mergeChannelFeaturesPatch,
  type ChannelFeatureMap,
} from "./channel-features.js";

/**
 * The per-channel merge is what makes a Slack command's persist safe: it applies a
 * delta on top of the CURRENT blob, so it can never clobber a concurrent per-channel
 * edit the way a whole-blob overwrite did. These pin: other channels survive, other
 * fields on the same channel survive, feedKinds merge key-by-key, clear removes a
 * channel, the merge is order-independent for distinct channels, and it fails open.
 */

describe("parseChannelFeatureMap — fail open", () => {
  test("missing / empty / malformed / non-object ⇒ empty map", () => {
    expect(parseChannelFeatureMap(undefined)).toEqual({});
    expect(parseChannelFeatureMap(null)).toEqual({});
    expect(parseChannelFeatureMap("")).toEqual({});
    expect(parseChannelFeatureMap("  ")).toEqual({});
    expect(parseChannelFeatureMap("{not json")).toEqual({});
    expect(parseChannelFeatureMap("[1,2]")).toEqual({});
    expect(parseChannelFeatureMap("42")).toEqual({});
  });

  test("well-formed JSON round-trips", () => {
    expect(parseChannelFeatureMap(JSON.stringify({ C: { feed: true } }))).toEqual({ C: { feed: true } });
  });
});

describe("mergeChannelFeaturesPatch", () => {
  test("a set delta on one channel preserves every OTHER channel (finding #1/#3)", () => {
    // The exact clobber scenario: an external writer set C feed:true; a command then
    // toggles a DIFFERENT channel D. With a whole-blob overwrite C was lost; the
    // per-channel merge keeps it.
    const current: ChannelFeatureMap = { C: { feed: true } };
    const merged = mergeChannelFeaturesPatch(current, { set: { D: { mirror: false } } });
    expect(merged).toEqual({ C: { feed: true }, D: { mirror: false } });
  });

  test("a set delta field-merges onto the SAME channel (other fields survive)", () => {
    // `mirror off` on a channel that already has feed:true must not wipe feed.
    const current: ChannelFeatureMap = { C: { feed: true } };
    const merged = mergeChannelFeaturesPatch(current, { set: { C: { mirror: false } } });
    expect(merged).toEqual({ C: { feed: true, mirror: false } });
  });

  test("feedKinds merge key-by-key, not whole-object replace", () => {
    const current: ChannelFeatureMap = { C: { feed: true, feedKinds: { launched: true, finished: true } } };
    const merged = mergeChannelFeaturesPatch(current, { set: { C: { feedKinds: { finished: false } } } });
    expect(merged).toEqual({ C: { feed: true, feedKinds: { launched: true, finished: false } } });
  });

  test("clear removes only the named channel", () => {
    const current: ChannelFeatureMap = { C: { feed: true }, D: { mirror: false } };
    expect(mergeChannelFeaturesPatch(current, { clear: ["C"] })).toEqual({ D: { mirror: false } });
  });

  test("distinct-channel patches COMMUTE — apply order can't lose a toggle (finding #3/#4)", () => {
    // Two concurrent commands: A `mirror off #alpha`, B `feed on #beta`. Whichever
    // order the collector applies them, both survive (the whole-blob race is gone).
    const patchA = { set: { alpha: { mirror: false } } };
    const patchB = { set: { beta: { feed: true } } };
    const abResult = mergeChannelFeaturesPatch(mergeChannelFeaturesPatch({}, patchA), patchB);
    const baResult = mergeChannelFeaturesPatch(mergeChannelFeaturesPatch({}, patchB), patchA);
    const expected = { alpha: { mirror: false }, beta: { feed: true } };
    expect(abResult).toEqual(expected);
    expect(baResult).toEqual(expected);
  });

  test("is pure — the input map is not mutated", () => {
    const current: ChannelFeatureMap = { C: { feed: true } };
    mergeChannelFeaturesPatch(current, { set: { C: { mirror: false } }, clear: ["Z"] });
    expect(current).toEqual({ C: { feed: true } });
  });

  test("a null/empty/garbage patch is a no-op copy", () => {
    const current: ChannelFeatureMap = { C: { feed: true } };
    expect(mergeChannelFeaturesPatch(current, null)).toEqual(current);
    expect(mergeChannelFeaturesPatch(current, {})).toEqual(current);
    // A malformed set is ignored, not applied.
    expect(mergeChannelFeaturesPatch(current, { set: undefined, clear: [] })).toEqual(current);
  });
});
