import { describe, expect, test } from "bun:test";
import {
  attachSessionToLaunch,
  createCheckpoint,
  createLaunch,
  createPersonaJob,
  createReviewPacket,
  createSession,
  createStore,
  getPersonaJob,
  linkPersonaJobLaunch,
  submitReviewPacket,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { CheckpointSource, PersonaJob, ReviewPacketDraft, WsMessage } from "@standup/shared";
import { createPersonaEventRouter } from "./events.js";
import { ownerHandoff } from "./handoff.js";

const OWNER = "alice";
const REPORTED =
  "Done: 3 local commits on standup/foo (tests green, typecheck clean). No push, PR or deploy; the owner opens the review.";

describe("ownerHandoff", () => {
  const handoffs = [
    REPORTED,
    "Branch is ready; the owner cuts the PR.",
    "Wrote the migration script for the owner to run.",
    "All green — ready for you to merge.",
    "PR description drafted, ready for your review.",
    "This needs your approval before I deploy.",
    "Two options below; needs your decision.",
    "Blocked: waiting on the owner.",
    "Waiting for you to confirm the account id.",
    "alice can merge once CI passes.",
    "You need to approve the plan.",
    "Handing it over to you.",
    "Over to you.",
  ];
  for (const text of handoffs) {
    test(`hands off: ${text}`, () => {
      expect(ownerHandoff(text, OWNER)).not.toBeNull();
    });
  }

  test("returns the hand-off sentence", () => {
    expect(ownerHandoff(REPORTED)).toBe("the owner opens the review.");
  });

  const reports = [
    "Committed and tests pass.",
    "I didn't push.",
    "Pushed the branch and opened the review.",
    "The owner opened the review and approved it.",
    "The owner approved the plan; implementing now.",
    "Was waiting on the owner, now unblocked and continuing.",
    "No need for you to review this one.",
    "This doesn't need your approval.",
    "You can run `bun test` to reproduce.",
    "Fixed the bug where the owner opens a closed job.",
    "Fixed the script you run nightly.",
    "If you run the migration twice it is now idempotent.",
    "Waiting for CI to finish.",
    "Ready for review by the integration step.",
    "Still working: reading the router, next writing tests.",
    "",
  ];
  for (const text of reports) {
    test(`not a hand-off: ${JSON.stringify(text)}`, () => {
      expect(ownerHandoff(text, OWNER)).toBeNull();
    });
  }
});

const DRAFT: ReviewPacketDraft = {
  title: "Ship the thing",
  intent: "Implements the task the launch was given.",
  changes: [{ area: "Collector", bullets: ["Changes x.ts"], files: [] }],
  validation: { samples: [{ label: "tests", input: "bun test", output: "all green" }] },
  risks: { risks: [], questions: [] },
  links: [],
};

function setUp(status: PersonaJob["status"] = "active") {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const job = createPersonaJob(store.db, { owner: OWNER, threadId: "t", title: "job", goal: "g" });
  createLaunch(store.db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  linkPersonaJobLaunch(store.db, job.id, "l1");
  createSession(store.db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "running" });
  attachSessionToLaunch(store.db, "l1", "s1");
  if (status !== "active") updatePersonaJob(store.db, job.id, { status });
  // The launch's review packet is in the owner's Review tab, which is what a
  // hand-off asking them to look at the change needs before it may flag the job.
  const packet = createReviewPacket(store.db, { owner: OWNER, launchId: "l1", jobId: job.id });
  submitReviewPacket(store.db, { id: packet.id, owner: OWNER, draft: DRAFT });

  const enqueued: Array<Record<string, unknown>> = [];
  const published: PersonaJob[] = [];
  const route = createPersonaEventRouter({
    db: store.db,
    owner: OWNER,
    coalesceMs: 1000,
    enqueue: (_kind, payload) => enqueued.push(payload),
    isSelfActing: () => false,
    publishJob: (j) => published.push(j),
  });
  const send = (type: WsMessage["type"], payload: unknown) => route({ type, payload, timestamp: "" });
  const checkpoint = (summary: string, source: CheckpointSource = "self-reported") =>
    createCheckpoint(store.db, "s1", source, summary);
  const current = () => getPersonaJob(store.db, job.id)!;
  return { store, job, enqueued, published, send, checkpoint, current };
}

describe("turn-end hand-off flag", () => {
  test("a turn ending on the owner-opens-the-review checkpoint marks the job waiting_user", () => {
    const h = setUp();
    h.checkpoint(REPORTED);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    const job = h.current();
    expect(job.status).toBe("waiting_user");
    expect(job.note).toContain("the owner opens the review");
    expect(h.published.map((j) => j.status)).toEqual(["waiting_user"]);
    expect(h.enqueued[0]).toMatchObject({ type: "turn_end", flaggedWaitingUser: true });
  });

  test("a done status frame flags it too, and so does the turn-end summary checkpoint", () => {
    const h = setUp();
    h.checkpoint("✓ Done — 3 commits ready for you to merge", "auto");
    h.send("session:status", { sessionId: "s1", status: "done" });
    expect(h.current().status).toBe("waiting_user");
  });

  for (const text of ["Committed and tests pass.", "I didn't push."]) {
    test(`a turn ending on "${text}" leaves the job active`, () => {
      const h = setUp();
      h.checkpoint(text);
      h.send("session:status", { sessionId: "s1", status: "idle" });
      expect(h.current().status).toBe("active");
      expect(h.current().note).toBeUndefined();
      // The turn end still refreshes the job's derived view; it is never flagged.
      expect(h.published.map((j) => j.status)).toEqual(["active"]);
      expect(h.enqueued[0]).not.toHaveProperty("flaggedWaitingUser");
    });
  }

  test("a worker still mid-task does not flip the job", () => {
    const h = setUp();
    h.checkpoint(REPORTED);
    h.send("session:status", { sessionId: "s1", status: "running" });
    h.send("session:status", { sessionId: "s1", status: "waiting" });
    expect(h.current().status).toBe("active");
  });

  for (const status of ["done", "failed", "cancelled", "waiting_user"] as const) {
    test(`a ${status} job is left alone`, () => {
      const h = setUp(status);
      h.checkpoint(REPORTED);
      h.send("session:status", { sessionId: "s1", status: "idle" });
      expect(h.current().status).toBe(status);
      expect(h.published.map((j) => j.status)).toEqual([status]);
    });
  }

  test("a subagent's structural checkpoint does not flag the job", () => {
    const h = setUp();
    h.checkpoint("Ready for you to merge.", "structural");
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
  });

  test("once the job is set active again, the same checkpoint does not re-flag it", () => {
    const h = setUp();
    const cp = h.checkpoint(REPORTED);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    // Persona resumes the job a moment later; the worker's next turn writes no new checkpoint.
    h.store.db.run("UPDATE checkpoints SET created_at = datetime('now', '-5 seconds') WHERE id = ?", [cp.id]);
    updatePersonaJob(h.store.db, h.job.id, { status: "active" });
    h.send("session:status", { sessionId: "s1", status: "running" });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
  });
});
