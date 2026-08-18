import { expect, test, describe } from "bun:test";
import {
  createStore,
  createSession,
  createLaunch,
  createAsk,
  getSession,
  getPendingAsksBySession,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { reapDeadSessions } from "./reaper.js";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

/** A launched session with a tmux pane and one pending permission ask. */
function launchedSessionWithAsk(store: Store, id: string): void {
  createSession(store.db, {
    id,
    projectId: "p",
    title: "t",
    cwd: `/tmp/${id}`,
    status: "waiting",
  });
  createLaunch(store.db, {
    id: `launch-${id}`,
    projectId: "p",
    task: "t",
    worktreePath: `/tmp/${id}`,
    branch: "main",
    tmuxSession: `tmux-${id}`,
    sessionId: id,
    status: "running",
  });
  createAsk(store.db, id, "permission_prompt", "may I?");
}

describe("reapDeadSessions", () => {
  test("reaps a launched session whose tmux pane is gone and cancels its asks", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "dead");

    const reaped = reapDeadSessions(store.db, () => false); // pane gone

    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.sessionId).toBe("dead");
    expect(reaped[0]!.cancelledAsks).toHaveLength(1);
    // Session is now ended and the ask no longer sits in "Needs you".
    expect(getSession(store.db, "dead")?.endedAt).toBeDefined();
    expect(getPendingAsksBySession(store.db, "dead")).toHaveLength(0);
  });

  test("leaves a launched session whose pane is still alive untouched", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "alive");

    const reaped = reapDeadSessions(store.db, () => true); // pane alive

    expect(reaped).toHaveLength(0);
    expect(getSession(store.db, "alive")?.endedAt).toBeUndefined();
    expect(getPendingAsksBySession(store.db, "alive")).toHaveLength(1);
  });

  test("ignores monitored sessions with no launch (Standup doesn't own their terminal)", () => {
    const store = setUp();
    createSession(store.db, {
      id: "monitored",
      projectId: "p",
      title: "t",
      cwd: "/tmp/monitored",
      status: "waiting",
    });
    createAsk(store.db, "monitored", "permission_prompt", "may I?");

    // Even claiming every pane is dead, a session with no launch is skipped.
    const reaped = reapDeadSessions(store.db, () => false);

    expect(reaped).toHaveLength(0);
    expect(getSession(store.db, "monitored")?.endedAt).toBeUndefined();
    expect(getPendingAsksBySession(store.db, "monitored")).toHaveLength(1);
  });
});
