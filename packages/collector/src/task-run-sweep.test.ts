import { expect, test, describe } from "bun:test";
import type { WsMessage } from "@standup/shared";
import {
  createStore,
  upsertProject,
  createSession,
  createLaunch,
  createTaskRun,
  updateTaskRunStatus,
  getTaskRun,
} from "@standup/store";
import type { Store } from "@standup/store";
import { sweepLostTaskRuns } from "./task-run-sweep.js";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

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
  createTaskRun(store.db, { id, projectId: "p", worktreePath: worktree, sessionId: id });
  updateTaskRunStatus(store.db, id, "running");
  store.db.run(
    "UPDATE task_runs SET started_at = datetime('now','-10 minutes'), last_event_at = datetime('now','-10 minutes') WHERE id = ?",
    [id]
  );
}

describe("sweepLostTaskRuns", () => {
  test("a reaped run with no backing ticket still broadcasts task:updated", () => {
    const store = setUp();
    launchedRun(store, "adhoc"); // no ticket links this session

    const frames: WsMessage[] = [];
    const lost = sweepLostTaskRuns(store.db, {
      sessionExists: () => false,
      broadcast: (m) => frames.push(m),
    });

    expect(lost).toHaveLength(1);
    expect(getTaskRun(store.db, "adhoc")?.status).toBe("lost");

    // The dead run flips on the fleet/board immediately — even ticketless.
    const taskFrames = frames.filter((f) => f.type === "task:updated");
    expect(taskFrames).toHaveLength(1);
    const payload = taskFrames[0]!.payload as { id: string; status: string };
    expect(payload.id).toBe("adhoc");
    expect(payload.status).toBe("lost");

    // No ticket backs this run, so no ticket frame is emitted.
    expect(frames.some((f) => f.type === "ticket:updated")).toBe(false);
  });

  test("a live pane produces no broadcast", () => {
    const store = setUp();
    launchedRun(store, "alive");

    const frames: WsMessage[] = [];
    const lost = sweepLostTaskRuns(store.db, {
      sessionExists: () => true,
      broadcast: (m) => frames.push(m),
    });

    expect(lost).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});
