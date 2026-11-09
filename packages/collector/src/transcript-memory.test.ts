import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, writeFile, appendFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, upsertProject, createSession, getEventsSince } from "@standup/store";
import {
  ingestTranscriptEvents,
  walkLinesFrom,
  currentModelForSession,
  readTranscript,
  INGEST_CHUNK_BYTES,
  transcriptReadStats,
  resetTranscriptReadStats,
} from "./transcript.js";

/**
 * Bounded-memory transcript reads: ingest walks a file a chunk at a time and
 * runs one pass per session, and the current model is cached per file so the
 * session list doesn't re-read every transcript on every poll.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function file(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-transcript-mem-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, text);
  return path;
}

function line(uuid: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: "assistant",
      uuid,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "assistant", content: [] },
      ...extra,
    }) + "\n"
  );
}

function assistant(uuid: string, model: string, pad = 0): string {
  return line(uuid, {
    message: { role: "assistant", model, content: [{ type: "text", text: "x".repeat(pad) }] },
  });
}

function seeded(sessionId: string) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, { id: sessionId, projectId: "p", title: "t", cwd: "/x", status: "running" });
  return store;
}

/** About `bytes` of 4 KB records with distinct uuids. */
function sized(prefix: string, bytes: number): string {
  const one = line(`${prefix}-0`, { pad: "z".repeat(4000) }).length;
  return Array.from({ length: Math.ceil(bytes / one) }, (_, i) =>
    line(`${prefix}-${i}`, { pad: "z".repeat(4000) })
  ).join("");
}

describe("memory bounds (read accounting)", () => {
  test("20 concurrent ingests of a cold 5 MB file read it about once, a chunk at a time", async () => {
    const store = seeded("once");
    const text = sized("once", 5 * 1024 * 1024);
    const size = Buffer.byteLength(text);
    const path = await file(text);

    resetTranscriptReadStats();
    await Promise.all(Array.from({ length: 20 }, () => ingestTranscriptEvents(store.db, "once", path)));

    expect(transcriptReadStats.bytes).toBeGreaterThanOrEqual(size);
    expect(transcriptReadStats.bytes).toBeLessThanOrEqual(size + INGEST_CHUNK_BYTES);
    expect(transcriptReadStats.largestRead).toBeLessThanOrEqual(INGEST_CHUNK_BYTES);
    store.close();
  });

  test("cold ingests across many sessions never hold more than 4 read slots", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    const ids = Array.from({ length: 10 }, (_, i) => `slots-${i}`);
    const paths: string[] = [];
    for (const id of ids) {
      createSession(store.db, { id, projectId: "p", title: "t", cwd: `/x/${id}`, status: "running" });
      paths.push(await file(sized(id, 3 * 1024 * 1024)));
    }

    resetTranscriptReadStats();
    await Promise.all(ids.map((id, i) => ingestTranscriptEvents(store.db, id, paths[i])));
    // Ten tails at once, too.
    await Promise.all(paths.map((p) => readTranscript(p, 10)));

    expect(transcriptReadStats.peakSlots).toBeLessThanOrEqual(4);
    expect(transcriptReadStats.peakSlots).toBeGreaterThan(1);
    store.close();
  });

  test("the model lookup reads nothing for an unchanged file and only the appended bytes after growth", async () => {
    const path = await file(sized("m", 2 * 1024 * 1024) + assistant("a", "claude-opus-5-5"));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");

    resetTranscriptReadStats();
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
    expect(transcriptReadStats.bytes).toBe(0);

    const appended = assistant("b", "claude-sonnet-5-5");
    await appendFile(path, appended);
    expect(await currentModelForSession(path)).toBe("claude-sonnet-5-5");
    expect(transcriptReadStats.bytes).toBeLessThanOrEqual(Buffer.byteLength(appended));
  });

  test("the model is the same however the cache learned it: older than the tail window reads as none", async () => {
    const head = assistant("a", "claude-opus-5-5");
    const gap = Array.from({ length: 120 }, (_, i) => line(`g${i}`, { pad: "q".repeat(6000) }));

    // Fresh lookup on the whole file.
    const fresh = await file(head + gap.join(""));
    // Cold ingest first, then a lookup.
    const store = seeded("taught");
    const ingested = await file(head + gap.join(""));
    await ingestTranscriptEvents(store.db, "taught", ingested);
    // Grown a record at a time, with a lookup after each.
    const grown = await file(head);
    expect(await currentModelForSession(grown)).toBe("claude-opus-5-5");
    for (const g of gap) {
      await appendFile(grown, g);
      await currentModelForSession(grown);
    }

    expect(await currentModelForSession(fresh)).toBeNull();
    expect(await currentModelForSession(ingested)).toBeNull();
    expect(await currentModelForSession(grown)).toBeNull();
    store.close();
  });
});

describe("walkLinesFrom", () => {
  test("yields whole lines in chunks, widens for a line longer than a chunk, holds back a partial tail", async () => {
    const long = line("long", { pad: "y".repeat(300) });
    const text = line("a") + long + line("b") + '{"type":"assistant","uuid":"partial"';
    const path = await file(text);
    const size = Buffer.byteLength(text);

    const chunks: string[] = [];
    const next = await walkLinesFrom(path, 0, size, (t) => chunks.push(t), 64);

    const whole = line("a") + long + line("b");
    expect(chunks.join("")).toBe(whole);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.endsWith("\n"))).toBe(true);
    expect(next).toBe(Buffer.byteLength(whole));
  });

  test("multi-byte text split across chunk edges decodes intact", async () => {
    const text = line("u", { pad: "é漢🙂".repeat(50) }) + line("v", { pad: "🙂".repeat(40) });
    const path = await file(text);
    const chunks: string[] = [];
    await walkLinesFrom(path, 0, Buffer.byteLength(text), (t) => chunks.push(t), 7);
    expect(chunks.join("")).toBe(text);
  });

  test("a file shorter than the walk's end (shrunk under it) stops at the last whole line", async () => {
    const text = line("a") + line("b") + '{"partial":';
    const path = await file(text);
    const chunks: string[] = [];
    const next = await walkLinesFrom(path, 0, Buffer.byteLength(text) + 64 * 1024 * 1024, (t) => chunks.push(t), 16);
    expect(chunks.join("")).toBe(line("a") + line("b"));
    expect(next).toBe(Buffer.byteLength(line("a") + line("b")));
  });

  test("an offset past the end restarts from 0", async () => {
    const text = line("a");
    const path = await file(text);
    const chunks: string[] = [];
    await walkLinesFrom(path, 10_000, Buffer.byteLength(text), (t) => chunks.push(t));
    expect(chunks.join("")).toBe(text);
  });
});

describe("ingestTranscriptEvents — bounded passes", () => {
  test("a file over one chunk ingests every record, in order", async () => {
    const store = seeded("chunked");
    const n = 400;
    const ids = Array.from({ length: n }, (_, i) => `u${i + 1}`);
    const text = ids.map((id) => line(id, { pad: "z".repeat(4000) })).join("");
    expect(Buffer.byteLength(text)).toBeGreaterThan(INGEST_CHUNK_BYTES);
    const path = await file(text);

    expect(await ingestTranscriptEvents(store.db, "chunked", path)).toEqual({ head: n, appended: n });
    const { events } = getEventsSince(store.db, "chunked", 0, n + 10);
    expect(events.map((e) => e.eventId)).toEqual(ids);
    store.close();
  });

  test("concurrent calls on a cold session run one pass at a time and report the appends once", async () => {
    const store = seeded("burst");
    const n = 50;
    const path = await file(Array.from({ length: n }, (_, i) => line(`u${i}`)).join(""));

    const results = await Promise.all(
      Array.from({ length: 20 }, () => ingestTranscriptEvents(store.db, "burst", path))
    );
    expect(results.reduce((sum, r) => sum + r.appended, 0)).toBe(n);
    expect(results.every((r) => r.head === n)).toBe(true);
    store.close();
  });

  test("a call that joins a queued pass sees bytes appended before it was made", async () => {
    const store = seeded("join");
    const path = await file(line("a"));

    const first = ingestTranscriptEvents(store.db, "join", path);
    await appendFile(path, line("b"));
    const second = ingestTranscriptEvents(store.db, "join", path);
    await appendFile(path, line("c"));
    const third = ingestTranscriptEvents(store.db, "join", path);

    await Promise.all([first, second, third]);
    expect((await third).head).toBe(3);
    const { events } = getEventsSince(store.db, "join", 0);
    expect(events.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
    store.close();
  });

  test("a call for a different file than the queued pass's gets its own pass", async () => {
    const store = seeded("twofiles");
    const first = await file(line("a"));
    const second = await file(line("b") + line("c"));

    const running = ingestTranscriptEvents(store.db, "twofiles", first);
    const queuedOld = ingestTranscriptEvents(store.db, "twofiles", first);
    const moved = ingestTranscriptEvents(store.db, "twofiles", second);
    await Promise.all([running, queuedOld]);

    expect(await moved).toEqual({ head: 3, appended: 2 });
    const { events } = getEventsSince(store.db, "twofiles", 0);
    expect(events.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
    store.close();
  });

  test("a session whose transcript moves to a new file reads that file from the start", async () => {
    const store = seeded("moved");
    const old = await file(line("a") + line("b") + line("c"));
    expect((await ingestTranscriptEvents(store.db, "moved", old)).head).toBe(3);

    const fresh = await file(line("d") + line("e") + line("f") + line("g"));
    expect(await ingestTranscriptEvents(store.db, "moved", fresh)).toEqual({ head: 7, appended: 4 });
    store.close();
  });
});

describe("currentModelForSession — cached per file", () => {
  test("reports the newest real model, skipping <synthetic>", async () => {
    const path = await file(assistant("a", "claude-sonnet-5-5") + assistant("b", "<synthetic>") + line("c"));
    expect(await currentModelForSession(path)).toBe("claude-sonnet-5-5");
  });

  test("picks up a model appended after the last answer", async () => {
    const path = await file(assistant("a", "claude-sonnet-5-5"));
    expect(await currentModelForSession(path)).toBe("claude-sonnet-5-5");
    await appendFile(path, assistant("b", "claude-opus-5-5"));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
  });

  test("appended records without a model keep the earlier answer", async () => {
    const path = await file(assistant("a", "claude-opus-5-5"));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
    await appendFile(path, Array.from({ length: 5 }, (_, i) => line(`t${i}`, { pad: "q".repeat(6000) })).join(""));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
  });

  test("a model-free gap wider than the tail window reads as cold, as a first lookup would", async () => {
    const path = await file(assistant("a", "claude-opus-5-5"));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
    await appendFile(
      path,
      Array.from({ length: 120 }, (_, i) => line(`t${i}`, { pad: "q".repeat(6000) })).join("")
    );
    expect(await currentModelForSession(path)).toBeNull();
  });

  test("a record still being written is read once it lands", async () => {
    const path = await file(assistant("a", "claude-sonnet-5-5"));
    const next = assistant("b", "claude-opus-5-5");
    await appendFile(path, next.slice(0, 20));
    expect(await currentModelForSession(path)).toBe("claude-sonnet-5-5");
    await appendFile(path, next.slice(20));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
  });

  test("a model line longer than one backward chunk is still found", async () => {
    const path = await file(assistant("a", "claude-haiku-5-5", 200_000) + line("b"));
    expect(await currentModelForSession(path)).toBe("claude-haiku-5-5");
  });

  test("a truncated and rewritten file is rescanned", async () => {
    const path = await file(assistant("a", "claude-opus-5-5", 2000) + assistant("b", "claude-opus-5-5", 2000));
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
    await writeFile(path, assistant("c", "claude-haiku-5-5"));
    expect(await currentModelForSession(path)).toBe("claude-haiku-5-5");
  });

  test("ingest feeds the cache: the model ingest saw is reported", async () => {
    const store = seeded("fed");
    const path = await file(assistant("a", "claude-sonnet-5-5"));
    await ingestTranscriptEvents(store.db, "fed", path);
    await appendFile(path, assistant("b", "claude-opus-5-5"));
    await ingestTranscriptEvents(store.db, "fed", path);
    expect(await currentModelForSession(path)).toBe("claude-opus-5-5");
    store.close();
  });

  test("concurrent lookups of one file share a read", async () => {
    const path = await file(assistant("a", "claude-opus-5-5"));
    const models = await Promise.all(Array.from({ length: 10 }, () => currentModelForSession(path)));
    expect(new Set(models)).toEqual(new Set(["claude-opus-5-5"]));
  });

  test("a missing path is null", async () => {
    expect(await currentModelForSession(null)).toBeNull();
    expect(await currentModelForSession("/nonexistent/transcript.jsonl")).toBeNull();
  });
});
