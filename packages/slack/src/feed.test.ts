// Feed dedup + per-channel enforcement. No live Slack: a fake WebClient records
// every chat.postMessage. Pins (1) the launch de-dup — a launch that re-broadcasts
// launch:started once per provisioning phase must post ONE `launched:` line, while
// two distinct launches post two — and (2) per-channel feed toggles under the
// QUIET default: an unset channel posts NO feed lines, `feed on` delivers them,
// `feed launched on` (allowlist) delivers only that kind, and the coarse feed
// master gates everything. A sibling channel is unaffected.

import { describe, expect, test } from "bun:test";
import type { WsMessage, Launch, Checkpoint, Ask } from "@standup/shared";
import { Feed } from "./feed.js";
import { ChannelFeatureStore, setFeature, setFeedKind } from "./channel-features.js";

function makeWeb() {
  const posts: { channel: string; text: string }[] = [];
  const web = {
    chat: {
      postMessage: async (args: { channel: string; text: string }) => {
        posts.push({ channel: args.channel, text: args.text });
        return { ok: true, ts: "ts" };
      },
    },
  };
  return { web, posts };
}

const collector = { sessionTitle: async () => "Session" } as never;

function launchMsg(id: string, status: string, phase?: string): WsMessage {
  return {
    type: "launch:started",
    payload: { id, status, phase, task: "ship the widget" } as unknown as Launch,
    timestamp: "2026-01-01T00:00:00Z",
  } as WsMessage;
}

function checkpointMsg(sessionId: string): WsMessage {
  return {
    type: "checkpoint:new",
    payload: {
      id: "cp1",
      sessionId,
      source: "self-reported",
      summary: "Shipped the fix",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    } satisfies Checkpoint,
    timestamp: "2026-01-01T00:00:00Z",
  } as WsMessage;
}

describe("Feed launch de-duplication", () => {
  test("a launch's starting + phase + running frames post exactly ONE launched line", async () => {
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector);
    feed.setChannel("C-feed");

    feed.handle(launchMsg("L1", "starting"));
    feed.handle(launchMsg("L1", "starting", "provisioning"));
    feed.handle(launchMsg("L1", "starting", "installing"));
    feed.handle(launchMsg("L1", "running"));
    await feed.whenIdle();

    const launched = posts.filter((p) => p.text.includes("launched:"));
    expect(launched.length).toBe(1);
  });

  test("two DISTINCT launches post two lines", async () => {
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector);
    feed.setChannel("C-feed");

    feed.handle(launchMsg("L1", "starting"));
    feed.handle(launchMsg("L2", "starting"));
    feed.handle(launchMsg("L1", "running")); // dup of L1 — suppressed
    await feed.whenIdle();

    expect(posts.filter((p) => p.text.includes("launched:")).length).toBe(2);
  });
});

describe("Feed per-channel toggles", () => {
  test("unset channel ⇒ feed off by default (no feed lines)", async () => {
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, new ChannelFeatureStore());
    feed.setChannel("A");
    feed.handle(launchMsg("L1", "starting"));
    feed.handle(checkpointMsg("s1"));
    await feed.whenIdle();
    expect(posts.length).toBe(0); // quiet by default until `feed on`
  });

  test("the daily digest is off by default; `feed digest on` alone delivers it", async () => {
    const digest = {
      type: "digest:posted",
      payload: {
        id: "digest:2026-01-15",
        createdAt: "2026-01-15T14:30:00Z",
        periodStart: "2026-01-14T14:30:00Z",
        periodEnd: "2026-01-15T14:30:00Z",
        body: "## web\n- shipped the digest cron",
        projects: ["web"],
        counts: { projects: 1, activeWork: 0, taskRuns: 1, checkpoints: 0, knowledgeChanges: 0, asks: 0, launches: 0 },
      },
      timestamp: "2026-01-15T14:30:00Z",
    } as WsMessage;
    const features = new ChannelFeatureStore();
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.handle(digest);
    await feed.whenIdle();
    expect(posts.length).toBe(0);

    features.set(setFeedKind(features.snapshot(), "A", "digest", true));
    feed.handle(digest);
    await feed.whenIdle();
    expect(posts.some((p) => p.text.includes("Morning digest"))).toBe(true);
  });

  test("`feed on` delivers feed lines (every kind)", async () => {
    const features = new ChannelFeatureStore();
    features.set(setFeature(features.snapshot(), "A", "feed", true));

    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.handle(launchMsg("L1", "starting"));
    feed.handle(checkpointMsg("s1"));
    await feed.whenIdle();

    expect(posts.some((p) => p.text.includes("launched:"))).toBe(true);
    expect(posts.some((p) => p.text.includes("Shipped the fix"))).toBe(true);
  });

  test("`feed launched on` (allowlist) delivers ONLY that kind", async () => {
    const features = new ChannelFeatureStore();
    // `feed on`, then `feed launched on`: coarse feed on, then allowlist launched.
    let map = setFeature(features.snapshot(), "A", "feed", true);
    map = setFeedKind(map, "A", "launched", true);
    features.set(map);

    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.handle(launchMsg("L1", "starting"));
    feed.handle(checkpointMsg("s1")); // a different kind — suppressed by the allowlist
    await feed.whenIdle();

    expect(posts.some((p) => p.text.includes("launched:"))).toBe(true);
    expect(posts.some((p) => p.text.includes("Shipped the fix"))).toBe(false);
  });

  test("feed on in A; a sibling channel B stays quiet (default off)", async () => {
    const features = new ChannelFeatureStore();
    features.set(setFeature(features.snapshot(), "A", "feed", true));

    const a = makeWeb();
    const feedA = new Feed(a.web as never, collector, features);
    feedA.setChannel("A");
    const b = makeWeb();
    const feedB = new Feed(b.web as never, collector, features);
    feedB.setChannel("B"); // no override ⇒ feed off

    feedA.handle(launchMsg("L1", "starting"));
    feedB.handle(launchMsg("L1", "starting"));
    await Promise.all([feedA.whenIdle(), feedB.whenIdle()]);

    expect(a.posts.some((p) => p.text.includes("launched:"))).toBe(true);
    expect(b.posts.length).toBe(0); // sibling unaffected — still quiet
  });

  test("coarse feed off mutes even an allowlisted kind", async () => {
    const features = new ChannelFeatureStore();
    let map = setFeature(features.snapshot(), "A", "feed", false);
    map = setFeedKind(map, "A", "launched", true); // kind on, but feed master off
    features.set(map);

    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.handle(launchMsg("L1", "starting"));
    await feed.whenIdle();

    expect(posts.length).toBe(0); // the coarse gate wins
  });
});

describe("Feed ask:new surface follows the channel's mirror state", () => {
  // The flat "needs input" line is a DOUBLE surface only when the mirror is on —
  // Asks posts the card in-thread then. With the mirror OFF for the channel but the
  // feed on, Asks falls back to a DM (or nowhere), so the flat feed line is the
  // channel's ONLY surface for the blocking ask and must not be suppressed just
  // because the (always-wired) thread resolver exists.
  function askMsg(sessionId: string): WsMessage {
    return {
      type: "ask:new",
      payload: { id: "ask1", sessionId, question: "Which region?", kind: "free_text" } as unknown as Ask,
      timestamp: "2026-01-01T00:00:00Z",
    } as WsMessage;
  }

  test("mirror ON + feed on: the flat 'needs input' line is suppressed (Asks posts in-thread)", async () => {
    const features = new ChannelFeatureStore();
    features.set(setFeature(setFeature(features.snapshot(), "A", "feed", true), "A", "mirror", true)); // feed on, mirror on
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.setThreadResolver(() => undefined); // mirror wiring present
    feed.handle(askMsg("s1"));
    await feed.whenIdle();
    expect(posts.some((p) => p.text.includes("needs input"))).toBe(false);
  });

  test("mirror OFF + feed on: the flat 'needs input' line IS emitted (channel's only surface)", async () => {
    const features = new ChannelFeatureStore();
    let map = setFeature(features.snapshot(), "A", "feed", true);
    map = setFeature(map, "A", "mirror", false); // feed on, mirror off
    features.set(map);
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.setThreadResolver(() => undefined); // resolver still wired, but mirror is off here
    feed.handle(askMsg("s1"));
    await feed.whenIdle();
    expect(posts.some((p) => p.text.includes("needs input"))).toBe(true);
  });

  test("mirror ON + asks OFF + feed on: the flat 'needs input' line IS emitted (no in-thread card)", async () => {
    // `asks off` disables the in-thread ask card (asks.ts gates it on channelAsksEnabled),
    // so the mirror being on no longer implies a duplicate surface. The flat feed line is
    // then the channel's only in-channel surface and must not be suppressed on mirror alone.
    const features = new ChannelFeatureStore();
    let map = setFeature(features.snapshot(), "A", "feed", true);
    map = setFeature(map, "A", "mirror", true);
    map = setFeature(map, "A", "asks", false); // feed on, mirror on, asks off
    features.set(map);
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.setThreadResolver(() => undefined); // mirror wiring present + mirror on, but asks off here
    feed.handle(askMsg("s1"));
    await feed.whenIdle();
    expect(posts.some((p) => p.text.includes("needs input"))).toBe(true);
  });

  test("mirror ON + asks ON + feed on: the flat 'needs input' line is suppressed (in-thread card posts)", async () => {
    // Both mirror and asks on ⇒ Asks posts the card in-thread, so the flat line would be
    // a duplicate and is dropped. (Guards the suppression path from over-correcting.)
    const features = new ChannelFeatureStore();
    let map = setFeature(features.snapshot(), "A", "feed", true);
    map = setFeature(map, "A", "mirror", true);
    map = setFeature(map, "A", "asks", true); // feed on, mirror on, asks explicitly on
    features.set(map);
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector, features);
    feed.setChannel("A");
    feed.setThreadResolver(() => undefined);
    feed.handle(askMsg("s1"));
    await feed.whenIdle();
    expect(posts.some((p) => p.text.includes("needs input"))).toBe(false);
  });
});

describe("Feed — personal frames never reach the shared channel", () => {
  test("an addressed frame or a personal-layer change posts nothing; a shared change still posts", async () => {
    const { web, posts } = makeWeb();
    const feed = new Feed(web as never, collector);
    feed.setChannel("C-feed");
    const change = (slug: string, title: string, extra: Record<string, unknown> = {}) =>
      ({
        type: "knowledge:change",
        payload: { id: slug, projectId: "p", slug, kind: "accepted", title, createdAt: "2026-01-01T00:00:00Z", ...extra },
        timestamp: "2026-01-01T00:00:00Z",
      }) as WsMessage;

    feed.handle({ ...change("native-mem-home-claude-md", "bob private CLAUDE.md"), audience: "bob" });
    feed.handle(change("alice-legal", "Alice divorce lawyer notes", { personal: true, ownerUser: "alice" }));
    feed.handle(change("team-doc", "Team deploy train"));
    await feed.whenIdle();

    const text = posts.map((p) => p.text).join("\n");
    expect(text).not.toContain("private CLAUDE.md");
    expect(text).not.toContain("divorce");
    expect(text).toContain("Team deploy train");
  });
});
