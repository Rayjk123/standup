// Mirror per-channel gate. No live Slack: a recording SlackApi fake captures
// outbound calls. Proves that turning the `mirror` feature off for a channel
// stops thread creation (ensureThread → null, onEvent a no-op, isEnabled false),
// that a channel with no override mirrors nothing, and that `mirror on` opens threads.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { RichRow, RichTranscriptPage } from "./collector-client.js";
import type { SlackApi, SlackCallResult } from "./stream-client.js";
import { Mirror, type MirrorTranscriptSource } from "./mirror.js";
import { SessionThreads } from "./session-threads.js";
import { ChannelFeatureStore, clearChannel, setFeature } from "./channel-features.js";

const TS = "2026-01-01T00:00:00Z";

class RecordingSlack implements SlackApi {
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];
  private seq = 0;
  /** Slack error a method answers with instead of succeeding. */
  readonly failing = new Map<string, string>();
  /** Runs before a method answers — a test's hook for an end landing mid-call. */
  readonly before = new Map<string, () => Promise<void>>();
  async call(method: string, args: Record<string, unknown> = {}): Promise<SlackCallResult> {
    this.calls.push({ method, args });
    const hook = this.before.get(method);
    if (hook) {
      this.before.delete(method);
      await hook();
    }
    const error = this.failing.get(method);
    if (error) return { ok: false, error, data: { ok: false, error } };
    if (method === "chat.postMessage") return { ok: true, ts: `msg-${++this.seq}`, data: { ok: true } };
    if (method === "chat.startStream") return { ok: true, ts: `stream-${++this.seq}`, data: { ok: true } };
    return { ok: true, data: { ok: true } };
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

class FakeCollector implements MirrorTranscriptSource {
  // Mutable so a test can grow the transcript (a new turn) after a thread opens.
  constructor(public rows: RichRow[]) {}
  async getRichTranscript(): Promise<RichTranscriptPage | null> {
    return { rows: this.rows, hasMore: false, truncated: false, totalRows: this.rows.length, outputTokens: 0, contextTokens: 0 };
  }
  async sessionTitle(): Promise<string> {
    return "My Session";
  }
}

const cleanups: string[] = [];
let seq = 0;
function tmpStore(): SessionThreads {
  const path = join(tmpdir(), `standup-slack-mirror-feat-${process.pid}-${++seq}.json`);
  process.env.STANDUP_SLACK_STATE = path;
  cleanups.push(path);
  return new SessionThreads();
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

/** A feature store with the mirror turned on (`mirror on`) in `channels`. */
function mirrorOn(...channels: string[]): ChannelFeatureStore {
  const features = new ChannelFeatureStore();
  for (const c of channels) features.set(setFeature(features.snapshot(), c, "mirror", true));
  return features;
}

const rows: RichRow[] = [
  { id: "u1", timestamp: TS, kind: "user", text: "do a thing" },
  { id: "a1", timestamp: TS, kind: "text", text: "on it" },
];

describe("Mirror per-channel gate", () => {
  test("mirror OFF for the channel: no thread is created, nothing is posted", async () => {
    const features = new ChannelFeatureStore();
    features.set(setFeature(features.snapshot(), "C-feed", "mirror", false));
    const slack = new RecordingSlack();
    const mirror = new Mirror(slack, new FakeCollector(rows), tmpStore(), "http://web.local", { features });
    mirror.setChannel("C-feed");

    expect(mirror.isEnabled()).toBe(false);
    expect(await mirror.ensureThread("s1")).toBeNull();
    mirror.onEvent("s1");
    await mirror.renderSession("s1");
    expect(slack.count("chat.postMessage")).toBe(0);
    expect(slack.count("chat.startStream")).toBe(0);
  });

  test("mirror OFF by default: a worker's events in the feed channel post nothing to Slack", async () => {
    const slack = new RecordingSlack();
    const mirror = new Mirror(slack, new FakeCollector(rows), tmpStore(), "http://web.local", {
      features: new ChannelFeatureStore(),
    });
    mirror.setChannel("C-feed");

    expect(mirror.isEnabled()).toBe(false);
    expect(await mirror.ensureThread("s1")).toBeNull();
    mirror.onEvent("s1");
    await mirror.renderSession("s1");
    mirror.onStatus("s1", "running");
    await mirror.onSessionEnd("s1");
    await mirror.resyncActive();
    await new Promise((r) => setTimeout(r, 20));
    expect(slack.calls).toEqual([]);
  });

  test("mirror ON (`mirror on`): a thread is created", async () => {
    const slack = new RecordingSlack();
    const mirror = new Mirror(slack, new FakeCollector(rows), tmpStore(), "http://web.local", {
      features: mirrorOn("C-feed"),
    });
    mirror.setChannel("C-feed");

    expect(mirror.isEnabled()).toBe(true);
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    expect(slack.count("chat.postMessage")).toBeGreaterThan(0); // root message posted
  });

  test("mirror turned OFF after a thread exists: resync/render/status/titles all stop mirroring", async () => {
    // A thread is opened + streamed while the mirror is ON …
    const features = mirrorOn("C-feed");
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const mirror = new Mirror(slack, collector, tmpStore(), "http://web.local", { features });
    mirror.setChannel("C-feed");

    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1"); // streams the first turn into the thread
    expect(slack.count("chat.startStream")).toBeGreaterThan(0);

    // … then the operator turns the mirror OFF for this channel. The binding still
    // exists (not ended), and the session keeps producing turns.
    features.set(setFeature(features.snapshot(), "C-feed", "mirror", false));
    expect(mirror.isEnabled()).toBe(false);
    collector.rows = [
      ...collector.rows,
      { id: "u2", timestamp: TS, kind: "user", text: "another thing" },
      { id: "a2", timestamp: TS, kind: "text", text: "second answer" },
    ];

    // The backstop (resyncActive), a reconnect re-render, title reconciliation, and
    // status reactions must ALL no-op now — none may stream the new turn into the
    // still-open thread or touch the root once mirroring is off for the channel.
    const before = slack.calls.length;
    await mirror.resyncActive();
    await mirror.renderSession("s1");
    await mirror.reconcileTitles();
    mirror.onStatus("s1", "running");
    await new Promise((r) => setTimeout(r, 20)); // let any wrongly-scheduled status timer fire
    expect(slack.calls.length).toBe(before);
  });

  test("feed moved A→B + mirror off in A: nudge / render / status / resync / end post NOTHING to A", async () => {
    // A binding lives in channel A. The operator then moves the feed to a fresh
    // channel B (`feed here` in B) AND turns the mirror off in A. B has the
    // mirror on, so isEnabled() — which keys on the CURRENT feed channel — is
    // TRUE. The per-binding gate must still key each A-bound path on A's OWN
    // (muted) mirror state, not on B, so nothing leaks into A.
    const features = mirrorOn("A", "B");
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features });

    mirror.setChannel("A");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1"); // streams the first turn into A's thread
    expect(slack.count("chat.startStream")).toBeGreaterThan(0);
    expect(store.get("s1")?.channel).toBe("A");

    // Move the feed to B and mute the mirror in A. The A-bound session keeps producing.
    mirror.setChannel("B");
    features.set(setFeature(features.snapshot(), "A", "mirror", false));
    expect(mirror.isEnabled()).toBe(true); // mirror on for the CURRENT feed channel B
    collector.rows = [
      ...collector.rows,
      { id: "u2", timestamp: TS, kind: "user", text: "another thing" },
      { id: "a2", timestamp: TS, kind: "text", text: "second answer" },
    ];

    const before = slack.calls.length;
    mirror.onEvent("s1"); // a live nudge for the A-bound session
    await mirror.renderSession("s1"); // a direct re-render
    await mirror.resyncActive(); // the reconnect / backstop re-render
    await mirror.reconcileTitles();
    mirror.onStatus("s1", "running");
    await mirror.onSessionEnd("s1"); // the session ends
    await new Promise((r) => setTimeout(r, 20)); // let any wrongly-scheduled timer fire
    expect(slack.calls.length).toBe(before); // nothing streamed / posted into A (or B)

    // Local end bookkeeping still ran (so a re-enable can't re-stream a finalized session).
    expect(store.get("s1")?.ended).toBe(true);
  });

  test("feed moved A→B while A keeps `mirror on`: A's binding gets NOTHING, and its root is no longer live", async () => {
    // Pins the current-feed-channel half of the gate: A's own toggle still says
    // mirror on, so only the binding ≠ feed channel check keeps A quiet.
    const features = mirrorOn("A", "B");
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const mirror = new Mirror(slack, collector, tmpStore(), "http://web.local", { features });
    mirror.setChannel("A");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    expect(mirror.liveRootFor("s1")).toBeDefined();

    mirror.setChannel("B");
    expect(features.mirrorEnabled("A")).toBe(true);
    expect(mirror.liveRootFor("s1")).toBeUndefined();
    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "second answer" }];
    const before = slack.calls.length;
    mirror.onEvent("s1");
    await mirror.renderSession("s1");
    await mirror.resyncActive();
    mirror.onStatus("s1", "running");
    await mirror.onSessionEnd("s1");
    await new Promise((r) => setTimeout(r, 20));
    expect(slack.calls.length).toBe(before);
  });

  test("mirror OFF after a thread exists: onSessionEnd touches NO Slack surface (no marker, no status clear)", async () => {
    // A thread is opened + streamed with an open live turn while the mirror is ON …
    const features = mirrorOn("C-feed");
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features });
    mirror.setChannel("C-feed");

    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1"); // opens a live stream for the turn
    expect(slack.count("chat.startStream")).toBeGreaterThan(0);

    // … then the operator mutes the channel. The binding is still live (not ended).
    features.set(setFeature(features.snapshot(), "C-feed", "mirror", false));
    expect(mirror.isEnabled()).toBe(false);

    // The session ends. onSessionEnd must NOT post "🏁 session ended", clear the
    // status line, or stopStream into the muted thread — the pre-existing binding
    // is exactly the case that used to leak past `mirror off`.
    const before = slack.calls.length;
    const postsBefore = slack.count("chat.postMessage");
    const stopsBefore = slack.count("chat.stopStream");
    const statusBefore = slack.count("assistant.threads.setStatus");
    await mirror.onSessionEnd("s1");
    expect(slack.calls.length).toBe(before); // zero new Slack calls at all
    expect(slack.count("chat.postMessage")).toBe(postsBefore); // no "🏁 session ended"
    expect(slack.count("chat.stopStream")).toBe(stopsBefore); // open stream not stopped via Slack
    expect(slack.count("assistant.threads.setStatus")).toBe(statusBefore); // status line untouched

    // Local bookkeeping still ran: the binding is flipped ended (so a re-enabled
    // render can't re-stream a finalized session) and it's idempotent.
    expect(store.get("s1")?.ended).toBe(true);
    await mirror.onSessionEnd("s1");
    expect(slack.calls.length).toBe(before);
  });

  test("standup off (channel cleared + unset) after a thread exists: onSessionEnd touches NO Slack surface", async () => {
    // `standup off` clears the channel's feature entry (clearChannel) AND unsets the
    // mirror channel — unlike `mirror off`, which sets mirror:false. Gating on the
    // CURRENT channel keeps a "🏁 session ended" write out of a channel the operator
    // explicitly tore down, whatever the cleared channel's default resolves to.
    const features = mirrorOn("C-feed");
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features });
    mirror.setChannel("C-feed");

    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1"); // opens a live stream for the turn
    expect(slack.count("chat.startStream")).toBeGreaterThan(0);

    // The operator runs `standup off`: the channel's overrides are dropped and the
    // mirror channel is unset.
    features.set(clearChannel(features.snapshot(), "C-feed"));
    mirror.setChannel(undefined);
    expect(mirror.isEnabled()).toBe(false);

    const before = slack.calls.length;
    const postsBefore = slack.count("chat.postMessage");
    const stopsBefore = slack.count("chat.stopStream");
    const statusBefore = slack.count("assistant.threads.setStatus");
    await mirror.onSessionEnd("s1");
    expect(slack.calls.length).toBe(before); // zero new Slack calls at all
    expect(slack.count("chat.postMessage")).toBe(postsBefore); // no "🏁 session ended"
    expect(slack.count("chat.stopStream")).toBe(stopsBefore); // open stream not stopped via Slack
    expect(slack.count("assistant.threads.setStatus")).toBe(statusBefore); // status line untouched

    // Local bookkeeping still ran + is idempotent.
    expect(store.get("s1")?.ended).toBe(true);
    await mirror.onSessionEnd("s1");
    expect(slack.calls.length).toBe(before);
  });

  test("standup off (channel cleared + unset) while a status timer is pending: the late timer touches NO Slack surface", async () => {
    const features = mirrorOn("C-feed");
    const slack = new RecordingSlack();
    const mirror = new Mirror(slack, new FakeCollector([...rows]), tmpStore(), "http://web.local", { features });
    mirror.setChannel("C-feed");

    expect(await mirror.ensureThread("s1")).not.toBeNull();
    mirror.onStatus("s1", "idle"); // schedules a status timer while the mirror is ON

    // Tear the channel down before the debounced timer fires.
    features.set(clearChannel(features.snapshot(), "C-feed"));
    mirror.setChannel(undefined);
    expect(mirror.isEnabled()).toBe(false);

    const before = slack.calls.length;
    await new Promise((r) => setTimeout(r, 800)); // let the pending timer fire (STATUS_DEBOUNCE_MS 700ms)
    expect(slack.calls.length).toBe(before);
  });

  test("mirror OFF while a status timer is pending: the late timer touches NO Slack surface", async () => {
    // A status reaction is scheduled while the mirror is still ON, so the debounced
    // timer is armed against a thread that is about to be muted.
    const features = mirrorOn("C-feed");
    const slack = new RecordingSlack();
    const mirror = new Mirror(slack, new FakeCollector([...rows]), tmpStore(), "http://web.local", { features });
    mirror.setChannel("C-feed");

    expect(await mirror.ensureThread("s1")).not.toBeNull();
    mirror.onStatus("s1", "idle"); // schedules a status timer (idle ⇒ also clears the "is …" line)

    // The operator mutes the channel BEFORE the debounced timer fires.
    features.set(setFeature(features.snapshot(), "C-feed", "mirror", false));
    expect(mirror.isEnabled()).toBe(false);

    // Let the pending timer fire (STATUS_DEBOUNCE_MS is 700ms). applyStatus must
    // no-op now — no status clear, no reaction add/remove on the muted thread root.
    const before = slack.calls.length;
    await new Promise((r) => setTimeout(r, 800));
    expect(slack.calls.length).toBe(before);
  });

  test("mirror ON: onSessionEnd posts the end marker and clears the status line", async () => {
    const slack = new RecordingSlack();
    const mirror = new Mirror(slack, new FakeCollector([...rows]), tmpStore(), "http://web.local", {
      features: mirrorOn("C-feed"),
    });
    mirror.setChannel("C-feed");

    expect(await mirror.ensureThread("s1")).not.toBeNull();
    const postsBefore = slack.count("chat.postMessage");
    await mirror.onSessionEnd("s1");
    expect(slack.count("chat.postMessage")).toBe(postsBefore + 1); // "🏁 session ended"
    expect(slack.count("assistant.threads.setStatus")).toBeGreaterThan(0); // "is …" cleared
  });
});

describe("Mirror after a revived session", () => {
  test("a revived session's thread reopens and renders its new turn", async () => {
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1");
    expect(store.get("s1")?.ended).toBe(true);

    collector.rows = [...collector.rows, { id: "u2", timestamp: TS, kind: "user", text: "back again" }];
    const streamsBefore = slack.count("chat.startStream") + slack.count("chat.postMessage");
    mirror.onRevived("s1");
    expect(store.get("s1")?.ended).toBe(false);
    await mirror.renderSession("s1");
    expect(slack.count("chat.startStream") + slack.count("chat.postMessage")).toBeGreaterThan(streamsBefore);
  });

  test("a revive that brings no new turn re-posts nothing", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const mirror = new Mirror(slack, new FakeCollector([...rows]), store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1");

    const before = slack.count("chat.startStream") + slack.count("chat.postMessage");
    mirror.onRevived("s1");
    await mirror.renderSession("s1");
    expect(slack.count("chat.startStream") + slack.count("chat.postMessage")).toBe(before);
  });

  test("a turn live at the end that carries on after a revive posts only what came after", async () => {
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1", { marker: false });

    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "all done" }];
    const before = slack.calls.length;
    mirror.onRevived("s1");
    await mirror.renderSession("s1");

    const after = slack.calls.slice(before);
    expect(after.filter((c) => c.method === "chat.startStream")).toHaveLength(1);
    const sent = JSON.stringify(after.filter((c) => c.method === "chat.appendStream").map((c) => c.args.chunks));
    expect(sent).toContain("all done");
    expect(sent).not.toContain("on it");
    expect(store.get("s1")?.endedEmitted).toBeUndefined();

    // Later growth of the same turn streams into the continuation, still from its own offset.
    collector.rows = [...collector.rows, { id: "a3", timestamp: TS, kind: "text", text: "and tidied up" }];
    const mid = slack.calls.length;
    await mirror.renderSession("s1");
    const later = JSON.stringify(slack.calls.slice(mid).map((c) => c.args.chunks));
    expect(later).toContain("and tidied up");
    expect(later).not.toContain("all done");
  });

  test("a tool still running at the end shows its result after the revive", async () => {
    const slack = new RecordingSlack();
    const pendingTool: RichRow = { id: "t1", timestamp: TS, kind: "tool", name: "Bash", input: { command: "make" }, result: { kind: "pending" } };
    const collector = new FakeCollector([...rows, pendingTool]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1", { marker: false });
    expect(store.get("s1")?.endedPending).toHaveLength(1);

    // Only the tool's result changes: no new row.
    collector.rows = [...rows, { ...pendingTool, result: { kind: "bash", stdout: "built ok", stderr: "", interrupted: false } } as RichRow];
    const before = slack.calls.length;
    mirror.onRevived("s1");
    await mirror.renderSession("s1");

    const sent = JSON.stringify(slack.calls.slice(before).map((c) => c.args.chunks));
    expect(sent).toContain("built ok");
    expect(sent).not.toContain("on it");
  });

  test("a second end before the turn grows keeps the first end's offset", async () => {
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1", { marker: false });
    const offset = store.get("s1")?.endedEmitted;
    expect(offset).toBeGreaterThan(0);

    mirror.onRevived("s1");
    await mirror.renderSession("s1"); // nothing new yet
    await mirror.onSessionEnd("s1", { marker: false });
    expect(store.get("s1")?.endedEmitted).toBe(offset);

    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "all done" }];
    const before = slack.calls.length;
    mirror.onRevived("s1");
    await mirror.renderSession("s1");
    const sent = JSON.stringify(slack.calls.slice(before).map((c) => c.args.chunks));
    expect(sent).toContain("all done");
    expect(sent).not.toContain("on it");
  });

  test("after a restart, an end before any render keeps how far the live message got", async () => {
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const first = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    first.setChannel("C-feed");
    expect(await first.ensureThread("s1")).not.toBeNull();
    await first.renderSession("s1");
    const shown = store.get("s1")?.liveEmitted;
    expect(shown).toBeGreaterThan(0);

    // A fresh adapter on the same store: nothing in memory, no render yet.
    const restarted = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    restarted.setChannel("C-feed");
    await restarted.onSessionEnd("s1", { marker: false });
    expect(store.get("s1")?.endedEmitted).toBe(shown);
    // The stream from before the restart is finalized.
    expect(slack.count("chat.stopStream")).toBe(1);

    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "all done" }];
    const before = slack.calls.length;
    restarted.onRevived("s1");
    await restarted.renderSession("s1");
    const sent = JSON.stringify(slack.calls.slice(before).map((c) => c.args.chunks));
    expect(sent).toContain("all done");
    expect(sent).not.toContain("on it");
  });

  test("with the Block-Kit fallback, a tool running at the end shows its result after a revive", async () => {
    const slack = new RecordingSlack();
    slack.failing.set("chat.startStream", "unknown_method");
    const pendingTool: RichRow = { id: "t1", timestamp: TS, kind: "tool", name: "Bash", input: { command: "make" }, result: { kind: "pending" } };
    const collector = new FakeCollector([...rows, pendingTool]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    expect(store.get("s1")?.liveMode).toBe("fallback");
    await mirror.onSessionEnd("s1", { marker: false });
    expect(store.get("s1")?.endedPending).toHaveLength(1);

    collector.rows = [...rows, { ...pendingTool, result: { kind: "bash", stdout: "built ok", stderr: "", interrupted: false } } as RichRow];
    const before = slack.calls.length;
    mirror.onRevived("s1");
    await mirror.renderSession("s1");
    const posted = JSON.stringify(slack.calls.slice(before).filter((c) => c.method === "chat.postMessage").map((c) => c.args));
    expect(posted).toContain("built ok");
    expect(posted).not.toContain("on it");
  });

  test("a continuation Slack keeps refusing is tried once, not on every render", async () => {
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1", { marker: false });

    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "all done" }];
    slack.failing.set("chat.appendStream", "invalid_blocks");
    mirror.onRevived("s1");
    await mirror.renderSession("s1");
    const opened = slack.count("chat.startStream");
    await mirror.renderSession("s1");
    await mirror.renderSession("s1");
    expect(slack.count("chat.startStream")).toBe(opened);
    expect(store.get("s1")?.endedEmitted).toBeUndefined();
  });

  test("an end landing while a continuation's stream opens closes it unused and keeps the record", async () => {
    const slack = new RecordingSlack();
    const collector = new FakeCollector([...rows]);
    const store = tmpStore();
    const mirror = new Mirror(slack, collector, store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");
    await mirror.onSessionEnd("s1", { marker: false });
    const offset = store.get("s1")?.endedEmitted;

    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "all done" }];
    mirror.onRevived("s1");
    slack.before.set("chat.startStream", () => mirror.onSessionEnd("s1", { marker: false }));
    const before = slack.calls.length;
    await mirror.renderSession("s1");

    const after = slack.calls.slice(before);
    expect(after.filter((c) => c.method === "chat.appendStream")).toHaveLength(0);
    expect(after.filter((c) => c.method === "chat.stopStream").length).toBeGreaterThan(0);
    expect(store.get("s1")).toMatchObject({ ended: true, endedEmitted: offset, liveTs: undefined });
  });

  test("an end without a marker closes the thread but posts nothing", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const mirror = new Mirror(slack, new FakeCollector([...rows]), store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    await mirror.renderSession("s1");

    const postsBefore = slack.count("chat.postMessage");
    await mirror.onSessionEnd("s1", { marker: false });
    expect(store.get("s1")?.ended).toBe(true);
    expect(slack.count("chat.postMessage")).toBe(postsBefore);
  });

  test("onRevived leaves a live binding alone", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const mirror = new Mirror(slack, new FakeCollector([...rows]), store, "http://web.local", { features: mirrorOn("C-feed") });
    mirror.setChannel("C-feed");
    expect(await mirror.ensureThread("s1")).not.toBeNull();
    mirror.onRevived("s1");
    mirror.onRevived("unknown");
    expect(store.get("s1")?.ended).toBeFalsy();
    expect(store.get("unknown")).toBeUndefined();
  });
});
