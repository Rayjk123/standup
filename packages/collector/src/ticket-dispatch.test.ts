import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createTicket,
  updateTicketStatus,
  setTicketSession,
  setTicketLaunch,
  createLaunch,
  createTaskRun,
  updateTaskRunStatus,
  setTicketAttemptGroup,
  getTicket,
} from "@standup/store";
import type { Store } from "@standup/store";
import { activeRunForTicket } from "./ticket-dispatch.js";

/**
 * The dispatch double-click guard resolves a ticket's in-flight run through its
 * CURRENT launch, not the ticket's stored session — because a just-dispatched
 * run has no session attached yet, and the ticket's session still points at the
 * previous, now-terminal run.
 */

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

/** A launch + its ledger run (created together, sharing worktreePath). */
function launchWithRun(
  store: Store,
  suffix: string,
  status: "queued" | "running" | "failed" | "lost",
  sessionId?: string
) {
  const worktreePath = `/wt/${suffix}`;
  const launch = createLaunch(store.db, {
    id: `L-${suffix}`,
    projectId: "p",
    task: "impl",
    worktreePath,
    branch: `standup/${suffix}`,
    tmuxSession: `tmux-${suffix}`,
  });
  const run = createTaskRun(store.db, {
    id: `R-${suffix}`,
    projectId: "p",
    worktreePath,
    sessionId,
  });
  if (status !== "queued") updateTaskRunStatus(store.db, run.id, "running");
  if (status === "failed" || status === "lost") {
    updateTaskRunStatus(store.db, run.id, status, { error: "x" });
  }
  return { launch, run };
}

describe("activeRunForTicket", () => {
  test("finds a freshly re-dispatched run that has no session attached yet", () => {
    const store = setUp();
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t", body: "" });
    updateTicketStatus(store.db, ticket.id, "approved");
    updateTicketStatus(store.db, ticket.id, "developing");

    // The previous, now-terminal run — still the ticket's stored session.
    const first = launchWithRun(store, "first", "failed", "S-old");
    setTicketSession(store.db, ticket.id, "S-old");
    setTicketLaunch(store.db, ticket.id, first.launch.id);
    // Session-only lookup would (correctly) see this terminal run as inactive.

    // A re-dispatch: a new launch + queued run, NO session attached yet. The
    // ticket now points at the new launch but keeps the stale session.
    const second = launchWithRun(store, "second", "queued");
    setTicketLaunch(store.db, ticket.id, second.launch.id);

    const found = activeRunForTicket(store.db, getTicket(store.db, ticket.id)!);
    expect(found?.id).toBe(second.run.id);
  });

  test("returns null when the current launch's run is terminal (dispatch may proceed)", () => {
    const store = setUp();
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t", body: "" });
    updateTicketStatus(store.db, ticket.id, "approved");
    updateTicketStatus(store.db, ticket.id, "developing");

    const { launch } = launchWithRun(store, "dead", "lost", "S1");
    setTicketSession(store.db, ticket.id, "S1");
    setTicketLaunch(store.db, ticket.id, launch.id);

    expect(activeRunForTicket(store.db, getTicket(store.db, ticket.id)!)).toBeNull();
  });

  test("falls back to the session lookup when the ticket has no launch", () => {
    const store = setUp();
    createSession(store.db, { id: "S2", projectId: "p", title: "", cwd: "/wt/s2", status: "running" });
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t", body: "" });
    updateTicketStatus(store.db, ticket.id, "approved");
    updateTicketStatus(store.db, ticket.id, "developing");
    const run = createTaskRun(store.db, { id: "R2", projectId: "p", worktreePath: "/wt/s2", sessionId: "S2" });
    updateTaskRunStatus(store.db, run.id, "running");
    setTicketSession(store.db, ticket.id, "S2");

    expect(activeRunForTicket(store.db, getTicket(store.db, ticket.id)!)?.id).toBe("R2");
  });

  test("returns null when the ticket has neither an active launch run nor a session", () => {
    const store = setUp();
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t", body: "" });
    updateTicketStatus(store.db, ticket.id, "approved");
    expect(activeRunForTicket(store.db, getTicket(store.db, ticket.id)!)).toBeNull();
  });

  test("sees a still-live best-of-N attempt in the ticket's group even after the anchor attempt is terminal", () => {
    const store = setUp();
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t", body: "" });
    updateTicketStatus(store.db, ticket.id, "approved");

    const group = "grp-bestofn";
    // Attempt 1 — the ticket's anchor launch — whose run has gone terminal.
    const l1 = createLaunch(store.db, {
      id: "L-a1",
      projectId: "p",
      task: "impl",
      worktreePath: "/wt/a1",
      branch: "b1",
      tmuxSession: "tm1",
    });
    const r1 = createTaskRun(store.db, { id: "R-a1", projectId: "p", worktreePath: "/wt/a1", attemptGroup: group });
    updateTaskRunStatus(store.db, r1.id, "running");
    updateTaskRunStatus(store.db, r1.id, "lost", { error: "x" });
    setTicketLaunch(store.db, ticket.id, l1.id);

    // Attempt 2 — its own worktree, still running, and NOT the ticket's anchor.
    const r2 = createTaskRun(store.db, { id: "R-a2", projectId: "p", worktreePath: "/wt/a2", attemptGroup: group });
    updateTaskRunStatus(store.db, r2.id, "running");

    setTicketAttemptGroup(store.db, ticket.id, group);

    // The anchor's run is dead, but the guard must still see attempt 2 so a
    // re-dispatch can't mint a new group and orphan it.
    const found = activeRunForTicket(store.db, getTicket(store.db, ticket.id)!);
    expect(found?.id).toBe("R-a2");
  });
});
