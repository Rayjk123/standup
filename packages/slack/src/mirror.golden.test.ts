// Golden-transcript regression for the Slack mirror's streaming render. A
// RecordingSlackClient captures every outbound (method, args) — NO live Slack
// call runs here — so a scripted rich turn is asserted against the exact ordered
// native-streaming sequence it must produce: chat.startStream → chat.appendStream
// (markdown_text + task_update cards, row-ordered, thinking included) →
// chat.stopStream, plus the "is …" thread status and a root status reaction. Also
// pins the turn-skip fix (every intermediate completed turn is posted) and the
// no-stream fallback (an edited Block-Kit placeholder, never append/stop).

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { KnownBlock } from "@slack/types";
import type { RichRow, RichTranscriptPage } from "./collector-client.js";
import type { SlackApi, SlackCallResult, StreamChunk } from "./stream-client.js";
import { Mirror, type MirrorTranscriptSource } from "./mirror.js";
import { SessionThreads, type SessionThread } from "./session-threads.js";

const TS = "2026-01-01T00:00:00Z";
const FIXED_NOW = () => 1_000_000; // deterministic elapsed / footers

// ---- test doubles ---------------------------------------------------------

interface Recorded {
  method: string;
  args: Record<string, unknown>;
}

/** A recording fake for the single SlackApi seam. Returns canned ts; no I/O. */
class RecordingSlack implements SlackApi {
  readonly calls: Recorded[] = [];
  private seq = 0;
  private appendSeq = 0;
  private startSeq = 0;
  constructor(
    private readonly opts: { streamUnavailable?: boolean; appendFailAt?: number[]; startFailAt?: number[] } = {},
  ) {}

  async call(method: string, args: Record<string, unknown>): Promise<SlackCallResult> {
    this.calls.push({ method, args });
    if (method === "chat.startStream") {
      this.startSeq++;
      if (this.opts.streamUnavailable || this.opts.startFailAt?.includes(this.startSeq)) {
        return { ok: false, error: "unknown_method", data: { ok: false, error: "unknown_method" } };
      }
      return { ok: true, ts: `stream-${++this.seq}`, data: { ok: true } };
    }
    if (method === "chat.appendStream") {
      this.appendSeq++;
      if (this.opts.appendFailAt?.includes(this.appendSeq)) {
        return { ok: false, error: "ratelimited", data: { ok: false, error: "ratelimited" } };
      }
      return { ok: true, data: { ok: true } };
    }
    if (method === "chat.postMessage") return { ok: true, ts: `msg-${++this.seq}`, data: { ok: true } };
    return { ok: true, data: { ok: true } };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  of(method: string): Recorded[] {
    return this.calls.filter((c) => c.method === method);
  }
}

class FakeCollector implements MirrorTranscriptSource {
  constructor(
    public rows: RichRow[],
    private readonly title = "My Session",
  ) {}
  async getRichTranscript(): Promise<RichTranscriptPage | null> {
    return {
      rows: this.rows,
      hasMore: false,
      truncated: false,
      totalRows: this.rows.length,
      outputTokens: 0,
      contextTokens: 1234,
    };
  }
  async sessionTitle(): Promise<string> {
    return this.title;
  }
}

const cleanups: string[] = [];
let storeSeq = 0;
/** A SessionThreads pointed at a throwaway state file (never the real one). */
function tmpStore(): SessionThreads {
  const path = join(tmpdir(), `standup-slack-golden-${process.pid}-${++storeSeq}.json`);
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

const chunksOf = (rec: Recorded): StreamChunk[] => (rec.args.chunks as StreamChunk[]) ?? [];
function summarize(c: StreamChunk): string {
  if (c.type === "markdown_text") return "md";
  if (c.type === "task_update") return `card:${c.id}:${c.status}`;
  return "plan";
}
const planTitle = (rec: Recorded): string => (chunksOf(rec)[0] as { title?: string } | undefined)?.title ?? "";

/** prompt → think → text → bash → text → diff → todo — the terminal's vocabulary. */
function scriptedTurn(): RichRow[] {
  return [
    { id: "u1", timestamp: TS, kind: "user", text: "fix the parser", sentBy: "alice" },
    { id: "a1:0", timestamp: TS, kind: "thinking", text: "I should read the file first." },
    { id: "a1:1", timestamp: TS, kind: "text", text: "Looking into it." },
    {
      id: "a1:2",
      timestamp: TS,
      kind: "tool",
      name: "Bash",
      input: { command: "ls" },
      result: { kind: "bash", stdout: "a.ts\nb.ts", stderr: "warn: deprecated", interrupted: false },
    },
    { id: "a2:0", timestamp: TS, kind: "text", text: "Now editing." },
    {
      id: "a2:1",
      timestamp: TS,
      kind: "tool",
      name: "Edit",
      input: { file_path: "/repo/src/a.ts" },
      result: {
        kind: "diff",
        filePath: "/repo/src/a.ts",
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" ctx", "-old", "+new"] }],
      },
    },
    {
      id: "a2:2",
      timestamp: TS,
      kind: "tool",
      name: "TodoWrite",
      input: {},
      result: {
        kind: "todo",
        todos: [
          { content: "read", status: "completed" },
          { content: "edit", status: "in_progress" },
        ],
      },
    },
  ];
}

function seedBinding(store: SessionThreads, over: Partial<SessionThread> & { sessionId: string }): void {
  store.set({
    channel: "C1",
    rootTs: "root-1",
    title: "Seeded",
    titleFinal: true,
    createdAt: TS,
    lastActivityAt: TS,
    ...over,
  });
}

// ---- tests ----------------------------------------------------------------

describe("mirror streaming render — golden sequence", () => {
  test("a rich turn streams startStream → appendStream(markdown+cards) → status + reaction, row-ordered", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const mirror = new Mirror(slack, new FakeCollector(scriptedTurn()), store, "http://web.local", {
      botUserId: "UBOT",
      teamId: "TEAM",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-A");

    // A live turn opens a stream and never finalizes it (no chat.update after either).
    expect(slack.methods()).toContain("chat.startStream");
    expect(slack.methods()).toContain("chat.appendStream");
    expect(slack.methods()).not.toContain("chat.stopStream");
    expect(slack.methods()).not.toContain("chat.update");

    // recipient contract carried through to startStream.
    const start = slack.of("chat.startStream")[0]!;
    expect(start.args.task_display_mode).toBe("plan");
    expect(start.args.recipient_team_id).toBe("TEAM");
    expect(start.args.recipient_user_id).toBe("UBOT");
    expect(start.args.thread_ts).toBe("msg-1"); // streams inside the freshly-created session thread root

    // The whole turn is one appendStream, chunked in ROW ORDER — think→text→tool
    // interleaving preserved, each tool a task card flipping in_progress→complete.
    // A tool's result body rides INSIDE its complete card (collapsible `output`),
    // not as a separate inline markdown_text code fence.
    const append = slack.of("chat.appendStream");
    expect(append).toHaveLength(1);
    const chunks = chunksOf(append[0]!);
    expect(chunks.map(summarize)).toEqual([
      "md", // user prompt
      "md", // thinking (condensed, de-emphasized)
      "md", // assistant text
      "card:a1:2:in_progress",
      "card:a1:2:complete", // bash output body rides in this card's `output`
      "md", // assistant text
      "card:a2:1:in_progress",
      "card:a2:1:complete", // diff body rides in this card's `output`
      "card:a2:2:in_progress",
      "card:a2:2:complete", // todo checklist body rides in this card's `output`
    ]);

    // Thinking survives (it was dropped by the distilled feed) and stays prose.
    const md = chunks.filter((c): c is Extract<StreamChunk, { type: "markdown_text" }> => c.type === "markdown_text");
    expect(md.some((c) => c.text.includes("✻") && c.text.includes("I should read"))).toBe(true);
    // Tool bodies are NOT loose code fences anymore — they live in the cards.
    expect(md.some((c) => c.text.includes("stderr") || c.text.includes("@@") || c.text.includes("☑︎ ~read~"))).toBe(false);

    // Each completed card carries a structured title AND its tool body as `output`.
    const cards = chunks.filter((c): c is Extract<StreamChunk, { type: "task_update" }> => c.type === "task_update");
    const complete = (id: string) => cards.find((c) => c.id === id && c.status === "complete");
    expect(complete("a1:2")?.output).toContain("a.ts");
    expect(complete("a1:2")?.output).toContain("stderr");
    expect(complete("a2:1")?.output).toContain("@@");
    expect(complete("a2:1")?.output).toContain("+new");
    expect(complete("a2:2")?.output).toContain("☑︎ ~read~");
    expect(complete("a2:2")?.output).toContain("▶ edit");
    expect(cards.find((c) => c.id === "a1:2")?.title).toBe("Bash · ls");
    expect(cards.find((c) => c.id === "a2:1")?.title).toBe("Edit · /repo/src/a.ts");
    // A genuine multi-tool turn: three distinct tool cards (bash, edit, todo), no more.
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set(["a1:2", "a2:1", "a2:2"]));
    expect(cards.find((c) => c.id === "a2:2")?.title).toBe("TodoWrite");

    // The "is …" thread-status line and a root status reaction both fire.
    const status = slack.of("assistant.threads.setStatus");
    expect(status.length).toBeGreaterThan(0);
    expect(typeof status[status.length - 1]!.args.status).toBe("string");
    expect(slack.of("reactions.add").length).toBeGreaterThan(0);
  });

  test("a pending tool leaves its card in_progress, then a later render completes it in place", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "run it" },
      {
        id: "a1:0",
        timestamp: TS,
        kind: "tool",
        name: "Bash",
        input: { command: "sleep 5" },
        result: { kind: "pending" },
      },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-P");
    const first = chunksOf(slack.of("chat.appendStream")[0]!);
    expect(first.map(summarize)).toEqual(["md", "card:a1:0:in_progress"]);
    // A pending tool → a wrench reaction on the root (the "tool" lifecycle phase).
    expect(slack.of("reactions.add").some((r) => r.args.name === "hammer_and_wrench")).toBe(true);

    // Resolve the tool; the SAME card id flips to complete + streams its body.
    collector.rows = [
      { id: "u1", timestamp: TS, kind: "user", text: "run it" },
      {
        id: "a1:0",
        timestamp: TS,
        kind: "tool",
        name: "Bash",
        input: { command: "sleep 5" },
        result: { kind: "bash", stdout: "done", stderr: "", interrupted: false },
      },
    ];
    await mirror.renderSession("sess-P");
    const second = chunksOf(slack.of("chat.appendStream")[1]!);
    expect(second.map(summarize)).toEqual(["card:a1:0:complete"]);
    const done = second.find(
      (c): c is Extract<StreamChunk, { type: "task_update" }> => c.type === "task_update",
    );
    expect(done!.output).toContain("done"); // bash body rides in the card, not a loose fence
    expect(slack.methods()).not.toContain("chat.stopStream"); // same turn still live
  });
});

describe("turn-skip fix — every intermediate completed turn is posted", () => {
  test("with two completed turns behind the live one, the middle turn is not dropped", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const rows: RichRow[] = [
      { id: "u1", timestamp: TS, kind: "user", text: "first task" },
      { id: "a1", timestamp: TS, kind: "text", text: "did first" },
      { id: "u2", timestamp: TS, kind: "user", text: "second task" },
      { id: "a2", timestamp: TS, kind: "text", text: "did second" },
      { id: "u3", timestamp: TS, kind: "user", text: "third task" },
      { id: "a3", timestamp: TS, kind: "text", text: "working third" },
    ];
    // The mirror last saw turn u1 as live and has already backfilled — so u2 and
    // u3 both landed between renders. u2 (intermediate) must be posted, not skipped.
    seedBinding(store, { sessionId: "sess-B", backfilled: true, lastTurnKey: "u1" });
    const mirror = new Mirror(slack, new FakeCollector(rows), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-B");

    // Two streams open: u2 (finalized) and u3 (live). u1 is neither re-posted nor dropped.
    const titles = slack.of("chat.startStream").map(planTitle);
    expect(titles).toEqual(["second task", "third task"]);

    // The intermediate turn (u2 → stream-1) is finalized; the live turn (u3 → stream-2) is not.
    const stopped = slack.of("chat.stopStream").map((c) => c.args.ts);
    expect(stopped).toContain("stream-1");
    expect(stopped).not.toContain("stream-2");
  });
});

describe("no-stream fallback — edited Block-Kit placeholder", () => {
  test("when startStream is unavailable, degrade to postMessage + chat.update, never append/stop", async () => {
    const slack = new RecordingSlack({ streamUnavailable: true });
    const store = tmpStore();
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "hi" },
      { id: "a1", timestamp: TS, kind: "text", text: "hello there" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-F");

    // startStream is attempted once (capability probe), then degrades.
    expect(slack.of("chat.startStream")).toHaveLength(1);
    expect(slack.methods()).not.toContain("chat.appendStream");
    expect(slack.methods()).not.toContain("chat.stopStream");
    // A placeholder message is posted with Block Kit blocks (root + placeholder).
    const posts = slack.of("chat.postMessage");
    expect(posts.length).toBe(2);
    const placeholder = posts[1]!;
    expect(Array.isArray(placeholder.args.blocks)).toBe(true);

    // The turn grows; the fallback edits the placeholder in place (no new stream attempt).
    collector.rows = [...collector.rows, { id: "a2", timestamp: TS, kind: "text", text: "all done" }];
    await mirror.renderSession("sess-F");
    expect(slack.methods()).toContain("chat.update");
    expect(slack.of("chat.startStream")).toHaveLength(1); // capability cached — not retried
  });
});

describe("appendStream failure — rotate in place, never re-stream the whole turn", () => {
  test("a dead append finalizes the orphan, opens ONE fresh stream, and resends only the delta", async () => {
    const slack = new RecordingSlack({ appendFailAt: [2] }); // fail the second (mid-turn) append
    const store = tmpStore();
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "go" },
      { id: "a1", timestamp: TS, kind: "text", text: "starting" },
    ]);
    seedBinding(store, { sessionId: "sess-R", backfilled: true });
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    // Render 1: the turn opens and its prompt+text stream fine into stream-1.
    await mirror.renderSession("sess-R");
    expect(chunksOf(slack.of("chat.appendStream")[0]!).map(summarize)).toEqual(["md", "md"]);

    // Render 2: the turn grows by a tool; that append fails and triggers a rotation.
    collector.rows = [
      ...collector.rows,
      {
        id: "a2",
        timestamp: TS,
        kind: "tool",
        name: "Bash",
        input: { command: "ls" },
        result: { kind: "bash", stdout: "out", stderr: "", interrupted: false },
      },
    ];
    await mirror.renderSession("sess-R");

    // The dead stream is finalized (not left stuck in-progress), and exactly ONE
    // fresh stream is opened to continue the same turn — no re-open storm.
    expect(slack.of("chat.stopStream").map((c) => c.args.ts)).toEqual(["stream-1"]);
    expect(slack.of("chat.startStream").map((c) => c.args.ts ?? null)).toHaveLength(2);

    // The rotation resends ONLY the failed delta into stream-2 — the already-streamed
    // prompt+text are NOT re-emitted, so the turn is not duplicated.
    const appends = slack.of("chat.appendStream");
    expect(appends).toHaveLength(3); // [ok prefix, failed delta, rotated resend]
    const resend = appends[2]!;
    expect(resend.args.ts).toBe("stream-2");
    expect(chunksOf(resend).map(summarize)).toEqual(["card:a2:in_progress", "card:a2:complete"]);
  });
});

describe("restart resume — a lost in-memory stream resumes from its persisted offset", () => {
  test("with no live entry but persisted stream state, the turn resumes without re-streaming from zero", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // The prior process streamed the first two events of the live turn into
    // stream-old, then died — only the durable ts + offset survive.
    seedBinding(store, {
      sessionId: "sess-X",
      backfilled: true,
      lastTurnKey: "u1",
      liveMode: "stream",
      liveTs: "stream-old",
      liveEmitted: 2,
    });
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "keep going" },
      { id: "a1", timestamp: TS, kind: "text", text: "first" },
      { id: "a2", timestamp: TS, kind: "text", text: "second" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-X");

    // No new stream is opened — the turn resumes on the persisted message.
    expect(slack.methods()).not.toContain("chat.startStream");
    const appends = slack.of("chat.appendStream");
    expect(appends).toHaveLength(1);
    expect(appends[0]!.args.ts).toBe("stream-old");
    // Only the not-yet-streamed tail (the 3rd event) is sent — no whole-turn re-emit.
    expect(chunksOf(appends[0]!).map(summarize)).toEqual(["md"]);
  });

  test("an in-flight tool card is restored on resume, so its completion + output still stream", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // The prior process streamed [user, tool_call(in_progress)] for a still-pending
    // Bash into stream-old, then died. Its tool_result sits at index 2 (< emitted),
    // and the pending card is recorded in livePending — the durable fact that lets
    // the completion resolve after the restart drops the in-memory maps.
    seedBinding(store, {
      sessionId: "sess-XP",
      backfilled: true,
      lastTurnKey: "u1",
      liveMode: "stream",
      liveTs: "stream-old",
      liveEmitted: 3,
      livePending: [{ id: "a1:0", title: "Bash · sleep 5", openedAt: FIXED_NOW() }],
    });
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "run it" },
      {
        id: "a1:0",
        timestamp: TS,
        kind: "tool",
        name: "Bash",
        input: { command: "sleep 5" },
        result: { kind: "bash", stdout: "done", stderr: "", interrupted: false },
      },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-XP");

    // Resumes on the persisted message — no fresh stream opened.
    expect(slack.methods()).not.toContain("chat.startStream");
    const appends = slack.of("chat.appendStream");
    expect(appends).toHaveLength(1);
    expect(appends[0]!.args.ts).toBe("stream-old");
    // The restored card flips complete IN PLACE, carrying its bash body as the
    // card's `output` — the resolved tool_result at index 2 (below `emitted`) is
    // no longer dropped, and never a loose markdown_text fence.
    expect(chunksOf(appends[0]!).map(summarize)).toEqual(["card:a1:0:complete"]);
    const complete = chunksOf(appends[0]!).find(
      (c): c is Extract<StreamChunk, { type: "task_update" }> => c.type === "task_update",
    );
    expect(complete!.title).toBe("Bash · sleep 5"); // opening title reused from livePending
    expect(complete!.output).toContain("done"); // bash body rides inside the card
  });
});

describe("reconnect re-render — active mirror threads refresh on resync", () => {
  test("resyncActive re-renders an active thread that advanced during an outage, and skips ended ones", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // Two mirror threads exist. The active one last mirrored turn u1 as live; a
    // second turn (u2) landed while the WS was down, so no nudge ever arrived to
    // self-heal it. The ended thread must NOT be touched by the resync.
    seedBinding(store, {
      sessionId: "sess-ACT",
      rootTs: "root-act",
      backfilled: true,
      lastTurnKey: "u1",
    });
    seedBinding(store, {
      sessionId: "sess-END",
      rootTs: "root-end",
      backfilled: true,
      lastTurnKey: "u1",
      ended: true,
    });
    const rows: RichRow[] = [
      { id: "u1", timestamp: TS, kind: "user", text: "first task" },
      { id: "a1", timestamp: TS, kind: "text", text: "did first" },
      { id: "u2", timestamp: TS, kind: "user", text: "second task" },
      { id: "a2", timestamp: TS, kind: "text", text: "working second" },
    ];
    const mirror = new Mirror(slack, new FakeCollector(rows), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    await mirror.resyncActive();

    // The active thread re-rendered: it opened a live stream for the new turn u2
    // inside its own root — closing the advanced-then-idle-during-outage gap.
    const starts = slack.of("chat.startStream");
    expect(starts.length).toBeGreaterThan(0);
    const threads = starts.map((s) => s.args.thread_ts);
    expect(threads).toContain("root-act");
    // The ended thread is skipped entirely — nothing streams into its root.
    expect(threads).not.toContain("root-end");
    expect(planTitle(starts.at(-1)!)).toBe("second task");
  });

  test("resyncActive does NOT clobber a dormant session's persisted root reaction after a restart", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // A fresh adapter process: an idle session's last turn was fully streamed then
    // never finalized (liveMode='stream' persists), and its root already shows 💤
    // (statusReaction='zzz'). lastStatus is in-memory only, so it is empty here —
    // no session:status frame has arrived for this dormant session. resyncActive
    // must NOT re-assert a live turn-phase reaction over the persisted 💤.
    seedBinding(store, {
      sessionId: "sess-IDLE",
      rootTs: "root-idle",
      backfilled: true,
      lastTurnKey: "u1",
      liveMode: "stream",
      liveTs: "stream-old",
      liveEmitted: 2, // both events already streamed → the resumed delta is a no-op
      statusReaction: "zzz",
    });
    const rows: RichRow[] = [
      { id: "u1", timestamp: TS, kind: "user", text: "hello" },
      { id: "a1", timestamp: TS, kind: "text", text: "hi back" },
    ];
    const mirror = new Mirror(slack, new FakeCollector(rows), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    await mirror.resyncActive();

    // The persisted 💤 is untouched: no live-phase reaction is added and 💤 is not removed.
    expect(slack.of("reactions.add").some((r) => r.args.name === "speech_balloon")).toBe(false);
    expect(slack.of("reactions.remove").some((r) => r.args.name === "zzz")).toBe(false);
    expect(store.get("sess-IDLE")!.statusReaction).toBe("zzz");
  });

  test("a finalized dormant thread stays silent on a fresh (restarted) process — no re-posted tail", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // A dormant session whose last turn was fully streamed and finalized on a
    // previous process: lastTurnKey persists and backfilled is true, but there is
    // NO live stream (clearPersistedLive ran at finalize, so liveTs is unset). On a
    // fresh adapter process — bun --watch restarts this adapter on any source
    // change — the in-memory seen-set is empty. resyncActive must treat the durable
    // lastTurnKey as proof the tail was already posted and stay silent, NOT re-open
    // the last turn into the thread. Re-posting on every restart is the bug that
    // flooded idle threads with duplicate/empty messages.
    seedBinding(store, {
      sessionId: "sess-DORMANT",
      rootTs: "root-dormant",
      backfilled: true,
      lastTurnKey: "u1",
    });
    const rows: RichRow[] = [
      { id: "u1", timestamp: TS, kind: "user", text: "old task" },
      { id: "a1", timestamp: TS, kind: "text", text: "old answer" },
    ];
    const mirror = new Mirror(slack, new FakeCollector(rows), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    await mirror.resyncActive();

    // Nothing streamed, appended, or posted into the dormant thread.
    expect(slack.of("chat.startStream")).toHaveLength(0);
    expect(slack.of("chat.appendStream")).toHaveLength(0);
    expect(slack.of("chat.postMessage")).toHaveLength(0);
  });

  test("resyncActive re-adopts a lost fallback placeholder without re-posting a duplicate turn", async () => {
    const slack = new RecordingSlack({ streamUnavailable: true });
    const store = tmpStore();
    const rows: RichRow[] = [
      { id: "u1", timestamp: TS, kind: "user", text: "hello" },
      { id: "a1", timestamp: TS, kind: "text", text: "hi back" },
    ];
    const collector = new FakeCollector(rows);
    seedBinding(store, { sessionId: "sess-FB", rootTs: "root-fb", backfilled: true });

    // Process 1: a non-streaming workspace degrades to an edited Block-Kit
    // placeholder; the durable fallback live state (mode + ts + signature) persists.
    const m1 = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    m1.setChannel("C1");
    await m1.renderSession("sess-FB");
    const postsAfterOpen = slack.of("chat.postMessage").length;
    expect(store.get("sess-FB")!.liveMode).toBe("fallback");
    expect(store.get("sess-FB")!.liveSig).toBeDefined();

    // Process 2 (restart): the in-memory live map is empty and the transcript is
    // unchanged. The resync must re-adopt the persisted placeholder — NOT post a
    // fresh duplicate of the turn, and NOT re-edit it (content-free → no-op).
    const m2 = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    m2.setChannel("C1");
    await m2.resyncActive();

    expect(slack.of("chat.postMessage").length).toBe(postsAfterOpen); // no duplicate placeholder
    expect(slack.methods()).not.toContain("chat.update"); // signature unchanged → no re-render
  });

  test("resyncActive does NOT re-post a turn whose stream was permanently abandoned mid-turn", async () => {
    // The first append fails AND the rotation's fresh startStream also fails, so the
    // live message is abandoned mid-turn. The session then goes idle. A later backstop
    // resync must NOT open a fresh stream / placeholder duplicating the emitted turn.
    const slack = new RecordingSlack({ appendFailAt: [1], startFailAt: [2] });
    const store = tmpStore();
    seedBinding(store, { sessionId: "sess-ABND", rootTs: "root-abnd", backfilled: true });
    const rows: RichRow[] = [
      { id: "u1", timestamp: TS, kind: "user", text: "go" },
      { id: "a1", timestamp: TS, kind: "text", text: "starting" },
    ];
    const mirror = new Mirror(slack, new FakeCollector(rows), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    // Render 1: opens (startStream #1), the append fails, the rotation's startStream
    // #2 also fails → the turn is abandoned and its persisted live state is cleared.
    await mirror.renderSession("sess-ABND");
    expect(slack.of("chat.startStream")).toHaveLength(2);
    expect(store.get("sess-ABND")!.liveTs).toBeUndefined();
    const startsBefore = slack.of("chat.startStream").length;
    const postsBefore = slack.of("chat.postMessage").length;

    // The backstop resync of the now-idle session is a true no-op — no re-open.
    await mirror.resyncActive();
    expect(slack.of("chat.startStream").length).toBe(startsBefore);
    expect(slack.of("chat.postMessage").length).toBe(postsBefore);
  });

  test("resyncActive is a no-op when no channel is configured", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    seedBinding(store, { sessionId: "sess-NC", rootTs: "root-nc", backfilled: true });
    const mirror = new Mirror(slack, new FakeCollector(scriptedTurn()), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    // channel intentionally left unset (feed off).
    await mirror.resyncActive();
    expect(slack.calls).toHaveLength(0);
  });
});

describe("steer-from-Slack render — a thread reply becomes a new live turn", () => {
  test("a steered follow-up finalizes the prior turn and opens ONE fresh stream titled with the reply", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // Pre-existing mirror thread (root already posted) so stream ts numbering is clean.
    seedBinding(store, { sessionId: "sess-S", rootTs: "root-s" });
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "fix the parser", sentBy: "alice" },
      { id: "a1", timestamp: TS, kind: "text", text: "on it" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    // Render 1: the owner's opening turn opens a live stream (stream-1), stays live.
    await mirror.renderSession("sess-S");
    expect(slack.of("chat.startStream")).toHaveLength(1);
    expect(slack.methods()).not.toContain("chat.stopStream");

    // A Slack thread reply steers the running agent (s7): the collector injects the
    // reply as a NEW user row — sentBy the steering Slack actor, not the owner — and
    // the agent continues with a fresh turn.
    collector.rows = [
      ...collector.rows,
      { id: "u2", timestamp: TS, kind: "user", text: "also add a test", sentBy: "slack:UZZZ" },
      { id: "a2", timestamp: TS, kind: "text", text: "adding the test" },
    ];

    await mirror.renderSession("sess-S");

    // The prior turn (stream-1) is finalized and exactly ONE fresh stream opens for
    // the steered turn — the injected reply is a new turn, never a re-post of u1.
    const starts = slack.of("chat.startStream");
    expect(starts).toHaveLength(2);
    expect(planTitle(starts[1]!)).toBe("also add a test");
    expect(slack.of("chat.stopStream").map((c) => c.args.ts)).toEqual(["stream-1"]);

    // The steered turn is still live (stream-2 not finalized) and its prompt streamed.
    expect(slack.of("chat.stopStream").map((c) => c.args.ts)).not.toContain("stream-2");
    const steered = chunksOf(slack.of("chat.appendStream").at(-1)!);
    expect(steered.some((c) => c.type === "markdown_text" && c.text.includes("also add a test"))).toBe(true);
  });
});

describe("content-free turns never post a blank header (regression)", () => {
  test("an assistant-led turn whose only prose is blank opens no stream and posts nothing", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // The tail window begins mid-message on an EMPTY assistant text block (Claude
    // emits one before going straight to tool use; the opening prompt aged out), so
    // the sole in-window turn has nothing renderable. It must NOT open a stream —
    // which Slack renders as a blank 'standup-dev … Thinking…' header that never
    // resolves — nor post a blank Block-Kit bubble.
    seedBinding(store, { sessionId: "sess-EMP", rootTs: "root-emp", backfilled: true, lastTurnKey: "prev" });
    const collector = new FakeCollector([{ id: "a0", timestamp: TS, kind: "text", text: "" }]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-EMP");

    expect(slack.of("chat.startStream")).toHaveLength(0);
    expect(slack.of("chat.appendStream")).toHaveLength(0);
    expect(slack.of("chat.postMessage")).toHaveLength(0);
  });

  test("a blank completed turn posts no header while the real live turn still streams", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // Two turns land between renders: an assistant-led BLANK-prose turn (a0,
    // intermediate) and a real user turn (u1, live). Before the fix the blank turn
    // slipped turnHasRenderableContent (markdownForEvent returned "" — not
    // undefined), so postCompletedTurn treated it as renderable and opened its OWN
    // second chat.startStream — titled "Working…", since a0 carries no prompt —
    // ahead of the real turn's stream: the doubled blank header seen in the feed.
    // Returning undefined makes the blank turn content-free, so only the real turn
    // streams.
    seedBinding(store, { sessionId: "sess-EMP2", rootTs: "root-emp2", backfilled: true, lastTurnKey: "prev" });
    const collector = new FakeCollector([
      { id: "a0", timestamp: TS, kind: "text", text: "   " },
      { id: "u1", timestamp: TS, kind: "user", text: "do the real thing" },
      { id: "a1", timestamp: TS, kind: "text", text: "on it" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-EMP2");

    // The content-free turn posts nothing — no fallback bubble either.
    expect(slack.of("chat.postMessage")).toHaveLength(0);
    // Exactly ONE stream opens — for the real turn only, never a second "Working…"
    // stream for the blank turn — carrying the real prompt.
    const starts = slack.of("chat.startStream");
    expect(starts).toHaveLength(1);
    expect(planTitle(starts[0]!)).toBe("do the real thing");
    const appended = chunksOf(slack.of("chat.appendStream").at(-1)!);
    expect(appended.some((c) => c.type === "markdown_text" && c.text.includes("do the real thing"))).toBe(true);
  });

  test("a turn whose only in-window event is blank thinking opens no stream and posts nothing", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    // The sole in-window turn is an assistant-led blank/whitespace THINKING block
    // (the opening prompt aged out). Like a blank text block it has no visible body:
    // a bare "> _✻ _" blockquote is not renderable content. It must NOT open a
    // stream — which Slack shows as a "Working…" plan header over a near-empty ✻
    // bubble that never resolves — closing the same class of empty-header bug.
    seedBinding(store, { sessionId: "sess-THK", rootTs: "root-thk", backfilled: true, lastTurnKey: "prev" });
    const collector = new FakeCollector([{ id: "a0", timestamp: TS, kind: "thinking", text: "   " }]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-THK");

    expect(slack.of("chat.startStream")).toHaveLength(0);
    expect(slack.of("chat.appendStream")).toHaveLength(0);
    expect(slack.of("chat.postMessage")).toHaveLength(0);
  });
});

describe("content-free turns on the Block-Kit fallback never post an empty section (regression)", () => {
  const sectionText = (blocks: KnownBlock[]): string[] =>
    blocks.filter((b): b is Extract<KnownBlock, { type: "section" }> => b.type === "section").map((b) => b.text?.text ?? "");

  test("a blank-text turn posts nothing when native streaming is unavailable", async () => {
    const slack = new RecordingSlack({ streamUnavailable: true });
    const store = tmpStore();
    // The content-free guard holds on the NO-STREAMING path too: an assistant-led
    // blank text block opens no stream and posts no placeholder. A blank section
    // would be rejected by Slack, and there is nothing to show regardless.
    seedBinding(store, { sessionId: "sess-FBE", rootTs: "root-fbe", backfilled: true, lastTurnKey: "prev" });
    const collector = new FakeCollector([{ id: "a0", timestamp: TS, kind: "text", text: "   " }]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-FBE");

    expect(slack.of("chat.startStream")).toHaveLength(0);
    expect(slack.of("chat.postMessage")).toHaveLength(0);
  });

  test("a mixed turn posts its real content and never an empty section on the fallback path", async () => {
    const slack = new RecordingSlack({ streamUnavailable: true });
    const store = tmpStore();
    // A renderable turn interleaves a blank text block with real prose. On the
    // Block-Kit fallback, renderEvent drops the blank block ([] not section("")), so
    // the placeholder posts the real content: a lone blank section would make Slack
    // reject the whole chat.postMessage and lose the turn.
    seedBinding(store, { sessionId: "sess-FBM", rootTs: "root-fbm", backfilled: true, lastTurnKey: "prev" });
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "do the real thing" },
      { id: "a1", timestamp: TS, kind: "text", text: "   " },
      { id: "a2", timestamp: TS, kind: "text", text: "the real answer" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-FBM");

    // Streaming is probed once then degrades; a single Block-Kit placeholder posts.
    expect(slack.of("chat.startStream")).toHaveLength(1);
    expect(slack.methods()).not.toContain("chat.appendStream");
    const posts = slack.of("chat.postMessage");
    expect(posts).toHaveLength(1);

    const sections = sectionText(posts.flatMap((p) => (p.args.blocks as KnownBlock[]) ?? []));
    // The real prose landed in a section …
    expect(sections.some((t) => t.includes("the real answer"))).toBe(true);
    // … and no section is empty/whitespace-only (the blank block rendered nothing).
    expect(sections.some((t) => t.trim() === "")).toBe(false);
  });
});

describe("session-end / idle guards", () => {
  test("a nudge after onSessionEnd never re-streams the finalized turn", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    seedBinding(store, { sessionId: "sess-D", backfilled: true, lastTurnKey: "u1", ended: true });
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "done already" },
      { id: "a1", timestamp: TS, kind: "text", text: "the final answer" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-D");

    // The ended guard short-circuits — nothing is posted below the end marker.
    expect(slack.calls).toHaveLength(0);
  });

  test("once the session goes idle, the 'is …' line is cleared and the reaction leaves the live phase", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "hello" },
      { id: "a1", timestamp: TS, kind: "text", text: "hi back" },
    ]);
    seedBinding(store, { sessionId: "sess-I", backfilled: true });
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");

    // Live turn renders while running — a live-phase reaction and a status line fire.
    await mirror.renderSession("sess-I");
    expect(slack.of("reactions.add").at(-1)!.args.name).toBe("speech_balloon");

    // The session goes idle; a trailing nudge must not re-assert the live phase.
    mirror.onStatus("sess-I", "idle");
    await mirror.renderSession("sess-I");

    expect(slack.of("assistant.threads.setStatus").some((c) => c.args.status === "")).toBe(true);
    expect(slack.of("reactions.add").at(-1)!.args.name).toBe("zzz");
  });

  test("onSessionDeleted unlinks the binding (both directions) and posts nothing", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    seedBinding(store, { sessionId: "sess-DEL", rootTs: "root-del", backfilled: true });
    const collector = new FakeCollector([
      { id: "u1", timestamp: TS, kind: "user", text: "hello" },
      { id: "a1", timestamp: TS, kind: "text", text: "hi" },
    ]);
    const mirror = new Mirror(slack, collector, store, "http://web.local", { botUserId: "U", teamId: "T", now: FIXED_NOW });
    mirror.setChannel("C1");
    await mirror.renderSession("sess-DEL");
    expect(mirror.sessionForRoot("root-del")).toBe("sess-DEL");

    const before = slack.calls.length;
    mirror.onSessionDeleted("sess-DEL");

    // Forward and reverse routes are both gone; deletion makes no Slack calls.
    expect(store.get("sess-DEL")).toBeUndefined();
    expect(mirror.sessionForRoot("root-del")).toBeUndefined();
    expect(slack.calls.length).toBe(before);
  });
});
