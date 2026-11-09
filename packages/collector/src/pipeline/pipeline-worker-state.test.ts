import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import {
  createLaunch,
  createSession,
  createTaskRun,
  deleteSession,
  getTaskRun,
  updateTaskRunStatus,
  endSession,
  getLaunch,
  getPipelineRun,
  linkPersonaJobLaunch,
  personaJobForLaunch,
  reviveSession,
  updateLaunchStatus,
  updatePipelineRun,
  updateSessionStatus,
} from "@standup/store";
import type { PipelineRun } from "@standup/shared";
import { pipelineJobSummary, startPipelineForLaunch } from "./engine.js";
import { OWNER, advance, human, makeWorld, type World } from "./test-world.js";

/** A second worker launched for the world's Persona job, with its own run. */
function relaunch(w: World): { launchId: string; sessionId: string; run: PipelineRun } {
  const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
  const sessionId = `sess-${randomUUID().slice(0, 8)}`;
  createSession(w.store.db, { id: sessionId, projectId: "proj", title: "Worker 2", cwd: `${w.worktree}-2`, status: "running" });
  const launch = createLaunch(w.store.db, {
    id: randomUUID(),
    projectId: "proj",
    task: "ship the thing, again",
    worktreePath: `${w.worktree}-2`,
    branch: "standup/thing-2",
    baseBranch: "main",
    status: "running",
    sessionId,
    requester: OWNER,
    launchedBy: OWNER,
  });
  linkPersonaJobLaunch(w.store.db, jobId, launch.id);
  const run = startPipelineForLaunch(w.store.db, { launchId: launch.id, owner: OWNER, projectId: "proj" });
  return { launchId: launch.id, sessionId, run };
}

async function jobRuns(w: World): Promise<PipelineRun[]> {
  const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
  const res = await w.app.request(`/api/pipeline/runs?jobId=${jobId}`, { headers: human(w) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { runs: PipelineRun[] }).runs;
}

describe("a run's worker state", () => {
  test("a running launch with a live session is live", () => {
    const w = makeWorld({ persona: true });
    expect(getPipelineRun(w.store.db, w.run.id)!.worker).toEqual({ state: "live" });
  });

  test("the session ending reads as ended, and a resumed session reads live again", () => {
    const w = makeWorld({ persona: true });
    endSession(w.store.db, w.sessionId);
    const ended = getPipelineRun(w.store.db, w.run.id)!;
    expect(ended.status).toBe("active");
    expect(ended.worker?.state).toBe("ended");
    expect(ended.worker?.endedAt).toBeString();
    reviveSession(w.store.db, w.sessionId);
    expect(getPipelineRun(w.store.db, w.run.id)!.worker).toEqual({ state: "live" });
  });

  test("a failed or cleaned-up launch is ended even while its session row is open", () => {
    const w = makeWorld({ persona: true });
    updateLaunchStatus(w.store.db, w.launch.id, "failed", "Stopped by you");
    expect(getPipelineRun(w.store.db, w.run.id)!.worker?.state).toBe("ended");
    updateLaunchStatus(w.store.db, w.launch.id, "cleaned");
    expect(getPipelineRun(w.store.db, w.run.id)!.worker?.state).toBe("ended");
  });

  test("a session marked done at turn end reads ended until a later prompt sets it running", () => {
    const w = makeWorld({ persona: true });
    updateSessionStatus(w.store.db, w.sessionId, "done");
    expect(getPipelineRun(w.store.db, w.run.id)!.worker).toEqual({ state: "ended" });
    updateSessionStatus(w.store.db, w.sessionId, "running");
    expect(getPipelineRun(w.store.db, w.run.id)!.worker).toEqual({ state: "live" });
  });

  test("deleting the worker's session fails its launch, so the run stays ended", () => {
    const w = makeWorld({ persona: true });
    const taskRun = createTaskRun(w.store.db, { id: randomUUID(), projectId: "proj", worktreePath: w.worktree, sessionId: w.sessionId });
    if (getTaskRun(w.store.db, taskRun.id)!.status !== "running") updateTaskRunStatus(w.store.db, taskRun.id, "running");
    deleteSession(w.store.db, w.sessionId);
    // The lost-run sweep can't find the pane of a failed launch, so the delete closes its task run.
    expect(getTaskRun(w.store.db, taskRun.id)!.status).toBe("lost");
    const launch = getLaunch(w.store.db, w.launch.id)!;
    expect(launch.status).toBe("failed");
    expect(launch.sessionId).toBeUndefined();
    expect(getPipelineRun(w.store.db, w.run.id)!.worker?.state).toBe("ended");
  });

  test("endedAt is ISO-8601", () => {
    const w = makeWorld({ persona: true });
    endSession(w.store.db, w.sessionId);
    expect(getPipelineRun(w.store.db, w.run.id)!.worker?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("a launch still starting with no session yet is live", () => {
    const w = makeWorld({ persona: true });
    w.store.db.run("UPDATE launches SET status = 'starting', session_id = NULL WHERE id = ?", [w.launch.id]);
    expect(getPipelineRun(w.store.db, w.run.id)!.worker).toEqual({ state: "live" });
  });

  test("an ended launch with a newer launch on the same job is superseded; the newer one is live", async () => {
    const w = makeWorld({ persona: true });
    const next = relaunch(w);
    // Both workers still running: the older one isn't superseded while it works.
    expect((await jobRuns(w)).map((r) => r.worker?.state)).toEqual(["live", "live"]);
    endSession(w.store.db, w.sessionId);
    const runs = await jobRuns(w);
    expect(runs.map((r) => [r.launchId, r.worker?.state])).toEqual([
      [w.launch.id, "superseded"],
      [next.launchId, "live"],
    ]);
  });

  test("the job summary comes from the live worker's run, not a dead one waiting on the owner", () => {
    const w = makeWorld({ persona: true });
    updatePipelineRun(w.store.db, w.run.id, { status: "waiting_user", waitingReason: "needs a decision" });
    const next = relaunch(w);
    updatePipelineRun(w.store.db, next.run.id, { currentStage: "screenshot" });
    endSession(w.store.db, w.sessionId);
    expect(pipelineJobSummary(w.store.db, [w.launch.id, next.launchId])).toEqual({ stage: "screenshot", status: "active" });
  });

  test("with no live worker the job summary comes from the newest run, not an older one waiting", () => {
    const w = makeWorld({ persona: true });
    updatePipelineRun(w.store.db, w.run.id, { status: "waiting_user", waitingReason: "needs a decision" });
    const next = relaunch(w);
    updatePipelineRun(w.store.db, next.run.id, { currentStage: "screenshot" });
    endSession(w.store.db, w.sessionId);
    endSession(w.store.db, next.sessionId);
    expect(pipelineJobSummary(w.store.db, [w.launch.id, next.launchId])?.stage).toBe("screenshot");
  });

  test("a pipeline frame carries the run's worker state", async () => {
    const w = makeWorld({ persona: true });
    await advance(w, "start");
    const live = w.broadcasts.filter((m) => m.type === "pipeline:updated");
    expect(live.length).toBeGreaterThan(0);
    expect((live.at(-1)!.payload as PipelineRun).worker?.state).toBe("live");
    endSession(w.store.db, w.sessionId);
    updatePipelineRun(w.store.db, w.run.id, { status: "waiting_user", waitingReason: "stalled" });
    const res = await w.app.request(`/api/pipeline/runs/${w.run.id}/waive`, {
      method: "POST",
      headers: { "content-type": "application/json", ...human(w) },
      body: JSON.stringify({ stage: "coding", reason: "not needed" }),
    });
    expect(res.status).toBe(200);
    const frames = w.broadcasts.filter((m) => m.type === "pipeline:updated");
    expect(frames.length).toBeGreaterThan(live.length);
    expect((frames.at(-1)!.payload as PipelineRun).worker?.state).toBe("ended");
  });
});
