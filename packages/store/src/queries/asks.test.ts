import { expect, test, describe } from "bun:test";
import type { Database } from "bun:sqlite";
import { createStore } from "../store.js";
import {
  upsertProject,
  createSession,
  createAsk,
  getAsk,
  dismissAllPendingAsks,
  getPendingAsksBySession,
  resolveAsk,
} from "../index.js";

/** A store seeded with the sessions asks foreign-key to. */
function seededStore(sessionIds: string[]): Database {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  for (const id of sessionIds) {
    createSession(store.db, {
      id,
      projectId: "p",
      title: "t",
      cwd: "/tmp",
      status: "running",
    });
  }
  return store.db;
}

describe("dismissAllPendingAsks", () => {
  test("scoped to ids dismisses only those, leaving others pending", () => {
    const db = seededStore(["s-alice", "s-bob"]);
    const mine1 = createAsk(db, "s-alice", "ask_human", "q1");
    const mine2 = createAsk(db, "s-alice", "ask_human", "q2");
    const theirs = createAsk(db, "s-bob", "ask_human", "q3");

    const dismissed = dismissAllPendingAsks(db, [mine1.id, mine2.id]);

    // Only the passed-in ids are cancelled — a teammate's ask is untouched, so
    // clearing your "Needs you" queue never ends someone else's wait.
    expect(new Set(dismissed)).toEqual(new Set([mine1.id, mine2.id]));
    expect(getAsk(db, mine1.id)?.status).toBe("cancelled");
    expect(getAsk(db, mine2.id)?.status).toBe("cancelled");
    expect(getAsk(db, theirs.id)?.status).toBe("pending");
  });

  test("an empty id set is a no-op — nothing is swept", () => {
    const db = seededStore(["s1"]);
    const a = createAsk(db, "s1", "ask_human", "q");

    expect(dismissAllPendingAsks(db, [])).toEqual([]);
    expect(getAsk(db, a.id)?.status).toBe("pending");
  });

  test("only still-pending ids are cancelled — an already-resolved id is skipped", () => {
    const db = seededStore(["s1"]);
    const pending = createAsk(db, "s1", "ask_human", "q1");
    const already = createAsk(db, "s1", "ask_human", "q2");
    dismissAllPendingAsks(db, [already.id]);

    const dismissed = dismissAllPendingAsks(db, [pending.id, already.id]);

    expect(dismissed).toEqual([pending.id]);
  });

  test("without ids, clears every pending ask (whole-backlog fallback)", () => {
    const db = seededStore(["s-alice", "s-bob"]);
    const a = createAsk(db, "s-alice", "ask_human", "q1");
    const b = createAsk(db, "s-bob", "ask_human", "q2");

    const dismissed = dismissAllPendingAsks(db);

    expect(new Set(dismissed)).toEqual(new Set([a.id, b.id]));
    expect(getAsk(db, a.id)?.status).toBe("cancelled");
    expect(getAsk(db, b.id)?.status).toBe("cancelled");
  });
});

describe("ask gate", () => {
  test("a gated ask persists its gate through every read path", () => {
    const db = seededStore(["s1"]);
    const gated = createAsk(db, "s1", "ask_human", "fire?", ["yes", "no"], { gate: "standup_improvement" });
    const plain = createAsk(db, "s1", "ask_human", "which?");
    expect(gated.gate).toBe("standup_improvement");
    expect(getAsk(db, gated.id)?.gate).toBe("standup_improvement");
    expect(getAsk(db, plain.id)?.gate).toBeUndefined();
    const pending = getPendingAsksBySession(db, "s1");
    expect(pending.find((a) => a.id === gated.id)?.gate).toBe("standup_improvement");
    expect(pending.find((a) => a.id === plain.id)).not.toHaveProperty("gate");
  });
});

describe("resolveAsk answeredBy", () => {
  test("records who answered, and leaves it unset when no one is named", () => {
    const db = seededStore(["s1"]);
    const named = createAsk(db, "s1", "ask_human", "q1");
    const anonymous = createAsk(db, "s1", "ask_human", "q2");

    resolveAsk(db, named.id, "yes", "alice");
    resolveAsk(db, anonymous.id, "no");

    const answered = getAsk(db, named.id);
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toBe("yes");
    expect(answered).toHaveProperty("answeredBy", "alice");
    expect(getAsk(db, anonymous.id)).not.toHaveProperty("answeredBy");
    const row = db.query("SELECT answered_by FROM asks WHERE id = ?").get(anonymous.id) as { answered_by: string | null };
    expect(row.answered_by).toBeNull();
  });
});
