import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  attachSessionToLaunch,
  createCheckpoint,
  createLaunch,
  createPersonaJob,
  createReviewPacket,
  createSession,
  createStore,
  deliverSteer,
  getPendingSteers,
  getPersonaJob,
  linkPersonaJobLaunch,
  submitReviewPacket,
  upsertProject,
} from "@standup/store";
import type { CheckpointSource, ReviewPacketDraft, WsMessage } from "@standup/shared";
import { MAX_REVIEW_PACKET_STEERS, REVIEW_PACKET_CODE_REVIEW_FIRST_STEER, REVIEW_PACKET_STEER, createPersonaEventRouter } from "./events.js";
import { isReviewHandoff } from "./handoff.js";
import { startPipelineForLaunch } from "../pipeline/engine.js";

/*
 * A worker that reports the change ready for the owner's review is only
 * allowed to hand the job over once its review packet is in the Review tab;
 * otherwise the worker is pushed to submit one and the owner is left alone.
 */

const OWNER = "alice";
const READY_FOR_REVIEW = "Done: the change is on standup/foo and tests are green; ready for your review.";
const READY_TO_MERGE = "Done: 3 commits on standup/foo (tests green). The owner merges it.";

const DRAFT: ReviewPacketDraft = {
  title: "Ship the thing",
  intent: "Implements the task the launch was given.",
  changes: [{ area: "Collector", bullets: ["Changes x.ts"], files: [] }],
  validation: { samples: [{ label: "tests", input: "bun test", output: "all green" }] },
  risks: { risks: [], questions: [] },
  links: [],
};

/** Runs `git <args>` in `cwd`, failing the test when git does. */
function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

/** A checkout on branch `b` with one commit of its own over `main`. */
function checkoutWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), "standup-handoff-"));
  git(dir, ["init", "--initial-branch=main"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "first"]);
  git(dir, ["checkout", "-b", "b"]);
  writeFileSync(join(dir, "b.txt"), "b\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "the change"]);
  return dir;
}

function setUp(opts: { pipeline?: boolean; worktree?: string; linkedReview?: boolean } = {}) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [], ...(opts.linkedReview ? { codeReviewAdapter: "generic" as const } : {}) });
  const job = createPersonaJob(store.db, { owner: OWNER, threadId: "t", title: "job", goal: "g" });
  createLaunch(store.db, { id: "l1", projectId: "p", task: "t", worktreePath: opts.worktree ?? "/w", branch: "b" });
  startPipelineForLaunch(store.db, { launchId: "l1", owner: OWNER, projectId: "p", disabled: opts.pipeline === false });
  linkPersonaJobLaunch(store.db, job.id, "l1");
  createSession(store.db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "running" });
  attachSessionToLaunch(store.db, "l1", "s1");

  const enqueued: Array<Record<string, unknown>> = [];
  const route = createPersonaEventRouter({
    db: store.db,
    owner: OWNER,
    coalesceMs: 1000,
    enqueue: (_kind, payload) => enqueued.push(payload),
    isSelfActing: () => false,
  });
  return {
    store,
    job,
    enqueued,
    send: (type: WsMessage["type"], payload: unknown) => route({ type, payload, timestamp: "" }),
    checkpoint: (summary: string, source: CheckpointSource = "self-reported") => createCheckpoint(store.db, "s1", source, summary),
    current: () => getPersonaJob(store.db, job.id)!,
    steers: () => getPendingSteers(store.db, "s1").map((s) => s.body),
    /** Puts a packet for the launch in the owner's Review tab. */
    submitPacket: () => {
      const packet = createReviewPacket(store.db, { owner: OWNER, launchId: "l1", jobId: job.id });
      expect(submitReviewPacket(store.db, { id: packet.id, owner: OWNER, draft: DRAFT })).toBeTruthy();
      return packet.id;
    },
  };
}

describe("a review hand-off with nothing in the Review tab", () => {
  test("pushes the worker to submit its packet and leaves the job active", () => {
    const h = setUp();
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
    expect(h.current().note).toBeUndefined();
    expect(h.steers()).toEqual([REVIEW_PACKET_STEER]);
    expect(h.enqueued[0]).not.toHaveProperty("flaggedWaitingUser");
  });

  test("a linked-review project's worker short of its code_review stage is sent on to it, and the owner is left alone", () => {
    const h = setUp({ linkedReview: true });
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
    expect(h.steers()).toEqual([REVIEW_PACKET_CODE_REVIEW_FIRST_STEER]);
    expect(REVIEW_PACKET_CODE_REVIEW_FIRST_STEER).toContain("code_review stage");
  });

  test("the same push is not queued twice", () => {
    const h = setUp();
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    h.checkpoint(`${READY_FOR_REVIEW} Still nothing submitted.`);
    h.send("session:status", { sessionId: "s2", status: "idle" });
    h.send("session:status", { sessionId: "s1", status: "done" });
    expect(h.steers()).toEqual([REVIEW_PACKET_STEER]);
  });

  test("once the packet is submitted the hand-off reaches the owner", () => {
    const h = setUp();
    h.submitPacket();
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.current().note).toContain("ready for your review");
    expect(h.steers()).toEqual([]);
  });

  test("a review the owner sent back doesn't count: the rework needs a new packet", () => {
    const h = setUp();
    const packetId = h.submitPacket();
    h.store.db.run("UPDATE review_packets SET status = 'changes_requested' WHERE id = ?", [packetId]);
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
    expect(h.steers()).toEqual([REVIEW_PACKET_STEER]);
  });

  test("a launch that runs no pipeline is held to the packet too when it has a change of its own", () => {
    const h = setUp({ pipeline: false, worktree: checkoutWithChange() });
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
    expect(h.steers()).toEqual([REVIEW_PACKET_STEER]);
  });

  test("a launch that runs no pipeline and changed no code (research, docs) hands off as before", () => {
    const dir = checkoutWithChange();
    git(dir, ["reset", "--hard", "main"]);
    const h = setUp({ pipeline: false, worktree: dir });
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.steers()).toEqual([]);
  });

  test("a launch that runs no pipeline and has no checkout to read hands off as before", () => {
    const h = setUp({ pipeline: false });
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.steers()).toEqual([]);
  });

  test("a launch that runs no pipeline whose work already landed hands off as before", () => {
    const dir = checkoutWithChange();
    git(dir, ["checkout", "main"]);
    git(dir, ["merge", "--no-ff", "-m", "merge b", "b"]);
    git(dir, ["checkout", "b"]);
    const h = setUp({ pipeline: false, worktree: dir });
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.steers()).toEqual([]);
  });

  test(`after ${MAX_REVIEW_PACKET_STEERS} pushes the hand-off reaches the owner anyway`, () => {
    const h = setUp();
    for (let i = 0; i < MAX_REVIEW_PACKET_STEERS; i++) {
      h.checkpoint(`${READY_FOR_REVIEW} (${i})`);
      h.send("session:status", { sessionId: "s1", status: "idle" });
      expect(h.current().status).toBe("active");
      for (const s of getPendingSteers(h.store.db, "s1")) deliverSteer(h.store.db, s.id);
    }
    h.checkpoint(`${READY_FOR_REVIEW} (last)`);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.steers()).toEqual([]);
  });

  test("the pushes are counted per round: after a send-back the worker is pushed again", () => {
    const h = setUp();
    for (let i = 0; i < MAX_REVIEW_PACKET_STEERS; i++) {
      h.checkpoint(`${READY_FOR_REVIEW} (${i})`);
      h.send("session:status", { sessionId: "s1", status: "idle" });
      for (const s of getPendingSteers(h.store.db, "s1")) deliverSteer(h.store.db, s.id);
    }
    // The round ends with a packet the owner sends back; the pushes before it
    // belong to that round.
    const packetId = h.submitPacket();
    h.store.db.run("UPDATE steers SET created_at = datetime('now', '-10 seconds') WHERE session_id = 's1'");
    h.store.db.run("UPDATE review_packets SET status = 'changes_requested', updated_at = ? WHERE id = ?", [
      new Date(Date.now() - 5_000).toISOString(),
      packetId,
    ]);
    h.store.db.run("UPDATE persona_jobs SET status = 'active' WHERE id = ?", [h.job.id]);
    h.checkpoint(`${READY_FOR_REVIEW} (rework)`);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("active");
    expect(h.steers()).toEqual([REVIEW_PACKET_STEER]);
  });

  test("a launch that runs no pipeline, with its packet submitted, hands off to the owner", () => {
    const h = setUp({ pipeline: false, worktree: checkoutWithChange() });
    h.submitPacket();
    h.checkpoint(READY_FOR_REVIEW);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.steers()).toEqual([]);
  });

  test("a hand-off about something other than the review still reaches the owner", () => {
    const h = setUp();
    h.checkpoint(READY_TO_MERGE);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.current().status).toBe("waiting_user");
    expect(h.steers()).toEqual([]);
  });
});

describe("which hand-offs are about the review", () => {
  for (const sentence of [
    "ready for your review.",
    "the owner opens the review.",
    "the review packet is ready for you.",
    "Please review the change.",
    "Can you review the diff?",
    "It's ready to review.",
    "Ready for code review.",
    "Over to you for review.",
    "Awaiting your review.",
    "Needs your review before merging.",
    "Please review.",
    "Please review it when you can.",
    "Ready for review — PR is up",
    "The change is up for your review.",
    "Can you review my work?",
  ]) {
    test(`about the review: ${sentence}`, () => {
      expect(isReviewHandoff(sentence)).toBe(true);
    });
  }

  for (const sentence of [
    "the owner merges it.",
    "waiting for you to confirm the account id.",
    "over to you.",
    "this needs your approval before I deploy.",
    "ready for you to run the migration.",
    "I've reviewed the plan and need you to approve the prod deploy.",
    "Here are the logs for your review of the incident.",
    "Please review the incident timeline and tell me which alarm to keep.",
    "You should review the IAM policy before I deploy.",
    "Could you review the deploy plan and approve it?",
    "This needs your sign-off to push to prod.",
    "I sent the doc to Alice for review.",
  ]) {
    test(`not about the review: ${sentence}`, () => {
      expect(isReviewHandoff(sentence)).toBe(false);
    });
  }
});
