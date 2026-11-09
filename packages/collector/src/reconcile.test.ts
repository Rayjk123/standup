import { expect, test, describe } from "bun:test";
import {
  createAsk,
  createLaunch,
  createSession,
  createStore,
  getPendingAsksBySession,
  getSession,
  insertEvent,
  updateSessionStatus,
  upsertProject,
} from "@standup/store";
import { reconcileBlockedSessions } from "./reconcile.js";
import { IDLE_NOTICE_GATE } from "./persona/policy.js";

function launchedSession(lastNotification: "idle_prompt" | "permission_prompt") {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "running" });
  createLaunch(store.db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b", sessionId: "s1", status: "running" });
  insertEvent(store.db, "s1", "Notification", {
    notification_type: lastNotification,
    message: lastNotification === "idle_prompt" ? "Claude is waiting for your input" : "Claude needs your permission to use Bash",
  });
  return store.db;
}

describe("reconcileBlockedSessions", () => {
  test("an idle notice is re-raised gated as one; a permission prompt is not gated", () => {
    const idle = launchedSession("idle_prompt");
    expect(reconcileBlockedSessions(idle).map((a) => a.gate)).toEqual([IDLE_NOTICE_GATE]);
    const permission = launchedSession("permission_prompt");
    expect(reconcileBlockedSessions(permission).map((a) => a.gate)).toEqual([undefined]);
  });

  test("a permission prompt still surfaces behind a pending question or idle notice", () => {
    const db = launchedSession("permission_prompt");
    createAsk(db, "s1", "ask_human", "Which approach?");
    createAsk(db, "s1", "permission_prompt", "Claude is waiting for your input", undefined, { gate: IDLE_NOTICE_GATE });
    expect(reconcileBlockedSessions(db)).toHaveLength(1);
    expect(reconcileBlockedSessions(db)).toHaveLength(0);
    expect(getPendingAsksBySession(db, "s1")).toHaveLength(3);
  });

  test("an idle notice is moot behind any pending ask and skipped for a session Persona will take", () => {
    const behind = launchedSession("idle_prompt");
    createAsk(behind, "s1", "ask_human", "Which approach?");
    expect(reconcileBlockedSessions(behind)).toHaveLength(0);
    const owned = launchedSession("idle_prompt");
    expect(reconcileBlockedSessions(owned, { personaOwned: () => true })).toHaveLength(0);
    expect(reconcileBlockedSessions(owned, { personaOwned: () => false })).toHaveLength(1);
  });

  test("an idle notice is not re-raised for a session already judged done; a permission prompt still is", () => {
    const idle = launchedSession("idle_prompt");
    updateSessionStatus(idle, "s1", "done");
    expect(reconcileBlockedSessions(idle)).toHaveLength(0);
    expect(getSession(idle, "s1")?.status).toBe("done");
    const permission = launchedSession("permission_prompt");
    updateSessionStatus(permission, "s1", "done");
    expect(reconcileBlockedSessions(permission)).toHaveLength(1);
  });
});
