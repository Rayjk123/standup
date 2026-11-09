// Regression for the "constant repeat" ask spam: `bun run dev` restarts the
// adapter on any source change, and on each reconnect resync() re-fetches the
// still-pending asks. The in-memory dedup is empty after a restart, so without a
// durable binding store every pending ask is re-posted. These tests drive two
// Asks instances against ONE persisted state file to prove a fresh process
// re-adopts an already-posted ask instead of re-posting it.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Ask } from "@standup/shared";
import { Asks, type ThreadProvider } from "./asks.js";
import { ChannelFeatureStore, setFeature } from "./channel-features.js";

function makeWeb() {
  const posts: { channel: string }[] = [];
  const updates: { channel: string; ts: string }[] = [];
  let ts = 0;
  const web = {
    chat: {
      postMessage: async (args: { channel: string }) => {
        posts.push({ channel: args.channel });
        return { ts: `ts-${++ts}` };
      },
      update: async (args: { channel: string; ts: string }) => {
        updates.push({ channel: args.channel, ts: args.ts });
        return { ok: true };
      },
    },
    conversations: {
      open: async () => ({ channel: { id: "D-owner" } }),
    },
  };
  return { web, posts, updates };
}

function makeCollector(pending: Ask[]) {
  return {
    sessionTitle: async () => "Session",
    getPendingAsks: async () => pending,
    setAskUser: async () => {},
    resolveAsk: async () => ({ ok: true }),
  };
}

const ask = (id: string): Ask =>
  ({
    id,
    sessionId: `s-${id}`,
    question: `Approve ${id}?`,
    kind: "permission_prompt",
    createdAt: "2026-01-01T00:00:00Z",
    status: "pending",
  }) as unknown as Ask;

const cleanups: string[] = [];
let seq = 0;
function tmpAskState(): void {
  const p = join(tmpdir(), `standup-asks-${process.pid}-${++seq}.json`);
  process.env.STANDUP_SLACK_ASK_STATE = p;
  cleanups.push(p);
}
afterAll(() => {
  for (const p of cleanups) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("Asks restart de-duplication", () => {
  test("a pending ask posted by one process is NOT re-posted by a fresh process on resync", async () => {
    tmpAskState();
    const a = ask("1");

    // Process 1: deliver the ask (DM mode — no thread provider).
    const w1 = makeWeb();
    const asks1 = new Asks(w1.web as never, makeCollector([a]) as never, "U-owner", undefined);
    await asks1.onAskNew(a);
    expect(w1.posts.length).toBe(1);

    // Process 2 (restart): same persisted state, same still-pending ask.
    const w2 = makeWeb();
    const asks2 = new Asks(w2.web as never, makeCollector([a]) as never, "U-owner", undefined);
    await asks2.resync();
    expect(w2.posts.length).toBe(0); // re-adopted from the persisted binding — no duplicate
  });

  test("hasPendingForDm tracks a DM channel's open asks (so the DM router can defer to the ask)", async () => {
    tmpAskState();
    const a = ask("dm");

    const w = makeWeb();
    const asks = new Asks(w.web as never, makeCollector([a]) as never, "U-owner", undefined);
    // No ask delivered yet — nothing pending on any channel.
    expect(asks.hasPendingForDm("D-owner")).toBe(false);

    await asks.onAskNew(a); // DM'd to the learned recipient's DM channel (D-owner)
    expect(asks.hasPendingForDm("D-owner")).toBe(true);
    expect(asks.hasPendingForDm("D-someone-else")).toBe(false);

    // Answering the ask clears it — the DM router would then treat a "launch …"
    // reply as a launch again.
    await asks.onDmText("D-owner", "the answer");
    expect(asks.hasPendingForDm("D-owner")).toBe(false);
  });

  test("an ask resolved while offline is retired in place, not re-posted, on the next process", async () => {
    tmpAskState();
    const a = ask("2");

    const w1 = makeWeb();
    const asks1 = new Asks(w1.web as never, makeCollector([a]) as never, "U-owner", undefined);
    await asks1.onAskNew(a);
    expect(w1.posts.length).toBe(1);

    // Process 2: the ask is no longer pending (answered in the web UI while offline).
    const w2 = makeWeb();
    const asks2 = new Asks(w2.web as never, makeCollector([]) as never, "U-owner", undefined);
    await asks2.resync();
    expect(w2.posts.length).toBe(0); // never re-posted
    expect(w2.updates.length).toBe(1); // stale prompt retired in place (chat.update)
  });
});

describe("Asks per-channel gate", () => {
  // Records where each ask is posted (thread vs DM) so we can tell the in-channel
  // leg from the DM leg.
  function makeWebWithThread() {
    const posts: { channel: string; thread_ts?: string }[] = [];
    let ts = 0;
    const web = {
      chat: {
        postMessage: async (args: { channel: string; thread_ts?: string }) => {
          posts.push({ channel: args.channel, thread_ts: args.thread_ts });
          return { ts: `ts-${++ts}` };
        },
        update: async () => ({ ok: true }),
      },
      conversations: { open: async () => ({ channel: { id: "D-owner" } }) },
    };
    return { web, posts };
  }

  const threads: ThreadProvider = {
    isEnabled: () => true,
    ensureThread: async () => ({ channel: "C-feed", rootTs: "root1" }),
    sessionForRoot: () => undefined,
  };

  test("asks OFF for the channel: the ask is delivered by DM, not into the channel thread", async () => {
    tmpAskState();
    const features = new ChannelFeatureStore();
    features.set(setFeature(features.snapshot(), "C-feed", "asks", false));

    const w = makeWebWithThread();
    const asks = new Asks(w.web as never, makeCollector([]) as never, "U-owner", threads, undefined, undefined, features);
    await asks.onAskNew(ask("g1"));

    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.channel).toBe("D-owner"); // DM fallback
    expect(w.posts[0]!.thread_ts).toBeUndefined();
  });

  test("asks ON (default): the ask posts into the channel thread", async () => {
    tmpAskState();
    const w = makeWebWithThread();
    const asks = new Asks(
      w.web as never,
      makeCollector([]) as never,
      "U-owner",
      threads,
      undefined,
      undefined,
      new ChannelFeatureStore(),
    );
    await asks.onAskNew(ask("g2"));

    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.channel).toBe("C-feed"); // in-thread
    expect(w.posts[0]!.thread_ts).toBe("root1");
  });
});
