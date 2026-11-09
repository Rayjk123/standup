import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import {
  createAsk,
  createLaunch,
  createSessionMessage,
  createSteer,
  getPipelineRun,
  getTicket,
  getTicketByLaunch,
  personaJobForLaunch,
  recordPipelineAttempt,
  updateLaunchStatus,
  updateTicketStatus,
  upsertProject,
} from "@standup/store";
import { DEFAULT_IDENTITY_HEADER, DEFAULT_PIPELINE } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { markReviewHandoff, markRunWaiting, reportedReviewUrlSource, startPipelineForLaunch } from "./engine.js";
import {
  EVIDENCE,
  OWNER,
  WORKTREE,
  advance,
  human,
  makeWorld,
  pngBytes,
  post,
  submitPacket,
  withIssueIdReviews,
  writeTinyPng,
  type World,
} from "./test-world.js";

const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

async function hook(w: World, event: string, extra: Record<string, unknown> = {}) {
  const res = await post(w, "/hook", { session_id: w.sessionId, cwd: WORKTREE, hook_event_name: event, ...extra });
  return (await res.json()) as Record<string, any>;
}

describe("status and advance", () => {
  test("status describes the current stage", async () => {
    const w = makeWorld();
    const res = await post(w, "/api/pipeline/status", { session_id: w.sessionId, cwd: WORKTREE });
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, any>;
    expect(view.run.currentStage).toBe("start");
    expect(view.stage.id).toBe("start");
    expect(view.next).toEqual([{ to: "coding", when: { outcome: "passed" } }]);
    expect(view.loopBudget.map((b: { edge: string }) => b.edge)).toContain("validation → coding");
    expect(view.incomplete).toContain("code_review");
  });

  test("a session with no run gets 404", async () => {
    const w = makeWorld();
    const res = await post(w, "/api/pipeline/status", { session_id: "nobody", cwd: "/nowhere" });
    expect(res.status).toBe(404);
  });

  test("advancing without evidence is refused with 422 naming what is missing", async () => {
    const w = makeWorld();
    await advance(w, "start");
    const res = await advance(w, "coding");
    expect(res.status).toBe(422);
    expect(res.body.missing).toEqual(["evidence.summary (non-empty string describing the change)"]);
    await advance(w, "coding", EVIDENCE.coding);
    const v = await advance(w, "validation", { commands: [] });
    expect(v.status).toBe(422);
    expect(v.body.missing[0]).toContain("evidence.commands");
  });

  test("advancing a stage that isn't current is refused with 409", async () => {
    const w = makeWorld();
    const res = await advance(w, "review", EVIDENCE.reviewClean);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('the run is at "start"');
    expect(runOf(w).attempts).toHaveLength(0);
  });

  test("a non-skippable stage refuses a skip; the screenshot stage takes one", async () => {
    // Screenshots that don't skip themselves, for a change with no UI.
    const w = makeWorld({ override: { stages: { screenshot: { skipWhen: [] } } } });
    w.changed.files = ["packages/collector/src/theme.ts"];
    await advance(w, "start");
    expect((await advance(w, "coding", undefined, { reason: "nah" })).status).toBe(422);
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    submitPacket(w);
    const skip = await advance(w, "screenshot", undefined, { reason: "backend-only styling constant" });
    expect(skip.status).toBe(200);
    expect(skip.body.outcome).toBe("skipped");
    expect(skip.body.to).toBe("code_review");
  });

  test("every transition writes a structural checkpoint and broadcasts pipeline:updated", async () => {
    const w = makeWorld();
    await advance(w, "start");
    expect(w.checkpoints.at(-1)).toContain("Pipeline: start passed");
    expect(w.broadcasts.some((m) => m.type === "pipeline:updated")).toBe(true);
  });

  test("a subagent session resolves to its parent's run", async () => {
    const w = makeWorld();
    w.store.db.run(
      "INSERT INTO sessions (id, project_id, cwd, parent_session_id, status) VALUES ('child-1', 'proj', ?, ?, 'running')",
      [WORKTREE, w.sessionId]
    );
    const res = await post(w, "/api/pipeline/advance", { session_id: "child-1", cwd: WORKTREE, stage: "start" });
    expect(res.status).toBe(200);
  });
});

describe("runs, screenshots and waivers", () => {
  test("runs list by launch ids and by job, for their human owner only", async () => {
    const w = makeWorld({ persona: true });
    const runs = async (query: string, alias = OWNER) =>
      ((await (await w.app.request(`/api/pipeline/runs?${query}`, { headers: human(w, alias) })).json()) as { runs: Array<{ id: string }> }).runs;
    expect((await runs(`launchIds=${w.launch.id},other`)).map((r) => r.id)).toEqual([w.run.id]);
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    expect((await runs(`jobId=${jobId}`)).map((r) => r.id)).toEqual([w.run.id]);
    expect((await w.app.request(`/api/pipeline/runs/${w.run.id}`, { headers: human(w) })).status).toBe(200);
    // Someone else's runs read as absent; a worker (no owner token) is refused outright.
    expect(await runs(`launchIds=${w.launch.id}`, "bob")).toEqual([]);
    expect((await w.app.request(`/api/pipeline/runs/${w.run.id}`, { headers: human(w, "bob") })).status).toBe(404);
    expect((await w.app.request(`/api/pipeline/runs?launchIds=${w.launch.id}`)).status).toBe(403);
    expect((await w.app.request(`/api/pipeline/runs/${w.run.id}`)).status).toBe(403);
  });

  test("a recorded screenshot is served from the collector's copy, to its owner only", async () => {
    const w = makeWorld();
    w.changed.files = ["packages/web/App.tsx"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    await advance(w, "deploy", EVIDENCE.deploy);
    submitPacket(w);
    const original = writeTinyPng(5, 5);
    await advance(w, "screenshot", { screenshots: [{ path: original }] });
    // The worker's file changing afterwards changes nothing that is served.
    writeFileSync(original, "replaced with something else");
    const attempt = runOf(w).attempts.find((a) => a.stageId === "screenshot")!;
    const url = `/api/pipeline/runs/${w.run.id}/screenshots/${attempt.id}/0`;
    expect((await w.app.request(url)).status).toBe(403);
    expect((await w.app.request(url, { headers: human(w, "bob") })).status).toBe(404);
    const res = await w.app.request(url, { headers: human(w) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(pngBytes(5, 5))).toBe(true);
    expect((await w.app.request(`/api/pipeline/runs/${w.run.id}/screenshots/${attempt.id}/1`, { headers: human(w) })).status).toBe(404);
  });

  test("a screenshot whose evidence names a file outside the store is never served", async () => {
    const w = makeWorld();
    const attempt = recordPipelineAttempt(w.store.db, w.run.id, {
      stageId: "screenshot",
      status: "passed",
      evidence: { screenshots: [{ path: "/etc/passwd", storedPath: "/etc/passwd" }] },
    });
    const res = await w.app.request(`/api/pipeline/runs/${w.run.id}/screenshots/${attempt.id}/0`, { headers: human(w) });
    expect(res.status).toBe(410);
  });

  test("the owner may waive the start stage", async () => {
    const w = makeWorld();
    const res = await post(w, `/api/pipeline/runs/${w.run.id}/waive`, { stage: "start", reason: "kicked off by hand" }, human(w));
    expect(res.status).toBe(200);
    expect(runOf(w).currentStage).toBe("coding");
  });

  test("only the run's owner may waive, through the console", async () => {
    const w = makeWorld();
    await advance(w, "start");
    const body = { stage: "coding", reason: "already shipped by hand" };
    expect((await post(w, `/api/pipeline/runs/${w.run.id}/waive`, body)).status).toBe(403);
    expect((await post(w, `/api/pipeline/runs/${w.run.id}/waive`, body, human(w, "bob"))).status).toBe(403);
    expect((await post(w, `/api/pipeline/runs/${w.run.id}/waive`, { stage: "review", reason: "x" }, human(w))).status).toBe(409);
    const res = await post(w, `/api/pipeline/runs/${w.run.id}/waive`, body, human(w));
    expect(res.status).toBe(200);
    const run = runOf(w);
    expect(run.currentStage).toBe("validation");
    expect(run.attempts.at(-1)).toMatchObject({ stageId: "coding", status: "waived" });
  });
});

describe("hooks", () => {
  test("Stop mid-pipeline is blocked three times, then goes through and hands off", async () => {
    const w = makeWorld({ persona: true });
    for (let i = 1; i <= 3; i++) {
      const out = await hook(w, "Stop");
      expect(out.decision).toBe("block");
      expect(out.reason).toContain("pipeline_advance");
    }
    const fourth = await hook(w, "Stop");
    expect(fourth).toEqual({ ok: true });
    expect(runOf(w).status).toBe("waiting_user");
    expect(runOf(w).waitingKind).toBe("stalled");
    expect(runOf(w).waitingReason).toContain("worker stopped 3 times at start");
    // The stall goes to Persona to decide; its job stays active.
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job).toMatchObject({ status: "active", note: expect.stringMatching(/^Persona deciding: worker stopped 3 times/) });
    expect(w.broadcasts.filter((m) => m.type === "pipeline:blocked").at(-1)?.payload).toMatchObject({ waitingKind: "stalled" });
    // A waiting run no longer blocks; the stalled worker's valid advance puts it back on track.
    expect(await hook(w, "Stop")).toEqual({ ok: true });
    expect((await advance(w, "coding", EVIDENCE.coding)).status).toBe(409);
    expect(runOf(w).status).toBe("waiting_user");
    const resumed = await advance(w, "start");
    expect(resumed.status).toBe(200);
    expect(runOf(w)).toMatchObject({ status: "active", currentStage: "coding" });
    expect(runOf(w).waitingKind).toBeUndefined();
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.status).toBe("active");
  });

  test("an exhausted run still refuses the worker's advance", async () => {
    const w = makeWorld();
    markRunWaiting(w.store.db, runOf(w), "out of budget", "exhausted", w.deps);
    const refused = await advance(w, "start");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Persona decides (skip, waive, close out or escalate) — or the owner in the console");
    expect(runOf(w).status).toBe("waiting_user");
  });

  test("a prompt to the worker starts the Stop count over", async () => {
    const w = makeWorld();
    await hook(w, "Stop");
    await hook(w, "Stop");
    expect(runOf(w).stopBlocks).toBe(2);
    await hook(w, "UserPromptSubmit", { prompt: "keep going" });
    expect(runOf(w).stopBlocks).toBe(0);
    for (let i = 0; i < 3; i++) expect((await hook(w, "Stop")).decision).toBe("block");
  });

  test("Stop isn't blocked while a subagent still runs or one of them has an ask pending", async () => {
    const w = makeWorld();
    w.store.db.run(
      "INSERT INTO sessions (id, project_id, cwd, parent_session_id, status) VALUES ('child-run', 'proj', ?, ?, 'running')",
      [WORKTREE, w.sessionId]
    );
    expect(await hook(w, "Stop")).toEqual({ ok: true });
    w.store.db.run("UPDATE sessions SET status = 'done' WHERE id = 'child-run'");
    createAsk(w.store.db, "child-run", "ask_human", "Which stack?");
    expect(await hook(w, "Stop")).toEqual({ ok: true });
    expect(runOf(w).stopBlocks).toBe(0);
  });

  test("an adopted launch sharing the worker's session id still resolves its run for status and advance", async () => {
    const w = makeWorld();
    updateLaunchStatus(w.store.db, w.launch.id, "cleaned");
    createLaunch(w.store.db, {
      id: randomUUID(),
      projectId: "proj",
      task: "adopted",
      worktreePath: "/tmp/wt-adopted-2",
      branch: "b",
      status: "running",
      sessionId: w.sessionId,
      kind: "adopted",
    });
    const status = await post(w, "/api/pipeline/status", { session_id: w.sessionId, cwd: "/tmp/wt-adopted-2" });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { run: { id: string } }).run.id).toBe(w.run.id);
    expect((await advance(w, "start")).status).toBe(200);
  });

  test("an advance resets the Stop count", async () => {
    const w = makeWorld();
    await hook(w, "Stop");
    await hook(w, "Stop");
    await advance(w, "start");
    expect(runOf(w).stopBlocks).toBe(0);
    expect((await hook(w, "Stop")).decision).toBe("block");
  });

  test("Stop isn't blocked for a disabled or complete run, or with an ask pending", async () => {
    const off = makeWorld({ disabled: true });
    expect(await hook(off, "Stop")).toEqual({ ok: true });

    const asked = makeWorld();
    createAsk(asked.store.db, asked.sessionId, "ask_human", "Which issue id?");
    expect(await hook(asked, "Stop")).toEqual({ ok: true });

    const done = makeWorld({ issueId: "ISSUE-1" });
    done.changed.files = ["packages/collector/a.ts"];
    await advance(done, "start");
    await advance(done, "coding", EVIDENCE.coding);
    await advance(done, "validation", EVIDENCE.validationPass);
    await advance(done, "review", EVIDENCE.reviewClean);
    const packetId = submitPacket(done);
    await advance(done, "deploy", EVIDENCE.deploy);
    await advance(done, "code_review", { reviewId: "R-1", issueId: "ISSUE-1" });
    expect((await post(done, `/api/reviews/${packetId}/approve`, {}, human(done))).status).toBe(200);
    expect(runOf(done).status).toBe("complete");
    expect(await hook(done, "Stop")).toEqual({ ok: true });
  });

  test("a blocked Stop carries queued steers and messages after the pipeline text, and announces them delivered", async () => {
    const w = makeWorld();
    const steer = createSteer(w.store.db, w.sessionId, "also bump the changelog");
    createSessionMessage(w.store.db, { toSessionId: w.sessionId, fromLabel: "teammate", body: "I took the store half" });
    const out = await hook(w, "Stop");
    expect(out.decision).toBe("block");
    const reason = out.reason as string;
    expect(reason.indexOf("The delivery pipeline isn't finished")).toBe(0);
    expect(reason).toContain("also bump the changelog");
    expect(reason).toContain("I took the store half");
    expect(w.broadcasts.some((m) => m.type === "steer:delivered" && (m.payload as { id: string }).id === steer.id)).toBe(true);
    expect(w.broadcasts.some((m) => m.type === "session:message")).toBe(true);
    // Delivered once: the next block carries only the pipeline text.
    expect((await hook(w, "Stop")).reason).not.toContain("also bump the changelog");
  });

  test("a Stop is never blocked for a session whose newest launch is adopted", async () => {
    const w = makeWorld();
    updateLaunchStatus(w.store.db, w.launch.id, "cleaned");
    createLaunch(w.store.db, {
      id: randomUUID(),
      projectId: "proj",
      task: "adopted",
      worktreePath: "/tmp/wt-adopted-3",
      branch: "b",
      status: "running",
      sessionId: w.sessionId,
      kind: "adopted",
    });
    expect(await hook(w, "Stop")).toEqual({ ok: true });
    expect(runOf(w).stopBlocks).toBe(0);
    expect((await hook(w, "UserPromptSubmit", { prompt: "go" })).hookSpecificOutput.additionalContext).toContain("[Standup delivery pipeline]");
  });

  test("UserPromptSubmit carries the pipeline line in additionalContext", async () => {
    const w = makeWorld();
    const out = await hook(w, "UserPromptSubmit", { prompt: "keep going" });
    expect(out.hookSpecificOutput.additionalContext).toContain("[Standup delivery pipeline] Current stage: Start (start)");
    const off = makeWorld({ disabled: true });
    expect((await hook(off, "UserPromptSubmit", { prompt: "go" })).hookSpecificOutput).toBeUndefined();
  });
});

describe("ready", () => {
  test("mark-ready is refused before the code_review stage and allowed at it", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    const ready = () => post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" });
    const refused = await ready();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("delivery pipeline is at Start");
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    expect((await ready()).status).toBe(409);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("code_review");
    expect((await ready()).status).toBe(200);
    expect(getTicket(w.store.db, ticket.id)!.status).toBe("needs_review");
  });

  test("sending the ticket back for rework returns the run to coding", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect((await post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" })).status).toBe(200);
    const back = await post(w, `/api/tickets/${ticket.id}/status`, { status: "developing", note: "needs another pass" }, human(w));
    expect(back.status).toBe(200);
    await Bun.sleep(10);
    const run = runOf(w);
    expect(run.currentStage).toBe("coding");
    expect(run.epoch).toBe(1);
    expect(run.attempts.at(-1)).toMatchObject({ stageId: "code_review", status: "failed" });
  });

  test("the worker sending its own ticket back doesn't reset its run", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    w.changed.files = ["packages/collector/a.ts"];
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect((await post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" })).status).toBe(200);
    const back = await post(w, `/api/tickets/${ticket.id}/status`, { status: "developing", session_id: w.sessionId });
    expect(back.status).toBe(200);
    await Bun.sleep(10);
    expect(runOf(w)).toMatchObject({ currentStage: "code_review", epoch: 0 });
  });

  test("report_ticket_status needs_review is refused the same way", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    const res = await post(w, `/api/tickets/${ticket.id}/status`, { status: "needs_review", session_id: w.sessionId });
    expect(res.status).toBe(409);
  });
});

describe("code review urls reported through the ticket's status", () => {
  withIssueIdReviews();

  async function atCodeReview(w: World) {
    w.changed.files = ["packages/collector/a.ts"];
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    await advance(w, "validation", EVIDENCE.validationPass);
    await advance(w, "review", EVIDENCE.reviewClean);
    submitPacket(w);
    await advance(w, "deploy", EVIDENCE.deploy);
    expect(runOf(w).currentStage).toBe("code_review");
  }
  const report = (w: World, body: Record<string, unknown>) =>
    post(w, `/api/tickets/${getTicketByLaunch(w.store.db, w.launch.id)!.id}/status`, body);

  test("a session that isn't the ticket's worker has no effect on the run", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    await atCodeReview(w);
    w.store.db.run("INSERT INTO sessions (id, project_id, cwd, status) VALUES ('intruder', 'proj', '/tmp/x', 'running')");
    await report(w, { status: "needs_review", reviewUrl: "https://git.example.com/acme/app/pull/9", session_id: "intruder" });
    await report(w, { status: "needs_review", reviewUrl: "https://git.example.com/acme/app/pull/9" });
    await Bun.sleep(10);
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("the ticket's own worker records its code review as its own report", async () => {
    const w = makeWorld({ issueId: "ISSUE-1" });
    await atCodeReview(w);
    await report(w, { status: "needs_review", reviewUrl: "https://git.example.com/acme/app/pull/9", session_id: w.sessionId });
    await Bun.sleep(10);
    const run = runOf(w);
    expect(run).toMatchObject({ status: "active", currentStage: "human_review" });
    expect(run.attempts.find((a) => a.stageId === "code_review")!.evidence).toMatchObject({ source: "worker", issueId: "ISSUE-1" });
  });

  test("a command-mode project's worker can't pass its report off as the gate's", async () => {
    const w = makeWorld({ issueId: "" });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "command" });
    await atCodeReview(w);
    await report(w, { status: "needs_review", reviewUrl: "https://git.example.com/acme/app/pull/9", session_id: w.sessionId });
    await Bun.sleep(10);
    // A worker's report needs an issue id, which this ticket hasn't got.
    expect(runOf(w).currentStage).toBe("code_review");
  });

  test("a review-agent project's worker cutting the code review the gate handed it records it as the gate's", async () => {
    const w = makeWorld({ issueId: "" });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "review-agent" });
    await atCodeReview(w);
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    updateTicketStatus(w.store.db, ticket.id, "needs_review");
    // Before the gate hands the code review over, the worker's report is its own — without an issue id, nothing is recorded.
    await report(w, { status: "needs_review", reviewUrl: "https://git.example.com/acme/app/pull/8", session_id: w.sessionId });
    await Bun.sleep(10);
    expect(runOf(w)).toMatchObject({ currentStage: "code_review", status: "active" });

    expect(markReviewHandoff(w.store.db, w.launch.id)).toBe(true);
    await report(w, { status: "needs_review", reviewUrl: "https://git.example.com/acme/app/pull/9", session_id: w.sessionId });
    await Bun.sleep(10);
    const run = runOf(w);
    expect(run).toMatchObject({ status: "active", currentStage: "human_review" });
    expect(run.reviewHandoffAt).toBeUndefined();
    expect(run.attempts.find((a) => a.stageId === "code_review")!.evidence).toMatchObject({ source: "review_gate", url: "https://git.example.com/acme/app/pull/9" });
  });

  test("each review hand-off is taken by one report", () => {
    const w = makeWorld({ issueId: "" });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "review-agent" });
    const ticket = { ...getTicketByLaunch(w.store.db, w.launch.id)!, status: "needs_review" };
    w.store.db.run("UPDATE pipeline_runs SET current_stage = 'code_review' WHERE id = ?", [w.run.id]);
    expect(markReviewHandoff(w.store.db, w.launch.id)).toBe(true);
    expect(reportedReviewUrlSource(w.store.db, ticket, w.sessionId)).toBe("review_gate");
    expect(reportedReviewUrlSource(w.store.db, ticket, w.sessionId)).toBe("worker");
    // Another session never takes it.
    markReviewHandoff(w.store.db, w.launch.id);
    expect(reportedReviewUrlSource(w.store.db, ticket, "someone-else")).toBeNull();
    expect(runOf(w).reviewHandoffAt).toBeDefined();
  });

  test("a review command that fails hands the run at code_review to the owner", async () => {
    const w = makeWorld({ issueId: "", persona: true });
    mkdirSync(WORKTREE, { recursive: true });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "command", reviewCommand: "echo boom >&2; exit 3" });
    await atCodeReview(w);
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    const ready = await post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" });
    expect(ready.status).toBe(200);
    for (let i = 0; i < 100 && runOf(w).status === "active"; i++) await Bun.sleep(20);
    expect(runOf(w)).toMatchObject({ currentStage: "code_review", status: "waiting_user", waitingKind: "owner_input" });
    expect(runOf(w).waitingReason).toBe("the review gate didn't record a code review — needs you");
    expect(personaJobForLaunch(w.store.db, w.launch.id)!.job.note).toBe("Persona deciding: the review gate didn't record a code review — needs you");
    // The worker is told how things stand rather than to mark the work ready again.
    const res = await advance(w, "code_review", { reviewId: "R-1" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("the ticket is already in review");
    expect(res.body.error).not.toContain("call mark_ready_for_review");
  });

  test("a review command that prints no url hands the run to the owner too", async () => {
    const w = makeWorld({ issueId: "" });
    mkdirSync(WORKTREE, { recursive: true });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "command", reviewCommand: "echo done" });
    await atCodeReview(w);
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    expect((await post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" })).status).toBe(200);
    for (let i = 0; i < 100 && runOf(w).status === "active"; i++) await Bun.sleep(20);
    expect(runOf(w).waitingReason).toBe("the review gate didn't record a code review — needs you");
  });

  test("a review-agent gate that can't reach the worker hands the run to the owner", async () => {
    const w = makeWorld({ issueId: "" });
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [], reviewProcess: "review-agent" });
    await atCodeReview(w);
    const ticket = getTicketByLaunch(w.store.db, w.launch.id)!;
    expect((await post(w, `/api/tickets/${ticket.id}/ready`, { session_id: w.sessionId, readyReason: "done" })).status).toBe(200);
    for (let i = 0; i < 100 && runOf(w).status === "active"; i++) await Bun.sleep(20);
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingReason: "the review gate didn't record a code review — needs you" });
    expect(runOf(w).reviewHandoffAt).toBeUndefined();
    // The review-agent worker is pointed at reporting the url.
    const res = await advance(w, "code_review", { reviewId: "R-1" });
    expect(res.body.error).toContain("report its url with report_ticket_status (reviewUrl)");
  });
});

describe("pipeline config", () => {
  const put = (w: World, override: unknown, headers: Record<string, string>, project?: string) =>
    w.app.request(`/api/pipeline-config${project ? `?project=${project}` : ""}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ override }),
    });
  const get = async (w: World, headers: Record<string, string>, project?: string) => {
    const res = await w.app.request(`/api/pipeline-config${project ? `?project=${project}` : ""}`, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  test("an agent (no owner token) is refused", async () => {
    const w = makeWorld();
    expect((await get(w, { [DEFAULT_IDENTITY_HEADER]: OWNER })).status).toBe(403);
    expect((await put(w, { enabled: false }, { [DEFAULT_IDENTITY_HEADER]: OWNER })).status).toBe(403);
    const del = await w.app.request("/api/pipeline-config", { method: "DELETE" });
    expect(del.status).toBe(403);
    expect((await get(w, { [OWNER_TOKEN_HEADER]: "wrong", [DEFAULT_IDENTITY_HEADER]: OWNER })).status).toBe(403);
  });

  test("each user edits only their own layers", async () => {
    const w = makeWorld();
    expect((await put(w, { enabled: false }, human(w, "alice"))).status).toBe(200);
    const bob = await get(w, human(w, "bob"));
    expect(bob.body.global).toBeNull();
    expect(bob.body.resolved.enabled).toBe(true);
    const alice = await get(w, human(w, "alice"));
    expect(alice.body.global).toEqual({ enabled: false });
    expect(alice.body.resolved.enabled).toBe(false);
    expect(alice.body.defaults).toEqual(DEFAULT_PIPELINE);
  });

  test("global and project layers stack, and delete removes one layer", async () => {
    const w = makeWorld();
    expect((await put(w, { stages: { review: { minReviewers: 3 } } }, human(w))).status).toBe(200);
    expect((await put(w, { stages: { review: { blockOn: "high" } } }, human(w), "proj")).status).toBe(200);
    const view = await get(w, human(w), "proj");
    const review = view.body.resolved.definition.stages.find((s: { id: string }) => s.id === "review");
    expect(review.minReviewers).toBe(3);
    expect(review.blockOn).toBe("high");
    expect((await w.app.request("/api/pipeline-config?project=proj", { method: "DELETE", headers: human(w) })).status).toBe(200);
    const after = await get(w, human(w), "proj");
    expect(after.body.project).toBeNull();
    expect(after.body.resolved.definition.stages.find((s: { id: string }) => s.id === "review").blockOn).toBe("medium");
    expect((await get(w, human(w), "no-such-project")).status).toBe(404);
  });

  test("an invalid override is refused with 400 and each error", async () => {
    const w = makeWorld();
    const res = await put(w, { stages: { nope: { title: "x" } } }, human(w));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errors: string[] }).errors[0]).toContain('unknown stage "nope"');
    const skipStart = await put(w, { stages: { start: { skip: true } } }, human(w));
    expect(skipStart.status).toBe(400);
    expect((await put(w, "not an object", human(w))).status).toBe(400);
  });

  test("a run keeps the definition it started with after the config changes", async () => {
    const w = makeWorld();
    const before = runOf(w);
    await put(w, { stages: { screenshot: { skip: true } } }, human(w));
    const after = runOf(w);
    expect(after.definitionHash).toBe(before.definitionHash);
    expect(after.definition.stages.map((s) => s.id)).toContain("screenshot");

    // A launch started after the edit gets the new definition.
    upsertProject(w.store.db, { id: "proj", name: "P", branch: "main", repos: [] });
    const next = createLaunch(w.store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: "/tmp/wt2", branch: "b", status: "running" });
    const fresh = startPipelineForLaunch(w.store.db, { launchId: next.id, owner: OWNER, projectId: "proj" });
    expect(fresh.definition.stages.map((s) => s.id)).not.toContain("screenshot");
    expect(fresh.definitionHash).not.toBe(before.definitionHash);
  });
});
