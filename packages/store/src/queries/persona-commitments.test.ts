import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import {
  closePersonaCommitment,
  dropPersonaCommitmentsByKeyPrefix,
  getPersonaCommitment,
  listPersonaCommitments,
  markPersonaCommitmentsNudged,
  openPersonaCommitment,
  overduePersonaCommitmentsToNudge,
  personaOwnerRepliedAfter,
  prunePersonaCommitments,
  reassignPersonaCommitment,
  appendPersonaMessage,
  getOrCreatePersonaConsoleThread,
} from "../index.js";

const T0 = "2026-10-10T12:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

describe("persona commitments", () => {
  const base = {
    owner: "me",
    threadId: "thread-1",
    assignee: "persona" as const,
    action: "Land review /review/abc",
    doneCheck: "install main contains abc's commits",
    openedAt: T0,
  };

  test("opens one with every field and reads it back", () => {
    const { db } = createStore();
    const { commitment, created } = openPersonaCommitment(db, { ...base, jobId: "job-1", staleAfter: at(10) });
    expect(created).toBe(true);
    expect(commitment).toEqual({
      id: expect.any(String),
      owner: "me",
      threadId: "thread-1",
      jobId: "job-1",
      assignee: "persona",
      action: base.action,
      doneCheck: base.doneCheck,
      status: "open",
      source: "persona",
      openedAt: T0,
      staleAfter: at(10),
    });
    expect(getPersonaCommitment(db, commitment.id)).toEqual(commitment);
  });

  test("a commitment with the same autoKey is returned, not duplicated, open or closed", () => {
    const { db } = createStore();
    const first = openPersonaCommitment(db, { ...base, source: "auto", autoKey: "review-approved:abc:1" });
    const again = openPersonaCommitment(db, { ...base, source: "auto", autoKey: "review-approved:abc:1", action: "other words" });
    expect(again.created).toBe(false);
    expect(again.commitment.id).toBe(first.commitment.id);
    closePersonaCommitment(db, { id: first.commitment.id, owner: "me", status: "done", evidence: "install main has it" });
    const replay = openPersonaCommitment(db, { ...base, source: "auto", autoKey: "review-approved:abc:1" });
    expect(replay).toMatchObject({ created: false, commitment: { id: first.commitment.id, status: "done" } });
    // Another owner's key is theirs.
    expect(openPersonaCommitment(db, { ...base, owner: "you", source: "auto", autoKey: "review-approved:abc:1" }).created).toBe(true);
  });

  test("the owner replied after a question when they — not someone else — wrote in its thread after it", () => {
    const { db } = createStore();
    const thread = getOrCreatePersonaConsoleThread(db, "me");
    const asked = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "Merge batch e?" }).message;
    appendPersonaMessage(db, { threadId: thread.id, role: "system", text: "Review ready" });
    appendPersonaMessage(db, { threadId: thread.id, role: "user", text: "+1", actor: "teammate" });
    expect(personaOwnerRepliedAfter(db, asked.id, "me")).toBe(false);
    appendPersonaMessage(db, { threadId: thread.id, role: "user", text: "yes", actor: "me" });
    expect(personaOwnerRepliedAfter(db, asked.id, "me")).toBe(true);
    expect(personaOwnerRepliedAfter(db, "gone", "me")).toBe(true);
  });

  test("the same action for the same job and assignee is one commitment, whitespace and case aside", () => {
    const { db } = createStore();
    const first = openPersonaCommitment(db, { ...base, jobId: "job-1" });
    expect(openPersonaCommitment(db, { ...base, jobId: "job-1", action: "  land REVIEW   /review/abc " }).created).toBe(false);
    // Another job, another assignee or another owner is a different commitment.
    expect(openPersonaCommitment(db, { ...base, jobId: "job-2" }).created).toBe(true);
    expect(openPersonaCommitment(db, { ...base, jobId: "job-1", assignee: "owner" }).created).toBe(true);
    expect(openPersonaCommitment(db, { ...base, owner: "you", jobId: "job-1" }).created).toBe(true);
    expect(listPersonaCommitments(db, "me").map((c) => c.id)).toContain(first.commitment.id);
  });

  test("open ones list stalest first, never-stale last; closed ones newest closed first", () => {
    const { db } = createStore();
    const late = openPersonaCommitment(db, { ...base, action: "late", staleAfter: at(30) }).commitment;
    const never = openPersonaCommitment(db, { ...base, action: "never", assignee: "owner" }).commitment;
    const soon = openPersonaCommitment(db, { ...base, action: "soon", staleAfter: at(5) }).commitment;
    expect(listPersonaCommitments(db, "me").map((c) => c.action)).toEqual(["soon", "late", "never"]);

    closePersonaCommitment(db, { id: late.id, owner: "me", status: "done", evidence: "checked it", closedAt: at(40) });
    closePersonaCommitment(db, { id: never.id, owner: "me", status: "dropped", evidence: "called off", closedAt: at(50) });
    expect(listPersonaCommitments(db, "me").map((c) => c.id)).toEqual([soon.id]);
    expect(listPersonaCommitments(db, "me", { status: "closed" }).map((c) => [c.action, c.status, c.closedEvidence])).toEqual([
      ["never", "dropped", "called off"],
      ["late", "done", "checked it"],
    ]);
    expect(listPersonaCommitments(db, "me", { status: "all" })).toHaveLength(3);
    expect(listPersonaCommitments(db, "someone-else", { status: "all" })).toEqual([]);
  });

  test("filters by job and thread", () => {
    const { db } = createStore();
    openPersonaCommitment(db, { ...base, action: "a", jobId: "job-1" });
    openPersonaCommitment(db, { ...base, action: "b", threadId: "thread-2" });
    expect(listPersonaCommitments(db, "me", { jobId: "job-1" }).map((c) => c.action)).toEqual(["a"]);
    expect(listPersonaCommitments(db, "me", { threadId: "thread-2" }).map((c) => c.action)).toEqual(["b"]);
  });

  test("closing is the owner's, once: a closed or foreign commitment comes back null", () => {
    const { db } = createStore();
    const { commitment } = openPersonaCommitment(db, base);
    expect(closePersonaCommitment(db, { id: commitment.id, owner: "mallory", status: "done", evidence: "x" })).toBeNull();
    const closed = closePersonaCommitment(db, { id: commitment.id, owner: "me", status: "done", evidence: "list_reviews shows it", closedAt: at(3) });
    expect(closed).toMatchObject({ status: "done", closedAt: at(3), closedEvidence: "list_reviews shows it" });
    expect(closePersonaCommitment(db, { id: commitment.id, owner: "me", status: "dropped", evidence: "y" })).toBeNull();
    expect(getPersonaCommitment(db, commitment.id)!.status).toBe("done");
  });

  test("reassigning hands an open one over with a fresh stale time and clears its nudge", () => {
    const { db } = createStore();
    const { commitment } = openPersonaCommitment(db, { ...base, staleAfter: at(10) });
    markPersonaCommitmentsNudged(db, [commitment.id], at(11));
    const moved = reassignPersonaCommitment(db, { id: commitment.id, owner: "me", assignee: "owner", staleAfter: at(240) });
    expect(moved).toMatchObject({ assignee: "owner", staleAfter: at(240) });
    expect(moved!.nudgedAt).toBeUndefined();
    expect(reassignPersonaCommitment(db, { id: commitment.id, owner: "mallory", assignee: "persona" })).toBeNull();
  });

  test("dropping by key prefix spares the kept key, other prefixes and other owners", () => {
    const { db } = createStore();
    const old = openPersonaCommitment(db, { ...base, source: "auto", autoKey: "review-approved:p1:1" }).commitment;
    openPersonaCommitment(db, { ...base, source: "auto", autoKey: "review-approved:p1:2" });
    openPersonaCommitment(db, { ...base, source: "auto", autoKey: "review-approved:p10:1" });
    openPersonaCommitment(db, { ...base, owner: "you", source: "auto", autoKey: "review-approved:p1:1" });
    expect(
      dropPersonaCommitmentsByKeyPrefix(db, { owner: "me", prefix: "review-approved:p1:", keep: "review-approved:p1:2", evidence: "superseded" })
    ).toBe(1);
    expect(getPersonaCommitment(db, old.id)).toMatchObject({ status: "dropped", closedEvidence: "superseded" });
    expect(listPersonaCommitments(db, "me").map((c) => c.autoKey).sort()).toEqual(["review-approved:p10:1", "review-approved:p1:2"]);
    expect(listPersonaCommitments(db, "you")).toHaveLength(1);
  });

  test("pruning deletes only the owner's closed ones closed before the cutoff", () => {
    const { db } = createStore();
    const oldClosed = openPersonaCommitment(db, { ...base, action: "old" }).commitment;
    const newClosed = openPersonaCommitment(db, { ...base, action: "new" }).commitment;
    openPersonaCommitment(db, { ...base, action: "open" });
    closePersonaCommitment(db, { id: oldClosed.id, owner: "me", status: "done", evidence: "x", closedAt: at(0) });
    closePersonaCommitment(db, { id: newClosed.id, owner: "me", status: "done", evidence: "x", closedAt: at(100) });
    expect(prunePersonaCommitments(db, "me", at(50))).toBe(1);
    expect(listPersonaCommitments(db, "me", { status: "all" }).map((c) => c.action).sort()).toEqual(["new", "open"]);
  });

  test("overdue ones to nudge: Persona's, open, past stale, not nudged since the renudge cutoff", () => {
    const { db } = createStore();
    const due = openPersonaCommitment(db, { ...base, action: "due", staleAfter: at(10) }).commitment;
    openPersonaCommitment(db, { ...base, action: "fresh", staleAfter: at(600) });
    openPersonaCommitment(db, { ...base, action: "worker's", assignee: "worker:s1", staleAfter: at(5) });
    openPersonaCommitment(db, { ...base, action: "owner's", assignee: "owner" });
    expect(overduePersonaCommitmentsToNudge(db, "me", at(9), at(-60))).toEqual([]);
    expect(overduePersonaCommitmentsToNudge(db, "me", at(11), at(-49)).map((c) => c.id)).toEqual([due.id]);

    markPersonaCommitmentsNudged(db, [due.id], at(11));
    expect(getPersonaCommitment(db, due.id)!.nudgedAt).toBe(at(11));
    // Nudged within the window: not again until the cutoff passes the nudge.
    expect(overduePersonaCommitmentsToNudge(db, "me", at(30), at(-30))).toEqual([]);
    expect(overduePersonaCommitmentsToNudge(db, "me", at(72), at(12)).map((c) => c.id)).toEqual([due.id]);

    closePersonaCommitment(db, { id: due.id, owner: "me", status: "done", evidence: "done and checked" });
    expect(overduePersonaCommitmentsToNudge(db, "me", at(200), at(140))).toEqual([]);
  });
});
