import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createTicket,
  updateTicketStatus,
  setTicketSession,
  setTicketLaunch,
  getTicket,
  createLaunch,
  createTaskRun,
  updateTaskRunStatus,
  getCheckpointsBySession,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { TaskRun, Ticket } from "@standup/shared";
import { createServer } from "./server.js";
import { syncTicketForTerminalRun } from "./task-ticket-sync.js";

/**
 * Dispatchable board — a task-run's terminal state is synced back to the
 * ticket it implements (the OpenClaw LIFECYCLE_TARGETS analog): success advances
 * a developing ticket to needs_review, failure/lost is surfaced on the card, and
 * a stranded card can be re-dispatched.
 */

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return { store, app: createServer(store, () => {}, null) };
}

/** A ticket driven to `developing` with `S1` as its impl session. */
function developingTicket(store: Store, sessionId = "S1") {
  createSession(store.db, {
    id: sessionId,
    projectId: "p",
    title: "",
    cwd: `/tmp/${sessionId}`,
    status: "running",
  });
  const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "fix it", body: "" });
  updateTicketStatus(store.db, ticket.id, "approved");
  updateTicketStatus(store.db, ticket.id, "developing");
  setTicketSession(store.db, ticket.id, sessionId);
  return ticket;
}

/** A terminal task-run linked to `sessionId`, driven queued -> running -> `to`. */
function terminalRun(
  store: Store,
  sessionId: string,
  to: TaskRun["status"],
  opts?: { summary?: string; error?: string }
): TaskRun {
  const run = createTaskRun(store.db, {
    id: `run-${sessionId}-${to}`,
    projectId: "p",
    worktreePath: `/tmp/${sessionId}`,
    sessionId,
  });
  updateTaskRunStatus(store.db, run.id, "running");
  return updateTaskRunStatus(store.db, run.id, to, opts);
}

/** Stub gated transition: performs the developing -> needs_review edge the way
 *  the server's advanceTicketToReview does, recording the args it was called with
 *  so a test can assert the sync delegated the edge rather than force-marking it. */
function makeReviewAdvance(store: Store) {
  const calls: Array<{ ticketId: string; readyReason: string }> = [];
  const advance = (t: Ticket, readyReason: string): Ticket => {
    calls.push({ ticketId: t.id, readyReason });
    return updateTicketStatus(store.db, t.id, "needs_review", { readyReason });
  };
  return { advance, calls };
}

/** Polls until `pred` holds, for asserting on the fire-and-forget review gate. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("syncTicketForTerminalRun", () => {
  test("succeeded advances a developing ticket to needs_review via the review transition", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    const run = terminalRun(store, "S1", "succeeded", { summary: "shipped the fix" });

    const { advance } = makeReviewAdvance(store);
    const synced = syncTicketForTerminalRun(store.db, run, advance);
    expect(synced?.status).toBe("needs_review");
    expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    store.close();
  });

  test("succeeded delegates the edge to the review transition (summary -> readyReason)", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    const run = terminalRun(store, "S1", "succeeded", { summary: "shipped the fix" });

    const { advance, calls } = makeReviewAdvance(store);
    syncTicketForTerminalRun(store.db, run, advance);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ ticketId: ticket.id, readyReason: "shipped the fix" });
    store.close();
  });

  test("succeeded without a review transition leaves the ticket developing (no un-gated force-mark)", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    const run = terminalRun(store, "S1", "succeeded", { summary: "done" });

    expect(syncTicketForTerminalRun(store.db, run)).toBeNull();
    expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
    store.close();
  });

  test("failed leaves status but stamps the reason on the ticket", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    const run = terminalRun(store, "S1", "failed", { error: "build broke" });

    const synced = syncTicketForTerminalRun(store.db, run);
    expect(synced?.status).toBe("developing");
    expect(synced?.error).toBe("build broke");
    expect(getTicket(store.db, ticket.id)!.error).toBe("build broke");
    store.close();
  });

  test("lost stamps the reason too", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    const run = terminalRun(store, "S1", "lost", { error: "pane gone" });

    syncTicketForTerminalRun(store.db, run);
    const fresh = getTicket(store.db, ticket.id)!;
    expect(fresh.status).toBe("developing");
    expect(fresh.error).toBe("pane gone");
    store.close();
  });

  test("does not flag a ticket already past developing (agent reported ready)", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    updateTicketStatus(store.db, ticket.id, "needs_review");
    const run = terminalRun(store, "S1", "lost", { error: "pane gone" });

    expect(syncTicketForTerminalRun(store.db, run)).toBeNull();
    expect(getTicket(store.db, ticket.id)!.error).toBeUndefined();
    store.close();
  });

  test("succeeded is a no-op when the ticket is not developing", () => {
    const { store } = setUp();
    const ticket = developingTicket(store);
    updateTicketStatus(store.db, ticket.id, "needs_review");
    const run = terminalRun(store, "S1", "succeeded");

    expect(syncTicketForTerminalRun(store.db, run)).toBeNull();
    expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    store.close();
  });

  test("a run with no ticket (ad-hoc launch) is a no-op", () => {
    const { store } = setUp();
    createSession(store.db, { id: "S9", projectId: "p", title: "", cwd: "/tmp/S9", status: "running" });
    const run = terminalRun(store, "S9", "failed", { error: "x" });
    expect(syncTicketForTerminalRun(store.db, run)).toBeNull();
    store.close();
  });
});

describe("POST /api/report-task syncs the ticket", () => {
  test("succeeded moves the linked ticket to needs_review", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);
    const run = createTaskRun(store.db, {
      id: "r1",
      projectId: "p",
      worktreePath: "/tmp/S1",
      sessionId: "S1",
    });
    updateTaskRunStatus(store.db, run.id, "running");

    const res = await app.request("/api/report-task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1", cwd: "/tmp/S1", status: "succeeded", summary: "done" }),
    });
    expect(res.status).toBe(200);
    expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    store.close();
  });

  test("failed stamps the reason and keeps the ticket developing", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);
    const run = createTaskRun(store.db, {
      id: "r2",
      projectId: "p",
      worktreePath: "/tmp/S1",
      sessionId: "S1",
    });
    updateTaskRunStatus(store.db, run.id, "running");

    const res = await app.request("/api/report-task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1", cwd: "/tmp/S1", status: "failed", summary: "no good" }),
    });
    expect(res.status).toBe(200);
    const fresh = getTicket(store.db, ticket.id)!;
    expect(fresh.status).toBe("developing");
    expect(fresh.error).toBe("no good");
    store.close();
  });

  test("succeeded runs the project review gate, not just a force-mark to needs_review", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: "p",
      name: "p",
      branch: "main",
      repos: [],
      reviewProcess: "command",
      reviewCommand: "echo https://git.example.com/acme/app/pull/42",
    });
    const app = createServer(store, () => {}, null);

    createSession(store.db, { id: "S1", projectId: "p", title: "", cwd: "/tmp/S1", status: "running" });
    const launch = createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: "impl",
      worktreePath: "/tmp",
      branch: "standup/x",
      tmuxSession: "tmux-x",
    });
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "fix", body: "" });
    updateTicketStatus(store.db, ticket.id, "approved");
    updateTicketStatus(store.db, ticket.id, "developing");
    setTicketSession(store.db, ticket.id, "S1");
    setTicketLaunch(store.db, ticket.id, launch.id);
    const run = createTaskRun(store.db, { id: "r-gate", projectId: "p", worktreePath: "/tmp", sessionId: "S1" });
    updateTaskRunStatus(store.db, run.id, "running");

    const res = await app.request("/api/report-task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1", cwd: "/tmp/S1", status: "succeeded", summary: "done" }),
    });
    expect(res.status).toBe(200);
    expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");

    // The gate is fire-and-forget: waiting for the review command's URL to be
    // captured proves the succeeded sync ran runReviewGate — not the old
    // un-reviewed force-mark, which never set a review URL.
    await waitFor(() => getTicket(store.db, ticket.id)!.reviewUrl === "https://git.example.com/acme/app/pull/42");
    store.close();
  });
});

describe("mark_ready_for_review vs. the terminal-run sync", () => {
  test("mark_ready lands as an idempotent no-op when the sync already advanced (200, not 409)", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);
    // The terminal-run sync got there first: the ticket is already in review
    // (its gate having run on that edge). The impl agent's own
    // mark_ready_for_review then lands second.
    updateTicketStatus(store.db, ticket.id, "needs_review");

    const res = await app.request(`/api/tickets/${ticket.id}/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // Pre-fix this was a needs_review -> needs_review self-loop -> 409, which
    // skipped the gate for whichever caller lost the race.
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ticket: { status: string } };
    expect(payload.ticket.status).toBe("needs_review");
    expect(getTicket(store.db, ticket.id)!.status).toBe("needs_review");
    store.close();
  });
});

describe("terminal states surface as substantive feed checkpoints", () => {
  test("report-task failed records a self-reported failure checkpoint", async () => {
    const { store, app } = setUp();
    developingTicket(store);
    const run = createTaskRun(store.db, { id: "rf", projectId: "p", worktreePath: "/tmp/S1", sessionId: "S1" });
    updateTaskRunStatus(store.db, run.id, "running");

    await app.request("/api/report-task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1", cwd: "/tmp/S1", status: "failed", summary: "build broke" }),
    });

    const cps = getCheckpointsBySession(store.db, "S1");
    const failure = cps.find((c) => c.summary.startsWith("✗ Failed"));
    expect(failure).toBeDefined();
    expect(failure!.source).toBe("self-reported");
    expect(failure!.summary).toBe("✗ Failed — build broke");
    store.close();
  });

  test("report-task succeeded records a self-reported success checkpoint", async () => {
    const { store, app } = setUp();
    developingTicket(store);
    const run = createTaskRun(store.db, { id: "rs", projectId: "p", worktreePath: "/tmp/S1", sessionId: "S1" });
    updateTaskRunStatus(store.db, run.id, "running");

    await app.request("/api/report-task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1", cwd: "/tmp/S1", status: "succeeded", summary: "done" }),
    });

    const cps = getCheckpointsBySession(store.db, "S1");
    const success = cps.find((c) => c.summary.startsWith("✓ Succeeded"));
    expect(success).toBeDefined();
    expect(success!.source).toBe("self-reported");
    expect(success!.summary).toBe("✓ Succeeded — done");
    store.close();
  });

  test("shipping a ticket records an auto ship checkpoint on its session", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);
    updateTicketStatus(store.db, ticket.id, "needs_review");

    const res = await app.request(`/api/tickets/${ticket.id}/ship`, { method: "POST" });
    expect(res.status).toBe(200);

    const cps = getCheckpointsBySession(store.db, "S1");
    const shipped = cps.find((c) => c.summary.startsWith("🚢 Shipped"));
    expect(shipped).toBeDefined();
    expect(shipped!.source).toBe("auto");
    expect(shipped!.summary).toBe("🚢 Shipped — fix it");
    store.close();
  });

  test("mark_ready_for_review records a self-reported ready checkpoint (no report-task success needed)", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);

    const res = await app.request(`/api/tickets/${ticket.id}/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "S1" }),
    });
    expect(res.status).toBe(200);

    const cps = getCheckpointsBySession(store.db, "S1");
    const ready = cps.find((c) => c.summary.startsWith("🔍 Ready for review"));
    expect(ready).toBeDefined();
    expect(ready!.source).toBe("self-reported");
    expect(ready!.summary).toBe("🔍 Ready for review — fix it");
    store.close();
  });

  test("report_ticket_status needs_review records a self-reported ready checkpoint", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);

    const res = await app.request(`/api/tickets/${ticket.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "needs_review", note: "implementation done" }),
    });
    expect(res.status).toBe(200);

    const cps = getCheckpointsBySession(store.db, "S1");
    const ready = cps.find((c) => c.summary.startsWith("🔍 Ready for review"));
    expect(ready).toBeDefined();
    expect(ready!.source).toBe("self-reported");
    store.close();
  });

  test("report_ticket_status shipped records an auto ship checkpoint (parity with the /ship button)", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);
    updateTicketStatus(store.db, ticket.id, "needs_review");

    const res = await app.request(`/api/tickets/${ticket.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "shipped" }),
    });
    expect(res.status).toBe(200);

    const cps = getCheckpointsBySession(store.db, "S1");
    const shipped = cps.find((c) => c.summary.startsWith("🚢 Shipped"));
    expect(shipped).toBeDefined();
    expect(shipped!.source).toBe("auto");
    expect(shipped!.summary).toBe("🚢 Shipped — fix it");
    store.close();
  });
});

describe("POST /api/tickets/:id/dispatch guards", () => {
  test("404 for an unknown ticket", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/tickets/nope/dispatch", { method: "POST" });
    expect(res.status).toBe(404);
    store.close();
  });

  test("409 for a proposed ticket (not yet approved)", async () => {
    const { store, app } = setUp();
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t", body: "" });
    const res = await app.request(`/api/tickets/${ticket.id}/dispatch`, { method: "POST" });
    expect(res.status).toBe(409);
    store.close();
  });

  test("409 while a run is still active for the ticket", async () => {
    const { store, app } = setUp();
    const ticket = developingTicket(store);
    const run = createTaskRun(store.db, {
      id: "r3",
      projectId: "p",
      worktreePath: "/tmp/S1",
      sessionId: "S1",
    });
    updateTaskRunStatus(store.db, run.id, "running");

    const res = await app.request(`/api/tickets/${ticket.id}/dispatch`, { method: "POST" });
    expect(res.status).toBe(409);
    store.close();
  });

  test("409 while a freshly re-dispatched run is in flight (no session attached yet)", async () => {
    const { store, app } = setUp();
    // A developing ticket whose stored session points at a previous, terminal
    // run — the exact state after a run failed and was re-dispatched.
    const ticket = developingTicket(store);
    const stale = createTaskRun(store.db, { id: "r-stale", projectId: "p", worktreePath: "/tmp/S1", sessionId: "S1" });
    updateTaskRunStatus(store.db, stale.id, "running");
    updateTaskRunStatus(store.db, stale.id, "failed", { error: "boom" });

    // The re-dispatch: a new launch + queued run with NO session attached. The
    // ticket points at the new launch but keeps the stale session.
    const launch = createLaunch(store.db, {
      id: "L-new", projectId: "p", task: "impl",
      worktreePath: "/wt/new", branch: "standup/new", tmuxSession: "tmux-new",
    });
    createTaskRun(store.db, { id: "r-new", projectId: "p", worktreePath: "/wt/new" });
    setTicketLaunch(store.db, ticket.id, launch.id);

    // A session-keyed guard would miss this and let a second agent spawn; the
    // launch-keyed guard refuses.
    const res = await app.request(`/api/tickets/${ticket.id}/dispatch`, { method: "POST" });
    expect(res.status).toBe(409);
    store.close();
  });
});
