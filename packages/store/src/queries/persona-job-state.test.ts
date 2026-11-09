import { describe, expect, test } from "bun:test";
import type { ReviewPacketDraft } from "@standup/shared";
import { createStore } from "../store.js";
import {
  appendPersonaMessage,
  attachSessionToLaunch,
  clearPersonaJobOpenAsk,
  createCheckpoint,
  createLaunch,
  createPersonaApproval,
  createPersonaJob,
  createReviewPacket,
  createSession,
  endSession,
  flagPersonaJobWaitingUser,
  getPersonaJob,
  linkPersonaJobLaunch,
  markPersonaJobWorkerResumed,
  listPersonaJobs,
  recordPersonaJobOwnerReply,
  refreshPersonaJob,
  setPersonaJobNote,
  setPersonaJobOpenAsk,
  submitReviewPacket,
  transitionPersonaApproval,
  updatePersonaJob,
  updateSessionStatus,
  upsertProject,
} from "./index.js";

const OWNER = "owner";

/** What a worker's submitted review packet says. */
const PACKET_DRAFT: ReviewPacketDraft = {
  title: "Ship the thing",
  intent: "Implements the task.",
  changes: [{ area: "Store", bullets: ["Changes a.ts"], files: [] }],
  validation: { samples: [{ label: "tests", input: "bun test", output: "green" }] },
  risks: { risks: [], questions: [] },
  links: [],
};

/** A job with one bound worker session `s1` (status `running`). */
function setUp() {
  const store = createStore(":memory:");
  const db = store.db;
  upsertProject(db, { id: "p", name: "p", branch: "main", repos: [] });
  const job = createPersonaJob(db, { owner: OWNER, threadId: "t1", title: "job", goal: "g" });
  createLaunch(db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  linkPersonaJobLaunch(db, job.id, "l1");
  createSession(db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "running" });
  attachSessionToLaunch(db, "l1", "s1");
  const view = () => getPersonaJob(db, job.id)!.view!;
  /** Moves every recorded time on the job back by `seconds`, so a later write is unambiguously after it. */
  const age = (seconds: number) => {
    const shift = (iso: string | null) => (iso ? new Date(Date.parse(iso) - seconds * 1000).toISOString() : null);
    const row = db
      .query("SELECT updated_at, waiting_since, open_ask_at, owner_responded_at, note_at FROM persona_jobs WHERE id = ?")
      .get(job.id) as Record<string, string | null>;
    db.run(
      `UPDATE persona_jobs SET updated_at = ?, waiting_since = ?, open_ask_at = ?, owner_responded_at = ?, note_at = ? WHERE id = ?`,
      [shift(row.updated_at), shift(row.waiting_since), shift(row.open_ask_at), shift(row.owner_responded_at), shift(row.note_at), job.id]
    );
  };
  /** Posts a Persona question about `jobId` in `threadId`; returns its message id. */
  const ask = (threadId: string, jobId: string) =>
    appendPersonaMessage(db, { threadId, role: "persona", text: "which?", options: ["a", "b"], jobIds: [jobId] }).message.id;
  return { db, job, view, age, ask };
}

function addEvent(db: ReturnType<typeof setUp>["db"], sessionId: string, seq: number, sqliteTime: string) {
  db.run("INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, 'tool', '{}', ?)", [
    sessionId,
    seq,
    sqliteTime,
  ]);
}

describe("persona job view: worker sessions", () => {
  test("a running session shows the job running; idle shows idle; ended stays idle", () => {
    const h = setUp();
    expect(h.view().state).toBe("running");
    updateSessionStatus(h.db, "s1", "idle");
    expect(refreshPersonaJob(h.db, h.job.id)!.job.view!.state).toBe("idle");
    updateSessionStatus(h.db, "s1", "running");
    endSession(h.db, "s1");
    expect(h.view().state).toBe("idle");
  });

  test("a launch still starting counts as running", () => {
    const h = setUp();
    updateSessionStatus(h.db, "s1", "idle");
    createLaunch(h.db, { id: "l2", projectId: "p", task: "t", worktreePath: "/w2", branch: "b2" });
    linkPersonaJobLaunch(h.db, h.job.id, "l2");
    expect(h.view().state).toBe("running");
  });

  test("last activity reads a session's SQLite-format event time as UTC", () => {
    const h = setUp();
    h.age(3600);
    addEvent(h.db, "s1", 1, "2099-01-02 03:04:05");
    expect(h.view().lastActivityAt).toBe("2099-01-02T03:04:05.000Z");
  });

  test("last activity takes the latest of transcript and hook events, not the first present", () => {
    const h = setUp();
    h.age(3600);
    h.db.run(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES ('s1', 1, '{}', '2098-01-01 00:00:00')"
    );
    addEvent(h.db, "s1", 1, "2099-01-02 03:04:05");
    expect(h.view().lastActivityAt).toBe("2099-01-02T03:04:05.000Z");
  });
});

describe("persona job view: approvals", () => {
  test("a pending card the owner decides needs them; deciding it clears that", () => {
    const h = setUp();
    const approval = createPersonaApproval(h.db, {
      owner: OWNER,
      jobId: h.job.id,
      action: "answer_ask",
      summary: "allow",
      args: {},
    });
    expect(h.view()).toMatchObject({ state: "needs_you", needs: ["approval"] });
    transitionPersonaApproval(h.db, approval.id, "pending", "denied", { decidedBy: OWNER });
    expect(refreshPersonaJob(h.db, h.job.id)!.job.view!.state).toBe("running");
  });

  test("a card someone else decides is not waiting on the owner", () => {
    const h = setUp();
    createPersonaApproval(h.db, { owner: OWNER, jobId: h.job.id, action: "x", summary: "s", args: {}, approver: "host" });
    expect(h.view().state).toBe("running");
  });

  test("approving the job's card clears an explicit waiting_user set before it", () => {
    const h = setUp();
    const approval = createPersonaApproval(h.db, { owner: OWNER, jobId: h.job.id, action: "x", summary: "s", args: {} });
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    h.age(5);
    expect(refreshPersonaJob(h.db, h.job.id)!.cleared).toBe(false);
    transitionPersonaApproval(h.db, approval.id, "pending", "approved", { decidedBy: OWNER });
    const refreshed = refreshPersonaJob(h.db, h.job.id)!;
    expect(refreshed.cleared).toBe(true);
    expect(refreshed.job.status).toBe("active");
    expect(refreshed.job.view!.state).toBe("running");
  });

  test("a card someone other than the owner decided does not answer the owner's waiting", () => {
    const h = setUp();
    const approval = createPersonaApproval(h.db, { owner: OWNER, jobId: h.job.id, action: "x", summary: "s", args: {} });
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    h.age(5);
    transitionPersonaApproval(h.db, approval.id, "pending", "denied", { decidedBy: "teammate" });
    expect(refreshPersonaJob(h.db, h.job.id)!.cleared).toBe(false);
    expect(h.view().needs).toEqual(["waiting"]);
  });

  test("an expired card answers nothing", () => {
    const h = setUp();
    const approval = createPersonaApproval(h.db, { owner: OWNER, jobId: h.job.id, action: "x", summary: "s", args: {} });
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    h.age(5);
    transitionPersonaApproval(h.db, approval.id, "pending", "expired", { result: "expired after 24h" });
    expect(refreshPersonaJob(h.db, h.job.id)!.cleared).toBe(false);
    expect(h.view()).toMatchObject({ state: "needs_you", needs: ["waiting"] });
  });
});

describe("persona job view: ask_user questions", () => {
  test("an open question needs the owner until they reply in the thread", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, h.ask("t1", h.job.id));
    expect(h.view()).toMatchObject({ state: "needs_you", needs: ["question"] });
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", {})).toEqual([h.job.id]);
    expect(h.view().state).toBe("running");
  });

  test("the owner answering the question clears the waiting_user it was set for", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, "m1");
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    h.age(5);
    recordPersonaJobOwnerReply(h.db, OWNER, "t1", { replyToMessageId: "m1" });
    const refreshed = refreshPersonaJob(h.db, h.job.id)!;
    expect(refreshed.cleared).toBe(true);
    expect(refreshed.job.status).toBe("active");
  });

  test("an untagged reply answers nothing while two jobs have questions open in its thread", () => {
    const h = setUp();
    const other = createPersonaJob(h.db, { owner: OWNER, threadId: "t1", title: "other", goal: "g" });
    setPersonaJobOpenAsk(h.db, h.job.id, h.ask("t1", h.job.id));
    setPersonaJobOpenAsk(h.db, other.id, h.ask("t1", other.id));
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", {})).toEqual([]);
    expect(h.view().needs).toEqual(["question"]);
    expect(getPersonaJob(h.db, other.id)!.view!.needs).toEqual(["question"]);
  });

  test("an untagged reply answers a question asked in its thread, whatever thread the job lives in", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, h.ask("console", h.job.id));
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", {})).toEqual([]);
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "console", {})).toEqual([h.job.id]);
    expect(h.view().state).toBe("running");
  });

  test("a quick reply to an earlier question about the job answers it after a re-ask", () => {
    const h = setUp();
    const first = h.ask("t1", h.job.id);
    setPersonaJobOpenAsk(h.db, h.job.id, first);
    setPersonaJobOpenAsk(h.db, h.job.id, h.ask("t1", h.job.id));
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", { replyToMessageId: first })).toEqual([h.job.id]);
    expect(h.view().state).toBe("running");
  });

  test("setting the job active keeps its open question; clearing it is explicit", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, "m1");
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    expect(h.view().needs).toEqual(["question", "waiting"]);
    updatePersonaJob(h.db, h.job.id, { status: "active", note: "asked which branch" });
    expect(h.view().needs).toEqual(["question"]);
    clearPersonaJobOpenAsk(h.db, h.job.id);
    expect(h.view().state).toBe("running");
  });

  test("a quick reply to a tagged message that isn't a question answers nothing", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, h.ask("t1", h.job.id));
    const status = appendPersonaMessage(h.db, { threadId: "t1", role: "persona", text: "update", jobIds: [h.job.id] }).message.id;
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", { replyToMessageId: status })).toEqual([]);
    expect(h.view().needs).toEqual(["question"]);
  });

  test("a reply tagged to a job, or a quick reply to its question, answers that job", () => {
    const h = setUp();
    const other = createPersonaJob(h.db, { owner: OWNER, threadId: "t1", title: "other", goal: "g" });
    setPersonaJobOpenAsk(h.db, h.job.id, "m1");
    setPersonaJobOpenAsk(h.db, other.id, "m2");
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", { jobId: h.job.id })).toEqual([h.job.id]);
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t1", { replyToMessageId: "m2" })).toEqual([other.id]);
    expect(getPersonaJob(h.db, other.id)!.view!.state).toBe("idle");
  });

  test("another thread's reply, or another owner's, answers nothing", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, "m1");
    expect(recordPersonaJobOwnerReply(h.db, OWNER, "t2", {})).toEqual([]);
    expect(recordPersonaJobOwnerReply(h.db, "someone", "t1", { jobId: h.job.id })).toEqual([]);
    expect(h.view().needs).toEqual(["question"]);
  });

  test("closing the job drops its open question", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, "m1");
    updatePersonaJob(h.db, h.job.id, { status: "done", outcome: "ok" });
    expect(h.view().state).toBe("done");
    expect(setPersonaJobOpenAsk(h.db, h.job.id, "m2")!.view!.state).toBe("done");
  });
});

describe("persona job view: explicit waiting_user and its override", () => {
  test("Persona's waiting_user needs the owner until answered, whatever the workers do", () => {
    const h = setUp();
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    h.age(5);
    addEvent(h.db, "s1", 1, "2099-01-01 00:00:00");
    expect(refreshPersonaJob(h.db, h.job.id)!.cleared).toBe(false);
    expect(h.view()).toMatchObject({ state: "needs_you", needs: ["waiting"] });
  });

  test("setting waiting_user again after the owner replied puts it back in front of them", () => {
    const h = setUp();
    recordPersonaJobOwnerReply(h.db, OWNER, "t1", { jobId: h.job.id });
    h.age(5);
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    expect(refreshPersonaJob(h.db, h.job.id)!.cleared).toBe(false);
    expect(h.view().state).toBe("needs_you");
  });

  test("a worker's hand-off waiting clears once that worker runs again, not when another one does", () => {
    const h = setUp();
    updateSessionStatus(h.db, "s1", "idle");
    createLaunch(h.db, { id: "l2", projectId: "p", task: "t", worktreePath: "/w2", branch: "b2" });
    linkPersonaJobLaunch(h.db, h.job.id, "l2");
    createSession(h.db, { id: "s2", projectId: "p", title: "w2", cwd: "/w2", status: "running" });
    attachSessionToLaunch(h.db, "l2", "s2");
    const cp = createCheckpoint(h.db, "s1", "self-reported", "ready for your review");
    h.db.run("UPDATE checkpoints SET created_at = '2099-01-01 00:00:00' WHERE id = ?", [cp.id]);
    // The hand-off has the worker's packet behind it in the owner's Review tab.
    const packet = createReviewPacket(h.db, { owner: OWNER, launchId: "l1", jobId: h.job.id });
    expect(submitReviewPacket(h.db, { id: packet.id, owner: OWNER, draft: PACKET_DRAFT })).toBeTruthy();
    expect(flagPersonaJobWaitingUser(h.db, h.job.id, cp.id, "Waiting on the owner")).not.toBeNull();
    h.age(5);
    // The other worker keeps busy: still waiting on the owner.
    addEvent(h.db, "s2", 1, "2099-01-01 00:00:00");
    expect(markPersonaJobWorkerResumed(h.db, h.job.id, "s2")).toBe(false);
    expect(refreshPersonaJob(h.db, h.job.id)!.cleared).toBe(false);
    expect(h.view().needs).toEqual(["waiting"]);
    // The worker that handed off runs again.
    updateSessionStatus(h.db, "s1", "running");
    expect(markPersonaJobWorkerResumed(h.db, h.job.id, "s1")).toBe(true);
    const refreshed = refreshPersonaJob(h.db, h.job.id)!;
    expect(refreshed.cleared).toBe(true);
    expect(refreshed.job.view!.state).toBe("running");
  });

  test("a worker's hand-off for something outside Standup links to the worker that raised it", () => {
    const h = setUp();
    updateSessionStatus(h.db, "s1", "idle");
    const cp = createCheckpoint(h.db, "s1", "self-reported", "ready for you to merge");
    h.db.run("UPDATE checkpoints SET created_at = '2099-01-01 00:00:00' WHERE id = ?", [cp.id]);
    expect(flagPersonaJobWaitingUser(h.db, h.job.id, cp.id, "Waiting on the owner")).not.toBeNull();
    expect(h.view()).toMatchObject({ state: "needs_you", needs: ["waiting"] });
    expect(h.view().actions).toEqual([{ kind: "session", id: "s1", label: "see what the worker handed you" }]);
  });

  test("a hand-off waiting whose session isn't known isn't shown as needing the owner", () => {
    const h = setUp();
    updateSessionStatus(h.db, "s1", "idle");
    h.db.run("UPDATE persona_jobs SET status = 'waiting_user', waiting_since = ?, waiting_source = 'handoff' WHERE id = ?", [
      new Date().toISOString(),
      h.job.id,
    ]);
    expect(h.view().state).toBe("idle");
    expect(h.view().actions).toBeUndefined();
  });

  test("setting the job active clears the waiting at once", () => {
    const h = setUp();
    updatePersonaJob(h.db, h.job.id, { status: "waiting_user" });
    updatePersonaJob(h.db, h.job.id, { status: "active" });
    expect(h.view().state).toBe("running");
  });
});

describe("persona job view: checkpoint and note", () => {
  test("a checkpoint newer than Persona's note is served; an older one is not", () => {
    const h = setUp();
    setPersonaJobNote(h.db, h.job.id, "Persona: waiting on CI");
    h.age(3600);
    const cp = createCheckpoint(h.db, "s1", "self-reported", "CI green, opening review");
    h.db.run("UPDATE checkpoints SET created_at = '2099-01-01 00:00:00' WHERE id = ?", [cp.id]);
    expect(h.view().checkpoint).toMatchObject({ summary: "CI green, opening review", sessionId: "s1" });
    h.db.run("UPDATE checkpoints SET created_at = '2000-01-01 00:00:00' WHERE id = ?", [cp.id]);
    expect(h.view().checkpoint).toBeUndefined();
    expect(getPersonaJob(h.db, h.job.id)!.noteAt).toBeDefined();
  });

  test("a subagent's structural checkpoint is not the job's", () => {
    const h = setUp();
    createCheckpoint(h.db, "s1", "structural", "subagent finished");
    expect(h.view().checkpoint).toBeUndefined();
  });

  test("list_jobs rows carry the derived view too", () => {
    const h = setUp();
    setPersonaJobOpenAsk(h.db, h.job.id, "m1");
    expect(listPersonaJobs(h.db, OWNER)[0]!.view).toMatchObject({ state: "needs_you" });
  });
});
