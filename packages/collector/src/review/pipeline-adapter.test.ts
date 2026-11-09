import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { testTempDir } from "../test-support/temp-dirs.js";
import {
  createReviewPacket,
  findDraftReviewPacketForLaunch,
  getPendingSteers,
  getPipelineRun,
  getReviewPacket,
  personaJobForLaunch,
  submitReviewPacket,
} from "@standup/store";
import { pipelineReadyBlock, pipelineStopDecision } from "../pipeline/engine.js";
import {
  EVIDENCE,
  OWNER,
  REVIEW_DRAFT,
  WORKTREE,
  advance,
  decideHumanReview,
  human,
  makeWorld,
  post,
  type World,
} from "../pipeline/test-world.js";
import { HUMAN_REVIEW_STOP_REASON } from "./pipeline-adapter.js";
import { setActiveProjectLayout, workspaceProjectLayout } from "../project-layout/layout.js";

/*
 * The human_review stage wired into the delivery pipeline: the run is held
 * short of code_review until the owner's review packet is submitted — the hold opens
 * the packet's draft and briefs the worker — the worker can't decide its own
 * review through pipeline_advance, and the owner's decision in the Review tab
 * is what passes the stage (approval) or loops it back to coding.
 */

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

/** Runs `git <args>` in `cwd` and returns its output, failing the test when git does. */
function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

const headOf = (dir: string) => git(dir, ["rev-parse", "HEAD"]);

function commitFile(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", `add ${name}`]);
}

/** A checkout on a feature branch with one commit of its own over `main`. */
function repoWithChange(): string {
  const dir = testTempDir("standup-review-adapter-");
  git(dir, ["init", "--initial-branch=main"]);
  commitFile(dir, "a.txt", "a\n");
  git(dir, ["checkout", "-b", "feature"]);
  commitFile(dir, "b.txt", "b\n");
  return dir;
}

/** Drives the run to the advance that would take it into code_review, which the missing packet holds back. */
async function toPacketHold(w: World) {
  w.changed.files = ["packages/collector/a.ts"];
  await advance(w, "start");
  await advance(w, "coding", EVIDENCE.coding);
  await advance(w, "validation", EVIDENCE.validationPass);
  await advance(w, "review", EVIDENCE.reviewClean);
  const held = await advance(w, "deploy", EVIDENCE.deploy);
  expect(held.status).toBe(422);
  return held;
}

/** The worker submitting the draft the hold opened, then moving the run on through code_review into human_review. */
async function submitAndEnterReview(w: World) {
  const draft = findDraftReviewPacketForLaunch(w.store.db, OWNER, w.launch.id)!;
  expect(submitReviewPacket(w.store.db, { id: draft.id, owner: OWNER, draft: REVIEW_DRAFT })).toBeTruthy();
  expect((await advance(w, "deploy", EVIDENCE.deploy)).status).toBe(200);
  const res = await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" });
  expect(res.body.to).toBe("human_review");
  return draft.id;
}

/** Drives a worker's run from start to the human_review stage behind code_review, its packet in the Review tab. */
async function toHumanReview(w: World) {
  await toPacketHold(w);
  return submitAndEnterReview(w);
}

// These runs are of a plain git project whose ticket carries an issue id: its
// code_review stage applies, and its packet owes no review link, so the packet
// is asked for before code_review. A linked-review project's packet waits until
// after code_review (see pipeline-code-review-packet-order.test.ts). They are
// pinned to the full preset, since a plain git project's own preset is light,
// with no deploy or code_review stage.
const FULL = { preset: "full" } as const;

describe("the human_review stage of a run", () => {
  test("the hold for a packet opens the owner's draft and steers the worker with the review brief, once", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1" });
    await toPacketHold(w);
    const packet = findDraftReviewPacketForLaunch(w.store.db, OWNER, w.launch.id)!;
    expect(packet).toMatchObject({ owner: OWNER, launchId: w.launch.id, pipelineRunId: w.run.id, status: "draft", revision: 0 });
    const steers = getPendingSteers(w.store.db, w.sessionId);
    expect(steers).toHaveLength(1);
    expect(steers[0]!.audience).toBe(OWNER);
    expect(steers[0]!.body).toContain(`Review packet: ${packet.id}`);
    expect(steers[0]!.body).toContain("submit_review_packet");
    expect(w.broadcasts.some((m) => m.type === "steer:queued" && m.audience === OWNER && m.requireProof === true)).toBe(true);
    // Held again, the worker isn't briefed a second time.
    expect((await advance(w, "deploy", EVIDENCE.deploy)).status).toBe(422);
    expect(getPendingSteers(w.store.db, w.sessionId)).toHaveLength(1);

    // Entering human_review with the packet waiting opens nothing more.
    await submitAndEnterReview(w);
    expect(findDraftReviewPacketForLaunch(w.store.db, OWNER, w.launch.id)).toBeNull();

    // A decided packet is never reopened: after changes are requested the
    // rework is held again for a fresh packet.
    await decideHumanReview(w, "changes_requested");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    expect((await advance(w, "deploy", EVIDENCE.deploy)).status).toBe(422);
    const reopened = findDraftReviewPacketForLaunch(w.store.db, OWNER, w.launch.id)!;
    expect(reopened.id).not.toBe(packet.id);
    expect(reopened).toMatchObject({ launchId: w.launch.id, status: "draft", revision: 0 });
  });

  test("the steered brief names the launch's scratch dir and its whole worktree, a provisioned workspace's too", async () => {
    const scratch = (w: World) => w.deps.reviewScratchDir(w.launch.id)!;
    // The brief names a worktree only while it is a real directory.
    mkdirSync(WORKTREE, { recursive: true });
    const own = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1" });
    await toHumanReview(own);
    const ownBrief = getPendingSteers(own.store.db, own.sessionId)[0]!.body;
    expect(ownBrief).toContain(`Review scratch dir: ${scratch(own)} — save screenshots and recordings here, or inside the worktree, ${WORKTREE};`);
    expect(statSync(scratch(own)).isDirectory()).toBe(true);

    // A workspace root with one package checked out under packages/ (the workspace layout), which the world's git fakes read.
    const workspace = testTempDir("standup-review-workspace-");
    mkdirSync(join(workspace, "packages", "pkg-a", ".git"), { recursive: true });
    setActiveProjectLayout(workspaceProjectLayout({ packagesDir: "packages" }));
    try {
      const provisioned = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1", provisioned: true, worktree: workspace });
      await toHumanReview(provisioned);
      const provBrief = getPendingSteers(provisioned.store.db, provisioned.sessionId)[0]!.body;
      expect(provBrief).toContain(`Review scratch dir: ${scratch(provisioned)} — save screenshots and recordings here, or inside the worktree, ${workspace};`);
      expect(provBrief).not.toContain("none for this launch");
    } finally {
      setActiveProjectLayout();
    }
  });

  test("a worker reporting its own approval is refused and the run stays at human_review", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1" });
    const packetId = await toHumanReview(w);

    const unknown = await advance(w, "human_review", { packetId: "01999999-0000-4000-8000-000000000000", decision: "approved" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toContain("Unknown review packet");

    // Its own packet, which the owner hasn't decided: not a decision either.
    const undecided = await advance(w, "human_review", { packetId, decision: "approved" });
    expect(undecided.status).toBe(409);
    expect(undecided.body.error).toContain("Only the owner decides a review");
    expect(runOf(w)).toMatchObject({ currentStage: "human_review", status: "active" });
    expect(getReviewPacket(w.store.db, packetId, OWNER)!.status).toBe("pending");
  });

  test("a worker at human_review with no packet submitted is told to submit it", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, persona: true, issueId: "ISSUE-1" });
    await toPacketHold(w);
    // The owner waives the run past the hold; the Review tab is still empty.
    const waive = (stage: string) => post(w, `/api/pipeline/runs/${w.run.id}/waive`, { stage, reason: "the owner moves it on" }, human(w));
    expect((await waive("deploy")).status).toBe(200);
    expect((await waive(runOf(w).currentStage)).status).toBe(200);
    expect(runOf(w).currentStage).toBe("human_review");
    // Nothing is in the owner's Review tab yet, so the run must not claim to need them.
    const blocked = pipelineStopDecision(w.store.db, w.sessionId, w.deps);
    expect(blocked?.reason).toContain("submit_review_packet");
    expect(runOf(w)).toMatchObject({ currentStage: "human_review", status: "active" });
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
  });

  test("a worker that stops once its packet is in the Review tab hands the run to its owner", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, persona: true, issueId: "ISSUE-1" });
    const packetId = await toHumanReview(w);
    const draft = { id: packetId };
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input", waitingReason: HUMAN_REVIEW_STOP_REASON });
    // Persona is told; its job stays active while the packet waits in the Review tab.
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
    expect(w.broadcasts.filter((m) => m.type === "pipeline:blocked").at(-1)?.payload).toMatchObject({ stage: "human_review" });
    // Nothing of the worker's is outstanding, so its work can still be marked ready.
    expect(await pipelineReadyBlock(w.store.db, w.launch.id, w.deps)).toBeNull();
    // The owner's decision still moves the waiting run on.
    expect((await post(w, `/api/reviews/${draft.id}/approve`, {}, human(w))).status).toBe(200);
    expect(runOf(w).status).toBe("complete");
  });

  test("the owner's approval in the Review tab completes the run", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1" });
    await toHumanReview(w);
    const decided = await decideHumanReview(w, "approved");
    expect(decided.status).toBe(200);
    expect(decided.body.pipeline).toMatchObject({ runId: w.run.id, ok: true });
    const run = runOf(w);
    expect(run).toMatchObject({ currentStage: "complete", status: "complete" });
    const attempt = run.attempts.at(-1)!;
    expect(attempt).toMatchObject({ stageId: "human_review", status: "passed", nextStage: "complete" });
    expect(attempt.evidence).toMatchObject({ packetId: decided.packetId, decision: "approved" });
  });

  test("approving a packet the checkout moved past is refused before it is recorded, and the worker is asked to resubmit", async () => {
    const dir = repoWithChange();
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1", worktree: dir });
    const packetId = await toHumanReview(w);
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE id = ?", [headOf(dir), packetId]);
    // The worker commits more on top of what the packet showed the owner.
    commitFile(dir, "unreviewed.txt", "not in the packet\n");
    const decided = await decideHumanReview(w, "approved");
    expect(decided.status).toBe(409);
    expect(decided.body.error).toContain("no longer shows the change as it stands");
    // Nothing was recorded: the packet still waits on the owner, the run at human review.
    expect(getReviewPacket(w.store.db, packetId, OWNER)!.status).toBe("pending");
    expect(runOf(w).currentStage).toBe("human_review");
    expect(getPendingSteers(w.store.db, w.sessionId).at(-1)!.body).toContain("resubmit the review packet");
    // Once the worker resubmits at the commit it stands at, the approval passes.
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE id = ?", [headOf(dir), packetId]);
    expect((await decideHumanReview(w, "approved")).status).toBe(200);
    expect(runOf(w).status).toBe("complete");
  });

  test("approving a packet over uncommitted edits is refused", async () => {
    const dir = repoWithChange();
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1", worktree: dir });
    const packetId = await toHumanReview(w);
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE id = ?", [headOf(dir), packetId]);
    writeFileSync(join(dir, "b.txt"), "edited after the packet\n");
    expect((await decideHumanReview(w, "approved")).status).toBe(409);
    expect(runOf(w).currentStage).toBe("human_review");
  });

  test("a stale approval a worker reports itself doesn't pass the stage", async () => {
    const dir = repoWithChange();
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1", worktree: dir });
    const packetId = await toHumanReview(w);
    w.store.db.run("UPDATE review_packets SET commit_sha = ?, status = 'approved', decided_at = ? WHERE id = ?", [
      headOf(dir),
      new Date().toISOString(),
      packetId,
    ]);
    commitFile(dir, "unreviewed.txt", "not in the packet\n");
    const res = await advance(w, "human_review", { packetId, decision: "approved" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("doesn't cover the change as it stands");
    expect(runOf(w).currentStage).toBe("human_review");
  });

  test("a worker reporting the approval of a packet a newer one superseded is refused", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1" });
    const first = await toHumanReview(w);
    // An approval of the older packet, then a newer packet for the same launch.
    w.store.db.run("UPDATE review_packets SET status = 'approved', decided_at = ? WHERE id = ?", [new Date().toISOString(), first]);
    const newer = createReviewPacket(w.store.db, { owner: OWNER, launchId: w.launch.id, sessionId: w.sessionId, projectId: "proj" });
    expect(submitReviewPacket(w.store.db, { id: newer.id, owner: OWNER, draft: REVIEW_DRAFT })).toBeTruthy();
    w.store.db.run("UPDATE review_packets SET status = 'approved' WHERE id = ?", [first]);
    const res = await advance(w, "human_review", { packetId: first, decision: "approved" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("superseded");
    expect(runOf(w).currentStage).toBe("human_review");
  });

  test("the owner requesting changes sends the run back to coding", async () => {
    const w = makeWorld({ reviewArtifact: null, override: FULL, issueId: "ISSUE-1" });
    await toHumanReview(w);
    const decided = await decideHumanReview(w, "changes_requested", "the retry still drops the last event");
    expect(decided.status).toBe(200);
    expect(decided.body.pipeline).toMatchObject({ runId: w.run.id, ok: true });
    const run = runOf(w);
    expect(run).toMatchObject({ currentStage: "coding", status: "active" });
    expect(run.attempts.at(-1)).toMatchObject({ stageId: "human_review", status: "failed", nextStage: "coding" });
    // The worker hears what to change, addressed to the owner like the brief.
    const steer = getPendingSteers(w.store.db, w.sessionId).at(-1)!;
    expect(steer.body).toContain("the retry still drops the last event");
    expect(steer.audience).toBe(OWNER);
  });
});
