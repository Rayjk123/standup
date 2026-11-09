// The ask-card path's two Persona guards: an ask a running Persona handles is
// never delivered as a Slack card (Persona relays it itself), and once the
// owner's Slack id is known a DM from anyone else can't re-route ask delivery.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Ask } from "@standup/shared";
import { Asks } from "./asks.js";

function makeWeb() {
  const posts: { channel: string }[] = [];
  let ts = 0;
  const web = {
    chat: {
      postMessage: async (args: { channel: string }) => {
        posts.push({ channel: args.channel });
        return { ts: `ts-${++ts}` };
      },
      update: async () => ({ ok: true }),
    },
    conversations: { open: async (a: { users: string }) => ({ channel: { id: `D-${a.users}` } }) },
  };
  return { web, posts };
}

function makeCollector(pending: Ask[]) {
  const askUsers: string[] = [];
  return {
    askUsers,
    collector: {
      sessionTitle: async () => "Session",
      getPendingAsks: async () => pending,
      setAskUser: async (u: string) => {
        askUsers.push(u);
      },
      resolveAsk: async () => ({ ok: true }),
    },
  };
}

const ask = (id: string, personaHandled?: boolean): Ask =>
  ({
    id,
    sessionId: `s-${id}`,
    question: `Approve ${id}?`,
    kind: "permission_prompt",
    createdAt: "2026-01-01T00:00:00Z",
    status: "pending",
    ...(personaHandled ? { personaHandled } : {}),
  }) as unknown as Ask;

const paths: string[] = [];
let n = 0;
function freshState(): void {
  const p = join(tmpdir(), `standup-persona-asks-${process.pid}-${++n}.json`);
  process.env.STANDUP_SLACK_ASK_STATE = p;
  paths.push(p);
}
afterAll(() => {
  for (const p of paths) rmSync(p, { force: true });
});

describe("personaHandled asks", () => {
  test("are skipped live and on resync, while ordinary asks still deliver", async () => {
    freshState();
    const w = makeWeb();
    const handled = ask("p1", true);
    const plain = ask("p2");
    const { collector } = makeCollector([handled, plain]);
    const asks = new Asks(w.web as never, collector as never, "U-owner", undefined);
    await asks.onAskNew(handled);
    expect(w.posts).toHaveLength(0);
    await asks.resync();
    expect(w.posts).toHaveLength(1);
  });
});

describe("asks on an approval card", () => {
  const carded = (id: string, cardDecider = "bob"): Ask => ({ ...ask(id, true), cardDecider }) as Ask;
  const routedTo = (slackId: string) => ({ routeFor: async () => ({ slackId }) });

  test("are left to the card, live and on resync, when it reaches the same Slack user", async () => {
    freshState();
    const w = makeWeb();
    const a = carded("c1");
    const asks = new Asks(w.web as never, makeCollector([a]).collector as never, "U-owner", undefined, routedTo("U-bob"));
    asks.setCardRecipient((alias) => (alias === "bob" ? "U-bob" : undefined));
    await asks.onAskNew(a);
    await asks.resync();
    expect(w.posts).toHaveLength(0);
  });

  test("are delivered, live and on resync, when the card reaches nobody in Slack", async () => {
    for (const recipient of [undefined, () => undefined]) {
      freshState();
      const w = makeWeb();
      const a = carded("c2");
      const asks = new Asks(w.web as never, makeCollector([a]).collector as never, "U-owner", undefined, routedTo("U-bob"));
      if (recipient) asks.setCardRecipient(recipient);
      await asks.onAskNew(a);
      expect(w.posts).toEqual([{ channel: "D-U-bob" }]);
      // Resync finds it delivered already.
      await asks.resync();
      expect(w.posts).toHaveLength(1);
    }
    freshState();
    const w = makeWeb();
    const a = carded("c3");
    const asks = new Asks(w.web as never, makeCollector([a]).collector as never, "U-owner", undefined, routedTo("U-bob"));
    asks.setCardRecipient(() => undefined);
    await asks.resync();
    expect(w.posts).toEqual([{ channel: "D-U-bob" }]);
  });

  test("are left to a card that reaches its decider, even when the ask routes to someone else", async () => {
    // A guest's owner-only hold: the session routes to the guest, but the card
    // goes to the host, who alone can allow it.
    freshState();
    const w = makeWeb();
    const a = carded("c4", "host");
    const asks = new Asks(w.web as never, makeCollector([a]).collector as never, "U-owner", undefined, routedTo("U-guest"));
    asks.setCardRecipient((alias) => (alias === "host" ? "U-owner" : undefined));
    await asks.onAskNew(a);
    await asks.resync();
    expect(w.posts).toHaveLength(0);
  });

  test("a guest's card whose host decider has no Slack id leaves the ask to Slack delivery", async () => {
    freshState();
    const w = makeWeb();
    const a = carded("c6", "host");
    const asks = new Asks(w.web as never, makeCollector([a]).collector as never, "U-owner", undefined, routedTo("U-guest"));
    asks.setCardRecipient((alias) => (alias === "guest" ? "U-guest" : undefined));
    await asks.onAskNew(a);
    expect(w.posts).toEqual([{ channel: "D-U-guest" }]);
  });

  test("with no owner routing, are left to a card that reaches the learned recipient", async () => {
    freshState();
    const w = makeWeb();
    const a = carded("c5", "alice");
    const asks = new Asks(w.web as never, makeCollector([]).collector as never, "U-owner", undefined);
    asks.setCardRecipient((alias) => (alias === "alice" ? "U-owner" : undefined));
    await asks.onAskNew(a);
    expect(w.posts).toHaveLength(0);
  });
});

describe("ask recipient gate", () => {
  test("a non-owner's DM doesn't become the ask recipient; the owner's does", async () => {
    freshState();
    const w = makeWeb();
    const c = makeCollector([]);
    const asks = new Asks(w.web as never, c.collector as never, undefined, undefined);
    asks.setRecipientGate((u) => u === "U-owner");
    await asks.noteDmSender("U-stranger", "D-stranger");
    expect(asks.ownerUserId).toBeUndefined();
    expect(c.askUsers).toEqual([]);
    await asks.noteDmSender("U-owner", "D-owner");
    expect(asks.ownerUserId).toBe("U-owner");
    expect(c.askUsers).toEqual(["U-owner"]);
  });
});

describe("asks while Persona owns the DM", () => {
  test("only a reply in an ask card's own thread answers it", async () => {
    freshState();
    const w = makeWeb();
    const resolved: { id: string; answer: string }[] = [];
    const c = makeCollector([]);
    const collector = { ...c.collector, resolveAsk: async (id: string, answer: string) => (resolved.push({ id, answer }), { ok: true }) };
    const asks = new Asks(w.web as never, collector as never, "U-owner", undefined);
    await asks.onAskNew(ask("q1"));
    expect(asks.hasPendingForDm("D-U-owner")).toBe(true);
    expect(asks.pendingAskForDmThread("D-U-owner", undefined)).toBeUndefined();
    expect(asks.pendingAskForDmThread("D-U-owner", "ts-other")).toBeUndefined();
    expect(asks.pendingAskForDmThread("D-U-owner", "ts-1")).toBe("q1");
    await asks.onDmThreadReply("q1", "D-U-owner", "yes", "slack:U-owner", "U-owner");
    expect(resolved).toEqual([{ id: "q1", answer: "yes" }]);
    expect(asks.pendingAskForDmThread("D-U-owner", "ts-1")).toBeUndefined();
  });

  test("resolved-before-posted ids are capped", async () => {
    freshState();
    const w = makeWeb();
    const asks = new Asks(w.web as never, makeCollector([]).collector as never, "U-owner", undefined);
    for (let i = 0; i < 700; i++) await asks.onAskResolved(`gone-${i}`, "x");
    const early = (asks as unknown as { resolvedEarly: Set<string> }).resolvedEarly;
    expect(early.size).toBe(500);
    expect(early.has("gone-699")).toBe(true);
    expect(early.has("gone-0")).toBe(false);
  });
});
