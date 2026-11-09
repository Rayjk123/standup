import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import {
  upsertProject,
  createLaunch,
  getLaunch,
  markLaunchReaped,
  clearLaunchReaped,
  setLaunchKeepAlive,
  updateLaunchStatus,
  launchHasOpenPersonaJob,
  createPersonaJob,
  updatePersonaJob,
  linkPersonaJobLaunch,
  createLaunchProcess,
  listLiveProcessesForLaunch,
  listLiveProcessesForJob,
  markProcessStopped,
} from "../index.js";

function seeded() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createLaunch(store.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/wt/1", branch: "b1" });
  createLaunch(store.db, { id: "L2", projectId: "p", task: "t", worktreePath: "/wt/2", branch: "b2" });
  return store.db;
}

describe("launch reaping and keep-alive", () => {
  test("a new launch is neither reaped nor kept alive", () => {
    const db = seeded();
    const l = getLaunch(db, "L1")!;
    expect(l.keepAlive).toBe(false);
    expect(l.reapedAt).toBeUndefined();
    expect(l.reapReason).toBeUndefined();
  });

  test("markLaunchReaped records when and why, leaves the status, and clearLaunchReaped undoes it", () => {
    const db = seeded();
    markLaunchReaped(db, "L1", "idle 2h");
    const reaped = getLaunch(db, "L1")!;
    expect(reaped.reapedAt).toBeInstanceOf(Date);
    expect(reaped.reapReason).toBe("idle 2h");
    expect(reaped.status).toBe("starting");
    expect(getLaunch(db, "L2")!.reapedAt).toBeUndefined();
    clearLaunchReaped(db, "L1");
    const cleared = getLaunch(db, "L1")!;
    expect(cleared.reapedAt).toBeUndefined();
    expect(cleared.reapReason).toBeUndefined();
  });

  test.each(["failed", "cleaned"] as const)("a launch set %s is no longer reaped", (status) => {
    const db = seeded();
    markLaunchReaped(db, "L1", "idle 2h");
    updateLaunchStatus(db, "L1", status);
    expect(getLaunch(db, "L1")!.reapedAt).toBeUndefined();
    expect(getLaunch(db, "L1")!.reapReason).toBeUndefined();
  });

  test("a launch set running keeps its reaped mark", () => {
    const db = seeded();
    markLaunchReaped(db, "L1", "idle 2h");
    updateLaunchStatus(db, "L1", "running");
    expect(getLaunch(db, "L1")!.reapedAt).toBeInstanceOf(Date);
  });

  test("bypassPermissions round-trips and is unset when the launch didn't choose", () => {
    const db = seeded();
    expect(getLaunch(db, "L1")!.bypassPermissions).toBeUndefined();
    createLaunch(db, { id: "L3", projectId: "p", task: "t", worktreePath: "/wt/3", branch: "b3", bypassPermissions: false });
    createLaunch(db, { id: "L4", projectId: "p", task: "t", worktreePath: "/wt/4", branch: "b4", bypassPermissions: true });
    expect(getLaunch(db, "L3")!.bypassPermissions).toBe(false);
    expect(getLaunch(db, "L4")!.bypassPermissions).toBe(true);
  });

  test("setLaunchKeepAlive toggles the flag", () => {
    const db = seeded();
    setLaunchKeepAlive(db, "L1", true);
    expect(getLaunch(db, "L1")!.keepAlive).toBe(true);
    expect(getLaunch(db, "L2")!.keepAlive).toBe(false);
    setLaunchKeepAlive(db, "L1", false);
    expect(getLaunch(db, "L1")!.keepAlive).toBe(false);
  });

  test("launchHasOpenPersonaJob follows the linked job's status", () => {
    const db = seeded();
    expect(launchHasOpenPersonaJob(db, "L1")).toBe(false);
    const job = createPersonaJob(db, { owner: "o", threadId: "t", title: "j", goal: "g" });
    linkPersonaJobLaunch(db, job.id, "L1");
    expect(launchHasOpenPersonaJob(db, "L1")).toBe(true);
    expect(launchHasOpenPersonaJob(db, "L2")).toBe(false);
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    expect(launchHasOpenPersonaJob(db, "L1")).toBe(true);
    updatePersonaJob(db, job.id, { status: "done" });
    expect(launchHasOpenPersonaJob(db, "L1")).toBe(false);
  });
});

describe("launch_processes registry", () => {
  test("createLaunchProcess stores a pid process and a unit, omitting unset fields", () => {
    const db = seeded();
    const p = createLaunchProcess(db, { launchId: "L1", jobId: "J1", kind: "pid", pid: 4242, pgid: 4242, label: "vite", port: 5173, argsFingerprint: "abc" });
    expect(p).toMatchObject({ launchId: "L1", jobId: "J1", kind: "pid", pid: 4242, pgid: 4242, label: "vite", port: 5173, argsFingerprint: "abc" });
    expect(typeof p.id).toBe("string");
    expect(p.registeredAt).toBeTruthy();
    expect(p.stoppedAt).toBeUndefined();
    const u = createLaunchProcess(db, { launchId: "L1", kind: "unit", unit: "run-x.service", label: "tunnel" });
    expect(u.unit).toBe("run-x.service");
    expect("pid" in u).toBe(false);
    expect("jobId" in u).toBe(false);
  });

  test("an unknown kind is refused", () => {
    const db = seeded();
    expect(() => createLaunchProcess(db, { launchId: "L1", kind: "socket" as "pid", label: "x" })).toThrow();
  });

  test("live listings are per launch and per job, and skip stopped rows", () => {
    const db = seeded();
    const a = createLaunchProcess(db, { launchId: "L1", jobId: "J1", kind: "pid", pid: 1, label: "a" });
    const b = createLaunchProcess(db, { launchId: "L2", jobId: "J1", kind: "pid", pid: 2, label: "b" });
    const c = createLaunchProcess(db, { launchId: "L1", kind: "unit", unit: "u.service", label: "c" });
    expect(listLiveProcessesForLaunch(db, "L1").map((p) => p.id)).toEqual([a.id, c.id]);
    expect(listLiveProcessesForJob(db, "J1").map((p) => p.id)).toEqual([a.id, b.id]);
    expect(markProcessStopped(db, a.id, "job closed")).toBe(true);
    expect(listLiveProcessesForLaunch(db, "L1").map((p) => p.id)).toEqual([c.id]);
    expect(listLiveProcessesForJob(db, "J1").map((p) => p.id)).toEqual([b.id]);
    expect(listLiveProcessesForJob(db, "nope")).toEqual([]);
  });

  test("markProcessStopped keeps the first stop and reports a repeat as a no-op", () => {
    const db = seeded();
    const a = createLaunchProcess(db, { launchId: "L1", kind: "pid", pid: 1, label: "a" });
    expect(markProcessStopped(db, a.id, "first")).toBe(true);
    expect(markProcessStopped(db, a.id, "second")).toBe(false);
    expect(markProcessStopped(db, "missing", "x")).toBe(false);
    const row = db.query("SELECT stop_reason, stopped_at FROM launch_processes WHERE id = ?").get(a.id) as {
      stop_reason: string;
      stopped_at: string | null;
    };
    expect(row.stop_reason).toBe("first");
    expect(row.stopped_at).not.toBeNull();
  });
});
