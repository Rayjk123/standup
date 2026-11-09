import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Launch, PersonaJob } from "@standup/shared";
import { SCRATCH_MARKER } from "@standup/shared/scratch";
import {
  clearLaunchReaped,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  endSession,
  getLaunch,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  listLiveProcessesForLaunch,
  markLaunchReaped,
  reviveSession,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import {
  closedJobHygieneStep,
  holdForResume,
  hygieneAfterReap,
  hygieneBackstop,
  hygieneSettled,
  jobLaunchIds,
  onJobClosed,
  onLaunchCleaned,
} from "./job-hygiene.js";
import { holdForCleanup } from "./launch-holds.js";
import { registerProcess, type ProcessRow } from "./process-registry.js";
import { FakeProcessSystem } from "./process-registry-fake.js";
import { ensureScratchDir } from "./scratch-dirs.js";

const INSTALL = "/home/me/standup";
const r = (pid: number, ppid: number, pgid: number, args: string): ProcessRow => ({ pid, ppid, pgid, uid: 1000, args });

let store: Store;
let sys: FakeProcessSystem;
let scratchRoot: string;
let notes: Array<{ jobId: string; text: string }>;

beforeEach(() => {
  store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  sys = new FakeProcessSystem(
    [
      r(900, 1, 900, "/usr/lib/systemd/systemd --user"),
      r(4000, 900, 4000, "bun run src/index.ts"),
      r(5000, 900, 5000, "node /wt/proj/a/server.js"),
      r(5100, 900, 5100, "node /wt/proj/b/server.js"),
    ],
    { selfPid: 4000, uid: 1000 }
  );
  scratchRoot = mkdtempSync(join(tmpdir(), "standup-scratch-hygiene-"));
  notes = [];
  livePanes = new Set();
});

/** The tmux sessions the fake workers' server has. */
let livePanes: Set<string>;

const opts = () => ({
  installDir: INSTALL,
  scratchRoot,
  graceMs: 0,
  env: {} as NodeJS.ProcessEnv,
  note: (job: PersonaJob, text: string) => notes.push({ jobId: job.id, text }),
  paneAlive: (name: string) => livePanes.has(name),
});

/** Names the launch's tmux session, as a launch with a pane has. */
function withPane(launch: Launch, name: string): Launch {
  store.db.run("UPDATE launches SET tmux_session = ? WHERE id = ?", [name, launch.id]);
  return getLaunch(store.db, launch.id)!;
}

/**
 * A worker of `job`: stopped (launch failed, session ended) by default; still
 * running (`sessionEnded: false`); or paused by the idle reaper (`paused`:
 * launch running and reaped, session ended).
 */
function workerOf(job: PersonaJob | null, wt: string, opts: { sessionEnded?: boolean; paused?: boolean } = {}): { launch: Launch; sessionId: string } {
  const sessionId = `s-${randomUUID().slice(0, 8)}`;
  const running = opts.paused || opts.sessionEnded === false;
  createSession(store.db, { id: sessionId, projectId: "proj", title: "W", cwd: wt, status: "running" });
  if (opts.sessionEnded !== false) endSession(store.db, sessionId);
  const launch = createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: wt, branch: "b", status: running ? "running" : "failed", sessionId });
  if (opts.paused) markLaunchReaped(store.db, launch.id, "idle 2h");
  if (job) linkPersonaJobLaunch(store.db, job.id, launch.id);
  ensureScratchDir(launch.id, scratchRoot);
  return { launch: getLaunch(store.db, launch.id)!, sessionId };
}

/** Pauses a running worker as the idle reaper does: the launch is marked reaped and its session ended. */
function pauseWorker(w: { launch: Launch; sessionId: string }): Launch {
  markLaunchReaped(store.db, w.launch.id, "idle 2h");
  endSession(store.db, w.sessionId);
  return getLaunch(store.db, w.launch.id)!;
}

function job(): PersonaJob {
  const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
  return createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: "J", goal: "g" });
}

describe("onJobClosed", () => {
  test("stops the job's registered processes, removes its scratch dirs and notes it; a second run is a no-op", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    expect(registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "api", port: 8080 }, { installDir: INSTALL }).ok).toBe(true);
    updatePersonaJob(store.db, j.id, { status: "done" });

    const first = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(first.processes.map((p) => p.outcome)).toEqual(["terminated"]);
    expect(first.scratchRemoved).toEqual([launch.id]);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(false);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("api (pid 5000, port 8080)");
    expect(notes[0]!.text).toContain("removed 1 scratch dir");

    const second = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(second).toEqual({ processes: [], scratchRemoved: [] });
    expect(sys.signals).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  test("does nothing for an open job", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "api" }, { installDir: INSTALL });
    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res).toEqual({ processes: [], scratchRemoved: [] });
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(1);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(true);
  });

  test("a worker still running keeps its processes and scratch dir until it is reaped", async () => {
    const j = job();
    const kept = workerOf(j, "/wt/proj/a", { sessionEnded: false });
    const stopped = workerOf(j, "/wt/proj/b");
    registerProcess(store.db, sys, { launch: kept.launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    registerProcess(store.db, sys, { launch: stopped.launch, jobId: j.id, pid: 5100, label: "b" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });

    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res.processes.map((p) => p.process.pid)).toEqual([5100]);
    expect(res.scratchRemoved).toEqual([stopped.launch.id]);
    expect(existsSync(join(scratchRoot, kept.launch.id))).toBe(true);

    // The reaper pauses the kept worker and runs the job's hygiene.
    const after = await hygieneAfterReap(store.db, sys, pauseWorker(kept), opts());
    expect(after?.processes.map((p) => p.process.pid)).toEqual([5000]);
    expect(after?.scratchRemoved).toEqual([kept.launch.id]);
  });

  test("a running, unpaused launch whose session reads ended is still live while its pane exists", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a", { sessionEnded: false });
    const launch = withPane(w.launch, "standup-w-alive");
    livePanes.add("standup-w-alive");
    endSession(store.db, w.sessionId);
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res).toEqual({ processes: [], scratchRemoved: [] });
    expect(existsSync(join(scratchRoot, w.launch.id))).toBe(true);
    expect(listLiveProcessesForLaunch(store.db, w.launch.id)).toHaveLength(1);
    expect(sys.signals).toEqual([]);
  });

  test("a running launch whose session ended and whose pane is gone has its processes stopped and scratch dir removed", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a", { sessionEnded: false });
    const launch = withPane(w.launch, "standup-w-dead");
    endSession(store.db, w.sessionId);
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res.processes.map((p) => p.process.pid)).toEqual([5000]);
    expect(res.scratchRemoved).toEqual([w.launch.id]);
    expect(existsSync(join(scratchRoot, w.launch.id))).toBe(false);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);
  });

  test("a running launch with no pane name whose session ended is still live", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a", { sessionEnded: false });
    endSession(store.db, w.sessionId);
    registerProcess(store.db, sys, { launch: w.launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res).toEqual({ processes: [], scratchRemoved: [] });
    expect(existsSync(join(scratchRoot, w.launch.id))).toBe(true);
  });

  test("concurrent runs for one job signal and note once", async () => {
    const j = job();
    const a = workerOf(j, "/wt/proj/a");
    const b = workerOf(j, "/wt/proj/b");
    registerProcess(store.db, sys, { launch: a.launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    registerProcess(store.db, sys, { launch: b.launch, jobId: j.id, pid: 5100, label: "b" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    sys.ignoresTerm.add(5000);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    sys.sleep = () => gate;

    const first = onJobClosed(store.db, sys, j.id, "job_closed", { ...opts(), graceMs: 1 });
    const second = onJobClosed(store.db, sys, j.id, "job_closed", { ...opts(), graceMs: 1 });
    const third = onJobClosed(store.db, sys, j.id, "job_closed", { ...opts(), graceMs: 1 });
    expect(third).toBe(second);
    await Bun.sleep(5);
    openGate();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.processes.map((p) => p.process.pid).sort()).toEqual([5000, 5100]);
    expect(r2).toEqual({ processes: [], scratchRemoved: [] });
    expect(sys.signals.filter((s) => s.sig === "SIGTERM")).toHaveLength(2);
    expect(notes).toHaveLength(1);
  });

  test("a starting launch of a closed job keeps its processes and scratch dir", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a");
    store.db.run("UPDATE launches SET status = 'starting' WHERE id = ?", [w.launch.id]);
    registerProcess(store.db, sys, { launch: w.launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res).toEqual({ processes: [], scratchRemoved: [] });
    expect(existsSync(join(scratchRoot, w.launch.id))).toBe(true);
    expect(sys.signals).toEqual([]);
  });

  test("a stopped launch whose session an adoption runs again keeps its processes and scratch dir", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a");
    createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: "/wt/proj/a", branch: "b", status: "running", sessionId: w.sessionId, kind: "adopted" });
    registerProcess(store.db, sys, { launch: w.launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res).toEqual({ processes: [], scratchRemoved: [] });
    expect(existsSync(join(scratchRoot, w.launch.id))).toBe(true);
  });

  test("a launch being cleaned up is left to the cleanup", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    const release = holdForCleanup(launch.id);
    expect(await onJobClosed(store.db, sys, j.id, "job_closed", opts())).toEqual({ processes: [], scratchRemoved: [] });
    release();
    expect((await onJobClosed(store.db, sys, j.id, "job_closed", opts())).scratchRemoved).toEqual([launch.id]);
  });

  test("a launch whose resume is in flight keeps its processes and scratch dir until the resume lets go", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a", { paused: true });
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });

    const release = holdForResume(launch.id);
    expect(await onJobClosed(store.db, sys, j.id, "job_closed", opts())).toEqual({ processes: [], scratchRemoved: [] });
    expect(existsSync(join(scratchRoot, launch.id))).toBe(true);
    release();
    release();

    const res = await onJobClosed(store.db, sys, j.id, "job_closed", opts());
    expect(res.processes.map((p) => p.process.pid)).toEqual([5000]);
    expect(res.scratchRemoved).toEqual([launch.id]);
  });

  test("a launch resumed while its job's hygiene waits out the grace period keeps its scratch dir", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a", { paused: true });
    registerProcess(store.db, sys, { launch: w.launch, jobId: j.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    sys.ignoresTerm.add(5000);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    sys.sleep = () => gate;

    const run = hygieneAfterReap(store.db, sys, w.launch, { ...opts(), graceMs: 1 });
    let settled = false;
    const waiter = hygieneSettled(w.launch.id).then(() => (settled = true));
    await Bun.sleep(5);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);
    expect(settled).toBe(false);

    // The resume lands while the hygiene sleeps: the launch is running and no longer paused.
    clearLaunchReaped(store.db, w.launch.id);
    reviveSession(store.db, w.sessionId);
    openGate();
    const res = await run;
    await waiter;
    expect(settled).toBe(true);
    expect(res?.scratchRemoved).toEqual([]);
    expect(existsSync(join(scratchRoot, w.launch.id))).toBe(true);
  });

  test("hygieneSettled resolves at once when no hygiene runs for the launch", async () => {
    await hygieneSettled(randomUUID());
  });

  test("hygieneAfterReap does nothing while the job is open", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    expect(await hygieneAfterReap(store.db, sys, launch, opts())).toBeNull();
  });

  test("a job's launches include an adopted launch of its session", () => {
    const j = job();
    const { launch, sessionId } = workerOf(j, "/wt/proj/a");
    const adopted = createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: "/wt/proj/a", branch: "b", status: "running", sessionId, kind: "adopted" });
    expect(jobLaunchIds(store.db, { ...j, launchIds: [launch.id], sessionIds: [sessionId] }).sort()).toEqual([launch.id, adopted.id].sort());
  });
});

describe("hygieneBackstop", () => {
  test("runs a closed job's hygiene that never ran, then finds nothing more to do", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "api" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "failed" });

    expect(await hygieneBackstop(store.db, sys, opts())).toEqual([j.id]);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(0);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(false);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);

    expect(await hygieneBackstop(store.db, sys, opts())).toEqual([]);
    expect(sys.signals).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  test("a closed job left with only a scratch dir has it removed", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    updatePersonaJob(store.db, j.id, { status: "done" });
    expect(await hygieneBackstop(store.db, sys, opts())).toEqual([j.id]);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(false);
  });

  test("leaves an open job, and a closed job with a live session", async () => {
    const open = job();
    const a = workerOf(open, "/wt/proj/a");
    registerProcess(store.db, sys, { launch: a.launch, jobId: open.id, pid: 5000, label: "a" }, { installDir: INSTALL });
    const closed = job();
    const b = workerOf(closed, "/wt/proj/b", { sessionEnded: false });
    registerProcess(store.db, sys, { launch: b.launch, jobId: closed.id, pid: 5100, label: "b" }, { installDir: INSTALL });
    updatePersonaJob(store.db, closed.id, { status: "done" });

    expect(await hygieneBackstop(store.db, sys, opts())).toEqual([]);
    expect(sys.signals).toEqual([]);
    expect(existsSync(join(scratchRoot, a.launch.id)) && existsSync(join(scratchRoot, b.launch.id))).toBe(true);
  });

  test("does nothing when STANDUP_ORPHAN_SWEEP turns the sweep off", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "api" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    expect(await hygieneBackstop(store.db, sys, { ...opts(), env: { STANDUP_ORPHAN_SWEEP: "off" } })).toEqual([]);
    expect(sys.signals).toEqual([]);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(1);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(true);
    expect(await hygieneBackstop(store.db, sys, { ...opts(), env: {} })).toEqual([j.id]);
  });

  test("a scratch dir without its marker doesn't keep a job a candidate", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    rmSync(join(scratchRoot, launch.id, SCRATCH_MARKER));
    updatePersonaJob(store.db, j.id, { status: "done" });
    expect(await hygieneBackstop(store.db, sys, opts())).toEqual([]);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(true);
  });
});

describe("closedJobHygieneStep", () => {
  test("runs a closed job's hygiene for the paused launch in the background", async () => {
    const j = job();
    const w = workerOf(j, "/wt/proj/a", { sessionEnded: false });
    const { launch } = w;
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "api" }, { installDir: INSTALL });
    updatePersonaJob(store.db, j.id, { status: "done" });
    closedJobHygieneStep(store.db, sys, { installDir: INSTALL, paneAlive: opts().paneAlive })(pauseWorker(w));
    for (let i = 0; i < 50 && listLiveProcessesForLaunch(store.db, launch.id).length > 0; i++) await Bun.sleep(5);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(0);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);
  });

  test("does nothing for an open job", async () => {
    const j = job();
    const { launch } = workerOf(j, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, jobId: j.id, pid: 5000, label: "api" }, { installDir: INSTALL });
    closedJobHygieneStep(store.db, sys, { installDir: INSTALL, paneAlive: opts().paneAlive })(launch);
    await Bun.sleep(20);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(1);
  });
});

describe("onLaunchCleaned", () => {
  test("stops the launch's processes and removes its scratch dir, once", async () => {
    const { launch } = workerOf(null, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, pid: 5000, label: "api" }, { installDir: INSTALL });
    const first = await onLaunchCleaned(store.db, sys, launch.id, opts());
    expect(first.processes.map((p) => p.outcome)).toEqual(["terminated"]);
    expect(first.scratchRemoved).toEqual([launch.id]);
    const second = await onLaunchCleaned(store.db, sys, launch.id, opts());
    expect(second).toEqual({ processes: [], scratchRemoved: [] });
  });

  test("waits for a resume of the launch in progress before clearing it", async () => {
    const { launch } = workerOf(null, "/wt/proj/a");
    registerProcess(store.db, sys, { launch, pid: 5000, label: "api" }, { installDir: INSTALL });
    const release = holdForResume(launch.id);
    let done = false;
    const cleaning = onLaunchCleaned(store.db, sys, launch.id, opts()).then((res) => {
      done = true;
      return res;
    });
    await Bun.sleep(5);
    expect(done).toBe(false);
    expect(sys.signals).toEqual([]);
    expect(existsSync(join(scratchRoot, launch.id))).toBe(true);
    release();
    const res = await cleaning;
    expect(res.processes.map((p) => p.process.pid)).toEqual([5000]);
    expect(res.scratchRemoved).toEqual([launch.id]);
  });
});
