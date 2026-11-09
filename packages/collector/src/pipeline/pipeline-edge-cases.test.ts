import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { testTempDir } from "../test-support/temp-dirs.js";
import {
  createLaunch,
  createSession,
  getPipelineRun,
  getTicketByLaunch,
  linkPersonaJobLaunch,
  personaJobForLaunch,
  recordPipelineAttempt,
  setReviewUrl,
  updateLaunchStatus,
  updateTicketStatus,
  upsertProject,
} from "@standup/store";
import { currentEpochAttempts } from "@standup/shared";
import {
  advancePipeline,
  disablePipelineForLaunch,
  enablePipelineForLaunch,
  markReviewHandoff,
  markRunWaiting,
  pipelineReworkRequested,
  pipelineStatusView,
  pipelineSteerLine,
  pipelineStopDecision,
  recordReviewUrl,
  startPipelineForLaunch,
  waivePipelineStage,
} from "./engine.js";
import { MAX_SCREENSHOTS_PER_ADVANCE } from "./runners.js";
import { validateScreenshotPath } from "./screenshots.js";
import { EVIDENCE, OWNER, advance, human, makeWorld, pngBytes, post, submitPacket, withIssueIdReviews, writeTinyPng, type World } from "./test-world.js";

/**
 * The pipeline's harder corners: budgets across a rework, review findings
 * only the owner can settle, review-gate projects at code_review, several workers on
 * one Persona job, what a worker may put in evidence, and the screenshot
 * caps.
 */

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

async function toReview(w: World) {
  expect((await advance(w, "start")).status).toBe(200);
  expect((await advance(w, "coding", EVIDENCE.coding)).status).toBe(200);
  expect((await advance(w, "validation", EVIDENCE.validationPass)).status).toBe(200);
}

async function toCodeReview(w: World) {
  w.changed.files = ["packages/collector/a.ts"];
  await toReview(w);
  expect((await advance(w, "review", EVIDENCE.reviewClean)).status).toBe(200);
  // The launch's packet reaches the owner's Review tab on the way; the run needs it to enter code_review.
  const packetId = submitPacket(w);
  const res = await advance(w, "deploy", EVIDENCE.deploy);
  expect(res.body.to).toBe("code_review");
  return packetId;
}

describe("budgets across a rework", () => {
  test("four validation failures, a waive and a rework: the next failure loops normally", async () => {
    const w = makeWorld();
    await advance(w, "start");
    for (let i = 0; i < 4; i++) {
      await advance(w, "coding", EVIDENCE.coding);
      expect((await advance(w, "validation", EVIDENCE.validationFail)).body.to).toBe("coding");
    }
    await advance(w, "coding", EVIDENCE.coding);
    const waived = await waivePipelineStage(w.store.db, w.run.id, { stage: "validation", reason: "flaky suite", actor: OWNER }, w.deps);
    expect(waived.ok && waived.to).toBe("review");
    const reworked = await pipelineReworkRequested(w.store.db, w.launch.id, w.deps);
    expect(reworked).toMatchObject({ currentStage: "coding", epoch: 1 });
    // The rework attempt belongs to the epoch it was made in.
    expect(runOf(w).attempts.at(-1)).toMatchObject({ stageId: "review", status: "failed", epoch: 0 });

    // Coding's sixth attempt overall, but the first of the new epoch.
    expect((await advance(w, "coding", EVIDENCE.coding)).status).toBe(200);
    const res = await advance(w, "validation", EVIDENCE.validationFail);
    expect(res.body.to).toBe("coding");
    expect(res.body.run.status).toBe("active");
    const view = pipelineStatusView(runOf(w));
    expect(view.loopBudget.find((b) => b.edge === "validation → coding")).toMatchObject({ used: 1, max: 4 });
    // The stage views keep the whole history.
    expect(view.stages.validation!.attempts).toBe(6);
  });
});

describe("review findings only the owner can settle", () => {
  test("a review blocked only by wontfix findings holds at review for the owner; the worker may re-advance", async () => {
    const w = makeWorld({ persona: true });
    await toReview(w);
    const wontfix = {
      reviewers: [
        { name: "r1", findings: [{ severity: "high", title: "schema drift", status: "wontfix" }] },
        { name: "r2", findings: [{ severity: "low", title: "nit", status: "open" }] },
      ],
    };
    const res = await advance(w, "review", wontfix);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("failed");
    expect(res.body.to).toBe("review");
    expect(runOf(w)).toMatchObject({ currentStage: "review", status: "waiting_user", waitingKind: "owner_input" });
    expect(runOf(w).waitingReason).toBe("review has wontfix High/Medium findings — Persona decides whether to accept them");
    expect(runOf(w).attempts.filter((a) => a.stageId === "coding")).toHaveLength(1);
    // Persona decides on the hold: its job stays active, and it's offered accept_wontfix.
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job).toMatchObject({ status: "active", note: expect.stringMatching(/^Persona deciding: /) });
    expect(w.broadcasts.filter((m) => m.type === "pipeline:blocked").at(-1)?.payload).toMatchObject({
      stage: "review",
      options: ["skip", "waive", "close_out", "accept_wontfix", "escalate"],
    });

    // An open High still loops to coding as usual; here the worker comes back with a clean review instead.
    const again = await advance(w, "review", EVIDENCE.reviewClean);
    expect(again.status).toBe(200);
    expect(again.body.to).toBe("deploy");
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
  });

  test("an open blocking finding alongside a wontfix one still loops to coding", async () => {
    const w = makeWorld();
    await toReview(w);
    const res = await advance(w, "review", {
      reviewers: [
        { name: "r1", findings: [{ severity: "high", title: "a", status: "wontfix" }] },
        { name: "r2", findings: [{ severity: "medium", title: "b", status: "open" }] },
      ],
    });
    expect(res.body.to).toBe("coding");
  });
});

describe("review-gate projects at code_review", () => {
  withIssueIdReviews();

  for (const issueId of ["", "ISSUE-1"]) {
    test(`a Stop at code_review sends the worker to mark_ready_for_review and never asks the owner for an issue id (${issueId ? "with" : "no"} ticket issue id)`, async () => {
      const w = makeWorld({ persona: true, issueId });
      upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "review-agent" });
      const packetId = await toCodeReview(w);
      const stop = pipelineStopDecision(w.store.db, w.sessionId, w.deps);
      expect(stop?.block).toBe(true);
      expect(stop!.reason).toContain("call mark_ready_for_review — the project's review gate then hands you the code review to cut");
      expect(stop!.reason).toContain("report its url with report_ticket_status (reviewUrl)");
      expect(stop!.reason).not.toContain("pipeline_advance");
      expect(pipelineSteerLine(w.store.db, w.sessionId)).toContain("report its url with report_ticket_status (reviewUrl)");
      expect(runOf(w).status).toBe("active");
      expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");

      // Without an issue id, a worker's own code review report is pointed at the gate too, without handing off.
      if (!issueId) {
        const res = await advance(w, "code_review", { reviewId: "R-1" });
        expect(res.status).toBe(422);
        expect(res.body.error).toContain("mark_ready_for_review");
        expect(runOf(w).status).toBe("active");
      }

      // The ticket is in review but no code review reached the run: the Stop goes through and Persona is told.
      const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
      updateTicketStatus(w.store.db, ticket.id, "needs_review");
      expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
      expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input", waitingReason: "the review gate didn't record a code review — needs you" });
      expect(personaJobForLaunch(w.store.db, w.launch.id)!.job).toMatchObject({
        status: "active",
        note: "Persona deciding: the review gate didn't record a code review — needs you",
      });

      // The code review the gate handed over still passes code_review, and the job is released;
      // the owner's review decision is all that is left.
      markReviewHandoff(w.store.db, w.launch.id);
      const res = await post(w, `/api/tickets/${ticket.id}/status`, {
        status: "needs_review",
        reviewUrl: "https://git.example.com/acme/app/pull/7",
        session_id: w.sessionId,
      });
      expect(res.status).toBe(200);
      for (let i = 0; i < 50 && runOf(w).currentStage !== "human_review"; i++) await Bun.sleep(10);
      expect(runOf(w)).toMatchObject({ status: "active", currentStage: "human_review" });
      expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
      expect((await post(w, `/api/reviews/${packetId}/approve`, {}, human(w))).status).toBe(200);
      expect(runOf(w).status).toBe("complete");
    });
  }
});

describe("several workers on one Persona job", () => {
  test("the job stays noted for Persona while any of its runs is still blocked", async () => {
    const w = makeWorld({ persona: true });
    const db = w.store.db;
    const job = personaJobForLaunch(db, w.launch.id)!.job;
    const s2 = `sess-${randomUUID().slice(0, 8)}`;
    createSession(db, { id: s2, projectId: "proj", title: "Worker 2", cwd: "/tmp/wt-2", status: "running" });
    const l2 = createLaunch(db, { id: randomUUID(), projectId: "proj", task: "t2", worktreePath: "/tmp/wt-2", branch: "b2", status: "running", sessionId: s2 });
    linkPersonaJobLaunch(db, job.id, l2.id);
    const run2 = startPipelineForLaunch(db, { launchId: l2.id, owner: OWNER, projectId: "proj" });

    markRunWaiting(db, runOf(w), "first needs you", "owner_input", w.deps);
    markRunWaiting(db, getPipelineRun(db, run2.id)!, "second needs you", "owner_input", w.deps);
    expect(personaJobForLaunch(db, w.launch.id)!.job).toMatchObject({ status: "active", note: "Persona deciding: first needs you" });
    // The second run is recorded as a flagger of the job too, and Persona heard of both blocks.
    expect(getPipelineRun(db, run2.id)!.flaggedJob).toEqual({ id: job.id, note: "Persona deciding: first needs you" });
    expect(w.broadcasts.filter((m) => m.type === "pipeline:blocked").map((m) => (m.payload as { runId: string }).runId)).toEqual([
      w.run.id,
      run2.id,
    ]);

    // The first run moves on: the job stays noted, now for the second run's block.
    await waivePipelineStage(db, w.run.id, { stage: "start", reason: "go", actor: OWNER }, w.deps);
    expect(personaJobForLaunch(db, w.launch.id)!.job).toMatchObject({ status: "active", note: "Persona deciding: second needs you" });
    expect(getPipelineRun(db, run2.id)!.flaggedJob).toEqual({ id: job.id, note: "Persona deciding: second needs you" });

    // The last blocked run moves on: the note says so.
    await waivePipelineStage(db, run2.id, { stage: "start", reason: "go", actor: OWNER }, w.deps);
    expect(personaJobForLaunch(db, w.launch.id)!.job).toMatchObject({ status: "active", note: "Pipeline moved on: Coding" });
  });
});

describe("what a worker may put in evidence", () => {
  test("storedPath, width and height are stripped from any stage's screenshots; a coding attempt's are never served", async () => {
    const w = makeWorld();
    await advance(w, "start");
    const original = writeTinyPng(2, 2);
    await advance(w, "coding", { ...EVIDENCE.coding, screenshots: [{ path: original, storedPath: "/etc/shadow", width: 9 }] });
    const coding = runOf(w).attempts.find((a) => a.stageId === "coding")!;
    expect((coding.evidence as { screenshots: unknown[] }).screenshots).toEqual([{ path: original }]);

    // Even a real stored copy named after a coding attempt isn't served: only screenshot stages are.
    const planted = recordPipelineAttempt(w.store.db, w.run.id, { id: "planted", stageId: "coding", status: "passed" });
    const storedPath = w.deps.screenshots.save(w.run.id, "planted-0.png", pngBytes(1, 1));
    w.store.db.run("UPDATE pipeline_stage_attempts SET evidence_json = ? WHERE id = ?", [
      JSON.stringify({ summary: "x", screenshots: [{ path: original, storedPath }] }),
      planted.id,
    ]);
    const res = await w.app.request(`/api/pipeline/runs/${w.run.id}/screenshots/planted/0`, { headers: human(w) });
    expect(res.status).toBe(404);
  });

  test("a skip or waive reason longer than the evidence string cap is refused", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/web/App.tsx"];
    await toReview(w);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    const long = "x".repeat(9000);
    const skip = await advance(w, "screenshot", undefined, { reason: long });
    expect(skip.status).toBe(422);
    expect(skip.body.missing[0]).toContain("skip.reason (at most");
    const waive = await waivePipelineStage(w.store.db, w.run.id, { stage: "screenshot", reason: long, actor: OWNER }, w.deps);
    expect(!waive.ok && waive.status).toBe(422);
    expect(runOf(w).currentStage).toBe("screenshot");
  });

  test(`at most ${MAX_SCREENSHOTS_PER_ADVANCE} screenshots per advance`, async () => {
    const w = makeWorld();
    w.changed.files = ["packages/web/App.tsx"];
    await toReview(w);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    submitPacket(w);
    const path = writeTinyPng();
    const res = await advance(w, "screenshot", { screenshots: Array.from({ length: 11 }, () => ({ path })) });
    expect(res.status).toBe(422);
    expect(res.body.missing).toEqual(["evidence.screenshots (at most 10 per advance)"]);
    const ok = await advance(w, "screenshot", { screenshots: Array.from({ length: 10 }, () => ({ path })) });
    expect(ok.status).toBe(200);
  });

  test("a refused screenshot leaves no stored copy, even of the ones before it that validated", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/web/App.tsx"];
    await toReview(w);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    const saved: string[] = [];
    const save = w.deps.screenshots.save;
    w.deps.screenshots = {
      ...w.deps.screenshots,
      save: (runId, name, bytes) => {
        const path = save(runId, name, bytes);
        saved.push(path);
        return path;
      },
    };
    const res = await advancePipeline(
      w.store.db,
      w.run.id,
      { stage: "screenshot", evidence: { screenshots: [{ path: writeTinyPng() }, { path: "/nope/x.png" }] } },
      w.deps
    );
    expect(!res.ok && res.status).toBe(422);
    expect(saved).toHaveLength(1);
    expect(existsSync(saved[0]!)).toBe(false);
  });
});

describe("the review gate's records and the worker's", () => {
  test("requireOwnerGate does not refuse the review gate's code review record", async () => {
    const w = makeWorld({ issueId: "ISSUE-1", override: { stages: { code_review: { requireOwnerGate: true } } } });
    await toCodeReview(w);
    expect((await advance(w, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" })).status).toBe(422);
    const res = await recordReviewUrl(w.store.db, w.launch.id, "https://git.example.com/acme/app/pull/1", undefined, w.deps, { fromReviewGate: true });
    expect(res?.ok).toBe(true);
    expect(runOf(w)).toMatchObject({ status: "active", currentStage: "human_review" });
  });

  test("a url a worker put on the ticket early isn't taken as the gate's on entering code_review", async () => {
    const w = makeWorld({ issueId: "" });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "command" });
    setReviewUrl(w.store.db, getTicketByLaunch(w.store.db, w.launch.id)!.id, "https://git.example.com/acme/app/pull/early");
    await toCodeReview(w);
    // Ticket still developing: the gate never ran, so the url is a worker's report without an issue id.
    expect(runOf(w)).toMatchObject({ currentStage: "code_review", status: "active" });
  });

  test("an exhausted run refuses a worker's code review record but not the review gate's", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    await toCodeReview(w);
    const run = runOf(w);
    markRunWaiting(w.store.db, run, "out of budget", "exhausted", w.deps);
    const worker = await recordReviewUrl(w.store.db, w.launch.id, "https://git.example.com/acme/app/pull/1", "ISSUE-1", w.deps, { fromReviewGate: false });
    expect(worker?.ok).toBe(false);
    expect(!worker?.ok && worker?.status).toBe(409);
    const gate = await recordReviewUrl(w.store.db, w.launch.id, "https://git.example.com/acme/app/pull/1", undefined, w.deps, { fromReviewGate: true });
    expect(gate?.ok).toBe(true);
  });
});

describe("owner hand-offs the worker can come back from", () => {
  withIssueIdReviews();

  test("once the issue id the run waited for is known, a Stop at code_review is blocked again", async () => {
    const w = makeWorld({ issueId: "" });
    await toCodeReview(w);
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input" });
    w.store.db.run("UPDATE tickets SET issue_id = 'ISSUE-5' WHERE launch_id = ?", [w.launch.id]);
    const stop = pipelineStopDecision(w.store.db, w.sessionId, w.deps);
    expect(stop?.block).toBe(true);
    expect(stop!.reason).toContain("you're at Code review (code_review)");
  });

  test("a waive computes the facts it plans with: an auto-skip still applies", async () => {
    const w = makeWorld();
    w.changed.files = null;
    await toReview(w);
    await advance(w, "review", EVIDENCE.reviewClean);
    expect(runOf(w).facts).toEqual({});
    w.changed.files = ["packages/store/a.ts"];
    const res = await waivePipelineStage(w.store.db, w.run.id, { stage: "deploy", reason: "no stack", actor: OWNER }, w.deps);
    expect(res.ok && res.to).toBe("code_review");
    expect(res.ok && res.skipped.map((s) => s.stageId)).toEqual(["screenshot"]);
    expect(runOf(w).facts).toEqual({ ui_changed: false, docs_only: false });
  });
});

describe("run frames", () => {
  test("pipeline:updated is addressed to the run's owner", async () => {
    const w = makeWorld();
    await advance(w, "start");
    const frames = w.broadcasts.filter((m) => m.type === "pipeline:updated");
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.audience).toBe(OWNER);
  });
});

describe("turning a run on and off", () => {
  function attemptLaunch(w: World, n: number) {
    const db = w.store.db;
    const sessionId = `sess-${randomUUID().slice(0, 8)}`;
    createSession(db, { id: sessionId, projectId: "proj", title: `Attempt ${n}`, cwd: `/tmp/wt-a${n}`, status: "running" });
    const launch = createLaunch(db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: `/tmp/wt-a${n}`, branch: `a${n}`, status: "running", sessionId });
    startPipelineForLaunch(db, { launchId: launch.id, owner: OWNER, projectId: "proj", disabled: true, disabledReason: "attempt" });
    return launch;
  }

  test("re-enabling a run picked before (A → B → A) starts a fresh epoch with fresh budgets", async () => {
    const w = makeWorld();
    const db = w.store.db;
    const a = attemptLaunch(w, 1);
    const b = attemptLaunch(w, 2);
    const runA = enablePipelineForLaunch(db, { launchId: a.id, owner: OWNER, projectId: "proj" }, w.deps);
    expect(runA).toMatchObject({ status: "active", currentStage: "coding", epoch: 0 });
    for (let i = 0; i < 3; i++) {
      expect((await advancePipeline(db, runA.id, { stage: "coding", evidence: EVIDENCE.coding }, w.deps)).ok).toBe(true);
      const failed = await advancePipeline(db, runA.id, { stage: "validation", evidence: EVIDENCE.validationFail }, w.deps);
      expect(failed.ok && failed.to).toBe("coding");
    }
    expect(pipelineStatusView(getPipelineRun(db, runA.id)!).loopBudget.find((x) => x.edge === "validation → coding")!.used).toBe(3);

    disablePipelineForLaunch(db, a.id, w.deps);
    expect(getPipelineRun(db, runA.id)).toMatchObject({ status: "disabled", disabledReason: "attempt" });
    enablePipelineForLaunch(db, { launchId: b.id, owner: OWNER, projectId: "proj" }, w.deps);
    disablePipelineForLaunch(db, b.id, w.deps);

    const again = enablePipelineForLaunch(db, { launchId: a.id, owner: OWNER, projectId: "proj" }, w.deps);
    expect(again).toMatchObject({ status: "active", currentStage: "coding", epoch: 1 });
    expect(again.disabledReason).toBeUndefined();
    expect(currentEpochAttempts(again).map((x) => x.stageId)).toEqual(["start"]);
    expect(pipelineStatusView(again).loopBudget.find((x) => x.edge === "validation → coding")!.used).toBe(0);
    // The history stays.
    expect(again.attempts.filter((x) => x.stageId === "validation")).toHaveLength(3);
  });

  test("only an attempt's run is turned on: an opt-out (unless a person allows it), a no-MCP worker and a config-off run stay off", () => {
    const w = makeWorld();
    const db = w.store.db;
    const make = (reason: "opt_out" | "no_mcp") => {
      const launch = createLaunch(db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: `/tmp/wt-${reason}`, branch: reason, status: "running" });
      startPipelineForLaunch(db, { launchId: launch.id, owner: OWNER, projectId: "proj", disabled: true, disabledReason: reason });
      return launch;
    };
    const optOut = make("opt_out");
    const noMcp = make("no_mcp");
    expect(enablePipelineForLaunch(db, { launchId: optOut.id, owner: OWNER, projectId: "proj" }, w.deps)).toMatchObject({ status: "disabled", disabledReason: "opt_out" });
    expect(enablePipelineForLaunch(db, { launchId: noMcp.id, owner: OWNER, projectId: "proj", allowOptOut: true }, w.deps).status).toBe("disabled");
    expect(enablePipelineForLaunch(db, { launchId: optOut.id, owner: OWNER, projectId: "proj", allowOptOut: true }, w.deps).status).toBe("active");

    const off = makeWorld({ override: { enabled: false } });
    expect(off.run).toMatchObject({ status: "disabled", disabledReason: "other" });
    expect(enablePipelineForLaunch(off.store.db, { launchId: off.launch.id, owner: OWNER, projectId: "proj" }, off.deps).status).toBe("disabled");
  });
});

describe("who may send the work back", () => {
  async function inReview(w: World) {
    await toCodeReview(w);
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    expect((await post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" })).status).toBe(200);
    return ticket;
  }

  test("a status call without a person's token never resets the run, whatever session it names", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    const ticket = await inReview(w);
    for (const body of [{ status: "developing" }, { status: "developing", session_id: "not-a-session" }]) {
      expect((await post(w, `/api/tickets/${ticket.id}/status`, body)).status).toBe(200);
      expect(getTicketByLaunch(w.store.db, w.launch.id)!.status).toBe("developing");
      await Bun.sleep(10);
      expect(runOf(w)).toMatchObject({ currentStage: "code_review", epoch: 0 });
      updateTicketStatus(w.store.db, ticket.id, "needs_review");
    }
    expect((await post(w, `/api/tickets/${ticket.id}/status`, { status: "developing" }, human(w))).status).toBe(200);
    await Bun.sleep(10);
    expect(runOf(w)).toMatchObject({ currentStage: "coding", epoch: 1 });
  });
});

describe("a Persona job's flag passing between runs", () => {
  function secondRun(w: World, status: "running" | "failed") {
    const db = w.store.db;
    const job = personaJobForLaunch(db, w.launch.id)!.job;
    const s2 = `sess-${randomUUID().slice(0, 8)}`;
    createSession(db, { id: s2, projectId: "proj", title: "Worker 2", cwd: "/tmp/wt-2", status: "running" });
    const l2 = createLaunch(db, { id: randomUUID(), projectId: "proj", task: "t2", worktreePath: "/tmp/wt-2", branch: "b2", status: "running", sessionId: s2 });
    linkPersonaJobLaunch(db, job.id, l2.id);
    const run2 = startPipelineForLaunch(db, { launchId: l2.id, owner: OWNER, projectId: "proj" });
    markRunWaiting(db, runOf(w), "first needs you", "owner_input", w.deps);
    markRunWaiting(db, getPipelineRun(db, run2.id)!, "second needs you", "owner_input", w.deps);
    if (status === "failed") updateLaunchStatus(db, l2.id, "failed");
    return { job, run2 };
  }

  test("the run that takes over the flag is published", async () => {
    const w = makeWorld({ persona: true });
    const { run2 } = secondRun(w, "running");
    w.broadcasts.length = 0;
    await waivePipelineStage(w.store.db, w.run.id, { stage: "start", reason: "go", actor: OWNER }, w.deps);
    const frame = w.broadcasts.find((m) => m.type === "pipeline:updated" && (m.payload as { id: string }).id === run2.id);
    expect((frame?.payload as { flaggedJob?: { note: string } } | undefined)?.flaggedJob?.note).toBe("Persona deciding: second needs you");
  });

  test("a run whose launch failed never takes over the flag", async () => {
    const w = makeWorld({ persona: true });
    const { run2 } = secondRun(w, "failed");
    await waivePipelineStage(w.store.db, w.run.id, { stage: "start", reason: "go", actor: OWNER }, w.deps);
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
    expect(getPipelineRun(w.store.db, run2.id)!.flaggedJob?.note).not.toBe("Persona deciding: second needs you");
  });
});

describe("screenshot files", () => {
  test("a FIFO named .png is refused without blocking", () => {
    const dir = testTempDir("standup-fifo-");
    const path = join(dir, "pipe.png");
    const made = Bun.spawnSync(["mkfifo", path]);
    if (made.exitCode !== 0) {
      console.warn("mkfifo unavailable; skipping the FIFO check");
      return;
    }
    const check = validateScreenshotPath(path, [dir]);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.error).toContain("is not a regular file");
  });
});
