// Owner-routed attention: an ask for a session owned by X routes to X (DM /
// @-mention their Slack id), an owner-less session's ask is suppressed rather
// than blasted at the channel, and an owner we can't map (or a lookup that
// couldn't resolve) falls back to today's learned-recipient delivery. Driven
// through the same recording web/thread mocks the other Slack tests use — no
// live Slack call in any case.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Ask } from "@standup/shared";
import { Asks, routeForResponsible, type OwnerRoute, type OwnerRouting, type ThreadProvider } from "./asks.js";
import { ownerSlackId, parseOwnerMap } from "./env.js";

interface Post {
  channel: string;
  thread_ts?: string;
  text?: string;
  blocks?: unknown;
}

/** `openState.fail` makes conversations.open return no channel id (DM can't be opened). */
function makeWeb(opts: { openState?: { fail: boolean } } = {}) {
  const posts: Post[] = [];
  const updates: { channel: string; ts: string }[] = []; // chat.update targets, in call order
  const opened: string[] = []; // conversations.open `users` args, in call order
  let ts = 0;
  const web = {
    chat: {
      postMessage: async (args: Post) => {
        posts.push(args);
        return { ts: `ts-${++ts}` };
      },
      update: async (args: { channel: string; ts: string }) => {
        updates.push({ channel: args.channel, ts: args.ts });
        return { ok: true };
      },
    },
    conversations: {
      open: async (args: { users: string }) => {
        opened.push(args.users);
        if (opts.openState?.fail) return { channel: {} }; // no id → dmChannelFor yields undefined
        return { channel: { id: `D-${args.users}` } };
      },
    },
  };
  return { web, posts, updates, opened };
}

const collector = { sessionTitle: async () => "Session" };

/** A collector that also records resolveAsk calls + serves pending asks for resync. */
function makeCollector(pending: Ask[] = []) {
  const resolved: { id: string; answer: string; actor?: string }[] = [];
  const collectorMock = {
    sessionTitle: async () => "Session",
    getPendingAsks: async () => pending,
    setAskUser: async () => {},
    resolveAsk: async (id: string, answer: string, actor?: string) => {
      resolved.push({ id, answer, actor });
      return { ok: true };
    },
  };
  return { collectorMock, resolved };
}

function threadProvider(): ThreadProvider {
  return {
    isEnabled: () => true,
    ensureThread: async () => ({ channel: "C-feed", rootTs: "root-1" }),
    sessionForRoot: () => undefined,
  };
}

/** A thread provider whose root maps back to `sessionId` (an in-thread reply resolves). */
function threadProviderFor(sessionId: string, rootTs = "root-1"): ThreadProvider {
  return {
    isEnabled: () => true,
    ensureThread: async () => ({ channel: "C-feed", rootTs }),
    sessionForRoot: (rt: string) => (rt === rootTs ? sessionId : undefined),
  };
}

const routing = (route: OwnerRoute): OwnerRouting => ({ routeFor: async () => route });

const ask = (id: string): Ask => askFor(id, `s-${id}`);

const askFor = (id: string, sessionId: string): Ask =>
  ({
    id,
    sessionId,
    question: `Approve ${id}?`,
    kind: "permission_prompt",
    createdAt: "2026-01-01T00:00:00Z",
    status: "pending",
  }) as unknown as Ask;

let seq = 0;
const cleanups: string[] = [];
function isolateState(): void {
  const p = join(tmpdir(), `standup-owner-routing-${process.pid}-${++seq}.json`);
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

describe("Asks — owner-routed delivery", () => {
  test("an owned ask DMs the owner directly (guaranteed ping) AND mirrors into the thread — never the learned recipient", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider(), routing({ slackId: "U-ownerX" }));

    await asks.onAskNew(ask("1"));

    // The owner is DM'd — the guaranteed notification, since a thread @-mention
    // only notifies channel members and the owner may not be one.
    expect(w.opened).toEqual(["U-ownerX"]);
    const dm = w.posts.find((p) => p.channel === "D-U-ownerX");
    expect(dm).toBeDefined();
    // The ask is ALSO mirrored into the session thread for team visibility,
    // @-mentioning the owner (not the learned recipient).
    const threadPost = w.posts.find((p) => p.thread_ts === "root-1");
    expect(threadPost).toBeDefined();
    expect(threadPost!.text).toContain("<@U-ownerX>");
    // The learned recipient is never pinged for an owner-routed ask.
    expect(w.posts.some((p) => p.text?.includes("<@U-recipient>"))).toBe(false);
    expect(w.opened).not.toContain("U-recipient");
  });

  test("a non-member owner is still paged: the DM lands even though the thread @-mention wouldn't notify them", async () => {
    isolateState();
    const w = makeWeb();
    // bob is mapped but not a member of the feed channel — the thread mention
    // alone would silently miss him; the DM is the delivery that reaches him.
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider(), routing({ slackId: "U-bob" }));

    await asks.onAskNew(ask("1b"));

    expect(w.opened).toEqual(["U-bob"]);
    expect(w.posts.some((p) => p.channel === "D-U-bob")).toBe(true);
  });

  test("resolving an owner-routed ask retires BOTH the DM and the mirror-thread copy — no zombie card", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider(), routing({ slackId: "U-ownerX" }));

    await asks.onAskNew(ask("1c"));
    const posted = new Set(w.posts.map((p) => p.channel));
    expect(posted.has("D-U-ownerX")).toBe(true); // DM
    expect(posted.has("C-feed")).toBe(true); // thread copy

    // Answered elsewhere (web UI / timeout) — both messages must be updated to
    // the closed card so nothing is left live in the thread.
    await asks.onAskResolved("1c", "yes");
    const updatedChannels = new Set(w.updates.map((u) => u.channel));
    expect(updatedChannels.has("D-U-ownerX")).toBe(true);
    expect(updatedChannels.has("C-feed")).toBe(true);
  });

  test("with the mirror off, an owned ask DMs the owner directly, never the learned recipient", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", undefined, routing({ slackId: "U-ownerX" }));

    await asks.onAskNew(ask("2"));

    expect(w.opened).toEqual(["U-ownerX"]); // opened the owner's DM, not the recipient's
    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.channel).toBe("D-U-ownerX");
  });

  test("an owner-less ask is never blasted into the thread, but the blocking ask still DMs the single learned recipient (mirror on)", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider(), routing({ ownerless: true }));

    await asks.onAskNew(ask("3"));

    // OpenClaw owner-less suppression preserved: nothing is posted channel-wide.
    expect(w.posts.some((p) => p.thread_ts === "root-1")).toBe(false);
    // But an ask blocks the agent, so it reaches the single learned recipient's
    // DM (a private message, not a channel post) rather than being dropped.
    expect(w.opened).toEqual(["U-recipient"]);
    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.channel).toBe("D-U-recipient");
  });

  test("an owner-less ask DMs the learned recipient (mirror off) — a blocking ask is never dropped", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", undefined, routing({ ownerless: true }));

    await asks.onAskNew(ask("3b"));

    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.channel).toBe("D-U-recipient");
  });

  test("an owner-less ask with no learned recipient at all is fully suppressed (nothing to fall back to)", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, undefined, threadProvider(), routing({ ownerless: true }));

    await asks.onAskNew(ask("3c"));

    expect(w.posts.length).toBe(0);
    expect(w.opened.length).toBe(0);
  });

  test("an owner we can't map (route {}) falls back to the learned recipient", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider(), routing({}));

    await asks.onAskNew(ask("4"));

    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.text).toContain("<@U-recipient>"); // today's behavior — the learned recipient
  });

  test("with no owner routing wired at all, delivery is unchanged and never suppressed", async () => {
    isolateState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider());

    await asks.onAskNew(ask("5"));

    expect(w.posts.length).toBe(1);
    expect(w.posts[0]!.text).toContain("<@U-recipient>");
  });

  test("an in-thread reply resolves an owner-routed DM+mirror ask (routed via the mirror thread, not the DM)", async () => {
    isolateState();
    const w = makeWeb();
    const { collectorMock, resolved } = makeCollector();
    const asks = new Asks(
      w.web as never,
      collectorMock as never,
      "U-recipient",
      threadProviderFor("s-r1"),
      routing({ slackId: "U-ownerX" }),
    );

    await asks.onAskNew(askFor("r1", "s-r1")); // DM to owner + a mirror copy in the thread
    expect(asks.hasPendingForSession("s-r1")).toBe(true); // the mirror copy accepts a thread reply

    await asks.onThreadReply("root-1", "go ahead", "slack:U-teammate");

    expect(resolved).toEqual([{ id: "r1", answer: "go ahead", actor: "slack:U-teammate" }]);
  });

  test("two owner-routed asks + an in-thread reply → the 'which one?' picker posts INTO the thread, not the owner's DM", async () => {
    isolateState();
    const w = makeWeb();
    const { collectorMock } = makeCollector();
    const asks = new Asks(
      w.web as never,
      collectorMock as never,
      "U-recipient",
      threadProviderFor("s-multi"),
      routing({ slackId: "U-ownerX" }),
    );

    await asks.onAskNew(askFor("m1", "s-multi"));
    await asks.onAskNew(askFor("m2", "s-multi"));

    const before = w.posts.length;
    await asks.onThreadReply("root-1", "the first one", "slack:U-teammate");
    const picker = w.posts.slice(before).find((p) => p.text?.includes("open questions"));

    expect(picker).toBeDefined();
    // The picker must land in the mirror thread the reply came from — not the
    // owner's DM (D-U-ownerX), where the feed-channel thread_ts doesn't resolve.
    expect(picker!.channel).toBe("C-feed");
    expect(picker!.thread_ts).toBe("root-1");
  });

  test("owner DM can't be opened but the thread copy was posted → the thread copy becomes the tracked prompt (ask not dropped)", async () => {
    isolateState();
    const w = makeWeb({ openState: { fail: true } });
    const asks = new Asks(w.web as never, collector as never, "U-recipient", threadProvider(), routing({ slackId: "U-ownerX" }));

    await asks.onAskNew(ask("f1"));

    expect(w.opened).toEqual(["U-ownerX"]); // the DM open was attempted
    expect(w.posts.some((p) => p.thread_ts === "root-1")).toBe(true); // the thread copy landed
    expect(w.posts.some((p) => p.channel.startsWith("D-"))).toBe(false); // no DM (open failed)

    // Resolving retires the thread copy in place — proof it was tracked, not lost.
    await asks.onAskResolved("f1", "yes");
    expect(w.updates.some((u) => u.channel === "C-feed")).toBe(true);
  });

  test("owner DM fails AND there is no thread copy → the ask is dropped this round, then re-delivered on the next resync", async () => {
    isolateState();
    const openState = { fail: true };
    const w = makeWeb({ openState });
    const noThread: ThreadProvider = { isEnabled: () => true, ensureThread: async () => null, sessionForRoot: () => undefined };
    const { collectorMock } = makeCollector([ask("f2")]);
    const asks = new Asks(w.web as never, collectorMock as never, "U-recipient", noThread, routing({ slackId: "U-ownerX" }));

    await asks.onAskNew(ask("f2"));
    expect(w.posts.length).toBe(0); // nothing landed — dropped this round (not recorded)

    openState.fail = false; // the owner's DM can be opened now
    await asks.resync(); // the collector is the source of truth — it re-delivers
    expect(w.posts.some((p) => p.channel === "D-U-ownerX")).toBe(true);
  });

  test("a mapped owner answering their owner-routed DM does NOT overwrite the learned ask recipient (no setAskUser)", async () => {
    isolateState();
    const w = makeWeb();
    // Capture setAskUser: the hijack would persist the routed owner as the recipient.
    let persistedRecipient: string | undefined;
    const collectorMock = {
      sessionTitle: async () => "Session",
      getPendingAsks: async () => [],
      resolveAsk: async () => ({ ok: true }),
      setAskUser: async (u: string) => {
        persistedRecipient = u;
      },
    };
    const asks = new Asks(
      w.web as never,
      collectorMock as never,
      "U-recipient",
      threadProviderFor("s-hijack"),
      routing({ slackId: "U-ownerX" }),
    );

    // The ask is DM'd to the mapped owner's routed DM channel (D-U-ownerX).
    await asks.onAskNew(askFor("hj", "s-hijack"));
    expect(asks.hasPendingForDm("D-U-ownerX")).toBe(true);

    // The owner answers in that routed DM, and the DM router then runs the
    // learn-from-DM path — exactly as index.ts does (onDmText then noteDmSender).
    await asks.onDmText("D-U-ownerX", "go ahead", "slack:U-ownerX");
    await asks.noteDmSender("U-ownerX", "D-U-ownerX");

    // The learned recipient is unchanged and was never re-persisted — a routed
    // owner's reply must not redirect owner-less/fallback asks to them.
    expect(asks.ownerUserId).toBe("U-recipient");
    expect(persistedRecipient).toBeUndefined();
  });

  test("a routed owner's follow-up DM after their ask resolved + a restart still does NOT overwrite the learned recipient (durable anti-hijack)", async () => {
    isolateState();
    const w = makeWeb();
    let persistedRecipient: string | undefined;
    const collectorMock = {
      sessionTitle: async () => "Session",
      getPendingAsks: async () => [],
      resolveAsk: async () => ({ ok: true }),
      setAskUser: async (u: string) => {
        persistedRecipient = u;
      },
    };
    // Route s-hijack to owner X and a later, unrelated s-keep to owner Y — so
    // after the restart D-U-ownerX is protected ONLY by the durable channel set
    // (its ask resolved, so it has no live binding to re-mark it).
    const perSession: OwnerRouting = {
      routeFor: async (sessionId: string) => (sessionId === "s-hijack" ? { slackId: "U-ownerX" } : { slackId: "U-ownerY" }),
    };

    const asks1 = new Asks(w.web as never, collectorMock as never, "U-recipient", threadProvider(), perSession);
    await asks1.onAskNew(askFor("hj", "s-hijack")); // DM'd to D-U-ownerX (channel marked + persisted)
    expect(asks1.hasPendingForDm("D-U-ownerX")).toBe(true);

    // The owner answers in their routed DM → the ask resolves → its binding is deleted.
    await asks1.onDmText("D-U-ownerX", "go ahead", "slack:U-ownerX");
    // A later owner-routed ask records + flushes, persisting the deletion to disk
    // (the on-disk `asks` no longer contains hj) — the finding's flush trigger.
    await asks1.onAskNew(askFor("keep", "s-keep"));

    // Restart: a fresh Asks re-arms only from the persisted state.
    const asks2 = new Asks(w.web as never, collectorMock as never, "U-recipient", threadProvider(), perSession);

    // The routed owner sends a follow-up DM in the same (now binding-less) channel.
    await asks2.onDmText("D-U-ownerX", "also check the logs", "slack:U-ownerX");
    await asks2.noteDmSender("U-ownerX", "D-U-ownerX");

    // The learned recipient is unchanged and was never re-persisted.
    expect(asks2.ownerUserId).toBe("U-recipient");
    expect(persistedRecipient).toBeUndefined();
  });

  test("owner DM post throws AFTER the thread copy landed → the thread copy is tracked, never orphaned or re-posted", async () => {
    isolateState();
    // A web whose owner-DM post throws (a D-… channel with no thread_ts) while the
    // thread copy (thread_ts set) succeeds — the after-thread-copy failure mode.
    const posts: Post[] = [];
    const updates: { channel: string; ts: string }[] = [];
    let ts = 0;
    const web = {
      chat: {
        postMessage: async (args: Post) => {
          if (args.channel.startsWith("D-") && !args.thread_ts) throw new Error("dm post failed");
          posts.push(args);
          return { ts: `ts-${++ts}` };
        },
        update: async (args: { channel: string; ts: string }) => {
          updates.push({ channel: args.channel, ts: args.ts });
          return { ok: true };
        },
      },
      conversations: {
        open: async (args: { users: string }) => ({ channel: { id: `D-${args.users}` } }),
      },
    };
    const { collectorMock } = makeCollector([askFor("t1", "s-throw")]);
    const asks = new Asks(web as never, collectorMock as never, "U-recipient", threadProviderFor("s-throw"), routing({ slackId: "U-ownerX" }));

    await asks.onAskNew(askFor("t1", "s-throw"));

    // Exactly one thread copy landed — the DM throw didn't abandon it.
    expect(posts.filter((p) => p.thread_ts === "root-1").length).toBe(1);

    // It was TRACKED despite the DM failure: a resync (the ask is still pending at
    // the collector) must NOT post a second, duplicate thread copy.
    await asks.resync();
    expect(posts.filter((p) => p.thread_ts === "root-1").length).toBe(1);

    // And it retires in place on resolve — proof it's the tracked prompt, not an
    // orphaned live card.
    await asks.onAskResolved("t1", "yes");
    expect(updates.some((u) => u.channel === "C-feed")).toBe(true);
  });
});

describe("routeForResponsible — the wiring's tri-state routing decision", () => {
  const map = parseOwnerMap("alice:U123");

  test("a mappable responsible human routes to their Slack id", () => {
    expect(routeForResponsible("alice", map)).toEqual({ slackId: "U123" });
    // a slack:U… actor carries its id directly, no map entry needed
    expect(routeForResponsible("slack:U999", map)).toEqual({ slackId: "U999" });
  });

  test("a genuinely unattributed session (null) is owner-less", () => {
    expect(routeForResponsible(null, map)).toEqual({ ownerless: true });
  });

  test("a failed lookup (undefined) falls back to today's delivery, never suppresses", () => {
    expect(routeForResponsible(undefined, map)).toEqual({});
  });

  test("a responsible human we can't map falls back to today's delivery", () => {
    expect(routeForResponsible("stranger", map)).toEqual({});
  });
});

describe("ownerSlackId", () => {
  test("a slack:U… owner actor yields its Slack id directly (no map needed)", () => {
    expect(ownerSlackId("slack:U999", new Map())).toBe("U999");
  });

  test("a user alias resolves through the configured owner map", () => {
    expect(ownerSlackId("alice", parseOwnerMap("alice:U123, carol:U456"))).toBe("U123");
  });

  test("an unmapped alias yields undefined (caller falls back)", () => {
    expect(ownerSlackId("stranger", parseOwnerMap("alice:U123"))).toBeUndefined();
  });
});
