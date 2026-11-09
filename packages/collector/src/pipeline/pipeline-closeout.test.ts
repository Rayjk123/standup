import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { testTempDir } from "../test-support/temp-dirs.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { DEFAULT_ORG_PROFILE } from "../org-profile/default.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import {
  createLaunch,
  createReviewPacket,
  decideReviewPacket,
  getPendingSteers,
  getPersonaJob,
  getPipelineRun,
  linkPersonaJobLaunch,
  pendingReviewPacketsForJob,
  personaJobForLaunch,
  submitReviewPacket,
  updatePersonaJob,
} from "@standup/store";
import type { Launch, PipelineRun, PipelineWaiverEvidence } from "@standup/shared";
import { pipelineWaivers } from "@standup/shared";
import {
  closeLandedPipelines,
  decidePipelineStage,
  formatPipelineInstruction,
  pipelineReworkRequested,
  approvalIsCurrent,
  gitBranchLanded,
  gitChangedFiles,
  landedCloses,
  type LandingGit,
  markRunWaiting,
  pipelineDoneRefusal,
  pipelineStopDecision,
  settleNotApplicableRuns,
  startPipelineForLaunch,
} from "./engine.js";
import { codeReviewNotApplicable } from "./runners.js";
import {
  EVIDENCE,
  OWNER,
  REVIEW_DRAFT,
  advance,
  human,
  makeWorld,
  plainGitRepo,
  post,
  submitPacket,
  writeTinyPng,
  type World,
} from "./test-world.js";

/*
 * Closing a job out when the pipeline can't finish itself: a code_review stage on a
 * project with no code review to cut settles itself, and work that landed
 * outside the pipeline (an approved review packet, or a branch merged into its
 * target) closes the job done with the stages the merge made moot recorded as
 * waived.
 */

/**
 * The full preset, pinned for plain git worlds (whose own preset is light,
 * with no deploy or code_review stage): these tests are about a code_review
 * stage that can't apply settling itself, the safety net for full runs on such
 * projects. The default world's project is pinned to the generic code review
 * adapter: a reviewed project, whose code_review stage applies.
 */
const FULL = { preset: "full" } as const;

// Remotes on code.example.corp are on a code-review host under the example.corp profile.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;
const stageOfRun = (run: PipelineRun, stageId: string) => run.attempts.filter((a) => a.stageId === stageId);

/** Drives the worker's run from start to the stage behind screenshots (the code_review stage). */
async function toCodeReview(w: World) {
  w.changed.files = ["packages/collector/src/x.ts"];
  await advance(w, "start");
  await advance(w, "coding", EVIDENCE.coding);
  await advance(w, "validation", EVIDENCE.validationPass);
  await advance(w, "review", EVIDENCE.reviewClean);
  // The run can't reach review without the packet the owner reviews.
  submitPacket(w);
  return advance(w, "deploy", EVIDENCE.deploy);
}

/** A second launch of the world's project, linked to the job its first launch belongs to. */
function followUpLaunch(w: World, branch = "standup/follow-up"): Launch {
  const launch = createLaunch(w.store.db, {
    id: randomUUID(),
    projectId: "proj",
    task: "follow up",
    worktreePath: `/tmp/standup-pipeline-test/${randomUUID()}`,
    branch,
    baseBranch: "main",
    status: "running",
    requester: OWNER,
    launchedBy: OWNER,
  });
  const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
  linkPersonaJobLaunch(w.store.db, job.id, launch.id);
  return launch;
}

describe("a code_review stage with no code review to cut settles itself", () => {
  test("a run reaching code_review on a plain git project skips it, recorded with the reason", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    const res = await toCodeReview(w);
    // deploy passed into code_review, which skipped itself on to the owner's review.
    expect(res.body.to).toBe("human_review");
    const run = runOf(w);
    expect(run.currentStage).toBe("human_review");
    expect(run.status).toBe("active");
    const stage = stageOfRun(run, "code_review").at(-1)!;
    expect(stage.status).toBe("skipped");
    expect(stage.reason).toContain("has no code review to cut");
    // Never passed, and the owner was never asked for an issue id.
    expect(stage.status).not.toBe("passed");
    expect(run.waitingReason).toBeUndefined();
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
  });

  test("the worker's brief on a plain git project never asks for an issue id", () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    const reason = codeReviewNotApplicable(w.store.db, w.run, w.launch);
    expect(reason).toContain("has no code review to cut");
    const brief = formatPipelineInstruction(w.run.definition, { codeReviewNotApplicable: reason });
    expect(brief).not.toContain("issue id from the owner");
    expect(brief).not.toMatch(/ask_human for it/);
    expect(brief).toContain("no issue id is needed");
    // A reviewed project whose review tool takes an issue id (the example.corp
    // cut command names {issueId}) still asks for it.
    const reviewed = makeWorld();
    expect(codeReviewNotApplicable(reviewed.store.db, reviewed.run, reviewed.launch)).toBeNull();
    expect(formatPipelineInstruction(reviewed.run.definition, { codeReviewNotApplicable: null })).toContain("issue id from the owner");
  });

  test("a reviewed project whose review tool takes no issue id never asks for one", () => {
    setActiveOrgProfile(DEFAULT_ORG_PROFILE);
    try {
      const reviewed = makeWorld();
      expect(codeReviewNotApplicable(reviewed.store.db, reviewed.run, reviewed.launch)).toBeNull();
      const stage = reviewed.run.definition.stages.find((s) => s.id === "code_review")!;
      expect(stage.ownerInput).toBeUndefined();
      const brief = formatPipelineInstruction(reviewed.run.definition, { codeReviewNotApplicable: null });
      expect(brief).toContain("code_review");
      expect(brief).not.toContain("issue id from the owner");
      expect(brief).not.toMatch(/ask_human for it/);
    } finally {
      setActiveOrgProfile(exampleCorpProfile());
    }
  });

  test("a reviewed project still runs its code_review stage and waits on the owner's issue id", async () => {
    const w = makeWorld();
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("code_review");
    const refused = await advance(w, "code_review", { reviewId: "R-1" });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("issue id");
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
  });

  test("work already merged upstream at a reviewed project's code_review stage points the owner at closing, not at an issue id", async () => {
    const dir = testTempDir("standup-landed-review-");
    const run = (args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
      });
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    };
    run(["init", "--initial-branch=main"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    run(["add", "."]);
    run(["commit", "-m", "first"]);
    run(["checkout", "-b", "standup/thing"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    run(["add", "."]);
    run(["commit", "-m", "the change"]);
    const remote = testTempDir("standup-origin-");
    run(["clone", "--bare", dir, remote]);
    run(["remote", "add", "origin", remote]);
    run(["fetch", "origin"]);

    const w = makeWorld({ worktree: dir, persona: true });
    // The run reaches code_review with its packet still pending, and waits on an issue id.
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("code_review");
    expect((await advance(w, "code_review", { reviewId: "R-1" })).status).toBe(422);
    expect(runOf(w).waitingReason).toContain("issue id");

    // Merged upstream outside the pipeline: the ask turns into a close.
    run(["push", "origin", "standup/thing:main"]);
    run(["fetch", "origin"]);
    pipelineStopDecision(w.store.db, w.sessionId, w.deps);
    const waiting = runOf(w);
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.waitingReason).toContain("already landed");
    expect(waiting.waitingReason).not.toContain("issue id");

    // The packet still pending doesn't hold the merged work's close back.
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    const closes = await landedCloses(w.store.db, job.id);
    expect(closes.map((c) => c.landing.via)).toEqual(["branch"]);
    expect(await pipelineDoneRefusal(w.store.db, job.id, undefined, closes)).toBeNull();
    expect(await closeLandedPipelines(w.store.db, job.id, "alice's Persona", w.deps, undefined, closes)).toHaveLength(1);
    expect(runOf(w).status).toBe("complete");
  });

  test("a worker's Stop at a code_review stage that doesn't apply never waits on an issue id", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    // The stage settled on entry, so the run is past code_review and its Stop is the
    // review stage's business, not a missing issue id.
    expect(runOf(w).currentStage).toBe("human_review");
    pipelineStopDecision(w.store.db, w.sessionId, w.deps);
    expect(runOf(w).waitingReason ?? "").not.toContain("issue id");
  });

  test("a run already waiting on the owner at code_review is settled by the boot sweep, and its job goes active", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    // The run reached code_review before Standup could tell the stage doesn't apply.
    await toCodeReview(w);
    const run = runOf(w);
    w.store.db.run("UPDATE pipeline_runs SET current_stage = 'code_review', status = 'active' WHERE id = ?", [run.id]);
    const stuck = getPipelineRun(w.store.db, run.id)!;
    expect(markRunWaiting(w.store.db, stuck, "code review stage needs an issue id from you", "owner_input", w.deps)).not.toBeNull();
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    // The block went to Persona: the job stays active, noted for Persona to decide.
    expect(getPersonaJob(w.store.db, job.id)).toMatchObject({ status: "active", note: expect.stringMatching(/^Persona deciding: /) });

    expect(await settleNotApplicableRuns(w.store.db, w.deps)).toBe(1);

    const settled = runOf(w);
    expect(settled.currentStage).toBe("human_review");
    expect(settled.status).toBe("active");
    expect(settled.waitingReason).toBeUndefined();
    expect(getPersonaJob(w.store.db, job.id)!.status).toBe("active");
  });

  test("a project pinned to GitHub PRs has no linked code review to cut either", async () => {
    const w = makeWorld({ reviewArtifact: "github-pr", project: { repos: [plainGitRepo()] }, override: FULL });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("human_review");
  });

  test("a pipeline without a code_review stage doesn't replay a send-back the run already acted on", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: { preset: "full", stages: { code_review: { skip: true } } } });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("human_review");
    const [packetId] = pendingReviewPacketsForJob(w.store.db, OWNER, personaJobForLaunch(w.store.db, w.launch.id)!.job.id, [w.launch.id]);
    const sentBack = await post(w, `/api/reviews/${packetId}/request-changes`, { comment: "redo it" }, human(w));
    expect(sentBack.status).toBe(200);
    expect(runOf(w).currentStage).toBe("coding");
    // The rework comes round to human review without a new packet: the old
    // send-back is not replayed, so the run waits there for the new one.
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("human_review");
    expect(stageOfRun(runOf(w), "human_review")).toHaveLength(1);
  });

  test("a project whose repo is on a code-review host keeps its code_review stage", async () => {
    const w = makeWorld({ reviewArtifact: null, project: { repos: [plainGitRepo("ssh://git@code.example.corp/pkg/MyPackage")] } });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("a local-only git repo (no remote at all) has no code review to cut either", async () => {
    const w = makeWorld({ reviewArtifact: null, project: { repos: [plainGitRepo(null)] }, override: FULL });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("human_review");
    expect(stageOfRun(runOf(w), "code_review").at(-1)?.reason).toContain("it has no git remote");
  });

  test("a project whose remote can't be read keeps its code_review stage", async () => {
    const w = makeWorld({ reviewArtifact: null, project: { repos: ["/tmp/standup-no-such-repo"] }, override: FULL });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("a ticket that carries an issue id keeps the code_review stage on a plain git project", async () => {
    const w = makeWorld({ reviewArtifact: null, issueId: "ISSUE-9", override: FULL });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("the sweep leaves a run whose code_review stage applies where it is", async () => {
    const w = makeWorld();
    await toCodeReview(w);
    expect(await settleNotApplicableRuns(w.store.db, w.deps)).toBe(0);
    expect(runOf(w).currentStage).toBe("code_review");
  });
});

describe("work that landed closes its job done", () => {
  /** The job of the world's first launch. */
  const jobOf = (w: World) => personaJobForLaunch(w.store.db, w.launch.id)!.job;

  /** The owner approving the launch's pending review packet (the one toCodeReview submitted). */
  function approvePacket(w: World): string {
    const [packetId] = pendingReviewPacketsForJob(w.store.db, OWNER, jobOf(w).id, [w.launch.id]);
    expect(packetId).toBeTruthy();
    const decided = decideReviewPacket(w.store.db, { id: packetId!, owner: OWNER, decision: "approved", actor: OWNER });
    expect(decided.ok).toBe(true);
    return packetId!;
  }

  /** The git a close reads: nothing changed, no branch landed, unless a test says otherwise. */
  const git = (over: Partial<LandingGit> = {}): LandingGit => ({
    changedFiles: async () => [],
    headState: async () => {
      throw new Error("no checkout");
    },
    branchLanded: async () => false,
    git: () => null,
    ...over,
  });

  /**
   * A checkout whose HEAD has moved past the packet's commit to a different
   * change: clean, at "d…", and its diff against the base differs from the
   * approved commit's.
   */
  const headMovedOn = (args: string[]): string | null => {
    if (args[0] === "status") return "";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "d".repeat(40);
    if (args[0] === "diff") return args.at(-1)!.endsWith("HEAD") ? "+ the rework" : "+ the approved change";
    return null;
  };

  const statusOf = (w: World, launchId: string) =>
    w.store.db.query("SELECT status, current_stage AS stage FROM pipeline_runs WHERE launch_id = ?").get(launchId) as {
      status: string;
      stage: string;
    };

  test("an approved review packet settles its own run; follow-ups that never started are moot", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    const packetId = approvePacket(w);
    // Two follow-up launches that never got past their start stage.
    const followUps = [followUpLaunch(w, "standup/follow-up-1"), followUpLaunch(w, "standup/follow-up-2")];
    for (const launch of followUps) {
      startPipelineForLaunch(w.store.db, { launchId: launch.id, owner: OWNER, projectId: "proj" });
    }

    const closes = await landedCloses(w.store.db, jobOf(w).id, git());
    expect(closes.find((c) => c.run.id === w.run.id)?.landing).toMatchObject({ via: "review_packet", packetId });
    expect(closes.filter((c) => c.landing.via === "moot")).toHaveLength(2);

    // The refusal check is read-only; the close itself settles the runs.
    expect(await pipelineDoneRefusal(w.store.db, jobOf(w).id, git())).toBeNull();
    expect(runOf(w).status).not.toBe("complete");
    const closed = await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, git());
    expect(closed).toHaveLength(3);

    const run = runOf(w);
    expect(run.status).toBe("complete");
    const waived = pipelineWaivers(run);
    expect(waived.length).toBeGreaterThan(0);
    expect(waived.every((wv) => wv.notApplicable === false)).toBe(true);
    const evidence = run.attempts.find((a) => a.status === "waived")!.evidence as PipelineWaiverEvidence;
    expect(evidence.waiver.landed).toMatchObject({ via: "review_packet", packetId });
    // An approval is recorded as one, not as a merge, and nothing as passed.
    expect(evidence.waiver.reason).toStartWith("approved:");
    expect(run.attempts.some((a) => a.stageId === "human_review" && a.status === "passed")).toBe(false);
    for (const launch of followUps) expect(statusOf(w, launch.id)).toMatchObject({ status: "complete", stage: "complete" });
  });

  test("a branch merged into its target settles its run as merged", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    // The packet was approved at another commit than the checkout stands at
    // now, so only the branch can show the work landed.
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE launch_id = ?", ["c".repeat(40), w.launch.id]);
    const asked: Array<{ branch: string; target: string }> = [];
    const closes = await landedCloses(
      w.store.db,
      jobOf(w).id,
      git({
        git: headMovedOn,
        branchLanded: async (_dir: string, branch: string, target: string) => {
          asked.push({ branch, target });
          return branch === w.launch.branch;
        },
      })
    );
    expect(closes.map((c) => c.landing)).toEqual([
      { via: "branch", branch: w.launch.branch, target: "main", why: `branch ${w.launch.branch} is merged into main` },
    ]);
    expect(asked).toContainEqual({ branch: w.launch.branch, target: "main" });
  });

  test("an approval the worker committed past doesn't settle the run", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE launch_id = ?", ["c".repeat(40), w.launch.id]);
    const headMoved = git({ git: headMovedOn });
    expect(await landedCloses(w.store.db, jobOf(w).id, headMoved)).toEqual([]);
    expect(await pipelineDoneRefusal(w.store.db, jobOf(w).id, headMoved)).toContain("cannot close done");
  });

  test("a packet submitted while the close was being checked rolls the whole close back", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const closes = await landedCloses(w.store.db, jobOf(w).id, git());
    expect(closes.map((c) => c.landing.via)).toEqual(["review_packet"]);
    // The worker puts a new packet in the Review tab before the close lands.
    submitPacket(w);
    expect(await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, git(), closes)).toEqual([]);
    expect(runOf(w).status).not.toBe("complete");
  });

  test("a commit made while the close was being checked rolls the whole close back", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const closes = await landedCloses(w.store.db, jobOf(w).id, git());
    expect(closes.map((c) => c.landing.via)).toEqual(["review_packet"]);
    // By the time the close runs the checkout has moved on to other code.
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE launch_id = ?", ["c".repeat(40), w.launch.id]);
    expect(await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, git({ git: headMovedOn }), closes)).toEqual([]);
    expect(runOf(w).status).not.toBe("complete");
  });

  test("an approval survives a rebase that leaves the change itself the same", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    w.store.db.run("UPDATE review_packets SET commit_sha = ? WHERE launch_id = ?", ["c".repeat(40), w.launch.id]);
    const rebased = (args: string[]): string | null => {
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "d".repeat(40);
      // The same change, with the index lines a rebase rewrites.
      if (args[0] === "diff") return `diff --git a/x b/x\nindex ${args.at(-1)!.slice(-4)}..1234\n@@ -1 +${args.at(-1)!.length} @@\n+ the change`;
      return null;
    };
    const closes = await landedCloses(w.store.db, jobOf(w).id, git({ git: rebased }));
    expect(closes.map((c) => c.landing.via)).toEqual(["review_packet"]);
  });

  test("an approval doesn't cover uncommitted edits on top of it", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const dirty = (args: string[]): string | null => (args[0] === "status" ? " M packages/collector/src/x.ts" : null);
    expect(await landedCloses(w.store.db, jobOf(w).id, git({ git: dirty }))).toEqual([]);
  });

  test("a close where one run moved meanwhile closes none of them", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const followUp = followUpLaunch(w, "standup/follow-up-race");
    startPipelineForLaunch(w.store.db, { launchId: followUp.id, owner: OWNER, projectId: "proj" });
    const closes = await landedCloses(w.store.db, jobOf(w).id, git());
    expect(closes).toHaveLength(2);
    // The follow-up's worker advances between the check and the close.
    w.store.db.run("UPDATE pipeline_runs SET updated_at = ? WHERE launch_id = ?", [new Date(Date.now() + 60_000).toISOString(), followUp.id]);
    expect(await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, git(), closes)).toEqual([]);
    expect(runOf(w).status).not.toBe("complete");
  });

  test("one launch landing never settles a follow-up with unlanded work of its own", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const followUp = followUpLaunch(w, "standup/follow-up-real");
    const run = startPipelineForLaunch(w.store.db, { launchId: followUp.id, owner: OWNER, projectId: "proj" });
    // It got past start and has a change of its own, not merged anywhere.
    w.store.db.run("UPDATE pipeline_runs SET current_stage = 'validation' WHERE id = ?", [run.id]);
    const changed = git({ changedFiles: async () => ["packages/collector/src/y.ts"] });

    const closes = await landedCloses(w.store.db, jobOf(w).id, changed);
    expect(closes.map((c) => c.run.launchId)).toEqual([w.launch.id]);
    const refusal = await pipelineDoneRefusal(w.store.db, jobOf(w).id, changed);
    expect(refusal).toContain(`launch ${followUp.id}`);
    await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, changed);
    expect(statusOf(w, followUp.id)).toMatchObject({ status: "active", stage: "validation" });
  });

  test("a follow-up that never started but changed files is not moot", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const followUp = followUpLaunch(w, "standup/follow-up-dirty");
    startPipelineForLaunch(w.store.db, { launchId: followUp.id, owner: OWNER, projectId: "proj" });
    const dirty = git({ changedFiles: async (path: string) => (path === followUp.worktreePath ? ["a.ts"] : []) });
    expect((await landedCloses(w.store.db, jobOf(w).id, dirty)).map((c) => c.run.launchId)).toEqual([w.launch.id]);
    expect(await pipelineDoneRefusal(w.store.db, jobOf(w).id, dirty)).toContain(`launch ${followUp.id}`);
  });

  test("nothing settles while one of the job's packets still waits on the owner", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const followUp = followUpLaunch(w, "standup/follow-up-in-review");
    const packet = createReviewPacket(w.store.db, { owner: OWNER, launchId: followUp.id, jobId: jobOf(w).id });
    expect(submitReviewPacket(w.store.db, { id: packet.id, owner: OWNER, draft: REVIEW_DRAFT })).toBeTruthy();
    expect(await landedCloses(w.store.db, jobOf(w).id, git())).toEqual([]);
  });

  test("an approval doesn't settle a run whose code review still has to be cut", async () => {
    const w = makeWorld({ persona: true });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("code_review");
    approvePacket(w);
    expect(await landedCloses(w.store.db, jobOf(w).id, git())).toEqual([]);
  });

  test("with a code review still to cut, only the remote target shows the branch landed", async () => {
    const w = makeWorld({ persona: true, project: { repos: [plainGitRepo("ssh://git@code.example.corp/pkg/MyPackage")] } });
    await toCodeReview(w);
    approvePacket(w);
    const asked: Array<{ remoteOnly?: boolean }> = [];
    await landedCloses(
      w.store.db,
      jobOf(w).id,
      git({
        branchLanded: async (_dir: string, _branch: string, _target: string, opts?: { remoteOnly?: boolean }) => {
          asked.push(opts ?? {});
          return false;
        },
      })
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((o) => o.remoteOnly === true)).toBe(true);
  });

  test("an approval made while the run waited at code_review is reported when it reaches human review", async () => {
    const w = makeWorld({ persona: true, issueId: "" });
    await toCodeReview(w);
    approvePacket(w);
    // The code review is cut with the owner's issue id after the approval came in.
    const res = await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" });
    expect(res.status).toBe(200);
    const run = runOf(w);
    expect(run).toMatchObject({ currentStage: "complete", status: "complete" });
    expect(run.attempts.at(-1)).toMatchObject({ stageId: "human_review", status: "passed" });
    // No second packet was opened for the owner to review again.
    expect(w.store.db.query("SELECT COUNT(*) AS n FROM review_packets WHERE launch_id = ? AND status = 'draft'").get(w.launch.id)).toEqual({ n: 0 });
  });

  test("an approval given before the work was sent back doesn't pass the reworked run", async () => {
    const w = reviewHostGitWorld({ persona: true, issueId: "" });
    await toCodeReview(w);
    approvePacket(w);
    // A person sends the work back after approving: a new epoch of rework.
    const reworked = await pipelineReworkRequested(w.store.db, w.launch.id, w.deps);
    expect(reworked?.currentStage).toBe("coding");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    // The old approval doesn't let the rework into code_review: it needs a fresh packet.
    const held = await advance(w, "deploy", EVIDENCE.deploy);
    expect(held.status).toBe(422);
    expect(held.body.error).toContain("can't move on to code_review");
    expect(runOf(w).currentStage).toBe("deploy");
  });

  test("changes requested while the run waited at code_review send it back to coding on reaching human review", async () => {
    const w = makeWorld({ persona: true, issueId: "" });
    await toCodeReview(w);
    const [packetId] = pendingReviewPacketsForJob(w.store.db, OWNER, jobOf(w).id, [w.launch.id]);
    expect(decideReviewPacket(w.store.db, { id: packetId!, owner: OWNER, decision: "changes_requested", actor: OWNER, comment: "redo it" }).ok).toBe(true);
    await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" });
    expect(runOf(w)).toMatchObject({ currentStage: "coding", status: "active" });
  });

  test("follow-ups alone settle nothing: something has to have landed", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await advance(w, "start");
    expect(await landedCloses(w.store.db, jobOf(w).id, git())).toEqual([]);
  });

  test("a job whose work hasn't landed is still refused, naming the stages", async () => {
    const w = makeWorld({ persona: true });
    await toCodeReview(w);
    const refusal = await pipelineDoneRefusal(w.store.db, jobOf(w).id, git({ changedFiles: async () => ["packages/collector/src/x.ts"] }));
    expect(refusal).toContain("cannot close done");
    expect(refusal).toContain("code_review");
    expect(runOf(w).status).not.toBe("complete");
  });

  test("closing a landed job twice leaves the first close's record alone", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    approvePacket(w);
    const first = await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, git());
    expect(first).toHaveLength(1);
    const attempts = runOf(w).attempts.length;
    expect(await closeLandedPipelines(w.store.db, jobOf(w).id, "alice's Persona", w.deps, git())).toHaveLength(0);
    expect(runOf(w).attempts).toHaveLength(attempts);
  });
});

describe("gitBranchLanded reads a real checkout", () => {
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

  /** A repo on `main` with one commit, and a `feature` branch with one commit of its own. */
  function repoWithFeature(): string {
    const dir = testTempDir("standup-landed-");
    git(dir, ["init", "--initial-branch=main"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "first"]);
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "the change"]);
    git(dir, ["checkout", "main"]);
    return dir;
  }

  test("a branch merged into main has landed; an unmerged one has not", async () => {
    const dir = repoWithFeature();
    expect(await gitBranchLanded(dir, "feature", "main")).toBe(false);
    git(dir, ["merge", "--no-ff", "-m", "merge feature", "feature"]);
    expect(await gitBranchLanded(dir, "feature", "main")).toBe(true);
  });

  test("a branch reset onto main after its work was abandoned has not landed", async () => {
    const dir = repoWithFeature();
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "main moves on"]);
    // The feature's commit is dropped and the branch now sits on main's tip.
    git(dir, ["branch", "-f", "feature", "main"]);
    expect(await gitBranchLanded(dir, "feature", "main")).toBe(false);
  });

  test("a branch rebased onto main and merged has landed", async () => {
    const dir = repoWithFeature();
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "main moves on"]);
    git(dir, ["checkout", "feature"]);
    git(dir, ["rebase", "main"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["merge", "--ff-only", "feature"]);
    expect(await gitBranchLanded(dir, "feature", "main")).toBe(true);
  });

  /** The commit `rev` names in `dir`. */
  function sha(dir: string, rev = "HEAD"): string {
    return Bun.spawnSync(["git", "rev-parse", rev], { cwd: dir, stdout: "pipe" }).stdout.toString().trim();
  }

  /** A launch on the `feature` branch checked out in `dir`, as approvalIsCurrent reads it. */
  const launchIn = (dir: string) => ({ worktreePath: dir, baseBranch: "main", branch: "feature" }) as Launch;

  test("an approval survives rebasing the change onto a newer main", () => {
    const dir = repoWithFeature();
    git(dir, ["checkout", "feature"]);
    const approved = sha(dir);
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "main moves on"]);
    git(dir, ["checkout", "feature"]);
    git(dir, ["rebase", "main"]);
    expect(sha(dir)).not.toBe(approved);
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved })).toBe(true);
  });

  test("an approval doesn't cover a different change, binary content included", () => {
    const dir = repoWithFeature();
    git(dir, ["checkout", "feature"]);
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "add a logo"]);
    const approved = sha(dir);
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]));
    git(dir, ["add", "."]);
    git(dir, ["commit", "--amend", "-m", "add a logo"]);
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved })).toBe(false);
  });

  /** A `main` with a 20-line function in f.ts, and a `feature` branch off it. */
  function repoWithFunction(): string {
    const dir = testTempDir("standup-landed-");
    git(dir, ["init", "--initial-branch=main"]);
    const body = Array.from({ length: 20 }, (_, i) => `  line${i + 1};`);
    writeFileSync(join(dir, "f.ts"), ["function a() {", ...body, "}", ""].join("\n"));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "first"]);
    git(dir, ["checkout", "-b", "feature"]);
    return dir;
  }

  /** Inserts `line` into f.ts after body line `after`. */
  function insertAfter(dir: string, after: number, line: string): void {
    const text = readFileSync(join(dir, "f.ts"), "utf8").split("\n");
    text.splice(after + 1, 0, line);
    writeFileSync(join(dir, "f.ts"), text.join("\n"));
  }

  test("an approval doesn't cover the same lines added somewhere else", () => {
    const dir = repoWithFunction();
    insertAfter(dir, 1, "  if (!authorized) return;");
    git(dir, ["commit", "-am", "guard"]);
    const approved = sha(dir);
    git(dir, ["reset", "--hard", "main"]);
    insertAfter(dir, 18, "  if (!authorized) return;");
    git(dir, ["commit", "-am", "guard"]);
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved })).toBe(false);
  });

  test("an approval survives a rebase that changes only the enclosing function git names in the hunk", () => {
    const dir = repoWithFunction();
    insertAfter(dir, 15, "  if (!authorized) return;");
    git(dir, ["commit", "-am", "guard"]);
    const approved = sha(dir);
    git(dir, ["checkout", "main"]);
    // A new function header above the hunk, outside its context lines: the
    // hunk header now names it, though the change is the same.
    insertAfter(dir, 5, "function inserted() {");
    git(dir, ["commit", "-am", "main moves on"]);
    git(dir, ["checkout", "feature"]);
    git(dir, ["rebase", "main"]);
    expect(sha(dir)).not.toBe(approved);
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved })).toBe(true);
  });

  test("where a code review is cut, an approval is read against the remote base, not a local one moved under it", () => {
    const dir = repoWithFeature();
    // An origin on a code-review host, last fetched where main is now.
    git(dir, ["remote", "add", "origin", "ssh://git@code.example.corp/pkg/Demo"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "main"]);
    git(dir, ["checkout", "feature"]);
    const approved = sha(dir);
    // Local main gains a commit the owner never saw; the branch is rebased onto it.
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "c2.txt"), "unreviewed\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "C2"]);
    git(dir, ["checkout", "feature"]);
    git(dir, ["rebase", "main"]);
    // A reviewed project's run: its code review is cut against origin/main, where C2 now rides along.
    const reviewed = makeWorld();
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved }, undefined, reviewed.run, reviewed.store.db)).toBe(false);
    // The same checkout with its origin on GitHub is a plain git project's,
    // which lands on its local main, so the local base counts there.
    git(dir, ["remote", "set-url", "origin", "https://github.com/example/demo.git"]);
    const plain = makeWorld({ reviewArtifact: null, project: { repos: [plainGitRepo()] } });
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved }, undefined, plain.run, plain.store.db)).toBe(true);
  });

  test("a code-review project's checkout with no code-review-host origin still keeps an approval across a rebase onto its local base", () => {
    const dir = repoWithFeature();
    git(dir, ["checkout", "feature"]);
    const approved = sha(dir);
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "main moves on"]);
    git(dir, ["checkout", "feature"]);
    git(dir, ["rebase", "main"]);
    // Pinned to the generic code review adapter, but this checkout has no origin to cut against.
    const reviewed = makeWorld();
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved }, undefined, reviewed.run, reviewed.store.db)).toBe(true);
  });

  test("an approval doesn't cover new commits hidden by moving the base up to HEAD", () => {
    const dir = repoWithFeature();
    git(dir, ["checkout", "feature"]);
    const approved = sha(dir);
    writeFileSync(join(dir, "unreviewed.txt"), "x\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "unreviewed"]);
    // Both three-dot diffs against main are now empty.
    git(dir, ["update-ref", "refs/heads/main", "HEAD"]);
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved })).toBe(false);
  });

  test("an approval doesn't cover uncommitted edits to tracked files", () => {
    const dir = repoWithFeature();
    git(dir, ["checkout", "feature"]);
    const approved = sha(dir);
    writeFileSync(join(dir, "b.txt"), "edited\n");
    expect(approvalIsCurrent(launchIn(dir), { commitSha: approved })).toBe(false);
  });

  test("a branch with no commit of its own never counts as landed", async () => {
    const dir = testTempDir("standup-landed-");
    git(dir, ["init", "--initial-branch=main"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "first"]);
    git(dir, ["branch", "empty"]);
    expect(await gitBranchLanded(dir, "empty", "main")).toBe(false);
  });

  test("an unknown branch or target reads as not landed", async () => {
    const dir = repoWithFeature();
    expect(await gitBranchLanded(dir, "no-such-branch", "main")).toBe(false);
    expect(await gitBranchLanded(dir, "feature", "no-such-target")).toBe(false);
  });

  test("changed files come from the newest base, so merges never pushed don't join the change", async () => {
    const dir = repoWithFeature();
    // A remote left where main was before the local merges, as a host that
    // merges locally and never pushes has.
    const remote = testTempDir("standup-origin-");
    git(dir, ["clone", "--bare", dir, remote]);
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["fetch", "origin"]);
    git(dir, ["merge", "--no-ff", "-m", "merge feature", "feature"]);
    writeFileSync(join(dir, "landed.txt"), "landed\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "another merge's file"]);
    git(dir, ["checkout", "-b", "standup/next"]);
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "my change"]);

    expect(await gitChangedFiles(dir, "main")).toEqual(["mine.txt"]);
  });

  test("a local base branch behind its remote isn't the base either", async () => {
    const dir = repoWithFeature();
    writeFileSync(join(dir, "landed.txt"), "landed\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "landed on main"]);
    const remote = testTempDir("standup-origin-");
    git(dir, ["clone", "--bare", dir, remote]);
    git(dir, ["remote", "add", "origin", remote]);
    git(dir, ["fetch", "origin"]);
    // Local main is now a commit behind origin/main, and the work is based on
    // the remote: the older local base would drag landed.txt into the change.
    git(dir, ["reset", "--hard", "HEAD~1"]);
    git(dir, ["checkout", "-b", "standup/next", "origin/main"]);
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "my change"]);

    expect(await gitChangedFiles(dir, "main")).toEqual(["mine.txt"]);
  });
});

/**
 * A plain git project whose remote is on a code-review host: its code_review
 * stage applies, and its packet owes no linked code review, so the packet is
 * asked for before code_review. (A project pinned to the generic adapter has
 * its packet follow its code review, see
 * pipeline-code-review-packet-order.test.ts.)
 */
const reviewHostGitWorld = (opts: Parameters<typeof makeWorld>[0] = {}) =>
  makeWorld({ reviewArtifact: null, project: { repos: [plainGitRepo("ssh://git@code.example.corp/pkg/Thing")] }, ...opts });

describe("nothing reaches the owner for review without a packet", () => {
  /** Drives the run to the stage before code_review without putting a packet in the Review tab. */
  async function toDeploy(w: World, files = ["packages/collector/src/x.ts"]) {
    w.changed.files = files;
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
  }

  test("the move into code_review is refused, and goes through once the packet is submitted", async () => {
    const w = reviewHostGitWorld({ persona: true });
    await toDeploy(w);
    const refused = await advance(w, "deploy", EVIDENCE.deploy);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("can't move on to code_review");
    expect(refused.body.error).toContain("submit_review_packet");
    // The run is left where it was, with nothing recorded as passed at code_review.
    expect(runOf(w).currentStage).toBe("deploy");
    expect(stageOfRun(runOf(w), "code_review")).toHaveLength(0);

    submitPacket(w);
    const allowed = await advance(w, "deploy", EVIDENCE.deploy);
    expect(allowed.status).toBe(200);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("skipping the stages before code_review doesn't get the run past the gate", async () => {
    const w = reviewHostGitWorld();
    // A test-only change: nothing to deploy, and no UI to shoot, so the skip would land on code_review.
    await toDeploy(w, ["packages/collector/src/x.test.ts"]);
    const refused = await advance(w, "deploy", undefined, { reason: "nothing to deploy" });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("can't move on to code_review");
    expect(runOf(w).currentStage).toBe("deploy");

    submitPacket(w);
    expect((await advance(w, "deploy", undefined, { reason: "nothing to deploy" })).status).toBe(200);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("screenshots reported in the refused advance are named, since nothing of it is recorded", async () => {
    const w = reviewHostGitWorld();
    w.changed.files = ["packages/web/src/components/X.tsx"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("screenshot");
    const refused = await advance(w, "screenshot", { screenshots: [{ path: writeTinyPng() }, { path: writeTinyPng() }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("Attach the 2 screenshots you just reported");
    expect(stageOfRun(runOf(w), "screenshot")).toHaveLength(0);
  });

  test("the refusal names the screenshots the run recorded, which the packet carries", async () => {
    const w = reviewHostGitWorld({ override: { stages: { screenshot: { skip: true } } } });
    await toDeploy(w);
    const refused = await advance(w, "deploy", EVIDENCE.deploy);
    expect(refused.status).toBe(422);
    expect(refused.body.missing).toEqual(["a submitted review packet"]);
  });

  /** A run at its code_review stage, waiting on an issue id, with nothing in the Review tab. */
  async function atCodeReviewWithoutPacket(w: World) {
    await toDeploy(w);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    // The packet the run passed the gate with is gone from the Review tab.
    w.store.db.run("UPDATE review_packets SET status = 'superseded' WHERE launch_id = ?", [w.launch.id]);
    expect(runOf(w).currentStage).toBe("code_review");
  }

  test("a worker's Stop is blocked instead of telling the owner a review waits", async () => {
    const w = reviewHostGitWorld({ persona: true, issueId: "" });
    await atCodeReviewWithoutPacket(w);
    // The stage needs the owner's issue id, but handing it over would leave
    // them nothing to look at.
    const blocked = pipelineStopDecision(w.store.db, w.sessionId, w.deps);
    expect(blocked?.reason).toContain("can't hand this to the owner yet");
    expect(blocked?.reason).toContain("submit_review_packet");
    expect(runOf(w).status).toBe("active");
    expect(getPersonaJob(w.store.db, personaJobForLaunch(w.store.db, w.launch.id)!.job.id)!.status).toBe("active");
  });

  test("the brief a blocked Stop steers names the launch's scratch dir", async () => {
    const w = reviewHostGitWorld({ persona: true, issueId: "" });
    await atCodeReviewWithoutPacket(w);
    const scratch = `/d/review-scratch/${w.launch.id}`;
    expect(pipelineStopDecision(w.store.db, w.sessionId, { ...w.deps, reviewScratchDir: () => scratch })?.block).toBe(true);
    const brief = getPendingSteers(w.store.db, w.sessionId).at(-1)!.body;
    expect(brief).toContain(`Review scratch dir: ${scratch} — save screenshots and recordings here`);
  });

  test("the hand-off goes through as soon as the packet is there", async () => {
    const w = reviewHostGitWorld({ persona: true, issueId: "" });
    await atCodeReviewWithoutPacket(w);
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)?.block).toBe(true);
    submitPacket(w);
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
    expect(runOf(w).waitingReason).toContain("issue id");
  });

  test("a worker that keeps stopping without a packet reaches the owner as a stall, not a review", async () => {
    const w = reviewHostGitWorld({ persona: true, issueId: "" });
    await atCodeReviewWithoutPacket(w);
    for (let i = 0; i < 3; i++) {
      expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)?.reason).toContain("can't hand this to the owner yet");
    }
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    const stalled = runOf(w);
    expect(stalled).toMatchObject({ status: "waiting_user", waitingKind: "stalled" });
    expect(stalled.waitingReason).toContain("without submitting a review packet");
    expect(stalled.waitingReason ?? "").not.toContain("issue id");
  });

  test("a reviewed project's run at code_review asks the owner for its issue id without waiting on a packet it can't submit yet", async () => {
    const w = makeWorld({ persona: true, issueId: "" });
    await toDeploy(w);
    expect((await advance(w, "deploy", EVIDENCE.deploy)).status).toBe(200);
    expect(runOf(w).currentStage).toBe("code_review");
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
    expect(runOf(w).waitingReason).toContain("issue id");
  });
});

describe("a waiting job says what the owner can act on", () => {
  test("a pipeline-flagged job links to the run that waits", async () => {
    const w = makeWorld({ persona: true });
    await toCodeReview(w);
    const refused = await advance(w, "code_review", { reviewId: "R-1" });
    expect(refused.status).toBe(422);
    const job = getPersonaJob(w.store.db, personaJobForLaunch(w.store.db, w.launch.id)!.job.id)!;
    // The block goes to Persona: the job stays active, not in front of the owner.
    expect(job.status).toBe("active");
    expect(job.view!.state).not.toBe("needs_you");
    // Persona escalating it is what puts it in front of the owner, linked to the run.
    const escalated = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "code_review", kind: "escalate", reason: "the code review needs the owner's issue id", actor: "alice's Persona" },
      w.deps
    );
    expect(escalated.ok).toBe(true);
    const waiting = getPersonaJob(w.store.db, job.id)!;
    expect(waiting.view).toMatchObject({ state: "needs_you", needs: ["waiting"] });
    expect(waiting.view!.actions).toContainEqual({
      kind: "pipeline",
      id: w.run.id,
      label: "waive or unblock the delivery pipeline at code_review",
    });
  });

  test("a run waiting at human review on its packet links the packet, not a waiver", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    expect(runOf(w).currentStage).toBe("human_review");
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    // Persona hands the wait to the owner, whose job links the packet.
    const escalated = await decidePipelineStage(
      w.store.db,
      w.run.id,
      { stage: "human_review", kind: "escalate", reason: "the packet waits on the owner's decision", actor: "alice's Persona" },
      w.deps
    );
    expect(escalated.ok).toBe(true);
    const job = getPersonaJob(w.store.db, personaJobForLaunch(w.store.db, w.launch.id)!.job.id)!;
    expect(job.view!.actions!.map((a) => a.kind)).toEqual(["review"]);
  });

  test("a job with a review packet waiting links to it", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    const packet = createReviewPacket(w.store.db, { owner: OWNER, launchId: w.launch.id, jobId });
    expect(submitReviewPacket(w.store.db, { id: packet.id, owner: OWNER, draft: REVIEW_DRAFT })).toBeTruthy();
    expect(updatePersonaJob(w.store.db, jobId, { status: "waiting_user", note: "Pipeline needs you: the review packet" })).not.toBeNull();
    const job = getPersonaJob(w.store.db, jobId)!;
    expect(job.view!.actions).toContainEqual({
      kind: "review",
      id: packet.id,
      label: "decide the review packet in the Review tab",
    });
  });

  test("a worker hand-off waiting with nothing behind it doesn't show as needing the owner", () => {
    const w = makeWorld({ persona: true, disabled: true });
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    w.store.db.run("UPDATE persona_jobs SET status = 'waiting_user', waiting_since = ?, waiting_source = 'handoff' WHERE id = ?", [
      new Date().toISOString(),
      job.id,
    ]);
    const waiting = getPersonaJob(w.store.db, job.id)!;
    expect(waiting.view!.state).not.toBe("needs_you");
    expect(waiting.view!.actions).toBeUndefined();
  });

  test("every pending packet of the job is linked, however recently another was decided", async () => {
    const w = makeWorld({ reviewArtifact: null, persona: true, override: FULL });
    await toCodeReview(w);
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    const followUp = followUpLaunch(w, "standup/follow-up-review");
    const later = createReviewPacket(w.store.db, { owner: OWNER, launchId: followUp.id, jobId });
    expect(submitReviewPacket(w.store.db, { id: later.id, owner: OWNER, draft: REVIEW_DRAFT })).toBeTruthy();
    // The first launch's packet is decided after the second was submitted.
    const [first] = pendingReviewPacketsForJob(w.store.db, OWNER, jobId, [w.launch.id]);
    expect(decideReviewPacket(w.store.db, { id: first!, owner: OWNER, decision: "approved", actor: OWNER }).ok).toBe(true);
    expect(updatePersonaJob(w.store.db, jobId, { status: "waiting_user", note: "the follow-up's review" })).not.toBeNull();
    const job = getPersonaJob(w.store.db, jobId)!;
    expect(job.view!.actions).toContainEqual({ kind: "review", id: later.id, label: "decide the review packet in the Review tab" });
  });

  test("a waiting Persona set itself links to its note in the thread", () => {
    const w = makeWorld({ persona: true, disabled: true });
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    expect(updatePersonaJob(w.store.db, job.id, { status: "waiting_user", note: "which account should it deploy to?" })).not.toBeNull();
    const waiting = getPersonaJob(w.store.db, job.id)!;
    expect(waiting.view).toMatchObject({ state: "needs_you", needs: ["waiting"] });
    // Every action names something that can be opened, so no "needs you" leads nowhere.
    expect(waiting.view!.actions).toEqual([
      { kind: "message", id: job.threadId, label: "reply to Persona in the Persona tab" },
    ]);
  });
});
