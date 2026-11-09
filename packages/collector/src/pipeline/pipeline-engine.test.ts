import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { testTempDir } from "../test-support/temp-dirs.js";
import { DEFAULT_PIPELINE, registerPipelineStageKind, VALIDATION_CHECK_BUDGET_MS, type PipelineOverride } from "@standup/shared";
import {
  approvePlan,
  createAsk,
  createLaunch,
  createPlanApproval,
  getLaunchBySession,
  getPendingAsksBySession,
  getPersonaJob,
  getPipelineRun,
  getPlanApprovalByLaunch,
  getTicketByLaunch,
  linkPersonaJobLaunch,
  listReviewPackets,
  personaJobForLaunch,
  recordPipelineAttempt,
  resolveAsk,
  setReviewUrl,
  submitPlan,
  updateLaunchStatus,
  updatePersonaJob,
  updatePipelineRun,
  upsertProject,
} from "@standup/store";
import { REVIEW_DESCRIPTION_BRIEF } from "../review-description.js";
import { classifyToolCall, type FloorProbes } from "../floor/classify.js";
import { FLOOR_GATE, FLOOR_OWNER_GATE, type FloorConfig } from "../floor/gate.js";
import { buildOpeningPrompt, startLaunchPipeline } from "../launcher.js";
import {
  advancePipeline,
  formatPipelineInstruction,
  incompletePipelinesForJob,
  pipelineDoneRefusal,
  pipelineJobSummary,
  pipelineReadyBlock,
  pipelineReworkRequested,
  pipelineStatusView,
  pipelineSteerLine,
  pipelineStopDecision,
  recordReviewUrl,
  registerPipelineStageRunner,
  rootPipelineRun,
  startPipelineForLaunch,
  waivePipelineStage,
} from "./engine.js";
import { MAX_SCREENSHOT_BYTES, validateScreenshotPath } from "./screenshots.js";
import { EVIDENCE, ISSUE_ID_REVIEW_PROFILE, OWNER, advance, human, makeWorld, pngBytes, post, submitPacket, withIssueIdReviews, writeTinyPng, type World } from "./test-world.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

/**
 * Advances start → coding → validation → review (clean) → deploy, leaving the
 * run at the stage after deploy. The launch's review packet reaches the
 * owner's Review tab on the way, which the run needs to get as far as code_review.
 */
async function throughDeploy(w: World) {
  expect((await advance(w, "start")).status).toBe(200);
  expect((await advance(w, "coding", EVIDENCE.coding)).status).toBe(200);
  expect((await advance(w, "validation", EVIDENCE.validationPass)).status).toBe(200);
  expect((await advance(w, "review", EVIDENCE.reviewClean)).status).toBe(200);
  submitPacket(w);
  return advance(w, "deploy", EVIDENCE.deploy);
}

/** The owner approving the launch's submitted packet in the console, which passes human_review. */
async function approveReview(w: World) {
  const [packet] = listReviewPackets(w.store.db, { owner: OWNER, status: "pending" });
  const res = await post(w, `/api/reviews/${packet!.id}/approve`, {}, human(w));
  expect(res.status).toBe(200);
  return res;
}

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

describe("loops", () => {
  test("four failing reviews loop back to coding; the fifth exhausts and hands the run and the Persona job to the owner", async () => {
    const w = makeWorld({ persona: true });
    await advance(w, "start");
    for (let round = 1; round <= 5; round++) {
      expect((await advance(w, "coding", EVIDENCE.coding)).status).toBe(200);
      expect((await advance(w, "validation", EVIDENCE.validationPass)).status).toBe(200);
      const res = await advance(w, "review", EVIDENCE.reviewHigh);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("failed");
      if (round <= 4) {
        expect(res.body.to).toBe("coding");
        expect(res.body.run.status).toBe("active");
      } else {
        expect(res.body.to).toBe("review");
        expect(res.body.run.status).toBe("waiting_user");
        expect(res.body.run.waitingReason).toContain("review → coding loop did not converge after 4 rounds");
      }
    }
    const run = runOf(w);
    expect(run.currentStage).toBe("review");
    expect(run.attempts.filter((a) => a.stageId === "review" && a.status === "failed")).toHaveLength(5);
    expect(run.waitingKind).toBe("exhausted");
    // The block goes to Persona: the job stays active, noted, and Persona is woken.
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    expect(job.status).toBe("active");
    expect(job.note).toStartWith("Persona deciding: ");
    expect(w.broadcasts.some((m) => m.type === "persona:job")).toBe(true);
    expect(w.broadcasts.filter((m) => m.type === "pipeline:blocked").at(-1)?.payload).toMatchObject({
      runId: w.run.id,
      stage: "review",
      waitingKind: "exhausted",
      options: ["skip", "waive", "close_out", "escalate"],
    });

    // The worker can't talk its way past an exhausted loop: Persona or the owner moves it on.
    const again = await advance(w, "review", EVIDENCE.reviewClean);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("Persona decides (skip, waive, close out or escalate) — or the owner in the console");
    const waived = await waivePipelineStage(w.store.db, w.run.id, { stage: "review", reason: "accepted the risk", actor: "alice" }, w.deps);
    expect(waived.ok && waived.to).toBe("deploy");
    expect(runOf(w).status).toBe("active");
    expect(runOf(w).waitingKind).toBeUndefined();
    // The Persona job the run had set waiting is active again.
    const restored = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    expect(restored.status).toBe("active");
    expect(restored.note).toBe("Pipeline moved on: Deploy and live-validate");
    expect(w.broadcasts.filter((m) => m.type === "persona:job").at(-1)?.payload).toMatchObject({ status: "active" });
  });

  test("a job someone changed since the run flagged it is left alone when the run moves on", async () => {
    const w = makeWorld({ persona: true, override: { stages: { coding: { maxAttempts: 1 } } } });
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationFail);
    expect(runOf(w).status).toBe("waiting_user");
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    updatePersonaJob(w.store.db, jobId, { note: "owner: hold this one" });
    await waivePipelineStage(w.store.db, w.run.id, { stage: "validation", reason: "flaky", actor: "alice" }, w.deps);
    expect(getPersonaJob(w.store.db, jobId)).toMatchObject({ status: "active", note: "owner: hold this one" });
  });

  test("a skip that runs out the target's attempt cap is recorded skipped and waits on the owner", async () => {
    const w = makeWorld({ override: { stages: { code_review: { maxAttempts: 1 }, screenshot: { skipWhen: [] } } } });
    w.changed.files = ["packages/collector/a.ts"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    // A code_review attempt already happened: the cap of 1 is spent.
    recordPipelineAttempt(w.store.db, w.run.id, { stageId: "code_review", status: "failed", reason: "earlier round" });
    const res = await advance(w, "screenshot", undefined, { reason: "no UI" });
    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("waiting_user");
    expect(res.body.run.waitingReason).toContain("attempt cap");
    expect(runOf(w).attempts.filter((a) => a.stageId === "screenshot").map((a) => a.status)).toEqual(["skipped"]);
  });

  test("a stage's attempt cap stops the loop and waits on the owner", async () => {
    const w = makeWorld({ override: { stages: { coding: { maxAttempts: 2 } } } });
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    expect((await advance(w, "validation", EVIDENCE.validationFail)).body.to).toBe("coding");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advance(w, "validation", EVIDENCE.validationFail);
    expect(res.body.run.status).toBe("waiting_user");
    expect(res.body.run.waitingReason).toContain("attempt cap");
    expect(runOf(w).currentStage).toBe("validation");
  });
});

describe("facts and auto-skip", () => {
  test("the screenshot stage is auto-skipped when no changed file is UI", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/collector/src/a.ts", "packages/store/src/b.ts"];
    const res = await throughDeploy(w);
    expect(res.body.to).toBe("code_review");
    expect(res.body.skipped).toEqual([{ stageId: "screenshot", reason: "auto-skipped: ui_changed is false" }]);
    const run = runOf(w);
    expect(run.facts).toEqual({ ui_changed: false, docs_only: false });
    expect(run.attempts.find((a) => a.stageId === "screenshot")?.status).toBe("skipped");
  });

  test("a UI change keeps the screenshot stage", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/web/src/App.tsx"];
    expect((await throughDeploy(w)).body.to).toBe("screenshot");
  });

  test("a docs-only change skips deploy and screenshots (even when a doc matches the UI globs)", async () => {
    const w = makeWorld();
    w.changed.files = ["docs/index.html"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    submitPacket(w);
    const res = await advance(w, "review", EVIDENCE.reviewClean);
    expect(res.body.to).toBe("code_review");
    expect(res.body.skipped).toEqual([
      { stageId: "deploy", reason: "auto-skipped: docs_only is true" },
      { stageId: "screenshot", reason: "auto-skipped: docs_only is true" },
    ]);
  });

  test("a change with no deploy target skips deploy with a recorded reason", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/collector/src/x.test.ts", "config/fixtures.json"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    const res = await advance(w, "deploy", undefined, { reason: "tests and fixtures only; nothing is deployed" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("skipped");
    expect(runOf(w).attempts.find((a) => a.stageId === "deploy")).toMatchObject({
      status: "skipped",
      reason: "tests and fixtures only; nothing is deployed",
    });
  });

  test("a worker can't skip a full run's deploy over deployable code, nor its screenshots over a UI change", async () => {
    const code = makeWorld();
    await advance(code, "start");
    await advance(code, "coding", EVIDENCE.coding);
    await advance(code, "validation", EVIDENCE.validationPass);
    await advance(code, "review", EVIDENCE.reviewClean);
    submitPacket(code);
    const deploy = await advance(code, "deploy", undefined, { reason: "a CLI script; nothing is deployed" });
    expect(deploy.status).toBe(422);
    expect(deploy.body.error).toContain("touches deployable code (packages/collector/src/x.ts)");
    expect(deploy.body.error).toContain("ask Persona to escalate");
    expect(runOf(code).currentStage).toBe("deploy");

    const ui = makeWorld({ override: { stages: { screenshot: { skipWhen: [] } } } });
    ui.changed.files = ["packages/web/src/App.tsx"];
    await advance(ui, "start");
    await advance(ui, "coding", EVIDENCE.coding);
    await advance(ui, "validation", EVIDENCE.validationPass);
    await advance(ui, "review", EVIDENCE.reviewClean);
    await advance(ui, "deploy", EVIDENCE.deploy);
    submitPacket(ui);
    const shot = await advance(ui, "screenshot", undefined, { reason: "backend-only styling constant" });
    expect(shot.status).toBe(422);
    expect(shot.body.error).toContain("touches UI (packages/web/src/App.tsx)");
    expect(runOf(ui).currentStage).toBe("screenshot");
  });

  test("facts unknown when coding left are computed on entering a stage that auto-skips", async () => {
    const w = makeWorld();
    w.changed.files = null;
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    expect(runOf(w).facts).toEqual({});
    // git answers later (the worktree settled): the screenshot stage's skipWhen gets its facts.
    w.changed.files = ["packages/store/a.ts"];
    await advance(w, "validation", EVIDENCE.validationPass);
    expect(runOf(w).facts).toEqual({ ui_changed: false, docs_only: false });
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    expect((await advance(w, "deploy", EVIDENCE.deploy)).body.to).toBe("code_review");
  });

  test("when git can't tell, the worker's changedFiles decide; with neither, facts stay unknown", async () => {
    const w = makeWorld();
    w.changed.files = null;
    await advance(w, "start");
    await advance(w, "coding", { summary: "x", changedFiles: ["packages/web/a.css"] });
    expect(runOf(w).facts.ui_changed).toBe(true);

    const v = makeWorld();
    v.changed.files = null;
    expect((await throughDeploy(v)).body.to).toBe("screenshot");
    expect(runOf(v).facts).toEqual({});
  });

  test("the git file list and the worker's are unioned", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/store/a.ts"];
    await advance(w, "start");
    await advance(w, "coding", { summary: "x", changedFiles: ["packages/web/b.tsx"] });
    const coding = runOf(w).attempts.find((a) => a.stageId === "coding")!;
    expect((coding.evidence as { changedFiles: string[] }).changedFiles.sort()).toEqual(["packages/store/a.ts", "packages/web/b.tsx"]);
  });
});

describe("validation criterion", () => {
  test("an approved criterion is recorded and an unmet one fails the stage", async () => {
    const w = makeWorld();
    w.deps.runCriterion = async () => ({ command: "make check", met: false, output: "1 failing" });
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(res.ok && res.outcome).toBe("failed");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    expect((attempt.evidence as { criterion: unknown }).criterion).toEqual({ command: "make check", met: false, output: "1 failing" });
  });

  test("a criterion the worker reports is dropped: only the server's counts", async () => {
    const w = makeWorld();
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const forged = { ...EVIDENCE.validationPass, criterion: { command: "true", met: true, output: "trust me" } };
    const res = await advance(w, "validation", forged);
    expect(res.status).toBe(200);
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    expect((attempt.evidence as { criterion?: unknown }).criterion).toBeUndefined();
  });

  test("the criterion runs again after a review sends the work back: a pass from the first round doesn't carry", async () => {
    const worktree = testTempDir("standup-criterion-loop-");
    const w = makeWorld({ worktree, realCommands: true });
    approveCriterion(w, "test -e ok");
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    writeFileSync(join(worktree, "ok"), "");
    const first = await advance(w, "validation", EVIDENCE.validationPass);
    expect(first.body.outcome).toBe("passed");
    expect(getPlanApprovalByLaunch(w.store.db, w.launch.id)!.criterionMet).toBe(true);

    expect((await advance(w, "review", EVIDENCE.reviewHigh)).body.to).toBe("coding");
    rmSync(join(worktree, "ok"));
    await advance(w, "coding", EVIDENCE.coding);
    const second = await advance(w, "validation", EVIDENCE.validationPass);
    expect(second.body.outcome).toBe("failed");
    expect(second.body.to).toBe("coding");
    const attempts = runOf(w).attempts.filter((a) => a.stageId === "validation");
    expect((attempts[1]!.evidence as { criterion: { met: boolean } }).criterion.met).toBe(false);
    // The stale pass is cleared, so the ready edge runs the criterion again too.
    expect(getPlanApprovalByLaunch(w.store.db, w.launch.id)!.criterionMet).toBe(false);
  });

  test("a failing criterion's failure carries the tail of what it printed, however long its output", async () => {
    const worktree = testTempDir("standup-criterion-tail-");
    const w = makeWorld({ worktree, realCommands: true });
    approveCriterion(w, "seq 1 20000; echo '(fail) large db > peak RSS'; exit 1");
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advance(w, "validation", EVIDENCE.validationPass);
    expect(res.body.outcome).toBe("failed");
    const reason = runOf(w).attempts.find((a) => a.stageId === "validation")!.reason!;
    expect(reason).toContain("last output:");
    expect(reason).toContain("19999\n20000\n(fail) large db > peak RSS\nexit code 1");
    expect(reason).not.toContain("\n1\n2\n3\n");
    expect(res.body.message).toContain("(fail) large db > peak RSS\nexit code 1");
  });

  test("a short failing criterion's failure carries what it printed, secrets redacted, not the ready gate's refusal", async () => {
    const worktree = testTempDir("standup-criterion-short-");
    const w = makeWorld({ worktree, realCommands: true });
    // The password is only spelled out in what the command prints, not in the command.
    approveCriterion(w, "echo 'Server=db;Password=hunter'$((6*7))'very;'; echo '1 failing'; exit 1");
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advance(w, "validation", EVIDENCE.validationPass);
    expect(res.body.outcome).toBe("failed");
    expect(res.body.message).toContain("; last output:\nServer=db;");
    expect(res.body.message).toContain("1 failing\nexit code 1");
    expect(res.body.message).toContain("Password=[REDACTED]");
    expect(res.body.message).not.toContain("hunter42very");
    expect(res.body.message).not.toContain("mark_ready_for_review");
  });

  test("a criterion the floor holds at the validation stage tells the worker to report the stage again", async () => {
    const worktree = testTempDir("standup-criterion-held-");
    const marker = join(worktree, "ran.marker");
    const w = makeWorld({ worktree, realCommands: true });
    approveCriterion(w, `touch ${marker} && git push origin HEAD`);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advance(w, "validation", EVIDENCE.validationPass);
    expect(res.body.outcome).toBe("failed");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    const { criterion } = attempt.evidence as { criterion: { met: boolean; output: string } };
    expect(criterion.met).toBe(false);
    expect(criterion.output).toContain("The acceptance criterion was not run");
    expect(criterion.output).toContain("Report the validation stage again once it is allowed.");
    expect(criterion.output).not.toContain("mark_ready_for_review");
    expect(existsSync(marker)).toBe(false);
  });
});

/** The owner's project layer that runs the console's live-update suite for a change to the code it covers. */
const LIVE_CHECK_LAYER: PipelineOverride = {
  stages: {
    validation: {
      checks: [
        {
          command: "bun run test:live",
          paths: [
            "packages/web/**",
            "packages/collector/src/ws*.ts",
            "packages/collector/src/persona/runtime.ts",
            "packages/gateway/src/**",
          ],
        },
      ],
    },
  },
};

/** Approves the world's plan gate with `criterion` as its acceptance criterion. */
function approveCriterion(w: World, criterion: string) {
  const gate = createPlanApproval(w.store.db, { launchId: w.launch.id, projectId: "proj", worktreePath: w.worktree });
  submitPlan(w.store.db, gate.id, { relevantFiles: [], plan: "the plan", acceptanceCriterion: criterion });
  approvePlan(w.store.db, gate.id, { acceptanceCriterion: criterion });
}

describe("validation checks", () => {
  /** Records each command runCheck is asked to run and answers with `met`. */
  function stubChecks(w: World, met: boolean) {
    const ran: string[] = [];
    w.deps.runCheck = async (_launch, command) => {
      ran.push(command);
      return { met, output: met ? "12 pass" : "1 fail: ws reconnect resyncs the thread" };
    };
    return ran;
  }

  test("a packages/web change runs the project's live check, and its failure fails validation", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["packages/web/src/hooks/useWs.ts"];
    const ran = stubChecks(w, false);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(res.ok && res.outcome).toBe("failed");
    expect(ran).toEqual(["bun run test:live"]);
    expect(runOf(w).currentStage).toBe("coding");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    expect(attempt.reason).toContain("validation check failed (`bun run test:live`)");
    expect((attempt.evidence as { checks: unknown }).checks).toEqual([
      { command: "bun run test:live", met: false, output: "1 fail: ws reconnect resyncs the thread" },
    ]);
  });

  test("a collector ws change matches too, and a passing check passes the stage", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["packages/collector/src/ws-hub.ts"];
    const ran = stubChecks(w, true);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(res.ok && res.outcome).toBe("passed");
    expect(runOf(w).attempts.find((a) => a.stageId === "validation")!.reason).toContain("1 check(s) passed");
    expect(ran).toEqual(["bun run test:live"]);
  });

  test("a docs-only change doesn't run the check, and records it skipped", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["docs/pipeline.md"];
    const ran = stubChecks(w, false);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(res.ok && res.outcome).toBe("passed");
    expect(ran).toEqual([]);
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    expect((attempt.evidence as { checks: Array<{ skipped?: boolean }> }).checks[0]!.skipped).toBe(true);
  });

  test("when no changed file is known, the check runs", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = null;
    const ran = stubChecks(w, true);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(ran).toEqual(["bun run test:live"]);
  });

  test("when git can't name the change, the worker's own file list can't narrow the checks away", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = null;
    const ran = stubChecks(w, false);
    await advance(w, "start");
    await advance(w, "coding", { ...EVIDENCE.coding, changedFiles: ["README.md"] });
    const res = await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(ran).toEqual(["bun run test:live"]);
    expect(res.ok && res.outcome).toBe("failed");
  });

  test("a retried advance waits on the checks already running instead of starting a second set", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["packages/web/src/App.tsx"];
    let release: () => void = () => {};
    const timeouts: Array<number | undefined> = [];
    w.deps.runCheck = async (_launch, _command, timeoutMs) => {
      timeouts.push(timeoutMs);
      await new Promise<void>((r) => {
        release = r;
      });
      return { met: true, output: "30/30" };
    };
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const first = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    await Bun.sleep(20);
    const retry = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    await Bun.sleep(20);
    release();
    await Promise.all([first, retry]);
    expect(timeouts.length).toBe(1);
    // A check is never given more than the whole validation's budget.
    expect(timeouts[0]!).toBeLessThanOrEqual(VALIDATION_CHECK_BUDGET_MS);
    // One of the two commits the shared result and moves the run on; the other finds it moved.
    expect(runOf(w).currentStage).toBe("review");
  });

  test("a later visit to validation (waived, then looped back) runs its own checks, never the earlier visit's in-flight result", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["packages/web/src/App.tsx"];
    const releases: Array<() => void> = [];
    let calls = 0;
    w.deps.runCheck = async () => {
      calls++;
      const call = calls;
      await new Promise<void>((r) => releases.push(r));
      return { met: call > 1, output: `run ${call}` };
    };
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const stale = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    await Bun.sleep(20);
    // The owner waives validation; review sends the work back; the worker reaches validation again.
    await waivePipelineStage(w.store.db, w.run.id, { stage: "validation", reason: "flaky", actor: "alice" }, w.deps);
    await advancePipeline(w.store.db, w.run.id, { stage: "review", evidence: EVIDENCE.reviewHigh }, w.deps);
    await advancePipeline(w.store.db, w.run.id, { stage: "coding", evidence: EVIDENCE.coding }, w.deps);
    const fresh = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    await Bun.sleep(20);
    expect(calls).toBe(2);
    for (const r of releases) r();
    await Promise.all([stale, fresh]);
    const last = runOf(w).attempts.filter((a) => a.stageId === "validation").at(-1)!;
    expect((last.evidence as { checks: Array<{ output: string }> }).checks[0]!.output).toBe("run 2");
  });

  test("a configured timeout past the validation budget is valid, and clamped to what's left of it", async () => {
    const layer: PipelineOverride = {
      stages: { validation: { checks: [{ command: "bun run test:live", timeoutMs: 1_800_000 }] } },
    };
    const w = makeWorld({ projectOverride: layer });
    w.changed.files = ["packages/web/src/App.tsx"];
    const timeouts: Array<number | undefined> = [];
    w.deps.runCheck = async (_launch, _command, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { met: true, output: "ok" };
    };
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(timeouts.length).toBe(1);
    expect(timeouts[0]!).toBeLessThanOrEqual(VALIDATION_CHECK_BUDGET_MS);
  });

  test("checks the worker reports are dropped: a forged pass doesn't hide the server's failure", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["packages/web/src/App.tsx"];
    stubChecks(w, false);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const forged = { ...EVIDENCE.validationPass, checks: [{ command: "bun run test:live", met: true, output: "trust me" }] };
    const res = await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: forged }, w.deps);
    expect(res.ok && res.outcome).toBe("failed");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    expect((attempt.evidence as { checks: Array<{ output: string }> }).checks.map((c) => c.output)).not.toContain("trust me");

    const plain = makeWorld();
    await advance(plain, "start");
    await advance(plain, "coding", EVIDENCE.coding);
    expect((await advance(plain, "validation", forged)).status).toBe(200);
    const recorded = runOf(plain).attempts.find((a) => a.stageId === "validation")!;
    expect((recorded.evidence as { checks?: unknown }).checks).toBeUndefined();
  });

  test("the check runs again on every validation attempt; a pass is never cached", async () => {
    const w = makeWorld({ projectOverride: LIVE_CHECK_LAYER });
    w.changed.files = ["packages/web/src/App.tsx"];
    const ran = stubChecks(w, true);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    await advancePipeline(w.store.db, w.run.id, { stage: "review", evidence: EVIDENCE.reviewHigh }, w.deps);
    await advancePipeline(w.store.db, w.run.id, { stage: "coding", evidence: EVIDENCE.coding }, w.deps);
    await advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    expect(ran).toEqual(["bun run test:live", "bun run test:live"]);
  });

  test("the server runs a check in the worktree, and one the safety floor holds fails without running", async () => {
    const worktree = testTempDir("standup-check-run-");
    const marker = join(worktree, "ran.marker");
    const w = makeWorld({
      worktree,
      realCommands: true,
      projectOverride: {
        stages: {
          validation: { checks: [{ command: "test -e ok" }, { command: `touch ${marker} && git push origin HEAD`, timeoutMs: 5000 }] },
        },
      },
    });
    writeFileSync(join(worktree, "ok"), "");
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    const res = await advance(w, "validation", EVIDENCE.validationPass);
    expect(res.body.outcome).toBe("failed");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "validation")!;
    const checks = (attempt.evidence as { checks: Array<{ met: boolean; output: string }> }).checks;
    expect(checks[0]!.met).toBe(true);
    expect(checks[1]!.met).toBe(false);
    expect(checks[1]!.output).toContain("The validation check was not run: the safety floor holds it");
    expect(existsSync(marker)).toBe(false);
    expect(getPendingAsksBySession(w.store.db, w.sessionId).map((a) => a.gate)).toEqual([FLOOR_OWNER_GATE]);
  });
});

describe("concurrency", () => {
  test("two advances racing on one stage: exactly one commits, the other is refused without writing", async () => {
    const w = makeWorld();
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.deps.runCriterion = async () => {
      await gate;
      return null;
    };
    const a = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    const b = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationFail }, w.deps);
    await Bun.sleep(5);
    release();
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok)!;
    expect(!lost.ok && lost.status).toBe(409);
    expect(!lost.ok && lost.error).toContain("the run moved while this advance was running; call pipeline_status");
    expect(runOf(w).attempts.filter((a) => a.stageId === "validation")).toHaveLength(1);
  });

  test("a waive racing an advance: the stale one writes nothing", async () => {
    const w = makeWorld();
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.deps.runCriterion = async () => {
      await gate;
      return null;
    };
    const pending = advancePipeline(w.store.db, w.run.id, { stage: "validation", evidence: EVIDENCE.validationPass }, w.deps);
    await Bun.sleep(5);
    const waived = await waivePipelineStage(w.store.db, w.run.id, { stage: "validation", reason: "ran by hand", actor: "alice" }, w.deps);
    expect(waived.ok).toBe(true);
    release();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(runOf(w).currentStage).toBe("review");
    expect(runOf(w).attempts.filter((a) => a.stageId === "validation").map((a) => a.status)).toEqual(["waived"]);
  });
});

describe("screenshot paths", () => {
  test("a real PNG under a root is accepted with its dimensions", () => {
    const path = writeTinyPng(3, 2);
    const check = validateScreenshotPath(path, [dirname(path)]);
    expect(check).toMatchObject({ ok: true, path, width: 3, height: 2 });
    expect(check.ok && Buffer.from(check.bytes).equals(pngBytes(3, 2))).toBe(true);
  });

  test("a directory between the root and the file that others can write is refused", () => {
    // Real paths, as the screenshot roots are spelled.
    const root = realpathSync(testTempDir("standup-root-"));
    const shared = join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const path = join(shared, "a.png");
    writeFileSync(path, pngBytes(1, 1));
    const check = validateScreenshotPath(path, [root]);
    expect(!check.ok && check.error).toContain("writable by its group or others");
    chmodSync(shared, 0o700);
    expect(validateScreenshotPath(path, [root]).ok).toBe(true);
  });

  test("a file over the size cap is refused", () => {
    const dir = realpathSync(testTempDir("standup-shot-"));
    const path = join(dir, "big.png");
    writeFileSync(path, Buffer.concat([pngBytes(1, 1), Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
    const check = validateScreenshotPath(path, [dir]);
    expect(!check.ok && check.error).toContain("larger than 20 MB");
  });

  test("a non-PNG is refused, by extension and by content", () => {
    const dir = realpathSync(testTempDir("standup-shot-"));
    writeFileSync(join(dir, "a.jpg"), pngBytes(1, 1));
    writeFileSync(join(dir, "b.png"), "not an image at all, just text padding here");
    expect(validateScreenshotPath(join(dir, "a.jpg"), [dir])).toMatchObject({ ok: false });
    const fake = validateScreenshotPath(join(dir, "b.png"), [dir]);
    expect(fake.ok).toBe(false);
    expect(!fake.ok && fake.error).toContain("not a PNG");
    expect(validateScreenshotPath("relative.png", [dir])).toMatchObject({ ok: false });
  });

  test("a PNG outside the roots is refused", () => {
    const path = writeTinyPng();
    const other = testTempDir("standup-root-");
    const check = validateScreenshotPath(path, [other]);
    expect(!check.ok && check.error).toContain("outside the screenshot roots");
  });

  test("a symlink is refused, wherever it points", () => {
    const outside = writeTinyPng();
    const root = testTempDir("standup-root-");
    const link = join(root, "escape.png");
    symlinkSync(outside, link);
    expect(validateScreenshotPath(link, [root]).ok).toBe(false);
    const both = validateScreenshotPath(link, [root, dirname(outside)]);
    expect(!both.ok && both.error).toContain("is a symlink");
    expect(validateScreenshotPath(outside, [root, dirname(outside)]).ok).toBe(true);
  });

  test("the screenshot stage refuses an invalid path with 422 and records a valid one's size", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/web/App.tsx"];
    await throughDeploy(w);
    const bad = await advance(w, "screenshot", { screenshots: [{ path: "/etc/passwd.png" }] });
    expect(bad.status).toBe(422);
    expect(bad.body.missing[0]).toContain("evidence.screenshots[0].path");
    const original = writeTinyPng(4, 4);
    const good = await advance(w, "screenshot", { screenshots: [{ path: original, caption: "home", storedPath: "/etc/shadow" }] });
    expect(good.status).toBe(200);
    expect(good.body.to).toBe("code_review");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "screenshot")!;
    const shot = (attempt.evidence as { screenshots: Array<{ width: number; path: string; storedPath: string }> }).screenshots[0]!;
    expect(shot.width).toBe(4);
    expect(shot.path).toBe(original);
    // The collector's own copy, named after the attempt; the worker's storedPath is ignored.
    expect(shot.storedPath).toEndWith(`/${w.run.id}/${attempt.id}-0.png`);
    expect(Buffer.from(readFileSync(shot.storedPath)).equals(pngBytes(4, 4))).toBe(true);
    expect(statSync(shot.storedPath).mode & 0o777).toBe(0o600);
  });
});

describe("outward stages stay on the floor", () => {
  const ROOT = "/tmp/standup-pipeline-test/wt";
  const config: FloorConfig = {
    v: 1,
    collectorUrl: "http://localhost:7777",
    launchId: "launch-1",
    root: ROOT,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: "/home/tester/.local/share/standup",
    floorPaths: ["/opt/standup/packages/collector/src/floor"],
    installDir: "/opt/standup",
    protectedPaths: [],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
  const probes: Partial<FloorProbes> = {
    gitBranch: () => "standup/thing",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: () => ({ ok: false, reason: "missing" }),
    exists: (p) => p === ROOT || p === "/tmp" || p === "/",
    isDirectory: (p) => p === ROOT || p === "/tmp" || p === "/",
    listDir: () => [],
    realpath: (p) => p,
    homeDir: () => "/home/tester",
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => 0,
  };
  const classify = (command: string) => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes);
  // The example.corp profile's review CLI, read under that profile.
  const corpConfig: FloorConfig = { ...config, orgProfile: exampleCorpProfile() };
  const corpReview = "corp-review --issue ISSUE-1 --description /tmp/d.md";
  const classifyCorp = (command: string) => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, corpConfig, probes);

  test("cdk deploy, gh pr create and a profile's review CLI classify identically with and without a run at deploy / code_review", async () => {
    const before = { deploy: classify("cdk deploy MyStack"), review: classify("gh pr create --fill"), corpReview: classifyCorp(corpReview), defaultReview: classify(corpReview) };
    expect(before.deploy.action).toBe("hold");
    expect(before.review.action).toBe("hold");
    expect(before.corpReview.action).toBe("hold");
    // Under the default profile the fixture's review CLI is whatever the
    // floor's built-in reading makes of it; only its stage-independence is
    // asserted here.

    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    expect(runOf(w).currentStage).toBe("deploy");
    expect(classify("cdk deploy MyStack")).toEqual(before.deploy);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("code_review");
    expect(classify("gh pr create --fill")).toEqual(before.review);
    expect(classifyCorp(corpReview)).toEqual(before.corpReview);
    expect(classify(corpReview)).toEqual(before.defaultReview);
  });

  test("the deploy advance records the floor asks raised during the stage", async () => {
    const w = makeWorld();
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    const ask = createAsk(w.store.db, w.sessionId, "ask_human", "Allow `cdk deploy MyStack`?", ["Allow once", "Deny"], { gate: FLOOR_GATE });
    resolveAsk(w.store.db, ask.id, "Allow once");
    createAsk(w.store.db, w.sessionId, "ask_human", "unrelated question");
    const res = await advance(w, "deploy", EVIDENCE.deploy);
    expect(res.status).toBe(200);
    const deploy = runOf(w).attempts.find((a) => a.stageId === "deploy")!.evidence as { floorAsks: Array<{ askId: string; gate: string; answer?: string }> };
    expect(deploy.floorAsks).toHaveLength(1);
    expect(deploy.floorAsks[0]).toMatchObject({ askId: ask.id, gate: FLOOR_GATE, answer: "Allow once", status: "answered" });
  });

  test("requireOwnerGate refuses the deploy until an owner-allowed floor ask exists", async () => {
    const w = makeWorld({ override: { stages: { deploy: { requireOwnerGate: true } } } });
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    const refused = await advance(w, "deploy", EVIDENCE.deploy);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain(FLOOR_OWNER_GATE);
    // An agent-gate floor ask, or a denied owner ask, doesn't count.
    resolveAsk(w.store.db, createAsk(w.store.db, w.sessionId, "ask_human", "q", undefined, { gate: FLOOR_GATE }).id, "Allow once");
    resolveAsk(w.store.db, createAsk(w.store.db, w.sessionId, "ask_human", "q", undefined, { gate: FLOOR_OWNER_GATE }).id, "Deny");
    expect((await advance(w, "deploy", EVIDENCE.deploy)).status).toBe(422);
    resolveAsk(w.store.db, createAsk(w.store.db, w.sessionId, "ask_human", "q", undefined, { gate: FLOOR_OWNER_GATE }).id, "Allow once");
    const ok = await advance(w, "deploy", EVIDENCE.deploy);
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe("passed");
  });
});

describe("a code review that attaches no issue id", () => {
  test("the stage takes the worker's review link alone, and nothing waits on the owner", async () => {
    const w = makeWorld({ persona: true, issueId: "" });
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    expect(runOf(w).definition.stages.find((s) => s.id === "code_review")?.ownerInput).toBeUndefined();
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)?.block).toBe(true);
    expect(runOf(w).status).toBe("active");
    const done = await advance(w, "code_review", { url: "https://github.com/example/repo/pull/7" });
    expect(done.status).toBe(200);
    expect(done.body.to).toBe("human_review");
  });

  test("a project whose review tool attaches one gets a code_review stage that asks for it", () => {
    setActiveOrgProfile(ISSUE_ID_REVIEW_PROFILE);
    try {
      const w = makeWorld({ issueId: "" });
      expect(runOf(w).definition.stages.find((s) => s.id === "code_review")?.ownerInput).toBe("issue_id");
      const pr = makeWorld({ issueId: "", reviewArtifact: "github-pr" });
      expect(runOf(pr).definition.stages.find((s) => s.id === "code_review")?.ownerInput).toBeUndefined();
    } finally {
      setActiveOrgProfile();
    }
  });
});

describe("the code_review stage and the owner's issue id", () => {
  withIssueIdReviews();

  test("entering code_review doesn't wait on the owner; a code review advanced without an issue id does, until one comes", async () => {
    const w = makeWorld({ persona: true });
    w.changed.files = ["packages/collector/a.ts"];
    const res = await throughDeploy(w);
    expect(res.body.to).toBe("code_review");
    expect(res.body.run.status).toBe("active");
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");

    const missing = await advance(w, "code_review", { url: "https://git.example.com/acme/app/pull/1" });
    expect(missing.status).toBe(422);
    expect(missing.body.missing[0]).toContain("evidence.issueId");
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
    // Persona gets the issue id from the owner: its job stays active, noted.
    const job = personaJobForLaunch(w.store.db, w.launch.id)!.job;
    expect(job.status).toBe("active");
    expect(job.note).toBe("Persona deciding: code review stage needs an issue id — Persona asks the owner for it");

    // Owner-input waiting still takes the worker's advance once it has the id.
    const done = await advance(w, "code_review", { url: "https://git.example.com/acme/app/pull/1", issueId: "ISSUE-9" });
    expect(done.status).toBe(200);
    expect(done.body.to).toBe("human_review");
    expect(done.body.run.status).toBe("active");
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
  });

  test("a Stop at code_review with no issue id known hands the run to the owner instead of blocking", async () => {
    const w = makeWorld({ persona: true });
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
    expect(runOf(w).waitingReason).toContain("issue id");
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job).toMatchObject({ status: "active", note: expect.stringMatching(/^Persona deciding: /) });
    expect(w.broadcasts.some((m) => m.type === "pipeline:blocked")).toBe(true);
  });

  test("the code review url must be http(s), and a known ticket issue id must be the one reported", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    const js = await advance(w, "code_review", { url: "javascript:alert(1)", issueId: "ISSUE-1" });
    expect(js.status).toBe(422);
    expect(js.body.missing).toContain("evidence.url (an http:// or https:// URL)");
    const other = await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-2" });
    expect(other.status).toBe(422);
    expect(other.body.error).toContain("ISSUE-1");
    // A worker can't claim its evidence came from the review gate.
    const forged = await advance(w, "code_review", { reviewId: "R-1", source: "review_gate" });
    expect(forged.status).toBe(422);
    expect((await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" })).status).toBe(200);
    expect(await recordReviewUrl(w.store.db, w.launch.id, "ftp://x", "ISSUE-1", w.deps, { fromReviewGate: true })).toBeNull();
  });

  test("a review url with the ticket's issue id records the stage", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    expect((await throughDeploy(w)).body.run.status).toBe("active");
    const res = await recordReviewUrl(w.store.db, w.launch.id, "https://git.example.com/acme/app/pull/2", "ISSUE-1", w.deps, { fromReviewGate: false });
    expect(res?.ok).toBe(true);
    expect(runOf(w)).toMatchObject({ status: "active", currentStage: "human_review" });
    const evidence = runOf(w).attempts.find((a) => a.stageId === "code_review")!.evidence as { url: string; issueId: string };
    expect(evidence).toMatchObject({ url: "https://git.example.com/acme/app/pull/2", issueId: "ISSUE-1", source: "worker" });
  });

  test("the review gate's code review is recorded without an issue id; a worker-reported url without one is not", async () => {
    const w = makeWorld({ issueId: "" });
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    expect(await recordReviewUrl(w.store.db, w.launch.id, "https://git.example.com/acme/app/pull/3", undefined, w.deps, { fromReviewGate: false })).toBeNull();
    expect(runOf(w).currentStage).toBe("code_review");
    const res = await recordReviewUrl(w.store.db, w.launch.id, "https://git.example.com/acme/app/pull/3", undefined, w.deps, { fromReviewGate: true });
    expect(res?.ok).toBe(true);
    const run = runOf(w);
    expect(run).toMatchObject({ status: "active", currentStage: "human_review" });
    expect(run.attempts.find((a) => a.stageId === "code_review")!.evidence).toMatchObject({ url: "https://git.example.com/acme/app/pull/3", source: "review_gate" });
  });

  test("a code review the review gate cut before the run reached code_review is recorded on entering it", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    setReviewUrl(w.store.db, ticket.id, "https://git.example.com/acme/app/pull/7");
    await throughDeploy(w);
    const run = runOf(w);
    expect(run).toMatchObject({ status: "active", currentStage: "human_review" });
    expect(run.attempts.find((a) => a.stageId === "code_review")!.evidence).toMatchObject({ url: "https://git.example.com/acme/app/pull/7", issueId: "ISSUE-1" });
  });

  test("rework sends a complete run back to coding with a recorded attempt", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" });
    await approveReview(w);
    expect(runOf(w).status).toBe("complete");
    const moved = await pipelineReworkRequested(w.store.db, w.launch.id, w.deps);
    expect(moved).toMatchObject({ status: "active", currentStage: "coding" });
    expect(runOf(w).attempts.at(-1)).toMatchObject({ stageId: "complete", status: "failed", nextStage: "coding" });
    expect(runOf(w).attempts.at(-1)!.reason).toContain("rework requested");
    expect(await pipelineReadyBlock(w.store.db, w.launch.id, w.deps)).toContain("Coding");
  });
});

describe("review-gate projects", () => {
  test("the brief and the code_review steer line say mark_ready_for_review cuts the code review", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "review-agent" });
    w.changed.files = ["packages/collector/a.ts"];
    expect(formatPipelineInstruction(DEFAULT_PIPELINE, { reviewGate: true })).toContain("call mark_ready_for_review — the project's review gate cuts the code review");
    // The brief asks the owner for an issue id only when the code_review stage takes one.
    expect(formatPipelineInstruction(DEFAULT_PIPELINE)).not.toContain("issue id from the owner");
    setActiveOrgProfile(ISSUE_ID_REVIEW_PROFILE);
    try {
      const issueIdRun = makeWorld({ issueId: "" }).run.definition;
      expect(formatPipelineInstruction(issueIdRun)).toContain("issue id from the owner — ask_human for it");
      expect(formatPipelineInstruction(issueIdRun, { codeReviewNotApplicable: "no code review to cut" })).not.toContain("issue id from the owner");
    } finally {
      setActiveOrgProfile();
    }
    // A worker that cuts the code review by hand is briefed on the packet-shaped
    // template; under a review gate the gate hands over the artifact (a review
    // description skeleton or a GitHub PR body), so the brief carries no template.
    expect(formatPipelineInstruction(DEFAULT_PIPELINE)).toContain(REVIEW_DESCRIPTION_BRIEF);
    expect(formatPipelineInstruction(DEFAULT_PIPELINE, { reviewGate: "review-agent" })).not.toContain(REVIEW_DESCRIPTION_BRIEF);
    expect(formatPipelineInstruction(DEFAULT_PIPELINE, { reviewGate: true })).not.toContain(REVIEW_DESCRIPTION_BRIEF);
    expect(formatPipelineInstruction(DEFAULT_PIPELINE, { codeReviewNotApplicable: "no code review to cut" })).not.toContain(REVIEW_DESCRIPTION_BRIEF);
    expect(pipelineSteerLine(w.store.db, w.sessionId)).not.toContain("mark_ready_for_review");
    await throughDeploy(w);
    expect(pipelineSteerLine(w.store.db, w.sessionId)).toContain("call mark_ready_for_review");
  });
});

describe("Persona job helpers", () => {
  test("incompletePipelinesForJob and pipelineJobSummary", async () => {
    const w = makeWorld({ persona: true });
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    expect(incompletePipelinesForJob(w.store.db, jobId)).toEqual([
      { launchId: w.launch.id, stages: ["coding", "validation", "review", "deploy", "screenshot", "code_review", "human_review"] },
    ]);
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationFail);
    expect(pipelineJobSummary(w.store.db, [w.launch.id])).toEqual({ stage: "coding", status: "active", round: 2 });
    updatePipelineRun(w.store.db, w.run.id, { status: "waiting_user", waitingReason: "needs a decision" });
    expect(pipelineJobSummary(w.store.db, [w.launch.id])).toEqual({ stage: "coding", status: "waiting_user", blocker: "needs a decision", round: 2 });
    expect(getPersonaJob(w.store.db, jobId)).not.toBeNull();
  });

  test("a disabled run is no pipeline for the job", async () => {
    const w = makeWorld({ persona: true, disabled: true });
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    expect(incompletePipelinesForJob(w.store.db, jobId)).toEqual([]);
    expect(pipelineJobSummary(w.store.db, [w.launch.id])).toBeUndefined();
    expect(await pipelineDoneRefusal(w.store.db, jobId)).toBeNull();
  });

  test("a failed launch's run no longer blocks done — but a job none of whose workers finished can't close done", async () => {
    const w = makeWorld({ persona: true, issueId: "ISSUE-1" });
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    expect(await pipelineDoneRefusal(w.store.db, jobId)).toContain("the delivery pipeline is incomplete");
    // A second worker that failed outright.
    const dead = createLaunch(w.store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: "/tmp/wt-dead", branch: "b2", status: "running" });
    linkPersonaJobLaunch(w.store.db, jobId, dead.id);
    startPipelineForLaunch(w.store.db, { launchId: dead.id, owner: "alice", projectId: "proj" });
    updateLaunchStatus(w.store.db, dead.id, "failed");
    expect(incompletePipelinesForJob(w.store.db, jobId).map((p) => p.launchId)).toEqual([w.launch.id]);
    // Only the failed worker left: still nothing finished.
    updateLaunchStatus(w.store.db, w.launch.id, "failed");
    expect(incompletePipelinesForJob(w.store.db, jobId)).toEqual([]);
    expect(await pipelineDoneRefusal(w.store.db, jobId)).toContain("no worker finished its delivery pipeline");
    // The first worker finishes after all: done is allowed.
    updateLaunchStatus(w.store.db, w.launch.id, "running");
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" });
    await approveReview(w);
    expect(await pipelineDoneRefusal(w.store.db, jobId)).toBeNull();
  });
});

describe("resumed and adopted sessions", () => {
  test("a session id shared by an ended launch and its adopted launch resolves to the open run", async () => {
    const w = makeWorld();
    // Adopting the ended session made a second launch row with the same session id, newest first.
    updateLaunchStatus(w.store.db, w.launch.id, "cleaned");
    const adopted = createLaunch(w.store.db, {
      id: randomUUID(),
      projectId: "proj",
      task: "adopted",
      worktreePath: "/tmp/wt-adopted",
      branch: "b",
      status: "running",
      sessionId: w.sessionId,
      kind: "adopted",
    });
    expect(getLaunchBySession(w.store.db, w.sessionId)!.id).toBe(adopted.id);
    expect(rootPipelineRun(w.store.db, w.sessionId)!.id).toBe(w.run.id);
    expect(pipelineSteerLine(w.store.db, w.sessionId)).toContain("Start (start)");
    expect((await advance(w, "start")).status).toBe(200);
    // A human drives the adopted session: its Stop is never blocked, though the steer line still applies.
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w).stopBlocks).toBe(0);
    expect(pipelineSteerLine(w.store.db, w.sessionId)).toContain("Coding (coding)");
  });
});

describe("stage kinds are a registry", () => {
  test("a registered custom kind inserted after code_review runs end to end", async () => {
    registerPipelineStageKind({
      kind: "review_signoff",
      validateEvidence: (_stage, ev) => (typeof ev.approver === "string" && ev.approver ? [] : ["evidence.approver (who approved)"]),
      evaluateOutcome: (_stage, ev) =>
        ev.approved === false ? { outcome: "failed", reason: "the human said no" } : { outcome: "passed", reason: `approved by ${String(ev.approver)}` },
      describe: () => "{approver, approved?}",
      defaults: { title: "Review sign-off", required: true, description: "A person signed off on the code review." },
    });
    const entered: string[] = [];
    registerPipelineStageRunner("review_signoff", {
      prepareEvidence: (ctx) => ({ evidence: { ...ctx.evidence, checkedBy: "collector" } }),
      onEnter: (ctx) => {
        entered.push(ctx.stage.id);
      },
    });
    const w = makeWorld({
      issueId: "ISSUE-1",
      override: { add: [{ after: "code_review", stage: { id: "signoff", kind: "review_signoff" } as never }] },
    });
    expect(w.run.definition.stages.map((s) => s.id)).toEqual([
      "start",
      "coding",
      "validation",
      "review",
      "deploy",
      "screenshot",
      "code_review",
      "signoff",
      "human_review",
      "complete",
    ]);
    expect(w.run.definition.stages.find((s) => s.id === "signoff")).toMatchObject({ title: "Review sign-off", required: true });
    w.changed.files = ["packages/collector/a.ts"];
    await throughDeploy(w);
    expect((await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" })).body.to).toBe("signoff");
    expect(entered).toEqual(["signoff"]);
    expect(pipelineStatusView(runOf(w)).exitCriteria).toContain("Evidence: {approver, approved?}.");
    const missing = await advance(w, "signoff", {});
    expect(missing.status).toBe(422);
    expect(missing.body.missing).toEqual(["evidence.approver (who approved)"]);
    const done = await advance(w, "signoff", { approver: "alice" });
    expect(done.status).toBe(200);
    expect(done.body.to).toBe("human_review");
    expect(runOf(w).attempts.find((a) => a.stageId === "signoff")!.evidence).toEqual({ approver: "alice", checkedBy: "collector" });
    await approveReview(w);
    expect(runOf(w).status).toBe("complete");
  });
});

describe("launcher", () => {
  test("buildOpeningPrompt briefs an active pipeline, and drops it without the standup MCP", () => {
    const w = makeWorld();
    const plain = buildOpeningPrompt(w.store.db, "Do the task", undefined, "proj");
    expect(plain).not.toContain("Delivery pipeline");
    const args = [w.store.db, "Do the task", undefined, "proj", undefined, "", "", false, "claude", undefined, "", undefined] as const;
    const briefed = buildOpeningPrompt(...args, DEFAULT_PIPELINE);
    expect(briefed).toContain(formatPipelineInstruction(DEFAULT_PIPELINE));
    expect(briefed).toContain("pipeline_advance");
    expect(briefed).toContain("ask_human");
    expect(briefed).toContain("pipeline-screenshot.ts");
    const strict = buildOpeningPrompt(w.store.db, "Do the task", undefined, "proj", "--strict-mcp-config", "", "", false, "claude", undefined, "", undefined, DEFAULT_PIPELINE);
    expect(strict).not.toContain("Delivery pipeline");
  });

  test("the pipeline brief makes a recording the default for perf, load-time and interaction-flow changes", () => {
    const brief = formatPipelineInstruction(DEFAULT_PIPELINE);
    const line = brief.split("\n").find((l) => l.startsWith("Recordings:"));
    expect(line).toBeDefined();
    for (const phrase of ["perf, load-time or interaction-flow change", "static UI stays on screenshots", "--record <local url> --cold", "--preset persona", ".webm", "review scratch dir", "submit_review_packet"]) {
      expect(line).toContain(phrase);
    }
    expect(line).not.toContain("mobile");
  });

  test("the screenshot stage says it takes desktop PNGs and that recordings go in the review packet", () => {
    const stage = formatPipelineInstruction(DEFAULT_PIPELINE)
      .split("\n")
      .find((l) => l.includes("Screenshots (screenshot):"));
    expect(stage).toContain("Desktop PNG screenshots");
    expect(stage).toContain("recordings go in the review packet's media");
  });

  test("startLaunchPipeline: pipeline:false records a disabled run; bootstrap, reuse and scratch get none", () => {
    const w = makeWorld();
    const db = w.store.db;
    const launch = (id: string) => ({ ...w.launch, id });
    const insert = (id: string) =>
      db.run(
        "INSERT INTO launches (id, kind, project_id, task, worktree_path, branch, status) VALUES (?, 'worktree', 'proj', 't', ?, 'b', 'running')",
        [id, `/tmp/wt-${id}`]
      );
    for (const id of ["l-off", "l-on", "l-boot", "l-reuse", "l-scratch", "l-nomcp"]) insert(id);
    expect(startLaunchPipeline(db, launch("l-nomcp"), { reusedWorktree: false, scratch: false, standupMcp: false })?.status).toBe("disabled");
    expect(startLaunchPipeline(db, launch("l-off"), { reusedWorktree: false, scratch: false, requester: "bob", pipeline: false })?.status).toBe("disabled");
    const on = startLaunchPipeline(db, launch("l-on"), { reusedWorktree: false, scratch: false });
    expect(on?.status).toBe("active");
    expect(on?.owner).toBe(process.env.STANDUP_HOST_USER?.trim() || process.env.USER?.trim() || "local");
    expect(startLaunchPipeline(db, launch("l-boot"), { kind: "bootstrap", reusedWorktree: false, scratch: false })).toBeNull();
    expect(startLaunchPipeline(db, launch("l-reuse"), { reusedWorktree: true, scratch: false })).toBeNull();
    expect(startLaunchPipeline(db, launch("l-scratch"), { reusedWorktree: false, scratch: true })).toBeNull();
  });
});
