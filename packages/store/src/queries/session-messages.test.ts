import { expect, test, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import {
  upsertProject,
  createSession,
  createSessionMessage,
  getPendingMessages,
  claimPendingMessages,
  cancelSessionMessage,
  cancelPendingMessagesFor,
  deleteSession,
  postSharedNote,
  getSharedNotes,
  setSharedNoteDone,
} from "../index.js";

/** A store seeded with the sessions the mailbox foreign-keys to. */
function seededStore(sessionIds: string[]): Database {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  for (const id of sessionIds) {
    createSession(store.db, {
      id,
      projectId: "p",
      title: id,
      cwd: "/tmp",
      status: "running",
    });
  }
  return store.db;
}

describe("session_messages — the per-session mailbox", () => {
  test("a message from A lands pending in B's mailbox, attributed to A", () => {
    const db = seededStore(["a", "b"]);

    createSessionMessage(db, {
      toSessionId: "b",
      fromSessionId: "a",
      fromLabel: "Session A",
      body: "please rebase onto main",
    });

    const pending = getPendingMessages(db, "b");
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe("please rebase onto main");
    expect(pending[0].fromSessionId).toBe("a");
    expect(pending[0].fromLabel).toBe("Session A");
    expect(pending[0].status).toBe("pending");
    // A's own mailbox is untouched — the message is one-directional.
    expect(getPendingMessages(db, "a")).toHaveLength(0);
  });

  test("claimPendingMessages drains atomically and marks delivered — a second claim is empty", () => {
    const db = seededStore(["a", "b"]);
    createSessionMessage(db, { toSessionId: "b", fromSessionId: "a", body: "one" });
    createSessionMessage(db, { toSessionId: "b", fromSessionId: "a", body: "two" });

    const first = claimPendingMessages(db, "b");
    expect(first.map((m) => m.body)).toEqual(["one", "two"]);
    expect(first.every((m) => m.status === "delivered")).toBe(true);

    // Drained — the delivery seam handing the same message twice is exactly what
    // the single-statement RETURNING claim prevents.
    expect(claimPendingMessages(db, "b")).toHaveLength(0);
    expect(getPendingMessages(db, "b")).toHaveLength(0);
  });

  test("a cancelled message is never delivered", () => {
    const db = seededStore(["a", "b"]);
    const m = createSessionMessage(db, { toSessionId: "b", fromSessionId: "a", body: "nvm" });

    cancelSessionMessage(db, m.id);

    expect(getPendingMessages(db, "b")).toHaveLength(0);
    expect(claimPendingMessages(db, "b")).toHaveLength(0);
  });

  test("cancelPendingMessagesFor drains a going-away session's pending mailbox", () => {
    const db = seededStore(["a", "b"]);
    createSessionMessage(db, { toSessionId: "b", fromSessionId: "a", body: "one" });
    createSessionMessage(db, { toSessionId: "b", fromSessionId: "a", body: "two" });

    const cancelled = cancelPendingMessagesFor(db, "b");
    expect(cancelled).toHaveLength(2);
    expect(cancelled.every((m) => m.status === "cancelled")).toBe(true);

    // Nothing pending remains, and a later delivery seam claims nothing.
    expect(getPendingMessages(db, "b")).toHaveLength(0);
    expect(claimPendingMessages(db, "b")).toHaveLength(0);
  });

  test("deleteSession purges a recipient's mailbox instead of tripping the sessions FK", () => {
    const db = seededStore(["a", "b"]);
    // A delivered message keyed on to_session_id — the FK that the delete of B
    // must clear first, and the row the old delete path forgot.
    createSessionMessage(db, { toSessionId: "b", fromSessionId: "a", body: "handled" });
    claimPendingMessages(db, "b");

    // Deleting B must not throw a FOREIGN KEY constraint failure.
    const counts = deleteSession(db, "b");
    expect(counts.messages).toBe(1);

    // B and its mailbox rows are gone; A survives and keeps its own row.
    expect(
      (db.query("SELECT COUNT(*) AS n FROM session_messages WHERE to_session_id = 'b'").get() as { n: number }).n
    ).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = 'b'").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE id = 'a'").get() as { n: number }).n).toBe(1);
  });
});

describe("shared_notes — the lightweight shared task-list", () => {
  test("posts are listed newest-first, and a project scope also sees global notes", () => {
    const db = seededStore(["a"]);
    upsertProject(db, { id: "other", name: "other", branch: "main", repos: [] });

    postSharedNote(db, { projectId: "p", fromSessionId: "a", body: "claiming the parser" });
    postSharedNote(db, { body: "global heads-up" });
    postSharedNote(db, { projectId: "other", body: "unrelated project note" });

    const board = getSharedNotes(db, { projectId: "p" });
    const bodies = board.map((n) => n.body);
    // The project's own note plus the global one; the other project's note is
    // excluded. Newest-first ordering puts the global note ahead of the earlier
    // project note.
    expect(bodies).toEqual(["global heads-up", "claiming the parser"]);
  });

  test("done can be flipped and open-only hides finished notes", () => {
    const db = seededStore(["a"]);
    const note = postSharedNote(db, { projectId: "p", body: "ship it" });

    const updated = setSharedNoteDone(db, note.id, true);
    expect(updated?.done).toBe(true);

    expect(getSharedNotes(db, { projectId: "p", openOnly: true })).toHaveLength(0);
    expect(getSharedNotes(db, { projectId: "p" })).toHaveLength(1);
  });
});
