// Steer-from-Slack routing + dedup + gate. Capabilities-only: a recording fake
// stands in for the collector's /send, so NO live Slack or HTTP call runs. The
// gate is asserted (owner + allowlist pass; a stranger is refused), a redelivered
// message id is deduped to a single send, attribution + idempotencyKey are wired
// through, and the raw text is bounded.

import { describe, expect, test } from "bun:test";
import { Steer, type SteerReply, type SteerSink } from "./steer.js";

interface SendCall {
  sessionId: string;
  text: string;
  actor?: string;
  idempotencyKey?: string;
}

/** Records every sendToSession; returns canned results keyed by call index. */
class RecordingSink implements SteerSink {
  readonly calls: SendCall[] = [];
  constructor(private readonly results: Array<{ ok: boolean; error?: string; status?: number }> = []) {}
  sendToSession = async (
    sessionId: string,
    text: string,
    actor?: string,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; deduped?: boolean; error?: string; status?: number }> => {
    this.calls.push({ sessionId, text, actor, idempotencyKey });
    return this.results[this.calls.length - 1] ?? { ok: true };
  };
}

interface Notice {
  channel: string;
  threadTs: string;
  text: string;
}
function recordingNotify(sink: Notice[]) {
  return async (channel: string, threadTs: string, text: string) => {
    sink.push({ channel, threadTs, text });
  };
}

const OWNER = "Uowner";
const reply = (over: Partial<SteerReply> = {}): SteerReply => ({
  sessionId: "sess-1",
  channel: "C1",
  rootTs: "root-1",
  text: "run the tests",
  userId: OWNER,
  actor: "slack:Uowner",
  dedupKey: "cm-1",
  ...over,
});

describe("Steer", () => {
  test("owner reply routes to the session's /send with attribution + idempotency key", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => OWNER });

    await steer.onThreadReply(reply());

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({
      sessionId: "sess-1",
      text: "run the tests",
      actor: "slack:Uowner",
      idempotencyKey: "cm-1",
    });
  });

  test("a redelivered message id is deduped to a single send", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => OWNER });

    await steer.onThreadReply(reply({ dedupKey: "cm-dup" }));
    await steer.onThreadReply(reply({ dedupKey: "cm-dup", text: "typed again on redelivery" }));

    expect(sink.calls).toHaveLength(1); // second delivery dropped before /send
    expect(sink.calls[0]!.text).toBe("run the tests");
  });

  test("distinct message ids each send (dedup keys on id, not content)", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => OWNER });

    await steer.onThreadReply(reply({ dedupKey: "cm-a", text: "first" }));
    await steer.onThreadReply(reply({ dedupKey: "cm-b", text: "second" }));

    expect(sink.calls.map((c) => c.text)).toEqual(["first", "second"]);
  });

  test("a non-owner stranger is refused — no send, a notice is posted", async () => {
    const sink = new RecordingSink();
    const notices: Notice[] = [];
    const steer = new Steer(sink, { ownerUserId: () => OWNER, notify: recordingNotify(notices) });

    await steer.onThreadReply(reply({ userId: "Ustranger", dedupKey: "cm-x" }));

    expect(sink.calls).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("owner");
    expect(notices[0]!.channel).toBe("C1");
    expect(notices[0]!.threadTs).toBe("root-1");
  });

  test("an allowlisted non-owner may steer", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => OWNER, allowlist: ["Ufriend"] });

    await steer.onThreadReply(reply({ userId: "Ufriend", actor: "slack:Ufriend", dedupKey: "cm-f" }));

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]!.actor).toBe("slack:Ufriend");
  });

  test("with no owner learned and no allowlist, all steering is refused", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => undefined });

    await steer.onThreadReply(reply({ userId: "Uanyone", dedupKey: "cm-none" }));

    expect(sink.calls).toHaveLength(0);
  });

  test("a 409 (session not launched) surfaces a notice back in-thread", async () => {
    const sink = new RecordingSink([{ ok: false, status: 409, error: "not launched" }]);
    const notices: Notice[] = [];
    const steer = new Steer(sink, { ownerUserId: () => OWNER, notify: recordingNotify(notices) });

    await steer.onThreadReply(reply({ dedupKey: "cm-409" }));

    expect(sink.calls).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("terminal");
  });

  test("raw text is trimmed and length-bounded before sending", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => OWNER });

    await steer.onThreadReply(reply({ text: `   ${"x".repeat(5000)}   `, dedupKey: "cm-big" }));

    const sent = sink.calls[0]!.text;
    expect(sent.length).toBe(4000);
    expect(sent.startsWith(" ")).toBe(false);
  });

  test("an empty reply after trim sends nothing", async () => {
    const sink = new RecordingSink();
    const steer = new Steer(sink, { ownerUserId: () => OWNER });

    await steer.onThreadReply(reply({ text: "   ", dedupKey: "cm-empty" }));

    expect(sink.calls).toHaveLength(0);
  });

  test("a stale reverse route (session no longer owns the rootTs) is refused — no send", async () => {
    // The router resolved a session that has since rebound to a new thread root;
    // the cross-check must refuse rather than type into the wrong session.
    const sink = new RecordingSink();
    const steer = new Steer(sink, {
      ownerUserId: () => OWNER,
      ownsRoot: (sessionId, rootTs) => sessionId === "sess-1" && rootTs === "root-current",
    });

    await steer.onThreadReply(reply({ rootTs: "root-stale", dedupKey: "cm-stale" }));
    expect(sink.calls).toHaveLength(0);

    // The same session on its CURRENT root still steers normally.
    await steer.onThreadReply(reply({ rootTs: "root-current", dedupKey: "cm-live" }));
    expect(sink.calls).toHaveLength(1);
  });

  // The shared gate the message router applies to BOTH thread-reply doors
  // (ask-answer and steer) before it forks on session state.
  test("allowed() gates the owner, allowlist, strangers, and the anonymous case", () => {
    const steer = new Steer(new RecordingSink(), { ownerUserId: () => OWNER, allowlist: ["Ufriend"] });

    expect(steer.allowed(OWNER)).toBe(true);
    expect(steer.allowed("Ufriend")).toBe(true);
    expect(steer.allowed("Ustranger")).toBe(false);
    expect(steer.allowed(undefined)).toBe(false);

    const noOwner = new Steer(new RecordingSink(), { ownerUserId: () => undefined });
    expect(noOwner.allowed("Uanyone")).toBe(false);
  });

  test("denyNotice posts the not-permitted notice into the thread", async () => {
    const notices: Notice[] = [];
    const steer = new Steer(new RecordingSink(), { ownerUserId: () => OWNER, notify: recordingNotify(notices) });

    await steer.denyNotice("C9", "root-9");

    expect(notices).toHaveLength(1);
    expect(notices[0]!.channel).toBe("C9");
    expect(notices[0]!.threadTs).toBe("root-9");
    expect(notices[0]!.text).toContain("owner");
  });
});
