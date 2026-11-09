import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import {
  upsertProject,
  createSession,
  createLaunch,
  createTaskRun,
  updateTaskRunStatus,
  heartbeatTaskRun,
  getTaskRun,
  getActiveTaskRunByWorktree,
  getActiveTaskRunBySession,
  countActiveTaskRuns,
  attachSessionToTaskRun,
  reconcileLostTaskRuns,
  TaskRunTransitionError,
} from "../index.js";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function newRun(store: Store, id: string, worktreePath: string, sessionId?: string) {
  return createTaskRun(store.db, { id, projectId: "p", worktreePath, sessionId });
}

describe("task-run status transitions", () => {
  test("queued -> running -> succeeded stamps the lifecycle timestamps", () => {
    const store = setUp();
    const run = newRun(store, "T1", "/tmp/T1");
    expect(run.status).toBe("queued");
    expect(run.startedAt).toBeUndefined();
    expect(run.endedAt).toBeUndefined();

    const running = updateTaskRunStatus(store.db, "T1", "running");
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();
    expect(running.endedAt).toBeUndefined();

    const done = updateTaskRunStatus(store.db, "T1", "succeeded", { summary: "shipped it" });
    expect(done.status).toBe("succeeded");
    expect(done.endedAt).toBeDefined();
    expect(done.summary).toBe("shipped it");
  });

  test("a failed report records the error and is terminal", () => {
    const store = setUp();
    newRun(store, "T1", "/tmp/T1");
    updateTaskRunStatus(store.db, "T1", "running");
    const failed = updateTaskRunStatus(store.db, "T1", "failed", { error: "boom" });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
    // Terminal: no outbound edges.
    expect(() => updateTaskRunStatus(store.db, "T1", "running")).toThrow(TaskRunTransitionError);
  });

  test("an illegal edge throws and does not mutate the row", () => {
    const store = setUp();
    newRun(store, "T1", "/tmp/T1");
    // queued cannot jump straight to succeeded.
    expect(() => updateTaskRunStatus(store.db, "T1", "succeeded")).toThrow(TaskRunTransitionError);
    expect(getTaskRun(store.db, "T1")?.status).toBe("queued");
  });

  test("heartbeat bumps last_event_at without changing status", () => {
    const store = setUp();
    newRun(store, "T1", "/tmp/T1");
    updateTaskRunStatus(store.db, "T1", "running");
    const beat = heartbeatTaskRun(store.db, "T1");
    expect(beat.status).toBe("running");
    expect(beat.lastEventAt).toBeDefined();
  });
});

describe("per-worktree serialization guard + global cap", () => {
  test("an active run occupies its worktree; a terminal one frees it", () => {
    const store = setUp();
    newRun(store, "T1", "/tmp/wt");
    expect(getActiveTaskRunByWorktree(store.db, "/tmp/wt")?.id).toBe("T1");
    expect(countActiveTaskRuns(store.db)).toBe(1);

    // Still active while running.
    updateTaskRunStatus(store.db, "T1", "running");
    expect(getActiveTaskRunByWorktree(store.db, "/tmp/wt")?.id).toBe("T1");

    // A terminal state releases the worktree and clears the active count.
    updateTaskRunStatus(store.db, "T1", "succeeded");
    expect(getActiveTaskRunByWorktree(store.db, "/tmp/wt")).toBeNull();
    expect(countActiveTaskRuns(store.db)).toBe(0);
  });

  test("distinct worktrees each count toward the global cap independently", () => {
    const store = setUp();
    newRun(store, "T1", "/tmp/a");
    newRun(store, "T2", "/tmp/b");
    newRun(store, "T3", "/tmp/c");
    expect(countActiveTaskRuns(store.db)).toBe(3);
    updateTaskRunStatus(store.db, "T2", "cancelled");
    expect(countActiveTaskRuns(store.db)).toBe(2);
  });
});

describe("attachSessionToTaskRun", () => {
  test("links the newest unclaimed active run for a worktree, write-once", () => {
    const store = setUp();
    createSession(store.db, { id: "s1", projectId: "p", title: "t", cwd: "/tmp/wt", status: "running" });
    newRun(store, "T1", "/tmp/wt");

    attachSessionToTaskRun(store.db, "/tmp/wt", "s1");
    expect(getActiveTaskRunBySession(store.db, "s1")?.id).toBe("T1");

    // Write-once: a second session does not steal an already-linked run.
    attachSessionToTaskRun(store.db, "/tmp/wt", "s2");
    expect(getTaskRun(store.db, "T1")?.sessionId).toBe("s1");
  });
});

describe("reconcileLostTaskRuns", () => {
  /** A running task run whose launch has a tmux pane and a live session. */
  function launchedRun(store: Store, id: string): void {
    const worktree = `/tmp/${id}`;
    createSession(store.db, {
      id,
      projectId: "p",
      title: "t",
      cwd: worktree,
      status: "running",
    });
    createLaunch(store.db, {
      id: `launch-${id}`,
      projectId: "p",
      task: "t",
      worktreePath: worktree,
      branch: "main",
      tmuxSession: `tmux-${id}`,
      sessionId: id,
      status: "running",
    });
    newRun(store, id, worktree, id);
    updateTaskRunStatus(store.db, id, "running");
  }

  /** Backdate a run's activity clock so it sits outside the grace window. */
  function age(store: Store, id: string): void {
    store.db.run(
      "UPDATE task_runs SET started_at = datetime('now','-10 minutes'), last_event_at = datetime('now','-10 minutes') WHERE id = ?",
      [id]
    );
  }

  test("marks a run lost when its pane is gone past the grace window", () => {
    const store = setUp();
    launchedRun(store, "dead");
    age(store, "dead");

    const lost = reconcileLostTaskRuns(store.db, { sessionExists: () => false });

    expect(lost).toHaveLength(1);
    expect(lost[0]!.id).toBe("dead");
    const run = getTaskRun(store.db, "dead");
    expect(run?.status).toBe("lost");
    expect(run?.endedAt).toBeDefined();
    expect(run?.error).toBeTruthy();
  });

  test("leaves a run whose pane is still alive untouched", () => {
    const store = setUp();
    launchedRun(store, "alive");
    age(store, "alive");

    const lost = reconcileLostTaskRuns(store.db, { sessionExists: () => true });

    expect(lost).toHaveLength(0);
    expect(getTaskRun(store.db, "alive")?.status).toBe("running");
  });

  test("respects the grace window — a pane just gone is not yet lost", () => {
    const store = setUp();
    launchedRun(store, "recent"); // last_event_at is now (not aged)

    const lost = reconcileLostTaskRuns(store.db, {
      sessionExists: () => false,
      graceMs: 2 * 60 * 1000,
    });

    expect(lost).toHaveLength(0);
    expect(getTaskRun(store.db, "recent")?.status).toBe("running");
  });

  test("leaves a run whose pane can't be resolved alone", () => {
    const store = setUp();
    // Running run with no launch and no session — nothing to probe.
    newRun(store, "orphan", "/tmp/orphan");
    updateTaskRunStatus(store.db, "orphan", "running");
    age(store, "orphan");

    const lost = reconcileLostTaskRuns(store.db, { sessionExists: () => false });

    expect(lost).toHaveLength(0);
    expect(getTaskRun(store.db, "orphan")?.status).toBe("running");
  });
});
