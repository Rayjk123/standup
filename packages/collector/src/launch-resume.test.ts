import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearLaunchReaped,
  createAsk,
  createLaunch,
  createPersonaJob,
  createSession,
  createSessionMessage,
  createSteer,
  createStore,
  endSession,
  getCheckpointsBySession,
  getLaunch,
  getOrCreatePersonaConsoleThread,
  getRecentEventsBySession,
  getSession,
  insertEvent,
  linkPersonaJobLaunch,
  markLaunchReaped,
  setSessionCreatedActor,
  updateLaunchStatus,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Launch, WsMessage } from "@standup/shared";
import { reapIdleWorkers } from "./idle-reaper.js";
import { hygieneAfterReap, onJobClosed } from "./job-hygiene.js";
import { holdForCleanup } from "./launch-holds.js";
import { cleanupLaunch, pauseKillArgv } from "./launcher.js";
import { registerProcess } from "./process-registry.js";
import { FakeProcessSystem } from "./process-registry-fake.js";
import { ensureScratchDir } from "./scratch-dirs.js";
import {
  adoptLiveReapedPanes,
  queuedWorkSession,
  RESUMED_NOTIFICATION,
  resumeReapedLaunch,
  waitForIdlePane,
  wakeForQueued,
  wakeIfReaped,
  type LaunchResumeDeps,
  type ResumeOutcome,
} from "./launch-resume.js";
import { lastActivityMs, WAKE_PROMPT, type PaneDriver } from "./session-recovery.js";
import { stopSession } from "./session-stop.js";
import { createServer } from "./server.js";
import { HOOK_TOKEN_ENV } from "./floor/gate.js";

const RULE = "─".repeat(80);
const IDLE = ["● Done.", RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on"].join("\n");
const STARTING = "Resuming conversation…";
const HOST = process.env.USER || "local";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake pane: alive once spawned, showing `screens` in turn (the last one repeats), recording what is typed. */
function fakePane(screens: string[] = [IDLE]) {
  const state = { alive: false, typed: [] as string[], captures: 0 };
  const pane: PaneDriver = {
    exists: () => state.alive,
    capture: () => screens[Math.min(state.captures++, screens.length - 1)]!,
    sendKey: () => true,
    type: async (_launch, text) => {
      state.typed.push(text);
      return { ok: true };
    },
    sleep: async () => {},
  };
  return { pane, state };
}

/** A worker the idle reaper paused: launch running and reaped, session ended, worktree on disk. */
function setUp(): { store: Store; launch: Launch; worktree: string } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const worktree = mkdtempSync(join(tmpdir(), "launch-resume-"));
  dirs.push(worktree);
  createSession(store.db, { id: "s1", projectId: "p", title: "fix the bug", cwd: worktree, status: "idle" });
  setSessionCreatedActor(store.db, "s1", HOST);
  createLaunch(store.db, {
    id: "l1",
    projectId: "p",
    task: "t",
    worktreePath: worktree,
    branch: "b",
    tmuxSession: "standup-l1",
    sessionId: "s1",
    status: "running",
    model: "opus",
  });
  markLaunchReaped(store.db, "l1", "idle 2h");
  endSession(store.db, "s1");
  return { store, launch: getLaunch(store.db, "l1")!, worktree };
}

/** The workers' tmux server as hygiene's liveness checks see it here: no panes, so none reaches real tmux. */
const noPanes = () => false;

function resumeDeps(worktree: string, pane: PaneDriver, over: Partial<LaunchResumeDeps> = {}) {
  const spawned: string[][] = [];
  const frames: WsMessage[] = [];
  const watched: string[] = [];
  const deps: LaunchResumeDeps = {
    pane,
    broadcast: (m) => frames.push(m),
    watch: (id) => watched.push(id),
    idleTimeoutMs: 50,
    pollMs: 1,
    paneAlive: noPanes,
    spawn: {
      dataDir: join(worktree, ".data"),
      floorUnavailable: () => undefined,
      run: async (cmd) => {
        spawned.push(cmd);
        // The spawn brings the pane up.
        (pane as PaneDriver & { up?: () => void }).up?.();
        return { ok: true, output: "" };
      },
    },
    ...over,
  };
  return { deps, spawned, frames, watched };
}

/** A fake pane whose spawn marks it alive. */
function spawnablePane(screens?: string[]) {
  const fake = fakePane(screens);
  Object.assign(fake.pane, { up: () => (fake.state.alive = true) });
  return fake;
}

describe("resumeReapedLaunch", () => {
  test("relaunches claude --resume into the same launch row, pane name, cwd and scratch dir", async () => {
    const { store, launch, worktree } = setUp();
    const { pane } = spawnablePane();
    const { deps, spawned, frames, watched } = resumeDeps(worktree, pane);

    const outcome = await resumeReapedLaunch(store.db, launch, deps);

    expect(outcome.resumed).toBe(true);
    expect(spawned).toHaveLength(1);
    const cmd = spawned[0]!;
    expect(cmd[cmd.indexOf("-s") + 1]).toBe("standup-l1");
    expect(cmd[cmd.indexOf("-c") + 1]).toBe(worktree);
    const claude = cmd.slice(cmd.indexOf("claude"));
    expect(claude.slice(0, 3)).toEqual(["claude", "--resume", "s1"]);
    expect(claude).toContain("opus");
    // Scratch TMPDIR keyed by the same launch id as its first spawn.
    expect(cmd.some((a) => a.startsWith("TMPDIR=") && a.includes("l1"))).toBe(true);
    // A fresh hook token rides the pane env.
    expect(cmd.some((a) => a.startsWith(`${HOOK_TOKEN_ENV}=`))).toBe(true);

    const after = getLaunch(store.db, "l1")!;
    expect(after.reapedAt).toBeUndefined();
    expect(after.status).toBe("running");
    expect(getSession(store.db, "s1")?.endedAt).toBeUndefined();
    expect(getCheckpointsBySession(store.db, "s1").at(-1)?.summary).toBe("Resumed after idle pause.");
    expect(frames.map((f) => f.type)).toEqual(["checkpoint:new", "launch:started"]);
    expect(watched).toEqual(["s1"]);
  });

  test("a second call after it resumed is a no-op", async () => {
    const { store, launch, worktree } = setUp();
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    expect((await resumeReapedLaunch(store.db, launch, deps)).resumed).toBe(true);
    const again = await resumeReapedLaunch(store.db, launch, deps);
    expect(again.resumed).toBe(false);
    expect(again.reason).toBe("it was not paused");
    expect(spawned).toHaveLength(1);
  });

  test("concurrent callers share one respawn", async () => {
    const { store, launch, worktree } = setUp();
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const [a, b] = await Promise.all([resumeReapedLaunch(store.db, launch, deps), resumeReapedLaunch(store.db, launch, deps)]);
    expect(a).toBe(b);
    expect(a.resumed).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  test("a launch that was not reaped is left alone", async () => {
    const { store, worktree } = setUp();
    store.db.run("UPDATE launches SET reaped_at = NULL WHERE id = 'l1'");
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const outcome = await resumeReapedLaunch(store.db, getLaunch(store.db, "l1")!, deps);
    expect(outcome).toMatchObject({ resumed: false, reason: "it was not paused" });
    expect(spawned).toHaveLength(0);
  });

  test("a pending safety-floor hold keeps it paused", async () => {
    const { store, launch, worktree } = setUp();
    createAsk(store.db, "s1", "ask_human", "Allow git push?", undefined, { gate: "safety_floor" });
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const outcome = await resumeReapedLaunch(store.db, launch, deps);
    expect(outcome).toMatchObject({ resumed: false, reason: "a safety-floor hold is pending on it" });
    expect(spawned).toHaveLength(0);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeInstanceOf(Date);
  });

  test("a cleaned launch or a removed worktree is not resumed", async () => {
    const cleaned = setUp();
    updateLaunchStatus(cleaned.store.db, "l1", "cleaned");
    // Cleaning a launch clears its pause, so it no longer reads as paused.
    expect(getLaunch(cleaned.store.db, "l1")?.reapedAt).toBeUndefined();
    const a = spawnablePane();
    const ra = resumeDeps(cleaned.worktree, a.pane);
    expect((await resumeReapedLaunch(cleaned.store.db, cleaned.launch, ra.deps)).reason).toBe("it was not paused");
    expect(ra.spawned).toHaveLength(0);

    const removed = setUp();
    rmSync(removed.worktree, { recursive: true, force: true });
    const b = spawnablePane();
    const rb = resumeDeps(join(tmpdir(), "launch-resume-gone"), b.pane);
    expect((await resumeReapedLaunch(removed.store.db, removed.launch, rb.deps)).reason).toBe("its worktree is gone");
    expect(rb.spawned).toHaveLength(0);
  });

  test("a pane still up on a launch marked paused is adopted as resumed, not respawned", async () => {
    const { store, launch, worktree } = setUp();
    const { pane, state } = spawnablePane();
    state.alive = true;
    const { deps, spawned, frames, watched } = resumeDeps(worktree, pane);
    const outcome = await resumeReapedLaunch(store.db, launch, deps);
    expect(outcome.resumed).toBe(true);
    expect(spawned).toHaveLength(0);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
    expect(getSession(store.db, "s1")?.endedAt).toBeUndefined();
    expect(watched).toEqual(["s1"]);
    expect(getCheckpointsBySession(store.db, "s1").map((c) => c.summary)).toContain("Resumed after idle pause.");
    expect(frames.map((f) => f.type)).toEqual(["checkpoint:new", "launch:started"]);
    // Adopted, it no longer reads as paused, so the next resume is a no-op.
    expect((await resumeReapedLaunch(store.db, getLaunch(store.db, "l1")!, deps)).reason).toBe("it was not paused");
  });

  test("the startup reconcile adopts paused launches whose pane is up and leaves the rest", () => {
    const { store, worktree } = setUp();
    createSession(store.db, { id: "s2", projectId: "p", title: "other", cwd: worktree, status: "idle" });
    createLaunch(store.db, {
      id: "l2",
      projectId: "p",
      task: "t",
      worktreePath: worktree,
      branch: "b2",
      tmuxSession: "standup-l2",
      sessionId: "s2",
      status: "running",
      model: "opus",
    });
    markLaunchReaped(store.db, "l2", "idle 2h");
    endSession(store.db, "s2");
    const up = new Set(["standup-l1"]);
    const watched: string[] = [];
    const pane: PaneDriver = { ...fakePane().pane, exists: (session) => up.has(session) };

    const adopted = adoptLiveReapedPanes(store.db, { pane, watch: (id) => watched.push(id) });

    expect(adopted.map((l) => l.id)).toEqual(["l1"]);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
    expect(getSession(store.db, "s1")?.endedAt).toBeUndefined();
    expect(getLaunch(store.db, "l2")?.reapedAt).toBeInstanceOf(Date);
    expect(watched).toEqual(["s1"]);
  });

  test("a cleanup that lands while the pane respawns kills the new pane and cleans the launch", async () => {
    const { store, launch, worktree } = setUp();
    const { pane, state } = spawnablePane();
    let openSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => (openSpawn = resolve));
    const spawned: string[][] = [];
    const { deps, frames, watched } = resumeDeps(worktree, pane, {
      spawn: {
        dataDir: join(worktree, ".data"),
        floorUnavailable: () => undefined,
        run: async (cmd) => {
          spawned.push(cmd);
          if (spawned.length === 1) {
            await spawnGate;
            state.alive = true;
          } else if (cmd.includes("kill-session")) {
            state.alive = false;
          }
          return { ok: true, output: "" };
        },
      },
    });
    const resuming = resumeReapedLaunch(store.db, launch, deps);
    await Bun.sleep(5);
    expect(spawned).toHaveLength(1);

    const cleanupRuns: string[][] = [];
    const cleaning = cleanupLaunch(store.db, launch, { id: "p", name: "p", branch: "main", repos: [] } as never, {
      dataDir: join(worktree, ".data"),
      processSystem: new FakeProcessSystem([], { selfPid: 4000, uid: 1000 }),
      scratchRoot: join(worktree, "standup-scratch"),
      run: async (cmd) => {
        cleanupRuns.push(cmd);
        if (cmd.includes("kill-session")) state.alive = false;
        return { ok: true, output: "" };
      },
    });
    // Cleared before the cleanup's first await, so the respawn's re-check sees it.
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
    await Bun.sleep(5);
    // The cleanup waits out the resume before it kills the pane.
    expect(cleanupRuns).toHaveLength(0);

    openSpawn();
    const outcome = await resuming;
    await cleaning;
    expect(outcome).toMatchObject({ resumed: false, reason: "it was stopped while resuming" });
    expect(spawned[1]).toEqual(pauseKillArgv("standup-l1"));
    expect(cleanupRuns.some((cmd) => cmd.includes("kill-session"))).toBe(true);
    expect(state.alive).toBe(false);
    expect(getLaunch(store.db, "l1")?.status).toBe("cleaned");
    expect(getSession(store.db, "s1")?.endedAt).toBeInstanceOf(Date);
    expect(frames).toEqual([]);
    expect(watched).toEqual([]);
  });

  test("a resume asked for while a cleanup runs does nothing", async () => {
    const { store, launch, worktree } = setUp();
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const release = holdForCleanup("l1");
    try {
      expect(await resumeReapedLaunch(store.db, launch, deps)).toMatchObject({ resumed: false, reason: "it is being cleaned up" });
    } finally {
      release();
    }
    expect(spawned).toHaveLength(0);
  });

  test("a resume that leaves the launch not live runs its closed job's hygiene; one that resumes it does not", async () => {
    const { store, launch, worktree } = setUp();
    const root = mkdtempSync(join(tmpdir(), "standup-scratch-resume-"));
    dirs.push(root);
    ensureScratchDir("l1", root);
    const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: "J", goal: "g" });
    linkPersonaJobLaunch(store.db, job.id, "l1");
    updatePersonaJob(store.db, job.id, { status: "done" });
    // A stop landed on the paused worker without clearing its mark: the resume does nothing.
    store.db.run("UPDATE launches SET status = 'failed' WHERE id = 'l1'");
    const sys = new FakeProcessSystem([], { selfPid: 4000, uid: 1000 });
    const ran: Array<Promise<unknown>> = [];
    const afterNotLive = (l: Launch) => {
      ran.push(hygieneAfterReap(store.db, sys, l, { installDir: "/home/me/standup", scratchRoot: root, paneAlive: noPanes, note: () => {} }));
    };
    const { pane } = spawnablePane();
    const { deps } = resumeDeps(worktree, pane, { afterNotLive });

    expect((await resumeReapedLaunch(store.db, launch, deps)).resumed).toBe(false);
    expect(ran).toHaveLength(1);
    expect(await ran[0]).toMatchObject({ scratchRemoved: ["l1"] });
    expect(existsSync(join(root, "l1"))).toBe(false);

    const resumable = setUp();
    const calls: string[] = [];
    const b = spawnablePane();
    const rb = resumeDeps(resumable.worktree, b.pane, { afterNotLive: (l) => calls.push(l.id) });
    expect((await resumeReapedLaunch(resumable.store.db, resumable.launch, rb.deps)).resumed).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a spawn that fails leaves it paused", async () => {
    const { store, launch, worktree } = setUp();
    const { pane } = spawnablePane();
    const { deps } = resumeDeps(worktree, pane, {
      spawn: { dataDir: join(worktree, ".data"), floorUnavailable: () => undefined, run: async () => ({ ok: false, output: "no server" }) },
    });
    const outcome = await resumeReapedLaunch(store.db, launch, deps);
    expect(outcome.resumed).toBe(false);
    expect(outcome.reason).toContain("no server");
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeInstanceOf(Date);
    expect(getSession(store.db, "s1")?.endedAt).toBeInstanceOf(Date);
  });

  test("a reaped launch that is no longer running is not resumed", async () => {
    const { store, launch, worktree } = setUp();
    store.db.run("UPDATE launches SET status = 'failed' WHERE id = 'l1'");
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    expect(await resumeReapedLaunch(store.db, launch, deps)).toMatchObject({ resumed: false, reason: "it is failed, not paused" });
    expect(spawned).toHaveLength(0);
  });

  test("a worker stopped while paused stays stopped when a message or steer arrives", async () => {
    const { store, launch, worktree } = setUp();
    const frames: WsMessage[] = [];
    await stopSession(
      store.db,
      {
        broadcast: (m) => frames.push(m),
        stopLaunch: async (db, l) => {
          updateLaunchStatus(db, l.id, "failed", "Stopped by you");
          return { ok: true, log: [] };
        },
      },
      { id: "s1" },
      launch
    );
    expect(frames.map((f) => f.type)).toContain("launch:stopped");
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();

    createSteer(store.db, "s1", "rebase first");
    const { pane, state } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    expect((await wakeIfReaped(store.db, "s1", deps)).resumed).toBe(false);
    expect((await wakeForQueued(store.db, "s1", deps)).resumed).toBe(false);
    expect((await resumeReapedLaunch(store.db, launch, deps)).resumed).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(state.typed).toEqual([]);
  });

  test("a deliberate stop clears the pause even when the caller's launch predates it", async () => {
    const { store } = setUp();
    store.db.run("UPDATE launches SET reaped_at = NULL WHERE id = 'l1'");
    const before = getLaunch(store.db, "l1")!;
    markLaunchReaped(store.db, "l1", "idle 2h");
    await stopSession(store.db, { broadcast: () => {}, stopLaunch: async () => ({ ok: true, log: [] }) }, { id: "s1" }, before);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
  });

  test("a deliberate stop that lands while the pane respawns kills the new pane and keeps it stopped", async () => {
    const { store, launch, worktree } = setUp();
    const { pane } = spawnablePane();
    const spawned: string[][] = [];
    const { deps, frames, watched } = resumeDeps(worktree, pane, {
      spawn: {
        dataDir: join(worktree, ".data"),
        floorUnavailable: () => undefined,
        run: async (cmd) => {
          spawned.push(cmd);
          if (spawned.length === 1) {
            // The stop runs while the respawn is in flight.
            updateLaunchStatus(store.db, "l1", "failed", "Stopped by you");
            clearLaunchReaped(store.db, "l1");
          }
          return { ok: true, output: "" };
        },
      },
    });

    const outcome = await resumeReapedLaunch(store.db, launch, deps);

    expect(outcome).toMatchObject({ resumed: false, reason: "it was stopped while resuming" });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toEqual(pauseKillArgv("standup-l1"));
    expect(getLaunch(store.db, "l1")?.status).toBe("failed");
    expect(getSession(store.db, "s1")?.endedAt).toBeInstanceOf(Date);
    expect(frames).toEqual([]);
    expect(watched).toEqual([]);
  });

  test("a resume waits for its closed job's hygiene in flight, which leaves the resuming launch's scratch dir", async () => {
    const { store, launch, worktree } = setUp();
    const root = mkdtempSync(join(tmpdir(), "standup-scratch-resume-"));
    dirs.push(root);
    ensureScratchDir("l1", root);
    const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: "J", goal: "g" });
    linkPersonaJobLaunch(store.db, job.id, "l1");
    const sys = new FakeProcessSystem(
      [
        { pid: 900, ppid: 1, pgid: 900, uid: 1000, args: "/usr/lib/systemd/systemd --user" },
        { pid: 4000, ppid: 900, pgid: 4000, uid: 1000, args: "bun run src/index.ts" },
        { pid: 5000, ppid: 900, pgid: 5000, uid: 1000, args: `node ${worktree}/server.js` },
      ],
      { selfPid: 4000, uid: 1000 }
    );
    expect(registerProcess(store.db, sys, { launch, jobId: job.id, pid: 5000, label: "api" }, { installDir: "/home/me/standup" }).ok).toBe(true);
    updatePersonaJob(store.db, job.id, { status: "done" });
    sys.ignoresTerm.add(5000);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    sys.sleep = () => gate;

    const hygiene = onJobClosed(store.db, sys, job.id, "job_closed", { installDir: "/home/me/standup", scratchRoot: root, graceMs: 1, paneAlive: noPanes, note: () => {} });
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const resuming = resumeReapedLaunch(store.db, launch, deps);
    await Bun.sleep(5);
    expect(spawned).toHaveLength(0);

    openGate();
    const cleared = await hygiene;
    expect((await resuming).resumed).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(cleared.scratchRemoved).toEqual([]);
    expect(existsSync(join(root, "l1"))).toBe(true);
  });

  test("records a resume event, so idleness is measured from the resume", async () => {
    const { store, launch, worktree } = setUp();
    store.db.run("UPDATE events SET created_at = datetime('now', '-3 hours') WHERE session_id = 's1'");
    const { pane } = spawnablePane();
    const { deps } = resumeDeps(worktree, pane);
    expect((await resumeReapedLaunch(store.db, launch, deps)).resumed).toBe(true);
    const last = getRecentEventsBySession(store.db, "s1", 1).at(-1)!;
    expect(last.type).toBe("Notification");
    expect((last.payload as { notification_type?: string }).notification_type).toBe(RESUMED_NOTIFICATION);
    expect(Date.now() - lastActivityMs(store.db, "s1")!).toBeLessThan(60_000);
  });

  test("the launch's own bypass choice outranks the project default on respawn", async () => {
    const optedOut = setUp();
    optedOut.store.db.run("UPDATE launches SET bypass_permissions = 0 WHERE id = 'l1'");
    const a = spawnablePane();
    const ra = resumeDeps(optedOut.worktree, a.pane);
    const outcome = await resumeReapedLaunch(optedOut.store.db, getLaunch(optedOut.store.db, "l1")!, ra.deps);
    expect(outcome.resumed).toBe(true);
    const cmdA = ra.spawned[0]!;
    expect(cmdA[cmdA.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(outcome.log.join("\n")).toContain("this launch opted out");

    const optedIn = setUp();
    upsertProject(optedIn.store.db, { id: "p", name: "p", branch: "main", repos: [], bypassPermissions: false });
    optedIn.store.db.run("UPDATE launches SET bypass_permissions = 1 WHERE id = 'l1'");
    const b = spawnablePane();
    const rb = resumeDeps(optedIn.worktree, b.pane);
    expect((await resumeReapedLaunch(optedIn.store.db, getLaunch(optedIn.store.db, "l1")!, rb.deps)).resumed).toBe(true);
    const cmdB = rb.spawned[0]!;
    expect(cmdB[cmdB.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  test("a resume asked for while a pause is closing the pane waits for it, then resumes", async () => {
    const { store, worktree } = setUp();
    store.db.run("UPDATE launches SET reaped_at = NULL WHERE id = 'l1'");
    store.db.run("UPDATE sessions SET ended_at = NULL WHERE id = 's1'");
    insertEvent(store.db, "s1", "Stop", { hook_event_name: "Stop", session_id: "s1" });
    const { pane, state } = spawnablePane();
    state.alive = true;
    const { deps, spawned } = resumeDeps(worktree, pane);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let resumed: Promise<ResumeOutcome> | undefined;
    const reaping = reapIdleWorkers(store.db, {
      now: () => Date.now() + 3 * 60 * 60 * 1000,
      env: {},
      pane: { exists: () => state.alive, capture: () => IDLE },
      onWorkerServer: () => true,
      attached: () => false,
      stop: async (session) => {
        // A message arrives while the pane is still closing.
        resumed = wakeIfReaped(store.db, "s1", deps);
        await gate;
        state.alive = false;
        endSession(store.db, session.id);
      },
    });
    await Bun.sleep(5);
    expect(spawned).toHaveLength(0);
    release();
    await reaping;
    const outcome = await resumed!;
    expect(outcome.resumed).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
  });
});

describe("waitForIdlePane", () => {
  test("waits through the startup screen to the prompt", async () => {
    const { launch } = setUp();
    const { pane, state } = fakePane([STARTING, STARTING, IDLE]);
    state.alive = true;
    expect(await waitForIdlePane(launch, { pane, timeoutMs: 1000, pollMs: 1 })).toBe(true);
    expect(state.captures).toBe(3);
  });

  test("is false when the pane is gone", async () => {
    const { launch } = setUp();
    const { pane } = fakePane();
    expect(await waitForIdlePane(launch, { pane, timeoutMs: 10, pollMs: 1 })).toBe(false);
  });
});

describe("wake hooks", () => {
  test("wakeIfReaped resumes a paused worker and waits for its prompt", async () => {
    const { store, worktree } = setUp();
    const { pane, state } = spawnablePane([STARTING, IDLE]);
    const { deps } = resumeDeps(worktree, pane);
    const outcome = await wakeIfReaped(store.db, "s1", deps);
    expect(outcome.resumed).toBe(true);
    expect(state.captures).toBeGreaterThanOrEqual(2);
    expect(state.typed).toEqual([]);
  });

  test("wakeIfReaped is a no-op for a worker that isn't paused", async () => {
    const { store, worktree } = setUp();
    store.db.run("UPDATE launches SET reaped_at = NULL WHERE id = 'l1'");
    const { pane } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    expect((await wakeIfReaped(store.db, "s1", deps)).resumed).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  test("wakeForQueued resumes and starts the next turn for a queued steer", async () => {
    const { store, worktree } = setUp();
    createSteer(store.db, "s1", "rebase first");
    const { pane, state } = spawnablePane();
    const { deps } = resumeDeps(worktree, pane);
    expect((await wakeForQueued(store.db, "s1", deps)).resumed).toBe(true);
    expect(state.typed).toEqual([WAKE_PROMPT]);
  });

  test("concurrent wakeForQueued calls start one turn", async () => {
    const { store, worktree } = setUp();
    createSteer(store.db, "s1", "rebase first");
    const { pane, state } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const [a, b] = await Promise.all([wakeForQueued(store.db, "s1", deps), wakeForQueued(store.db, "s1", deps)]);
    expect(a).toBe(b);
    expect(spawned).toHaveLength(1);
    expect(state.typed).toEqual([WAKE_PROMPT]);
  });

  test("queuedWorkSession names the session a steer:queued frame is for, and nothing else", () => {
    const { store } = setUp();
    const steer = createSteer(store.db, "s1", "rebase first");
    expect(queuedWorkSession({ type: "steer:queued", payload: steer, timestamp: "" })).toBe("s1");
    expect(queuedWorkSession({ type: "steer:delivered", payload: steer, timestamp: "" })).toBeNull();
    expect(queuedWorkSession({ type: "steer:queued", payload: {}, timestamp: "" })).toBeNull();
  });

  function server(store: Store, deps: LaunchResumeDeps) {
    const frames: WsMessage[] = [];
    const app = createServer(
      store,
      (m) => frames.push(m),
      null,
      undefined,
      undefined,
      "",
      "",
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      {},
      { resume: deps, paneAlive: noPanes }
    );
    return { app, frames };
  }

  test("POST /steer resumes a paused worker and delivers the steer", async () => {
    const { store, worktree } = setUp();
    const { pane, state } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const { app } = server(store, deps);
    const res = await app.request("/api/sessions/s1/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "rebase first" }),
    });
    expect(res.status).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(getLaunch(store.db, "l1")?.reapedAt).toBeUndefined();
    expect(state.typed).toEqual([WAKE_PROMPT]);
  });

  test("POST /api/messages resumes a paused target and delivers the message", async () => {
    const { store, worktree } = setUp();
    const { pane, state } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const { app } = server(store, deps);
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_session: "s1", body: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(state.typed).toEqual([WAKE_PROMPT]);
  });

  test("a steer to a worker that isn't paused spawns nothing", async () => {
    const { store, worktree } = setUp();
    store.db.run("UPDATE launches SET reaped_at = NULL WHERE id = 'l1'");
    const { pane, state } = spawnablePane();
    const { deps, spawned } = resumeDeps(worktree, pane);
    const { app } = server(store, deps);
    createSessionMessage(store.db, { toSessionId: "s1", body: "queued earlier" });
    const res = await app.request("/api/sessions/s1/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "rebase first" }),
    });
    expect(res.status).toBe(200);
    expect(spawned).toHaveLength(0);
    expect(state.typed).toEqual([]);
  });
});
