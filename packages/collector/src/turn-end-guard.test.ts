import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createLaunch,
  createTaskRun,
  getActiveTaskRunBySession,
  getSession,
  updateLaunchStatus,
  updateTaskRunStatus,
} from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";
import {
  liveWorkAtTurnEnd,
  markDoneAtTurnEnd,
  OPEN_SUBAGENT_STALE_MS,
  type TurnEndGuardDeps,
} from "./turn-end-guard.js";

/**
 * The turn-end classifier can label a turn DONE from the transcript alone — a
 * worker that ends its turn with "two reviewers are still running" reads as
 * finished. markDoneAtTurnEnd is what the Stop path applies that DONE through;
 * these cases drive the session through the real /hook route, then apply the
 * classifier's DONE and check the status it lands on.
 */

const SESSION = "sess-worker";

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
  const app = createServer(store, () => {}, null);
  return { store, app };
}

function hook(app: ReturnType<typeof createServer>, body: Record<string, unknown>) {
  return app.request("/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: SESSION, cwd: "/repo", transcript_path: "/none.jsonl", ...body }),
  });
}

function deps(over: Partial<TurnEndGuardDeps> = {}): TurnEndGuardDeps {
  return { tmuxSessionExists: () => false, tmuxAvailable: () => true, now: Date.now, ...over };
}

async function startedSession(app: ReturnType<typeof createServer>) {
  await hook(app, { hook_event_name: "SessionStart" });
  await hook(app, { hook_event_name: "UserPromptSubmit", prompt: "review the change" });
}

/** A launched worker: a running launch on tmux session `standup-p-t` with an active task run. */
function launched(store: Store) {
  createLaunch(store.db, {
    id: "l1", projectId: "p", task: "t", worktreePath: "/repo", branch: "b",
    tmuxSession: "standup-p-t", sessionId: SESSION, status: "running",
  });
  createTaskRun(store.db, { id: "run1", projectId: "p", worktreePath: "/repo", sessionId: SESSION });
}

const paneAlive = (over: Partial<TurnEndGuardDeps> = {}) =>
  deps({ tmuxSessionExists: (name) => name === "standup-p-t", ...over });

/** Applies the classifier's DONE and returns the status the session lands on. */
function applyDone(store: Store, d: TurnEndGuardDeps): string | undefined {
  markDoneAtTurnEnd(store.db, SESSION, d);
  return getSession(store.db, SESSION)?.status;
}

describe("a DONE classification at turn end", () => {
  test("stays idle while a background subagent is still running", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    await hook(app, { hook_event_name: "SubagentStart", agent_type: "reviewer", agent_id: "r1" });
    await hook(app, { hook_event_name: "Stop" });

    expect(liveWorkAtTurnEnd(store.db, SESSION, deps())).toBe("1 background subagent(s) still running");
    expect(applyDone(store, deps())).toBe("idle");
  });

  test("goes done once every subagent has stopped", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    await hook(app, { hook_event_name: "SubagentStart", agent_type: "reviewer", agent_id: "r1" });
    await hook(app, { hook_event_name: "SubagentStart", agent_type: "reviewer", agent_id: "r2" });
    await hook(app, { hook_event_name: "SubagentStop", agent_type: "reviewer", agent_id: "r1", last_assistant_message: "ok" });
    await hook(app, { hook_event_name: "Stop" });
    expect(applyDone(store, deps())).toBe("idle");

    await hook(app, { hook_event_name: "SubagentStop", agent_type: "reviewer", agent_id: "r2", last_assistant_message: "ok" });
    expect(applyDone(store, deps())).toBe("done");
  });

  test("a long-running subagent still holds its parent while its tool hooks keep arriving", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    await hook(app, { hook_event_name: "SubagentStart", agent_type: "reviewer", agent_id: "r1" });
    store.db.run(
      "UPDATE events SET created_at = datetime('now', '-3 hours') WHERE session_id LIKE ?",
      [`${SESSION}%`]
    );
    store.db.run("UPDATE sessions SET started_at = datetime('now', '-3 hours') WHERE id = ?", [`${SESSION}:r1`]);
    await hook(app, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "r1" });
    await hook(app, { hook_event_name: "Stop" });

    expect(applyDone(store, deps())).toBe("idle");
  });

  test("a subagent silent past the stale window no longer holds its parent", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    await hook(app, { hook_event_name: "SubagentStart", agent_type: "reviewer", agent_id: "r1" });
    await hook(app, { hook_event_name: "Stop" });

    const later = () => Date.now() + OPEN_SUBAGENT_STALE_MS + 60_000;
    expect(applyDone(store, deps({ now: later }))).toBe("done");
  });

  test("a launched worker with a live pane and an unreported task run stays idle", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    launched(store);
    await hook(app, { hook_event_name: "Stop" });

    expect(liveWorkAtTurnEnd(store.db, SESSION, paneAlive())).toBe(
      "its launch pane is still alive and its task run is unreported"
    );
    expect(applyDone(store, paneAlive())).toBe("idle");
  });

  test("a launched worker that reported its task run finished goes done with its pane still up", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    launched(store);
    for (let run = getActiveTaskRunBySession(store.db, SESSION); run; run = getActiveTaskRunBySession(store.db, SESSION)) {
      updateTaskRunStatus(store.db, run.id, "running");
      updateTaskRunStatus(store.db, run.id, "succeeded", { summary: "done" });
    }
    await hook(app, { hook_event_name: "Stop" });

    expect(applyDone(store, paneAlive())).toBe("done");
  });

  test("a launched worker whose pane has exited goes done", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    launched(store);
    await hook(app, { hook_event_name: "Stop" });

    expect(applyDone(store, deps())).toBe("done");
  });

  test("a stopped launch goes done even if a same-named tmux session exists", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    launched(store);
    updateLaunchStatus(store.db, "l1", "cleaned");
    await hook(app, { hook_event_name: "Stop" });

    expect(applyDone(store, deps({ tmuxSessionExists: () => true }))).toBe("done");
  });

  test("without tmux, a running launch with an unreported run stays idle", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    launched(store);
    await hook(app, { hook_event_name: "Stop" });

    expect(applyDone(store, deps({ tmuxAvailable: () => false }))).toBe("idle");
  });

  test("a monitored session with nothing running goes done", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    await hook(app, { hook_event_name: "Stop" });

    expect(applyDone(store, deps())).toBe("done");
  });

  test("a session that moved on from idle is left alone", async () => {
    const { store, app } = setUp();
    await startedSession(app);
    await hook(app, { hook_event_name: "Stop" });
    await hook(app, { hook_event_name: "UserPromptSubmit", prompt: "next" });

    expect(applyDone(store, deps())).toBe("running");
  });
});
