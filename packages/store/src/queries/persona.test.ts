import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  upsertProject,
  createLaunch,
  createSession,
  attachSessionToLaunch,
  endSession,
  getOrCreatePersonaConsoleThread,
  getPersonaThread,
  appendPersonaMessage,
  listPersonaMessages,
  enqueuePersonaInbox,
  claimDuePersonaInbox,
  markPersonaInboxDone,
  failPersonaInbox,
  resetProcessingPersonaInbox,
  cancelPersonaInbox,
  countPendingPersonaInbox,
  getPersonaInboxItem,
  listPendingPersonaInbox,
  nextPersonaInboxDue,
  getOrCreatePersonaState,
  updatePersonaState,
  createPersonaJob,
  getPersonaJob,
  updatePersonaJob,
  listPersonaJobs,
  linkPersonaJobLaunch,
  personaJobForSession,
  personaJobForLaunch,
  countPersonaLaunchesToday,
  countActivePersonaLaunches,
  createPersonaApproval,
  getPersonaApproval,
  listPersonaApprovals,
  transitionPersonaApproval,
  expirePersonaApprovals,
  failInterruptedPersonaApprovals,
  prunePersonaInbox,
  countStartingPersonaJobLaunches,
  setPersonaJobNote,
  getOrCreatePersonaThreadByRef,
  listPersonaThreads,
  claimDuePersonaInboxForThread,
  getPersonaThreadSessionId,
  setPersonaThreadSessionId,
  clearPersonaThreadSessions,
  mergePersonaAudience,
  listPersonaApprovalsForDecider,
  listPendingPersonaApprovalsAwaiting,
  listPersonaOwners,
  getPersonaMessage,
  addPersonaMessageJobTags,
  removePersonaMessageJobTag,
} from "../index.js";

/** The approver a stored approval carries, if any. */
function approverOf(approval: object | null | undefined): string | undefined {
  return (approval as { approver?: string } | null | undefined)?.approver;
}

function seed() {
  const store = createStore();
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function seedLaunch(store: ReturnType<typeof seed>, id: string, sessionId?: string) {
  createLaunch(store.db, { id, projectId: "p", task: "t", worktreePath: `/wt/${id}`, branch: "b" });
  if (sessionId) {
    createSession(store.db, { id: sessionId, projectId: "p", title: "s", cwd: `/wt/${id}`, status: "running" });
    attachSessionToLaunch(store.db, id, sessionId);
  }
}

describe("persona threads + messages", () => {
  test("the console thread is created once per owner", () => {
    const store = seed();
    const a = getOrCreatePersonaConsoleThread(store.db, "alice");
    const b = getOrCreatePersonaConsoleThread(store.db, "alice");
    const c = getOrCreatePersonaConsoleThread(store.db, "bob");
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(a.channel).toBe("console");
    expect(getPersonaThread(store.db, a.id)?.owner).toBe("alice");
  });

  test("append assigns consecutive seqs and round-trips options/jobIds/approvalId", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const m1 = appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: "hi", actor: "alice" });
    const m2 = appendPersonaMessage(store.db, {
      threadId: t.id,
      role: "persona",
      text: "which?",
      options: ["A", "B"],
      jobIds: ["j1"],
    });
    const m3 = appendPersonaMessage(store.db, { threadId: t.id, role: "system", text: "held", approvalId: "ap1" });
    expect([m1.message.seq, m2.message.seq, m3.message.seq]).toEqual([1, 2, 3]);
    expect(m1.message.actor).toBe("alice");
    expect(m2.message.options).toEqual(["A", "B"]);
    expect(m2.message.jobIds).toEqual(["j1"]);
    expect(m3.message.approvalId).toBe("ap1");
    expect(m1.message.options).toBeUndefined();
  });

  test("a repeated idempotency key returns the original row", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const first = appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: "x", idempotencyKey: "k" });
    const again = appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: "x", idempotencyKey: "k" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    expect(listPersonaMessages(store.db, t.id)).toHaveLength(1);
  });

  test("list returns the latest N ascending, or the N after a seq", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    for (let i = 1; i <= 5; i++) appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: `m${i}` });
    expect(listPersonaMessages(store.db, t.id, { limit: 2 }).map((m) => m.text)).toEqual(["m4", "m5"]);
    expect(listPersonaMessages(store.db, t.id, { afterSeq: 2, limit: 2 }).map((m) => m.seq)).toEqual([3, 4]);
    expect(listPersonaMessages(store.db, t.id, { afterSeq: 5 })).toEqual([]);
  });

  test("beforeSeq returns the latest N below it, ascending", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    for (let i = 1; i <= 6; i++) appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: `m${i}` });
    expect(listPersonaMessages(store.db, t.id, { beforeSeq: 5, limit: 2 }).map((m) => m.seq)).toEqual([3, 4]);
    expect(listPersonaMessages(store.db, t.id, { beforeSeq: 3, limit: 2 }).map((m) => m.seq)).toEqual([1, 2]);
    expect(listPersonaMessages(store.db, t.id, { beforeSeq: 2, limit: 5 }).map((m) => m.seq)).toEqual([1]);
    expect(listPersonaMessages(store.db, t.id, { beforeSeq: 1 })).toEqual([]);
    expect(listPersonaMessages(store.db, t.id, { beforeSeq: 100 }).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // With afterSeq too: the first N strictly between the two.
    expect(listPersonaMessages(store.db, t.id, { afterSeq: 1, beforeSeq: 6, limit: 2 }).map((m) => m.seq)).toEqual([2, 3]);
    expect(listPersonaMessages(store.db, t.id, { afterSeq: 1, beforeSeq: 4 }).map((m) => m.seq)).toEqual([2, 3]);
    expect(listPersonaMessages(store.db, t.id, { afterSeq: 3, beforeSeq: 4 })).toEqual([]);
  });
});

describe("persona message job tags", () => {
  const legacyJobIds = (store: ReturnType<typeof seed>, id: string) =>
    (store.db.query("SELECT job_ids_json FROM persona_messages WHERE id = ?").get(id) as { job_ids_json: string | null })
      .job_ids_json;
  /** Inserts jobs with fixed ids, owned by `owner` in `threadId`. */
  const seedJobs = (store: ReturnType<typeof seed>, owner: string, threadId: string, ids: string[]) => {
    for (const id of ids) {
      store.db.run(
        `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'g', '2026-10-06', '2026-10-06')`,
        [id, owner, threadId, id]
      );
    }
  };

  test("append records the message's jobs as explicit tags owned by the thread's owner", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const { message } = appendPersonaMessage(store.db, {
      threadId: t.id,
      role: "persona",
      text: "started",
      jobIds: ["j1", "j2", "j1"],
    });
    expect(message.jobIds).toEqual(["j1", "j2"]);
    expect(message.jobTags).toEqual([
      { jobId: "j1", source: "explicit" },
      { jobId: "j2", source: "explicit" },
    ]);
    expect(
      store.db.query("SELECT DISTINCT owner FROM persona_message_jobs WHERE message_id = ?").all(message.id)
    ).toEqual([{ owner: "alice" }]);
    expect(legacyJobIds(store, message.id)).toBe('["j1","j2","j1"]');

    const plain = appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: "hi" }).message;
    expect(plain.jobIds).toBeUndefined();
    expect(plain.jobTags).toBeUndefined();
  });

  test("add tags new jobs, upgrades a weaker source, and never downgrades", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    seedJobs(store, "alice", t.id, ["j1", "j2", "j3"]);
    const m = appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "x", jobIds: ["j1"] }).message;

    const added = addPersonaMessageJobTags(store.db, {
      messageId: m.id,
      owner: "alice",
      tags: [
        { jobId: "j2", source: "inferred" },
        { jobId: "j3", source: "declared" },
        { jobId: "j1", source: "inferred" },
        { jobId: "", source: "explicit" },
      ],
    });
    expect(added?.jobTags).toEqual([
      { jobId: "j1", source: "explicit" },
      { jobId: "j2", source: "inferred" },
      { jobId: "j3", source: "declared" },
    ]);
    expect(added?.jobIds).toEqual(["j1", "j2", "j3"]);

    const upgraded = addPersonaMessageJobTags(store.db, {
      messageId: m.id,
      owner: "alice",
      tags: [
        { jobId: "j2", source: "declared" },
        { jobId: "j3", source: "inferred" },
      ],
    });
    expect(upgraded?.jobTags).toEqual([
      { jobId: "j1", source: "explicit" },
      { jobId: "j2", source: "declared" },
      { jobId: "j3", source: "declared" },
    ]);
    const explicit = addPersonaMessageJobTags(store.db, {
      messageId: m.id,
      owner: "alice",
      tags: [{ jobId: "j2", source: "explicit" }],
    });
    expect(explicit?.jobTags?.find((tag) => tag.jobId === "j2")?.source).toBe("explicit");
  });

  test("add is owner-scoped: another owner or an unknown message gets undefined and changes nothing", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    seedJobs(store, "alice", t.id, ["j1"]);
    const m = appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "x" }).message;
    expect(
      addPersonaMessageJobTags(store.db, { messageId: m.id, owner: "bob", tags: [{ jobId: "j1", source: "explicit" }] })
    ).toBeUndefined();
    expect(
      addPersonaMessageJobTags(store.db, { messageId: "nope", owner: "alice", tags: [{ jobId: "j1", source: "explicit" }] })
    ).toBeUndefined();
    expect(getPersonaMessage(store.db, m.id)?.jobTags).toBeUndefined();
  });

  test("add skips a job that is unknown or another owner's", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const bobs = getOrCreatePersonaConsoleThread(store.db, "bob");
    seedJobs(store, "alice", t.id, ["mine"]);
    seedJobs(store, "bob", bobs.id, ["theirs"]);
    const m = appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "x" }).message;
    const tagged = addPersonaMessageJobTags(store.db, {
      messageId: m.id,
      owner: "alice",
      tags: [
        { jobId: "theirs", source: "declared" },
        { jobId: "ghost", source: "inferred" },
        { jobId: "mine", source: "inferred" },
      ],
    });
    expect(tagged?.jobTags).toEqual([{ jobId: "mine", source: "inferred" }]);
  });

  test("remove drops the tag and the id from job_ids_json; owner-scoped", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    seedJobs(store, "alice", t.id, ["j3"]);
    const m = appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "x", jobIds: ["j1", "j2"] }).message;
    addPersonaMessageJobTags(store.db, { messageId: m.id, owner: "alice", tags: [{ jobId: "j3", source: "inferred" }] });

    expect(removePersonaMessageJobTag(store.db, { messageId: m.id, jobId: "j1", owner: "bob" })).toBeUndefined();
    expect(removePersonaMessageJobTag(store.db, { messageId: "nope", jobId: "j1", owner: "alice" })).toBeUndefined();
    expect(getPersonaMessage(store.db, m.id)?.jobIds).toEqual(["j1", "j2", "j3"]);

    const removed = removePersonaMessageJobTag(store.db, { messageId: m.id, jobId: "j1", owner: "alice" });
    expect(removed?.jobIds).toEqual(["j2", "j3"]);
    expect(legacyJobIds(store, m.id)).toBe('["j2"]');

    const inferredGone = removePersonaMessageJobTag(store.db, { messageId: m.id, jobId: "j3", owner: "alice" });
    expect(inferredGone?.jobTags).toEqual([{ jobId: "j2", source: "explicit" }]);
    expect(legacyJobIds(store, m.id)).toBe('["j2"]');

    const last = removePersonaMessageJobTag(store.db, { messageId: m.id, jobId: "j2", owner: "alice" });
    expect(last?.jobIds).toBeUndefined();
    expect(last?.jobTags).toBeUndefined();
    expect(legacyJobIds(store, m.id)).toBeNull();
  });

  test("list filters by any of the given job ids, keeps afterSeq/limit, and hydrates tags", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const other = getOrCreatePersonaConsoleThread(store.db, "bob");
    seedJobs(store, "alice", t.id, ["j1"]);
    appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: "m1", jobIds: ["j1"] });
    appendPersonaMessage(store.db, { threadId: t.id, role: "user", text: "m2" });
    const m3 = appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "m3", jobIds: ["j2"] }).message;
    appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "m4", jobIds: ["j3"] });
    const m5 = appendPersonaMessage(store.db, { threadId: t.id, role: "persona", text: "m5" }).message;
    addPersonaMessageJobTags(store.db, { messageId: m5.id, owner: "alice", tags: [{ jobId: "j1", source: "inferred" }] });
    appendPersonaMessage(store.db, { threadId: other.id, role: "user", text: "elsewhere", jobIds: ["j1"] });

    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j1"] }).map((m) => m.text)).toEqual(["m1", "m5"]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j1", "j2"] }).map((m) => m.text)).toEqual(["m1", "m3", "m5"]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j1", "j2"], limit: 2 }).map((m) => m.text)).toEqual([
      "m3",
      "m5",
    ]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j1", "j2"], afterSeq: 1, limit: 1 }).map((m) => m.text)).toEqual([
      "m3",
    ]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j1", "j2"], beforeSeq: 5, limit: 1 }).map((m) => m.text)).toEqual([
      "m3",
    ]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j1", "j2"], beforeSeq: 5 }).map((m) => m.text)).toEqual([
      "m1",
      "m3",
    ]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: [] })).toEqual([]);
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["nope"] })).toEqual([]);

    removePersonaMessageJobTag(store.db, { messageId: m3.id, jobId: "j2", owner: "alice" });
    expect(listPersonaMessages(store.db, t.id, { jobIds: ["j2"] })).toEqual([]);

    const all = listPersonaMessages(store.db, t.id);
    expect(all.map((m) => m.jobTags ?? [])).toEqual([
      [{ jobId: "j1", source: "explicit" }],
      [],
      [],
      [{ jobId: "j3", source: "explicit" }],
      [{ jobId: "j1", source: "inferred" }],
    ]);
    expect(all.map((m) => m.jobIds)).toEqual([["j1"], undefined, undefined, ["j3"], ["j1"]]);
  });
});

describe("persona inbox", () => {
  test("claim takes only due pending items and moves them to processing", () => {
    const store = seed();
    const now = new Date("2026-10-04T12:00:00.000Z");
    const due = enqueuePersonaInbox(store.db, { owner: "alice", kind: "user_message", payload: { text: "a" } }).item;
    const past = enqueuePersonaInbox(store.db, {
      owner: "alice",
      kind: "schedule",
      payload: {},
      notBefore: "2026-10-04T11:59:00.000Z",
    }).item;
    enqueuePersonaInbox(store.db, { owner: "alice", kind: "schedule", payload: {}, notBefore: "2026-10-04T13:00:00.000Z" });
    enqueuePersonaInbox(store.db, { owner: "bob", kind: "user_message", payload: {} });
    const claimed = claimDuePersonaInbox(store.db, "alice", now.toISOString());
    expect(claimed.map((i) => i.id).sort()).toEqual([due.id, past.id].sort());
    expect(claimed.every((i) => i.status === "processing")).toBe(true);
    expect(claimDuePersonaInbox(store.db, "alice", now.toISOString())).toEqual([]);
    expect(nextPersonaInboxDue(store.db, "alice")).toBe("2026-10-04T13:00:00.000Z");
    expect(countPendingPersonaInbox(store.db, "alice")).toBe(3);
    markPersonaInboxDone(store.db, claimed.map((i) => i.id));
    expect(getPersonaInboxItem(store.db, due.id)?.status).toBe("done");
    expect(countPendingPersonaInbox(store.db, "alice")).toBe(1);
  });

  test("a pending item with the same coalesce key is updated in place", () => {
    const store = seed();
    const a = enqueuePersonaInbox(store.db, {
      owner: "alice",
      kind: "worker_event",
      payload: { status: "idle" },
      coalesceKey: "session:s1",
      notBefore: "2026-10-04T12:00:20.000Z",
    });
    const b = enqueuePersonaInbox(store.db, {
      owner: "alice",
      kind: "worker_event",
      payload: { status: "waiting" },
      coalesceKey: "session:s1",
      notBefore: "2026-10-04T12:00:40.000Z",
    });
    expect(b.coalesced).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.payload).toEqual({ status: "waiting" });
    expect(b.item.notBefore).toBe("2026-10-04T12:00:20.000Z");
    expect(listPendingPersonaInbox(store.db, "alice")).toHaveLength(1);
    // Once claimed, the key opens a fresh item rather than mutating the in-flight one.
    claimDuePersonaInbox(store.db, "alice", "2026-10-04T12:01:00.000Z");
    const c = enqueuePersonaInbox(store.db, { owner: "alice", kind: "worker_event", payload: {}, coalesceKey: "session:s1" });
    expect(c.coalesced).toBe(false);
  });

  test("failure backs off exponentially then gives up at max attempts", () => {
    const store = seed();
    const { item } = enqueuePersonaInbox(store.db, { owner: "alice", kind: "user_message", payload: {} });
    const t0 = Date.parse("2026-10-04T12:00:00.000Z");
    claimDuePersonaInbox(store.db, "alice", new Date(t0).toISOString());
    let r = failPersonaInbox(store.db, [item.id], "boom", { nowMs: t0 });
    expect(r.retried[0].attempts).toBe(1);
    expect(r.retried[0].notBefore).toBe(new Date(t0 + 30_000).toISOString());
    claimDuePersonaInbox(store.db, "alice", new Date(t0 + 30_000).toISOString());
    r = failPersonaInbox(store.db, [item.id], "boom", { nowMs: t0 });
    expect(r.retried[0].notBefore).toBe(new Date(t0 + 60_000).toISOString());
    claimDuePersonaInbox(store.db, "alice", new Date(t0 + 60_000).toISOString());
    r = failPersonaInbox(store.db, [item.id], "boom again", { nowMs: t0 });
    expect(r.retried).toHaveLength(0);
    expect(r.failed[0].status).toBe("failed");
    expect(r.failed[0].attempts).toBe(3);
    expect(r.failed[0].error).toBe("boom again");
  });

  test("boot reset returns processing items to pending; cancel is owner-scoped and pending-only", () => {
    const store = seed();
    const a = enqueuePersonaInbox(store.db, { owner: "alice", kind: "user_message", payload: {} }).item;
    claimDuePersonaInbox(store.db, "alice");
    expect(resetProcessingPersonaInbox(store.db)).toBe(1);
    expect(getPersonaInboxItem(store.db, a.id)?.status).toBe("pending");
    expect(getPersonaInboxItem(store.db, a.id)?.attempts).toBe(0);
    const s = enqueuePersonaInbox(store.db, { owner: "alice", kind: "schedule", payload: {}, notBefore: "2099-01-01T00:00:00.000Z" }).item;
    expect(cancelPersonaInbox(store.db, s.id, "bob")).toBe(false);
    expect(cancelPersonaInbox(store.db, s.id, "alice", "user_message")).toBe(false);
    expect(cancelPersonaInbox(store.db, s.id, "alice", "schedule")).toBe(true);
    expect(cancelPersonaInbox(store.db, s.id, "alice")).toBe(false);
    expect(getPersonaInboxItem(store.db, s.id)?.status).toBe("cancelled");
  });
});

describe("persona state", () => {
  test("get-or-create defaults and patch semantics (null clears, absent keeps)", () => {
    const store = seed();
    const s = getOrCreatePersonaState(store.db, "alice");
    expect(s.paused).toBe(false);
    expect(s.epoch).toBe(1);
    expect(s.claudeSessionId).toBeUndefined();
    updatePersonaState(store.db, "alice", { claudeSessionId: "sid", lastContextTokens: 1234, lastError: "x" });
    const u = updatePersonaState(store.db, "alice", { lastError: null, paused: true });
    expect(u.claudeSessionId).toBe("sid");
    expect(u.lastContextTokens).toBe(1234);
    expect(u.lastError).toBeUndefined();
    expect(u.paused).toBe(true);
    const r = updatePersonaState(store.db, "alice", { claudeSessionId: null, epoch: 2, handoffNote: "note" });
    expect(r.claudeSessionId).toBeUndefined();
    expect(r.epoch).toBe(2);
    expect(r.handoffNote).toBe("note");
  });
});

describe("persona jobs", () => {
  test("CRUD, listing newest first, and launch/session links", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const j1 = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "one", goal: "g1" });
    const j2 = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "two", goal: "g2", acceptance: "tests pass" });
    seedLaunch(store, "L1", "S1");
    seedLaunch(store, "L2");
    linkPersonaJobLaunch(store.db, j1.id, "L1", true);
    linkPersonaJobLaunch(store.db, j1.id, "L2");
    linkPersonaJobLaunch(store.db, j1.id, "L2");
    const got = getPersonaJob(store.db, j1.id)!;
    expect(got.launchIds).toEqual(["L1", "L2"]);
    expect(got.sessionIds).toEqual(["S1"]);
    expect(getPersonaJob(store.db, j2.id)?.acceptance).toBe("tests pass");
    updatePersonaJob(store.db, j2.id, { status: "done", outcome: "shipped" });
    expect(listPersonaJobs(store.db, "alice").map((j) => j.title)).toEqual(["two", "one"]);
    expect(listPersonaJobs(store.db, "alice", { status: "active" }).map((j) => j.id)).toEqual([j1.id]);
    expect(
      listPersonaJobs(store.db, "alice", { status: ["active"], closedSince: "2000-01-01T00:00:00.000Z" }).map((j) => j.id)
    ).toEqual([j2.id, j1.id]);
    expect(
      listPersonaJobs(store.db, "alice", { status: ["active"], closedSince: "2999-01-01T00:00:00.000Z" }).map((j) => j.id)
    ).toEqual([j1.id]);
    expect(listPersonaJobs(store.db, "bob")).toEqual([]);
    expect(personaJobForLaunch(store.db, "L1")?.personaPlanGate).toBe(true);
    expect(personaJobForLaunch(store.db, "nope")).toBeNull();
  });

  test("jobForSession resolves through the launch and through a subagent's parent", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "x", goal: "g" });
    seedLaunch(store, "L1", "S1");
    linkPersonaJobLaunch(store.db, job.id, "L1");
    createSession(store.db, { id: "S1:agent", projectId: "p", title: "c", cwd: "/wt/L1", parentSessionId: "S1", status: "running" });
    createSession(store.db, { id: "other", projectId: "p", title: "o", cwd: "/x", status: "running" });
    const direct = personaJobForSession(store.db, "S1");
    expect(direct?.job.id).toBe(job.id);
    expect(direct?.launchId).toBe("L1");
    const child = personaJobForSession(store.db, "S1:agent");
    expect(child?.job.id).toBe(job.id);
    expect(child?.rootSessionId).toBe("S1");
    expect(personaJobForSession(store.db, "other")).toBeNull();
    expect(personaJobForSession(store.db, "missing")).toBeNull();
  });

  test("launch counts: today's launches and still-active launches", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "x", goal: "g" });
    seedLaunch(store, "L1", "S1");
    seedLaunch(store, "L2", "S2");
    seedLaunch(store, "L3");
    seedLaunch(store, "L4");
    for (const id of ["L1", "L2", "L3", "L4"]) linkPersonaJobLaunch(store.db, job.id, id);
    store.db.run("UPDATE launches SET status = 'failed' WHERE id = 'L4'");
    store.db.run("UPDATE launches SET created_at = '2000-01-01 00:00:00' WHERE id = 'L3'");
    endSession(store.db, "S2");
    expect(countPersonaLaunchesToday(store.db, "alice")).toBe(3);
    // L1 running (session live), L3 starting (no session); L2's session ended, L4 failed.
    expect(countActivePersonaLaunches(store.db, "alice")).toBe(2);
    expect(countActivePersonaLaunches(store.db, "bob")).toBe(0);
  });
});

describe("persona approvals", () => {
  test("create, list, compare-and-set transitions, and expiry", () => {
    const store = seed();
    const a = createPersonaApproval(store.db, {
      owner: "alice",
      action: "answer_ask",
      summary: "Answer 'yes'",
      reason: "safe",
      args: { askId: "q1", answer: "yes" },
    });
    expect(a.status).toBe("pending");
    expect(a.args).toEqual({ askId: "q1", answer: "yes" });
    expect(listPersonaApprovals(store.db, "alice", "pending")).toHaveLength(1);
    const approved = transitionPersonaApproval(store.db, a.id, "pending", "approved", { decidedBy: "alice" });
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("alice");
    expect(transitionPersonaApproval(store.db, a.id, "pending", "denied")).toBeNull();
    const executed = transitionPersonaApproval(store.db, a.id, "approved", "executed", { result: "ok" });
    expect(executed?.result).toBe("ok");
    expect(executed?.decidedAt).toBe(approved?.decidedAt);

    const old = createPersonaApproval(store.db, { owner: "alice", action: "launch_session", summary: "s", args: {} });
    store.db.run("UPDATE persona_approvals SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", [old.id]);
    const expired = expirePersonaApprovals(store.db, "alice", "2026-10-03T00:00:00.000Z");
    expect(expired.map((x) => x.id)).toEqual([old.id]);
    expect(getPersonaApproval(store.db, old.id)?.status).toBe("expired");
    expect(expirePersonaApprovals(store.db, "alice", "2026-10-03T00:00:00.000Z")).toEqual([]);
  });
});

describe("persona inbox — bounds and retries", () => {
  test("a new event does not coalesce into an item already in retry backoff", () => {
    const store = seed();
    const first = enqueuePersonaInbox(store.db, { owner: "alice", kind: "worker_event", payload: { n: 1 }, coalesceKey: "k" });
    claimDuePersonaInbox(store.db, "alice", "2999-01-01T00:00:00.000Z");
    failPersonaInbox(store.db, [first.item.id], "model API 403");
    const second = enqueuePersonaInbox(store.db, { owner: "alice", kind: "worker_event", payload: { n: 2 }, coalesceKey: "k" });
    expect(second.coalesced).toBe(false);
    expect(second.item.id).not.toBe(first.item.id);
    expect(second.item.attempts).toBe(0);
    expect(second.item.error).toBeUndefined();
    // A fresh item still absorbs later events under the key.
    const third = enqueuePersonaInbox(store.db, { owner: "alice", kind: "worker_event", payload: { n: 3 }, coalesceKey: "k" });
    expect(third).toMatchObject({ coalesced: true, item: { id: second.item.id, payload: { n: 3 } } });
  });

  test("claim takes at most `limit` items, oldest first; the rest stay pending", () => {
    const store = seed();
    for (let i = 0; i < 5; i++) enqueuePersonaInbox(store.db, { owner: "alice", kind: "schedule", payload: { i } });
    const claimed = claimDuePersonaInbox(store.db, "alice", undefined, 3);
    expect(claimed.map((c) => c.payload.i)).toEqual([0, 1, 2]);
    expect(listPendingPersonaInbox(store.db, "alice").map((c) => c.payload.i)).toEqual([3, 4]);
    expect(claimDuePersonaInbox(store.db, "alice").map((c) => c.payload.i)).toEqual([3, 4]);
  });

  test("prune deletes only settled items older than the cutoff", () => {
    const store = seed();
    const ids = ["done", "failed", "cancelled", "pending", "recent"].map(
      (n) => enqueuePersonaInbox(store.db, { owner: "alice", kind: "schedule", payload: { n } }).item.id
    );
    const [done, failed, cancelled, pending, recent] = ids;
    store.db.run("UPDATE persona_inbox SET status = 'done', processed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [done]);
    store.db.run("UPDATE persona_inbox SET status = 'failed', processed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [failed]);
    store.db.run("UPDATE persona_inbox SET status = 'cancelled', processed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [cancelled]);
    store.db.run("UPDATE persona_inbox SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [pending]);
    store.db.run("UPDATE persona_inbox SET status = 'done', processed_at = '2026-09-30T00:00:00.000Z' WHERE id = ?", [recent]);
    expect(prunePersonaInbox(store.db, "bob", "2026-09-01T00:00:00.000Z")).toBe(0);
    expect(prunePersonaInbox(store.db, "alice", "2026-09-01T00:00:00.000Z")).toBe(3);
    const left = (store.db.query("SELECT id FROM persona_inbox").all() as Array<{ id: string }>).map((r) => r.id).sort();
    expect(left).toEqual([pending, recent].sort());
  });
});

describe("persona jobs — notes and launch accounting", () => {
  test("a job note is stored apart from the outcome", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "x", goal: "g" });
    expect(job.note).toBeUndefined();
    expect(setPersonaJobNote(store.db, job.id, "waiting on CI")?.note).toBe("waiting on CI");
    const got = getPersonaJob(store.db, job.id)!;
    expect(got.note).toBe("waiting on CI");
    expect(got.outcome).toBeUndefined();
  });

  test("starting launches exclude bound, failed and cleaned ones", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "x", goal: "g" });
    seedLaunch(store, "B1", "SB1");
    seedLaunch(store, "S1");
    seedLaunch(store, "F1");
    seedLaunch(store, "C1");
    for (const id of ["B1", "S1", "F1", "C1"]) linkPersonaJobLaunch(store.db, job.id, id);
    store.db.run("UPDATE launches SET status = 'failed' WHERE id = 'F1'");
    store.db.run("UPDATE launches SET status = 'cleaned' WHERE id = 'C1'");
    expect(countStartingPersonaJobLaunches(store.db, job.id)).toBe(1);
  });

  test("live workers of a closed job do not count toward the active cap", () => {
    const store = seed();
    const t = getOrCreatePersonaConsoleThread(store.db, "alice");
    const open = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "open", goal: "g" });
    const waiting = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "waiting", goal: "g" });
    const closed = createPersonaJob(store.db, { owner: "alice", threadId: t.id, title: "closed", goal: "g" });
    seedLaunch(store, "L1", "S1");
    seedLaunch(store, "L2", "S2");
    seedLaunch(store, "L3", "S3");
    linkPersonaJobLaunch(store.db, open.id, "L1");
    linkPersonaJobLaunch(store.db, waiting.id, "L2");
    linkPersonaJobLaunch(store.db, closed.id, "L3");
    updatePersonaJob(store.db, waiting.id, { status: "waiting_user" });
    updatePersonaJob(store.db, closed.id, { status: "done", outcome: "shipped" });
    expect(countActivePersonaLaunches(store.db, "alice")).toBe(2);
  });

  test("the session → job lookup uses the launches(session_id) index", () => {
    const store = seed();
    const plan = store.db
      .query(
        `EXPLAIN QUERY PLAN SELECT pjl.job_id FROM launches l JOIN persona_job_launches pjl ON pjl.launch_id = l.id
          WHERE l.session_id = ? LIMIT 1`
      )
      .all("S1") as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(" | ")).toContain("idx_launches_session");
  });
});

describe("persona approvals — interrupted execution", () => {
  test("approvals left approved by a crash are failed with the reason; others untouched", () => {
    const store = seed();
    const mid = createPersonaApproval(store.db, { owner: "alice", action: "launch_session", summary: "s", args: {} });
    const pending = createPersonaApproval(store.db, { owner: "alice", action: "launch_session", summary: "s", args: {} });
    const bobs = createPersonaApproval(store.db, { owner: "bob", action: "launch_session", summary: "s", args: {} });
    transitionPersonaApproval(store.db, mid.id, "pending", "approved", { decidedBy: "alice" });
    transitionPersonaApproval(store.db, bobs.id, "pending", "approved", { decidedBy: "bob" });
    const failed = failInterruptedPersonaApprovals(store.db, "alice", "interrupted by a collector restart");
    expect(failed.map((a) => [a.id, a.status, a.result])).toEqual([[mid.id, "failed", "interrupted by a collector restart"]]);
    expect(getPersonaApproval(store.db, pending.id)?.status).toBe("pending");
    expect(getPersonaApproval(store.db, bobs.id)?.status).toBe("approved");
  });
});

describe("persona channel threads", () => {
  test("get-or-create by ref returns one thread per (owner, channel, ref) and keeps the console thread apart", () => {
    const store = seed();
    const console1 = getOrCreatePersonaConsoleThread(store.db, "alice");
    const a = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:111.1", "#general");
    const again = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:111.1");
    const otherRef = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "dm:D1");
    const otherOwner = getOrCreatePersonaThreadByRef(store.db, "bob", "slack", "C1:111.1");
    expect(again.id).toBe(a.id);
    expect(again.title).toBe("#general");
    expect(a).toMatchObject({ owner: "alice", channel: "slack", externalRef: "C1:111.1" });
    expect(new Set([console1.id, a.id, otherRef.id, otherOwner.id]).size).toBe(4);
    expect(getOrCreatePersonaConsoleThread(store.db, "alice").id).toBe(console1.id);
  });

  test("a new title replaces the stored one without counting as activity", () => {
    const store = seed();
    const a = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", "#old");
    store.db.run("UPDATE persona_threads SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [a.id]);
    const renamed = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", "#new");
    expect(renamed.title).toBe("#new");
    expect(renamed.updatedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  test("the unique index refuses a second row for the same ref", () => {
    const store = seed();
    getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1");
    expect(() =>
      store.db.run(
        "INSERT INTO persona_threads (id, owner, channel, external_ref, created_at, updated_at) VALUES ('x', 'alice', 'slack', 'C1:1', 'a', 'a')"
      )
    ).toThrow();
    // Console threads carry no ref and are not constrained by it.
    store.db.run(
      "INSERT INTO persona_threads (id, owner, channel, created_at, updated_at) VALUES ('c2', 'alice', 'console', 'a', 'a')"
    );
  });

  test("listPersonaThreads: newest activity first with counts and the last message; owner-scoped", async () => {
    const store = seed();
    const c = getOrCreatePersonaConsoleThread(store.db, "alice");
    const s = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "dm:D1", "DM");
    getOrCreatePersonaThreadByRef(store.db, "bob", "slack", "dm:D2");
    appendPersonaMessage(store.db, { threadId: c.id, role: "user", text: "one" });
    await Bun.sleep(2);
    appendPersonaMessage(store.db, { threadId: s.id, role: "user", text: "two" });
    appendPersonaMessage(store.db, { threadId: s.id, role: "persona", text: "three" });
    const threads = listPersonaThreads(store.db, "alice");
    expect(threads.map((t) => t.id)).toEqual([s.id, c.id]);
    expect(threads[0]).toMatchObject({ messageCount: 2, title: "DM", lastMessage: { seq: 2, role: "persona", text: "three" } });
    expect(threads[1]).toMatchObject({ messageCount: 1, lastMessage: { seq: 1, text: "one" } });
    const empty = getOrCreatePersonaThreadByRef(store.db, "carol", "slack", "dm:D3");
    expect(listPersonaThreads(store.db, "carol")).toEqual([{ ...empty, messageCount: 0 }]);
  });

  test("claimDuePersonaInboxForThread takes only the oldest due item's thread; unthreaded items count as the default", () => {
    const store = seed();
    const now = "2026-10-04T12:00:00.000Z";
    const ins = (thread: string | null, i: number, notBefore?: string) =>
      store.db.run(
        "INSERT INTO persona_inbox (id, owner, kind, thread_id, payload_json, not_before, created_at) VALUES (?, 'alice', 'user_message', ?, ?, ?, ?)",
        [`i${i}`, thread, JSON.stringify({ i }), notBefore ?? null, `2026-10-04T11:00:0${i}.000Z`]
      );
    ins("T2", 0, "2026-10-04T13:00:00.000Z"); // not due: does not pick the thread
    ins(null, 1);
    ins("T2", 2);
    ins("CONSOLE", 3);
    ins("T2", 4);
    const first = claimDuePersonaInboxForThread(store.db, "alice", "CONSOLE", now)!;
    expect(first.threadId).toBe("CONSOLE");
    expect(first.items.map((i) => i.payload.i)).toEqual([1, 3]);
    expect(first.items.every((i) => i.status === "processing")).toBe(true);
    const second = claimDuePersonaInboxForThread(store.db, "alice", "CONSOLE", now, 1)!;
    expect(second.threadId).toBe("T2");
    expect(second.items.map((i) => i.payload.i)).toEqual([2]);
    expect(claimDuePersonaInboxForThread(store.db, "alice", "CONSOLE", now)!.items.map((i) => i.payload.i)).toEqual([4]);
    expect(claimDuePersonaInboxForThread(store.db, "alice", "CONSOLE", now)).toBeNull();
    expect(claimDuePersonaInboxForThread(store.db, "bob", "CONSOLE", now)).toBeNull();
  });

  test("approvals record their thread", () => {
    const store = seed();
    const a = createPersonaApproval(store.db, { owner: "alice", threadId: "T1", action: "x", summary: "s", args: {} });
    expect(getPersonaApproval(store.db, a.id)?.threadId).toBe("T1");
    const b = createPersonaApproval(store.db, { owner: "alice", action: "x", summary: "s", args: {} });
    expect(b.threadId).toBeUndefined();
  });

  test("audience: the console is private, a new ref thread takes the requested audience (default shared)", () => {
    const store = seed();
    expect(getOrCreatePersonaConsoleThread(store.db, "alice").audience).toBe("private");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "dm:D1", "DM", "private").audience).toBe("private");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", "#x").audience).toBe("shared");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C2:1", "#ext", "external").audience).toBe("external");
  });

  test("audience only widens: shared never goes back to private; private may widen", () => {
    const store = seed();
    const shared = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", "#x", "shared");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", "#x", "private").audience).toBe("shared");
    expect(getPersonaThread(store.db, shared.id)?.audience).toBe("shared");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", undefined, "external").audience).toBe("external");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1", undefined, "shared").audience).toBe("external");
    getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "dm:D1", "DM", "private");
    expect(getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "dm:D1", undefined, "shared").audience).toBe("shared");
    expect(mergePersonaAudience("external", "private")).toBe("external");
    expect(mergePersonaAudience("private", undefined)).toBe("private");
  });

  test("per-thread Claude sessions: set, read, clear per owner", () => {
    const store = seed();
    const a = getOrCreatePersonaThreadByRef(store.db, "alice", "slack", "C1:1");
    const b = getOrCreatePersonaThreadByRef(store.db, "bob", "slack", "C1:1");
    expect(getPersonaThreadSessionId(store.db, a.id)).toBeUndefined();
    setPersonaThreadSessionId(store.db, a.id, "sid-a");
    setPersonaThreadSessionId(store.db, b.id, "sid-b");
    expect(getPersonaThreadSessionId(store.db, a.id)).toBe("sid-a");
    clearPersonaThreadSessions(store.db, "alice");
    expect(getPersonaThreadSessionId(store.db, a.id)).toBeUndefined();
    expect(getPersonaThreadSessionId(store.db, b.id)).toBe("sid-b");
    setPersonaThreadSessionId(store.db, b.id, null);
    expect(getPersonaThreadSessionId(store.db, b.id)).toBeUndefined();
  });
});

describe("persona approvals — approver routing", () => {
  test("an approver card goes to its approver, not its owner; a card without one goes to its owner", () => {
    const store = seed();
    const routed = createPersonaApproval(store.db, {
      owner: "dave",
      approver: "carol",
      action: "floor_allow",
      summary: "s",
      args: {},
    });
    const own = createPersonaApproval(store.db, { owner: "dave", action: "launch_session", summary: "s", args: {} });
    const hosts = createPersonaApproval(store.db, { owner: "carol", action: "launch_session", summary: "s", args: {} });
    expect(approverOf(routed)).toBe("carol");
    expect(approverOf(own)).toBeUndefined();

    expect(listPersonaApprovalsForDecider(store.db, "carol").map((a) => a.id).sort()).toEqual(
      [routed.id, hosts.id].sort()
    );
    expect(listPersonaApprovalsForDecider(store.db, "dave").map((a) => a.id)).toEqual([own.id]);
    // Owner-scoped listing is unchanged: the owner still sees the card it owns.
    expect(listPersonaApprovals(store.db, "dave").map((a) => a.id).sort()).toEqual([routed.id, own.id].sort());

    transitionPersonaApproval(store.db, hosts.id, "pending", "denied", { decidedBy: "carol" });
    expect(listPersonaApprovalsForDecider(store.db, "carol", "pending").map((a) => a.id)).toEqual([routed.id]);
    expect(listPersonaApprovalsForDecider(store.db, "carol", "denied").map((a) => a.id)).toEqual([hosts.id]);
    expect(listPendingPersonaApprovalsAwaiting(store.db, "carol").map((a) => a.id)).toEqual([routed.id]);
    expect(listPendingPersonaApprovalsAwaiting(store.db, "dave").map((a) => a.id)).toEqual([own.id]);
    expect(listPendingPersonaApprovalsAwaiting(store.db, "nobody")).toEqual([]);
  });

  test("an approver equal to the owner, or blank, is stored as none", () => {
    const store = seed();
    const self = createPersonaApproval(store.db, { owner: "alice", approver: "alice", action: "x", summary: "s", args: {} });
    const blank = createPersonaApproval(store.db, { owner: "alice", approver: "  ", action: "x", summary: "s", args: {} });
    for (const a of [self, blank]) {
      expect(approverOf(a)).toBeUndefined();
      const row = store.db.query("SELECT approver FROM persona_approvals WHERE id = ?").get(a.id) as { approver: string | null };
      expect(row.approver).toBeNull();
    }
    expect(listPersonaApprovalsForDecider(store.db, "alice")).toHaveLength(2);
  });

  test("pending awaiting is newest first and honors the limit", () => {
    const store = seed();
    const first = createPersonaApproval(store.db, { owner: "bob", approver: "alice", action: "x", summary: "s", args: {} });
    const second = createPersonaApproval(store.db, { owner: "alice", action: "x", summary: "s", args: {} });
    store.db.run("UPDATE persona_approvals SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", [first.id]);
    store.db.run("UPDATE persona_approvals SET created_at = '2026-10-02T00:00:00.000Z' WHERE id = ?", [second.id]);
    expect(listPendingPersonaApprovalsAwaiting(store.db, "alice").map((a) => a.id)).toEqual([second.id, first.id]);
    expect(listPendingPersonaApprovalsAwaiting(store.db, "alice", 1).map((a) => a.id)).toEqual([second.id]);
  });
});

describe("listPersonaOwners", () => {
  test("lists every owner with a persona_state row, sorted", () => {
    const store = seed();
    expect(listPersonaOwners(store.db)).toEqual([]);
    getOrCreatePersonaState(store.db, "dave");
    getOrCreatePersonaState(store.db, "carol");
    getOrCreatePersonaState(store.db, "carol");
    expect(listPersonaOwners(store.db)).toEqual(["carol", "dave"]);
  });
});
