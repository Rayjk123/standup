// Session ↔ thread isolation regression for the Slack mirror. With a recording
// Slack client (NO live calls) and a fake transcript source holding TWO distinct
// sessions, this pins that one session's content can never bleed into another's
// thread: (a) each session gets its OWN distinct root (rootTs); (b) rendering
// session A streams ONLY A's content into A's root, never B's; (c) a status or a
// thread-reply route for one session never lands on the other's thread.
//
// Guards the cross-bleed root cause: the collector's transcript readers used to
// emit EVERY record in the resolved file with no per-record sessionId filter, so
// a file that legitimately held a second session's records (resume/compaction
// copies the parent turns, each keeping its original sessionId) leaked those
// turns into the requested session's thread. The FakeCollector here models the
// filtered collector — it hands each session only its OWN rows.

import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { RichRow, RichTranscriptPage } from "./collector-client.js";
import type { SlackApi, SlackCallResult, StreamChunk } from "./stream-client.js";
import { Mirror, type MirrorTranscriptSource } from "./mirror.js";
import { SessionThreads } from "./session-threads.js";

const TS = "2026-01-01T00:00:00Z";
const FIXED_NOW = () => 1_000_000;

interface Recorded {
  method: string;
  args: Record<string, unknown>;
}

/** Recording fake for the SlackApi seam; assigns a unique ts to every posted/streamed message. */
class RecordingSlack implements SlackApi {
  readonly calls: Recorded[] = [];
  /** stream ts → the thread_ts it was opened against (so a chunk can be traced to its thread). */
  readonly streamThread = new Map<string, string>();
  private seq = 0;

  async call(method: string, args: Record<string, unknown>): Promise<SlackCallResult> {
    this.calls.push({ method, args });
    if (method === "chat.startStream") {
      const ts = `stream-${++this.seq}`;
      this.streamThread.set(ts, String(args.thread_ts ?? ""));
      return { ok: true, ts, data: { ok: true } };
    }
    if (method === "chat.postMessage") return { ok: true, ts: `msg-${++this.seq}`, data: { ok: true } };
    return { ok: true, data: { ok: true } };
  }

  of(method: string): Recorded[] {
    return this.calls.filter((c) => c.method === method);
  }
}

/** A transcript source that keys rows + titles by sessionId — each session sees only its own. */
class MultiSessionCollector implements MirrorTranscriptSource {
  constructor(
    private readonly rowsBySession: Map<string, RichRow[]>,
    private readonly titles: Map<string, string> = new Map(),
  ) {}
  async getRichTranscript(sessionId: string): Promise<RichTranscriptPage | null> {
    const rows = this.rowsBySession.get(sessionId) ?? [];
    return { rows, hasMore: false, truncated: false, totalRows: rows.length, outputTokens: 0, contextTokens: 0 };
  }
  async sessionTitle(sessionId: string): Promise<string> {
    return this.titles.get(sessionId) ?? sessionId.slice(0, 8);
  }
}

const cleanups: string[] = [];
let storeSeq = 0;
function tmpStore(): SessionThreads {
  const path = join(tmpdir(), `standup-slack-iso-${process.pid}-${++storeSeq}.json`);
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
const mdText = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c): c is Extract<StreamChunk, { type: "markdown_text" }> => c.type === "markdown_text")
    .map((c) => c.text)
    .join("\n");

describe("mirror session ↔ thread isolation", () => {
  test("two sessions get distinct threads and neither streams the other's content", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const rows = new Map<string, RichRow[]>([
      [
        "sess-A",
        [
          { id: "ua", timestamp: TS, kind: "user", text: "task for alpha" },
          { id: "aa", timestamp: TS, kind: "text", text: "ALPHA-ONLY-CONTENT" },
        ],
      ],
      [
        "sess-B",
        [
          { id: "ub", timestamp: TS, kind: "user", text: "task for bravo" },
          { id: "ab", timestamp: TS, kind: "text", text: "BRAVO-ONLY-CONTENT" },
        ],
      ],
    ]);
    const mirror = new Mirror(
      slack,
      new MultiSessionCollector(rows, new Map([["sess-A", "Alpha"], ["sess-B", "Bravo"]])),
      store,
      "http://web.local",
      { botUserId: "U", teamId: "T", now: FIXED_NOW },
    );
    mirror.setChannel("C1");

    await mirror.renderSession("sess-A");
    await mirror.renderSession("sess-B");

    // (a) Each session maps to its OWN distinct root thread.
    const rootA = store.get("sess-A")!.rootTs;
    const rootB = store.get("sess-B")!.rootTs;
    expect(rootA).toBeDefined();
    expect(rootB).toBeDefined();
    expect(rootA).not.toBe(rootB);

    // (b) Every streamed chunk lands in the thread of the session it belongs to —
    // A's content only ever streams into rootA, B's only into rootB.
    for (const append of slack.of("chat.appendStream")) {
      const thread = slack.streamThread.get(String(append.args.ts));
      const text = mdText(chunksOf(append));
      if (text.includes("ALPHA-ONLY-CONTENT")) expect(thread).toBe(rootA);
      if (text.includes("BRAVO-ONLY-CONTENT")) expect(thread).toBe(rootB);
      // No chunk ever carries BOTH sessions' content, and A's thread never sees B's.
      if (thread === rootA) expect(text).not.toContain("BRAVO-ONLY-CONTENT");
      if (thread === rootB) expect(text).not.toContain("ALPHA-ONLY-CONTENT");
    }

    // The reverse route (used to answer/steer an inbound thread reply) resolves each
    // root to ITS OWN session — a reply in A's thread can never be steered into B.
    expect(mirror.sessionForRoot(rootA)).toBe("sess-A");
    expect(mirror.sessionForRoot(rootB)).toBe("sess-B");
  });

  test("a status event for one session reacts only on its own thread", async () => {
    const slack = new RecordingSlack();
    const store = tmpStore();
    const rows = new Map<string, RichRow[]>([
      ["sess-A", [{ id: "ua", timestamp: TS, kind: "user", text: "a" }, { id: "aa", timestamp: TS, kind: "text", text: "A" }]],
      ["sess-B", [{ id: "ub", timestamp: TS, kind: "user", text: "b" }, { id: "ab", timestamp: TS, kind: "text", text: "B" }]],
    ]);
    const mirror = new Mirror(slack, new MultiSessionCollector(rows), store, "http://web.local", {
      botUserId: "U",
      teamId: "T",
      now: FIXED_NOW,
    });
    mirror.setChannel("C1");

    await mirror.renderSession("sess-A");
    await mirror.renderSession("sess-B");
    const rootA = store.get("sess-A")!.rootTs;
    const rootB = store.get("sess-B")!.rootTs;
    const before = slack.calls.length;

    // A status frame for B applies a reaction; it must target B's root only.
    mirror.onStatus("sess-B", "idle");
    await new Promise((r) => setTimeout(r, 800)); // let the status debounce fire

    const reactions = slack.calls
      .slice(before)
      .filter((c) => c.method === "reactions.add" || c.method === "reactions.remove");
    expect(reactions.length).toBeGreaterThan(0);
    for (const r of reactions) {
      expect(r.args.timestamp).toBe(rootB);
      expect(r.args.timestamp).not.toBe(rootA);
    }
  });
});
