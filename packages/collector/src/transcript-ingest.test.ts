import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, writeFile, appendFile, rm, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { createStore } from "@standup/store";
import {
  upsertProject,
  createSession,
  getEventsSince,
  appendEvent,
  appendPendingReply,
  headSeq,
} from "@standup/store";
import { ingestTranscriptEvents, eventIdForRecord } from "./transcript.js";

/**
 * Transcript ingest: the JSONL transcript is the source, transcript_events is the
 * canonical served state. Pins that ingest is idempotent (dedup by JSONL uuid),
 * stays monotonic as the file grows, no-ops on an unchanged file, and mirrors
 * uuid-less UI-state lines too — keyed by a deterministic content hash so the
 * log stays a complete mirror without duplicating on re-ingest.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function record(uuid: string | null, extra: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    type: "assistant",
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: [] },
    ...extra,
  };
  if (uuid !== null) base.uuid = uuid;
  return JSON.stringify(base);
}

/** Bytes read from the end of the file when tailing (transcript.ts TAIL_BYTES). */
const TAIL_BYTES = 512 * 1024;

/** A ~6 KB record, so a modest count of them overflows the fixed tail window. */
function big(uuid: string): string {
  return record(uuid, { pad: "x".repeat(6000) });
}

async function jsonl(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-ingest-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, lines.map((l) => l + "\n").join(""));
  return path;
}

function seeded(sessionId: string) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, { id: sessionId, projectId: "p", title: "t", cwd: "/x", status: "running" });
  return store;
}

describe("ingestTranscriptEvents", () => {
  test("appends newly-visible records as the file grows, dedup by uuid, monotonic", async () => {
    const store = seeded("s1");
    const path = await jsonl([record("u1"), record("u2"), record("u3")]);

    const first = await ingestTranscriptEvents(store.db, "s1", path);
    expect(first).toEqual({ head: 3, appended: 3 });

    // File grows: two new records, the three originals still present.
    await appendFile(path, record("u4") + "\n" + record("u5") + "\n");

    const second = await ingestTranscriptEvents(store.db, "s1", path);
    // Only the two new uuids appended; u1..u3 dedup to their existing seqs.
    expect(second).toEqual({ head: 5, appended: 2 });

    const { events } = getEventsSince(store.db, "s1", 0);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((e) => e.eventId)).toEqual(["u1", "u2", "u3", "u4", "u5"]);
    store.close();
  });

  test("an unchanged file is a no-op on re-ingest", async () => {
    const store = seeded("s2");
    const path = await jsonl([record("a"), record("b")]);

    expect((await ingestTranscriptEvents(store.db, "s2", path)).appended).toBe(2);
    // Same file, untouched — stat gate skips the re-parse.
    expect((await ingestTranscriptEvents(store.db, "s2", path)).appended).toBe(0);
    store.close();
  });

  test("uuid-less UI-state lines are mirrored under a deterministic content id", async () => {
    const store = seeded("s3");
    // A `mode` record carries no JSONL uuid but is renderable (rich-transcript
    // emits mode-change banners from it), so it must land in the durable log.
    const modeLine = record(null, { type: "mode", mode: "plan" });
    const path = await jsonl([modeLine, record("has-uuid")]);

    const result = await ingestTranscriptEvents(store.db, "s3", path);
    expect(result).toEqual({ head: 2, appended: 2 });

    const { events } = getEventsSince(store.db, "s3", 0);
    // The uuid-less line is keyed by a `synthetic:` content hash of its raw
    // line; the record with a uuid keeps it. Both are preserved, in order.
    const expectedSynthetic = `synthetic:${createHash("sha256").update(modeLine).digest("hex")}`;
    expect(events.map((e) => e.eventId)).toEqual([expectedSynthetic, "has-uuid"]);
    store.close();
  });

  test("re-ingesting the same uuid-less line from a cold offset dedups", async () => {
    const store = seeded("s3b");
    const modeLine = record(null, { type: "mode", mode: "plan" });
    const path = await jsonl([modeLine]);

    // First (cold) ingest appends the synthetic-keyed record.
    expect((await ingestTranscriptEvents(store.db, "s3b", path)).appended).toBe(1);

    // A fresh session replaying the identical line resolves to the same content
    // id — the guarantee that a cold re-read (offset reset to 0) never double-
    // appends the same UI-state line.
    createSession(store.db, { id: "s3c", projectId: "p", title: "t", cwd: "/x", status: "running" });
    const id = eventIdForRecord({ type: "mode" } as never, modeLine);
    expect(appendEvent(store.db, "s3c", { eventId: id, event: {} }).inserted).toBe(true);
    expect(appendEvent(store.db, "s3c", { eventId: id, event: {} }).inserted).toBe(false);
    store.close();
  });

  test("an optimistic pending reply reconciles in place when the real record ingests", async () => {
    const store = seeded("reply1");
    // The send path logged an optimistic pending reply before typing.
    const pending = appendPendingReply(store.db, "reply1", {
      idempotencyKey: "k1",
      text: "ship it",
      actor: "alice",
    });
    expect(pending).toEqual({ seq: 1, inserted: true });

    // The agent's JSONL now records the real user turn (its own uuid) followed
    // by the assistant's reply.
    const userRecord = JSON.stringify({
      type: "user",
      uuid: "real-user-uuid",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "ship it" },
    });
    const path = await jsonl([userRecord, record("assistant-1")]);

    const result = await ingestTranscriptEvents(store.db, "reply1", path);
    // The user record reconciled the pending event in place (no new seq); only
    // the assistant record is a fresh append.
    expect(result.head).toBe(2);

    const { events } = getEventsSince(store.db, "reply1", 0);
    // No duplicate "ship it" message: seq 1 became the real user record, seq 2
    // is the assistant turn.
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[0].eventId).toBe("real-user-uuid");
    expect((events[0].event as { pending?: boolean }).pending).toBeUndefined();
    expect(events[1].eventId).toBe("assistant-1");

    // A later turn keeps appending monotonically past the reconciled reply.
    await appendFile(path, record("assistant-2") + "\n");
    await ingestTranscriptEvents(store.db, "reply1", path);
    expect(headSeq(store.db, "reply1")).toBe(3);
    store.close();
  });

  test("a foreign session's records in the file are never stamped under this session", async () => {
    // Session isolation: a resumed/compacted transcript can hold the parent
    // conversation's turns, each keeping its ORIGINAL sessionId. Ingesting under
    // the owning session must skip those foreign records so one session's turns
    // never land in another session's durable log.
    const store = seeded("own");
    const path = await jsonl([
      record("mine-1", { sessionId: "own" }),
      record("foreign-1", { sessionId: "other" }),
      record("mine-2", { sessionId: "own" }),
      record("foreign-2", { sessionId: "other" }),
      // A uuid-less UI-state line carries no sessionId — it is un-attributable
      // and kept (dropping it would lose the mode/permission banners).
      record(null, { type: "mode", mode: "plan" }),
    ]);

    const result = await ingestTranscriptEvents(store.db, "own", path);
    expect(result.appended).toBe(3); // two own records + the un-attributable mode line

    const { events } = getEventsSince(store.db, "own", 0);
    const ids = events.map((e) => e.eventId);
    expect(ids).toContain("mine-1");
    expect(ids).toContain("mine-2");
    // The other session's records never leaked into this session's log.
    expect(ids).not.toContain("foreign-1");
    expect(ids).not.toContain("foreign-2");
    store.close();
  });

  test("skipSessionFilter mirrors a dedicated file under the session id, foreign sessionId and all", async () => {
    // A subagent child is keyed by the synthetic composite id `${parent}:${agentId}`,
    // but its dedicated transcript file's records carry the subagent's OWN real
    // session UUID — which never equals that composite id. Without the skip, the
    // session-isolation filter would reject every record (see the foreign-session
    // test above) and the durable log would stay empty. With it, the whole file
    // is mirrored under the child id.
    const childId = "parent-uuid:agent-1";
    const realUuid = "98a955d2-4c1e-4b3a-9f2d-0123456789ab";
    const store = seeded(childId);
    const path = await jsonl([
      record("a1", { sessionId: realUuid }),
      record("a2", { sessionId: realUuid }),
    ]);

    const result = await ingestTranscriptEvents(store.db, childId, path, {
      skipSessionFilter: true,
    });
    expect(result).toEqual({ head: 2, appended: 2 });

    const { events } = getEventsSince(store.db, childId, 0);
    // Both records landed, stored under the child id despite their foreign
    // (real) sessionId — no record dropped by the isolation filter.
    expect(events.map((e) => e.eventId)).toEqual(["a1", "a2"]);
    store.close();
  });

  test("a missing transcript path is a safe no-op", async () => {
    const store = seeded("s4");
    expect(await ingestTranscriptEvents(store.db, "s4", null)).toEqual({ head: 0, appended: 0 });
    expect(await ingestTranscriptEvents(store.db, "s4", "/nope/does-not-exist.jsonl")).toEqual({
      head: 0,
      appended: 0,
    });
    store.close();
  });

  test("first ingest captures the whole file even when it exceeds the tail window", async () => {
    const store = seeded("big1");
    const n = 150;
    const ids = Array.from({ length: n }, (_, i) => `u${i + 1}`);
    const path = await jsonl(ids.map(big));
    // The fixture really is larger than the fixed tail window — a tail-only read
    // would begin mid-file and drop the earlier history.
    expect((await stat(path)).size).toBeGreaterThan(TAIL_BYTES);

    const result = await ingestTranscriptEvents(store.db, "big1", path);
    expect(result).toEqual({ head: n, appended: n });

    const { events } = getEventsSince(store.db, "big1", 0, n + 10);
    expect(events).toHaveLength(n);
    // seq=1 is the true first record, not an arbitrary mid-file one.
    expect(events[0].seq).toBe(1);
    expect(events[0].eventId).toBe("u1");
    expect(events.map((e) => e.eventId)).toEqual(ids);
    store.close();
  });

  test("growth past the tail window between ingests leaves no hole", async () => {
    const store = seeded("big2");
    const path = await jsonl([record("u1"), record("u2"), record("u3")]);
    expect((await ingestTranscriptEvents(store.db, "big2", path)).head).toBe(3);

    // Append well over a tail window of new records in a single unobserved gap
    // (a collector restart / long quiet window is the realistic trigger).
    const n = 150;
    const grownIds = Array.from({ length: n }, (_, i) => `u${i + 4}`);
    const grownText = grownIds.map((id) => big(id) + "\n").join("");
    expect(Buffer.byteLength(grownText)).toBeGreaterThan(TAIL_BYTES);
    await appendFile(path, grownText);

    const result = await ingestTranscriptEvents(store.db, "big2", path);
    expect(result).toEqual({ head: 3 + n, appended: n });

    const total = 3 + n;
    const { events } = getEventsSince(store.db, "big2", 0, total + 10);
    // Contiguous seqs and eventIds — no records skipped in the oversized gap.
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1)
    );
    expect(events.map((e) => e.eventId)).toEqual(
      Array.from({ length: total }, (_, i) => `u${i + 1}`)
    );
    store.close();
  });
});
