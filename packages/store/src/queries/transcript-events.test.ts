import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  upsertProject,
  createSession,
  appendEvent,
  appendPendingReply,
  releasePendingReply,
  reconcilePendingReply,
  getEventsSince,
  getEventsBefore,
  headSeq,
  deleteSession,
  getSession,
} from "../index.js";

/**
 * The transcript events substrate. Pins the three properties the design leans on:
 * seq is monotonic and independent per session, an append is idempotent on both
 * identity keys (uuid and idempotency_key), and cursor paging walks the log
 * exactly once.
 */

function seededStore() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function session(store: ReturnType<typeof seededStore>, id: string) {
  createSession(store.db, {
    id,
    projectId: "p",
    title: "t",
    cwd: "/x",
    status: "running",
  });
}

describe("transcript-events store", () => {
  test("seq is monotonic per session and independent across sessions", () => {
    const store = seededStore();
    session(store, "s1");
    session(store, "s2");

    expect(appendEvent(store.db, "s1", { eventId: "a", event: {} }).seq).toBe(1);
    expect(appendEvent(store.db, "s1", { eventId: "b", event: {} }).seq).toBe(2);
    // A second session's log starts its own count at 1 — not global.
    expect(appendEvent(store.db, "s2", { eventId: "a", event: {} }).seq).toBe(1);
    expect(appendEvent(store.db, "s1", { eventId: "c", event: {} }).seq).toBe(3);

    expect(headSeq(store.db, "s1")).toBe(3);
    expect(headSeq(store.db, "s2")).toBe(1);
    store.close();
  });

  test("head is 0 for a session with no events", () => {
    const store = seededStore();
    session(store, "s1");
    expect(headSeq(store.db, "s1")).toBe(0);
    store.close();
  });

  test("re-appending the same eventId dedups to the existing seq", () => {
    const store = seededStore();
    session(store, "s1");

    const first = appendEvent(store.db, "s1", { eventId: "u1", event: { n: 1 } });
    expect(first).toEqual({ seq: 1, inserted: true });

    appendEvent(store.db, "s1", { eventId: "u2", event: { n: 2 } });

    // Same uuid again → same seq, no new row, no clobber of the stored event.
    const again = appendEvent(store.db, "s1", { eventId: "u1", event: { n: 999 } });
    expect(again).toEqual({ seq: 1, inserted: false });
    expect(headSeq(store.db, "s1")).toBe(2);
    expect(getEventsSince(store.db, "s1", 0).events[0].event).toEqual({ n: 1 });
    store.close();
  });

  test("a repeat idempotency_key dedups even under a new eventId", () => {
    const store = seededStore();
    session(store, "s1");

    const first = appendEvent(store.db, "s1", {
      eventId: "e1",
      event: {},
      idempotencyKey: "k",
    });
    expect(first).toEqual({ seq: 1, inserted: true });

    const dup = appendEvent(store.db, "s1", {
      eventId: "e2",
      event: {},
      idempotencyKey: "k",
    });
    expect(dup).toEqual({ seq: 1, inserted: false });
    expect(headSeq(store.db, "s1")).toBe(1);
    store.close();
  });

  test("null idempotency_key never dedups across records", () => {
    const store = seededStore();
    session(store, "s1");
    appendEvent(store.db, "s1", { eventId: "e1", event: {} });
    appendEvent(store.db, "s1", { eventId: "e2", event: {} });
    expect(headSeq(store.db, "s1")).toBe(2);
    store.close();
  });

  test("cursor paging walks the log once and then idles at the head", () => {
    const store = seededStore();
    session(store, "s1");
    for (let i = 1; i <= 5; i++) {
      appendEvent(store.db, "s1", { eventId: `u${i}`, event: { i } });
    }

    const p1 = getEventsSince(store.db, "s1", 0, 2);
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.cursor).toBe(2);
    expect(p1.events[0].eventId).toBe("u1");

    const p2 = getEventsSince(store.db, "s1", p1.cursor, 2);
    expect(p2.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(p2.cursor).toBe(4);

    const p3 = getEventsSince(store.db, "s1", p2.cursor, 2);
    expect(p3.events.map((e) => e.seq)).toEqual([5]);
    expect(p3.cursor).toBe(5);

    // At the head: empty page, cursor unchanged so the caller can keep polling.
    const p4 = getEventsSince(store.db, "s1", p3.cursor, 2);
    expect(p4.events).toEqual([]);
    expect(p4.cursor).toBe(5);
    store.close();
  });

  test("getEventsBefore(before=0) returns the tail oldest-first with head/first/hasEarlier", () => {
    const store = seededStore();
    session(store, "s1");
    for (let i = 1; i <= 5; i++) {
      appendEvent(store.db, "s1", { eventId: `u${i}`, event: { i } });
    }

    // The newest 2 events, but returned in log order so a caller can concat them.
    const tail = getEventsBefore(store.db, "s1", 0, 2);
    expect(tail.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(tail.firstSeq).toBe(4);
    expect(tail.headSeq).toBe(5);
    expect(tail.cursor).toBe(5);
    expect(tail.hasEarlier).toBe(true);
    store.close();
  });

  test("getEventsBefore pages backward into history and reports when it's exhausted", () => {
    const store = seededStore();
    session(store, "s1");
    for (let i = 1; i <= 5; i++) {
      appendEvent(store.db, "s1", { eventId: `u${i}`, event: { i } });
    }

    const tail = getEventsBefore(store.db, "s1", 0, 2); // [4,5]
    const older = getEventsBefore(store.db, "s1", tail.firstSeq, 2);
    expect(older.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(older.firstSeq).toBe(2);
    expect(older.hasEarlier).toBe(true);

    const oldest = getEventsBefore(store.db, "s1", older.firstSeq, 2);
    expect(oldest.events.map((e) => e.seq)).toEqual([1]);
    expect(oldest.firstSeq).toBe(1);
    // Nothing precedes seq 1 — the reader has reached the start of the log.
    expect(oldest.hasEarlier).toBe(false);
    store.close();
  });

  test("getEventsBefore on an empty session yields no events and no earlier history", () => {
    const store = seededStore();
    session(store, "s1");
    const tail = getEventsBefore(store.db, "s1", 0, 10);
    expect(tail.events).toEqual([]);
    expect(tail.hasEarlier).toBe(false);
    expect(tail.headSeq).toBe(0);
    store.close();
  });

  test("the same idempotency key sent twice claims once — a retry types nothing", () => {
    const store = seededStore();
    session(store, "s1");

    // Model the send handler: it types into the pane only when the claim is a
    // fresh insert. A double-clicked/retried send with the same key must claim
    // nothing new, so the pane is typed into exactly once.
    let typed = 0;
    const send = (key: string) => {
      const claim = appendPendingReply(store.db, "s1", {
        idempotencyKey: key,
        text: "ship it",
        actor: "alice",
      });
      if (claim.inserted) typed++;
      return claim;
    };

    const first = send("k1");
    const retry = send("k1");
    expect(first.inserted).toBe(true);
    expect(retry).toEqual({ seq: first.seq, inserted: false });
    expect(typed).toBe(1);
    // Only one optimistic event exists, shaped like a user message.
    const { events } = getEventsSince(store.db, "s1", 0);
    expect(events).toHaveLength(1);
    expect((events[0].event as { type: string }).type).toBe("user");
    store.close();
  });

  test("a pending reply reconciles to the real record in place, keeping its seq", () => {
    const store = seededStore();
    session(store, "s1");

    const pending = appendPendingReply(store.db, "s1", {
      idempotencyKey: "k1",
      text: "ship it",
      actor: "alice",
    });
    expect(pending).toEqual({ seq: 1, inserted: true });

    const realRecord = {
      type: "user",
      uuid: "real-uuid",
      message: { role: "user", content: "ship it" },
    };
    const reconciled = reconcilePendingReply(store.db, "s1", {
      text: "ship it",
      eventId: "real-uuid",
      event: realRecord,
    });
    expect(reconciled).toBe(true);

    // Same seq, no duplicate row: the pending event was rewritten in place to
    // the real record, and the pending marker is gone.
    expect(headSeq(store.db, "s1")).toBe(1);
    const { events } = getEventsSince(store.db, "s1", 0);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
    expect(events[0].eventId).toBe("real-uuid");
    // The durable record is the real turn plus the reply's carried attribution.
    expect(events[0].event).toEqual({ ...realRecord, sentBy: "alice" });

    // Re-ingesting the real record dedups on its uuid — no second copy.
    expect(
      appendEvent(store.db, "s1", { eventId: "real-uuid", event: realRecord }).inserted
    ).toBe(false);
    // A retried send with the original key still resolves to the same seq.
    expect(
      appendPendingReply(store.db, "s1", {
        idempotencyKey: "k1",
        text: "ship it",
        actor: "alice",
      })
    ).toEqual({ seq: 1, inserted: false });
    store.close();
  });

  test("reconcile skips a record already in the log rather than throwing (cold re-read)", () => {
    const store = seededStore();
    session(store, "s1");

    // A historical user turn with the same text as a later reply is already
    // logged under its own uuid (no idempotency key).
    appendEvent(store.db, "s1", {
      eventId: "hist-uuid",
      event: { type: "user", uuid: "hist-uuid", message: { role: "user", content: "continue" } },
    });
    // A still-pending optimistic reply of the same text.
    appendPendingReply(store.db, "s1", { idempotencyKey: "k1", text: "continue", actor: "alice" });

    // Ingest re-reads from offset 0 and re-encounters the historical record.
    // Repointing the pending row onto "hist-uuid" would violate the identity PK;
    // reconcile must skip it (returning false) instead of throwing.
    expect(() =>
      reconcilePendingReply(store.db, "s1", {
        text: "continue",
        eventId: "hist-uuid",
        event: { type: "user", uuid: "hist-uuid", message: { role: "user", content: "continue" } },
      })
    ).not.toThrow();
    expect(
      reconcilePendingReply(store.db, "s1", {
        text: "continue",
        eventId: "hist-uuid",
        event: { type: "user", message: { role: "user", content: "continue" } },
      })
    ).toBe(false);

    // The pending reply is still pending — its real record hasn't ingested yet.
    const { events } = getEventsSince(store.db, "s1", 0);
    expect(events).toHaveLength(2);
    const pendingEvent = events.find(
      (e) => (e.event as { pending?: boolean }).pending === true
    );
    expect(pendingEvent).toBeDefined();

    // When the reply's own real record ingests (a fresh uuid), it reconciles.
    expect(
      reconcilePendingReply(store.db, "s1", {
        text: "continue",
        eventId: "reply-uuid",
        event: { type: "user", uuid: "reply-uuid", message: { role: "user", content: "continue" } },
      })
    ).toBe(true);
    expect(headSeq(store.db, "s1")).toBe(2);
    store.close();
  });

  test("reconcile matches the newest pending of duplicate text, not a stale one", () => {
    const store = seededStore();
    session(store, "s1");

    // A stale pending (e.g. a reply consumed by a dialog that never produced its
    // own user record) at an older seq, then a fresh reply of the same text.
    appendPendingReply(store.db, "s1", { idempotencyKey: "stale", text: "ship it", actor: "alice" });
    appendEvent(store.db, "s1", { eventId: "mid", event: { type: "assistant", uuid: "mid" } });
    const fresh = appendPendingReply(store.db, "s1", {
      idempotencyKey: "fresh",
      text: "ship it",
      actor: "bob",
    });

    // The real record for the fresh send reconciles the newest pending, keeping
    // the message at its correct (later) seq and leaving the stale one alone.
    expect(
      reconcilePendingReply(store.db, "s1", {
        text: "ship it",
        eventId: "fresh-uuid",
        event: { type: "user", uuid: "fresh-uuid", message: { role: "user", content: "ship it" } },
      })
    ).toBe(true);

    const { events } = getEventsSince(store.db, "s1", 0);
    const reconciled = events.find((e) => e.eventId === "fresh-uuid");
    expect(reconciled?.seq).toBe(fresh.seq);
    expect((reconciled?.event as { sentBy?: string }).sentBy).toBe("bob");
    // The stale pending is untouched at its original seq.
    const stalePending = events.find(
      (e) => (e.event as { pending?: boolean }).pending === true
    );
    expect(stalePending?.seq).toBe(1);
    store.close();
  });

  test("reconcile is a no-op when no pending reply matches the text", () => {
    const store = seededStore();
    session(store, "s1");
    appendPendingReply(store.db, "s1", {
      idempotencyKey: "k1",
      text: "ship it",
      actor: "alice",
    });
    expect(
      reconcilePendingReply(store.db, "s1", {
        text: "different text",
        eventId: "real-uuid",
        event: { type: "user" },
      })
    ).toBe(false);
    store.close();
  });

  test("releasePendingReply frees the key so a genuine retry re-sends", () => {
    const store = seededStore();
    session(store, "s1");

    const first = appendPendingReply(store.db, "s1", {
      idempotencyKey: "k1",
      text: "ship it",
    });
    expect(first.inserted).toBe(true);

    // The send that claimed the key failed to type — release it.
    releasePendingReply(store.db, "s1", "k1");
    expect(headSeq(store.db, "s1")).toBe(0);

    // The retry with the same key now claims fresh (and would type).
    const retry = appendPendingReply(store.db, "s1", {
      idempotencyKey: "k1",
      text: "ship it",
    });
    expect(retry.inserted).toBe(true);
    store.close();
  });

  test("deleting a session with logged transcript events succeeds (no FK violation)", () => {
    // foreign_keys is ON (createStore), and these tables reference sessions(id)
    // with no ON DELETE CASCADE, so deleteSession must clear them explicitly or
    // the parent delete rolls back with FOREIGN KEY constraint failed.
    const store = seededStore();
    session(store, "s1");
    appendEvent(store.db, "s1", { eventId: "u1", event: {}, idempotencyKey: "k" });
    appendEvent(store.db, "s1", { eventId: "u2", event: {} });

    expect(() => deleteSession(store.db, "s1")).not.toThrow();
    expect(getSession(store.db, "s1")).toBeNull();
    expect(headSeq(store.db, "s1")).toBe(0);
    store.close();
  });
});
