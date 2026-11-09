import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, createSession, insertEvent, upsertProject, type Store } from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { TranscriptTailer } from "./transcript-tailer.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
async function tmpTranscript(initial: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-tailer-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, initial);
  return path;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function sessionEvents(broadcasts: WsMessage[]) {
  return broadcasts.filter((m) => m.type === "session:event");
}

describe("TranscriptTailer", () => {
  test("a file append to a watched session triggers a debounced session:event", async () => {
    const store: Store = createStore(":memory:");
    const broadcasts: WsMessage[] = [];
    const tailer = new TranscriptTailer(store.db, (m) => broadcasts.push(m), {
      pollMs: 5,
      debounceMs: 20,
    });
    const path = await tmpTranscript('{"type":"assistant"}\n');

    tailer.watch("s1", path);
    // First pass only records the baseline size — pre-existing content is not a
    // live-turn signal, so no nudge fires for it.
    tailer.tick();
    await delay(40);
    expect(sessionEvents(broadcasts)).toHaveLength(0);

    await appendFile(path, '{"type":"assistant"}\n');
    tailer.tick();
    // Debounced: nothing on the wire yet.
    expect(sessionEvents(broadcasts)).toHaveLength(0);
    await delay(40);

    const nudges = sessionEvents(broadcasts);
    expect(nudges).toHaveLength(1);
    const payload = nudges[0].payload as { sessionId: string; seq: number };
    expect(payload.sessionId).toBe("s1");
    expect(typeof payload.seq).toBe("number");

    tailer.stop();
    store.close();
  });

  test("a burst of growth is coalesced into a single nudge", async () => {
    const store: Store = createStore(":memory:");
    const broadcasts: WsMessage[] = [];
    // Huge poll + debounce so neither auto-fires during the test — the burst is
    // driven by explicit tick()s and released by an explicit flush(), so the
    // assertion never races the wall clock (the old real-timer version flaked
    // under load when an inter-tick gap exceeded the debounce).
    const tailer = new TranscriptTailer(store.db, (m) => broadcasts.push(m), {
      pollMs: 10_000_000,
      debounceMs: 10_000_000,
    });
    const path = await tmpTranscript("a\n");

    tailer.watch("s1", path);
    tailer.tick(); // baseline

    for (let i = 0; i < 4; i++) {
      await appendFile(path, `line-${i}\n`);
      tailer.tick(); // each re-arms the single pending debounce
    }
    tailer.flush(); // release the one coalesced nudge synchronously

    expect(sessionEvents(broadcasts)).toHaveLength(1);

    tailer.stop();
    store.close();
  });

  test("a watcher is created on watch and removed on unwatch — no leak", async () => {
    const store: Store = createStore(":memory:");
    const broadcasts: WsMessage[] = [];
    const tailer = new TranscriptTailer(store.db, (m) => broadcasts.push(m), {
      pollMs: 5,
      debounceMs: 20,
    });
    const path = await tmpTranscript("a\n");

    expect(tailer.watchCount).toBe(0);
    tailer.watch("s1", path);
    expect(tailer.isWatching("s1")).toBe(true);
    expect(tailer.watchCount).toBe(1);

    tailer.unwatch("s1");
    expect(tailer.isWatching("s1")).toBe(false);
    expect(tailer.watchCount).toBe(0);

    // After removal, growth on the (now unwatched) file produces no nudge, and
    // any pending debounce was cleared — nothing leaks onto the wire.
    await appendFile(path, "more\n");
    tailer.tick();
    await delay(40);
    expect(sessionEvents(broadcasts)).toHaveLength(0);

    store.close();
  });

  test("watch is idempotent and back-fills a path learned later", async () => {
    const store: Store = createStore(":memory:");
    const tailer = new TranscriptTailer(store.db, () => {}, { pollMs: 5, debounceMs: 20 });
    const path = await tmpTranscript("a\n");

    tailer.watch("s1"); // activated before a transcript path is known
    tailer.watch("s1", path); // a later hook supplies it
    expect(tailer.watchCount).toBe(1);

    tailer.stop();
    store.close();
  });

  test("resolves the transcript path from the event stream when none is given", async () => {
    const store: Store = createStore(":memory:");
    const broadcasts: WsMessage[] = [];
    const tailer = new TranscriptTailer(store.db, (m) => broadcasts.push(m), {
      pollMs: 5,
      debounceMs: 20,
    });
    const path = await tmpTranscript("a\n");
    upsertProject(store.db, { id: "p1", name: "Tailer Test", branch: "main", repos: [] });
    createSession(store.db, {
      id: "s1",
      projectId: "p1",
      title: "t",
      cwd: "/tmp/x",
      status: "running",
    });
    insertEvent(store.db, "s1", "SessionStart", { transcript_path: path });

    tailer.watch("s1"); // no path — must resolve via transcriptPathForSession
    tailer.tick(); // resolves path + baseline
    await appendFile(path, "grow\n");
    tailer.tick();
    await delay(40);

    expect(sessionEvents(broadcasts)).toHaveLength(1);

    tailer.stop();
    store.close();
  });
});
