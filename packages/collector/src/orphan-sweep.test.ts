import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync, realpathSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  endSession,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  updateLaunchStatus,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { findOrphans, orphanSweepEnabled, orphanTargets, sweepOrphans, type OrphanTarget } from "./orphan-sweep.js";
import { holdForCleanup, holdForResume } from "./launch-holds.js";
import { FakeProcessSystem } from "./process-registry-fake.js";
import { usablePath, type ProcessRow } from "./process-registry.js";

const INSTALL = "/home/me/standup";
const SCRATCH = "/home/me/.cache/standup-scratch";
const WT_ROOT = "/home/me/.local/share/standup/worktrees/proj";
/** The workers' tmux server as these tests see it: no panes, so no liveness check reaches real tmux. */
const paneAlive = () => false;

const r = (pid: number, ppid: number, pgid: number, args: string, uid = 1000): ProcessRow => ({ pid, ppid, pgid, uid, args });

describe("findOrphans", () => {
  const closedWt = `${WT_ROOT}/closed-job`;
  const targets: OrphanTarget[] = [{ launchId: "L1", jobId: "J1", paths: [closedWt, `${SCRATCH}/L1`] }];
  const base: ProcessRow[] = [
    r(1, 0, 1, "/usr/lib/systemd/systemd --switched-root --system", 0),
    r(900, 1, 900, "/usr/lib/systemd/systemd --user"),
    r(1000, 900, 1000, "bun run dev"),
    r(4000, 1000, 1000, "bun run src/index.ts"),
  ];
  const find = (extra: ProcessRow[], t = targets) => findOrphans([...base, ...extra], t, { selfPid: 4000, uid: 1000, installDir: INSTALL }).map((o) => o.row.pid);

  test("a closed job's dev server reparented to systemd --user is an orphan", () => {
    expect(find([r(5000, 900, 5000, `node ${closedWt}/node_modules/.bin/vite --port 5200`)])).toEqual([5000]);
  });

  test("one reparented to init is an orphan", () => {
    expect(find([r(5001, 1, 5001, `python3 -m http.server --directory ${closedWt}`)])).toEqual([5001]);
  });

  test("one naming the launch's scratch dir is an orphan", () => {
    expect(find([r(5002, 900, 5002, `node ${SCRATCH}/L1/proxy.js`)])).toEqual([5002]);
  });

  test("a longer path sharing the worktree's prefix is not", () => {
    expect(find([r(5003, 900, 5003, `node ${closedWt}-other/server.js`)])).toEqual([]);
  });

  test("a process with a live parent is not an orphan", () => {
    expect(find([r(5004, 2002, 5004, `node ${closedWt}/server.js`)])).toEqual([]);
  });

  test("another user's, the collector's group, Standup's tree and install-dir processes are untouched", () => {
    expect(
      find([
        r(5005, 900, 5005, `node ${closedWt}/a.js`, 1001),
        r(5006, 900, 1000, `node ${closedWt}/b.js`),
        r(1002, 1000, 1002, `node ${closedWt}/c.js`),
        r(5007, 900, 5007, `bun run ${INSTALL}/packages/gateway/src/cli.ts --root ${closedWt}`),
        r(5008, 900, 5008, `tmux -S /x/workers new-session -c ${closedWt}`),
      ])
    ).toEqual([]);
  });

  test("an open job's launch is never a target", () => {
    expect(find([r(5009, 900, 5009, `node ${WT_ROOT}/open-job/server.js`)])).toEqual([]);
  });
});

describe("orphanTargets and sweepOrphans", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore(":memory:");
    upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  });

  /**
   * A Persona launch in `wt` whose job has `status` and whose worker is still
   * running (session live) or stopped (session ended, launch failed).
   */
  const personaLaunch = (wt: string, status: "active" | "done", sessionEnded: boolean, kind?: "adopted") => {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    createSession(store.db, { id: sessionId, projectId: "proj", title: "W", cwd: wt, status: "running" });
    if (sessionEnded) endSession(store.db, sessionId);
    const launch = createLaunch(store.db, {
      id: randomUUID(),
      projectId: "proj",
      task: "t",
      worktreePath: wt,
      branch: "b",
      status: sessionEnded ? "failed" : "running",
      sessionId,
      ...(kind ? { kind } : {}),
    });
    const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
    const job = createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: "J", goal: "g" });
    linkPersonaJobLaunch(store.db, job.id, launch.id);
    if (status !== "active") updatePersonaJob(store.db, job.id, { status });
    return { launch, job, sessionId };
  };

  test("only closed jobs with ended sessions, and cleaned job-less launches, are targets", () => {
    const closed = personaLaunch(`${WT_ROOT}/closed`, "done", true);
    personaLaunch(`${WT_ROOT}/open`, "active", true);
    personaLaunch(`${WT_ROOT}/kept`, "done", false);
    const cleaned = createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: `${WT_ROOT}/cleaned`, branch: "b", status: "running" });
    updateLaunchStatus(store.db, cleaned.id, "cleaned");
    createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: `${WT_ROOT}/plain`, branch: "b", status: "running" });
    const targets = orphanTargets(store.db, { installDir: INSTALL, scratchRoot: SCRATCH, paneAlive });
    expect(targets.map((t) => t.launchId).sort()).toEqual([closed.launch.id, cleaned.id].sort());
    expect(targets.find((t) => t.launchId === closed.launch.id)).toMatchObject({
      jobId: closed.job.id,
      sessionId: closed.sessionId,
      paths: [join(SCRATCH, closed.launch.id), `${WT_ROOT}/closed`],
    });
  });

  test("a closed job's worker still running unpaused, a starting one, one being resumed or cleaned up, and a stopped launch whose session an adoption runs again are not targets", () => {
    const running = personaLaunch(`${WT_ROOT}/running`, "done", true);
    updateLaunchStatus(store.db, running.launch.id, "running");
    const starting = personaLaunch(`${WT_ROOT}/starting`, "done", true);
    updateLaunchStatus(store.db, starting.launch.id, "starting");
    const resuming = personaLaunch(`${WT_ROOT}/resuming`, "done", true);
    const cleaning = personaLaunch(`${WT_ROOT}/cleaning`, "done", true);
    const original = personaLaunch(`${WT_ROOT}/original`, "done", true);
    createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: `${WT_ROOT}/original`, branch: "b", status: "running", sessionId: original.sessionId, kind: "adopted" });
    const stopped = personaLaunch(`${WT_ROOT}/stopped`, "done", true);
    const releaseResume = holdForResume(resuming.launch.id);
    const releaseCleanup = holdForCleanup(cleaning.launch.id);
    try {
      expect(orphanTargets(store.db, { installDir: INSTALL, scratchRoot: SCRATCH, paneAlive }).map((t) => t.launchId)).toEqual([stopped.launch.id]);
    } finally {
      releaseResume();
      releaseCleanup();
    }
    expect(orphanTargets(store.db, { installDir: INSTALL, scratchRoot: SCRATCH, paneAlive }).map((t) => t.launchId).sort()).toEqual(
      [stopped.launch.id, resuming.launch.id, cleaning.launch.id].sort()
    );
  });

  test("an adopted launch's checkout and any path another launch still uses are not matched", () => {
    const adopted = personaLaunch("/home/me/src/real-repo", "done", true, "adopted");
    personaLaunch(`${WT_ROOT}/shared`, "done", true);
    personaLaunch(`${WT_ROOT}/shared`, "active", false);
    const targets = orphanTargets(store.db, { installDir: INSTALL, scratchRoot: SCRATCH, paneAlive });
    expect(targets.find((t) => t.launchId === adopted.launch.id)?.paths).toEqual([join(SCRATCH, adopted.launch.id)]);
    expect(targets.some((t) => t.paths.includes(`${WT_ROOT}/shared`))).toBe(false);
  });

  test("dryRun reports without signalling; a real run stops and notes each orphan on its job", async () => {
    const closed = personaLaunch(`${WT_ROOT}/closed`, "done", true);
    personaLaunch(`${WT_ROOT}/open`, "active", false);
    const sys = new FakeProcessSystem(
      [
        r(900, 1, 900, "/usr/lib/systemd/systemd --user"),
        r(4000, 900, 4000, "bun run src/index.ts"),
        r(5000, 900, 5000, `node ${WT_ROOT}/closed/server.js`),
        r(5001, 5000, 5000, `node ${WT_ROOT}/closed/worker.js`),
        r(5002, 900, 5002, `node ${WT_ROOT}/open/server.js`),
      ],
      { selfPid: 4000, uid: 1000 }
    );
    const notes: Array<{ launchId: string; text: string }> = [];
    const dry = await sweepOrphans(store.db, sys, { installDir: INSTALL, scratchRoot: SCRATCH, paneAlive, dryRun: true });
    expect(dry.orphans.map((o) => o.row.pid)).toEqual([5000]);
    expect(sys.signals).toEqual([]);

    const res = await sweepOrphans(store.db, sys, {
      installDir: INSTALL,
      scratchRoot: SCRATCH,
      paneAlive,
      note: (t, text) => notes.push({ launchId: t.launchId, text }),
    });
    expect(res.outcomes).toEqual(["terminated"]);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);
    expect(sys.isAlive(5002)).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.launchId).toBe(closed.launch.id);
    expect(notes[0]!.text).toContain("pid 5000");
  });

  test("a path inside the install dir is dropped whether the install dir is named as written or resolved", () => {
    const real = mkdtempSync(join(tmpdir(), "standup-orphan-install-"));
    const link = join(mkdtempSync(join(tmpdir(), "standup-orphan-link-")), "standup");
    symlinkSync(real, link);
    const inside = personaLaunch(join(realpathSync(real), "wt", "x"), "done", true);
    const targets = orphanTargets(store.db, { installDir: link, scratchRoot: SCRATCH, paneAlive });
    expect(targets.find((t) => t.launchId === inside.launch.id)?.paths).toEqual([join(SCRATCH, inside.launch.id)]);
    expect(usablePath(join(realpathSync(real), "wt", "x"), link)).toBe(false);
    expect(usablePath(join(link, "wt", "x"), link)).toBe(false);
    expect(usablePath(`${WT_ROOT}/elsewhere`, link)).toBe(true);
  });

  test("an orphan records its start time, so a restarted pid isn't stopped", async () => {
    personaLaunch(`${WT_ROOT}/closed`, "done", true);
    const sys = new FakeProcessSystem(
      [
        r(900, 1, 900, "/usr/lib/systemd/systemd --user"),
        r(4000, 900, 4000, "bun run src/index.ts"),
        { pid: 5000, ppid: 900, pgid: 5000, uid: 1000, started: 100, args: `node ${WT_ROOT}/closed/server.js` },
      ],
      { selfPid: 4000, uid: 1000 }
    );
    // The table the sweep reads shows the old start time; the live process has a new one.
    sys.startedOf = () => 200;
    const res = await sweepOrphans(store.db, sys, { installDir: INSTALL, scratchRoot: SCRATCH, paneAlive });
    expect(res.outcomes).toEqual(["reused"]);
    expect(sys.signals).toEqual([]);
  });

  test("STANDUP_ORPHAN_SWEEP=0 turns the sweep off", () => {
    expect(orphanSweepEnabled({ STANDUP_ORPHAN_SWEEP: "0" })).toBe(false);
    expect(orphanSweepEnabled({ STANDUP_ORPHAN_SWEEP: "off" })).toBe(false);
    expect(orphanSweepEnabled({})).toBe(true);
  });
});
