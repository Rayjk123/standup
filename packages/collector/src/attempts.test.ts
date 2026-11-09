import { expect, test, describe } from "bun:test";
import { randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStore,
  upsertProject,
  getProject,
  createTicket,
  updateTicketStatus,
  getTicket,
  createSession,
  createLaunch,
  createTaskRun,
  updateTaskRunStatus,
  attachSessionToTaskRun,
  getTaskRun,
  getTaskRunsByAttemptGroup,
  countActiveTaskRuns,
  setTicketSession,
  getPipelineRunByLaunch,
  getPendingSteers,
  setReviewUrl,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Launch, Project, Ticket, WsMessage } from "@standup/shared";
import {
  clampAttempts,
  MAX_ATTEMPTS,
  MAX_UNTRACKED_DIFFS,
  dispatchTicketAttempts,
  collectAttemptDiffs,
  gitWorktreeDiff,
  pickAttempt,
  type AttemptLauncher,
  type WorktreeDiffReader,
} from "./attempts.js";
import { MAX_ACTIVE_TASK_RUNS, startLaunchPipeline } from "./launcher.js";

function setUp(): { store: Store; project: Project; ticket: Ticket } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"] });
  const project = getProject(store.db, "p")!;
  const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "the bug" });
  updateTicketStatus(store.db, ticket.id, "approved");
  return { store, project, ticket: getTicket(store.db, ticket.id)! };
}

/**
 * A stand-in for the real launcher: it records exactly the rows launchSession
 * would — a launch plus its ledger run stamped with the attempt group, each in
 * its own worktree — WITHOUT provisioning a worktree or spawning tmux. This is
 * the seam the task keeps the live launch behind; every test drives it so there
 * are no git or process side effects.
 */
function mockLauncher(): AttemptLauncher {
  let n = 0;
  const launcher: AttemptLauncher = async (db, req) => {
    n += 1;
    const worktreePath = `/wt/${req.attemptGroup ?? "solo"}/${n}`;
    const launch = createLaunch(db, {
      id: `L-${n}-${randomUUID().slice(0, 4)}`,
      projectId: req.project.id,
      task: req.label ?? req.task,
      worktreePath,
      branch: `standup/attempt-${n}`,
      baseBranch: req.project.branch,
      tmuxSession: `tmux-${n}`,
      status: "running",
      requester: req.requester,
    });
    createTaskRun(db, {
      id: `R-${n}-${randomUUID().slice(0, 4)}`,
      projectId: req.project.id,
      worktreePath,
      requester: req.requester,
      attemptGroup: req.attemptGroup,
    });
    return { launch, log: [] };
  };
  return launcher;
}

describe("clampAttempts", () => {
  test("bounds a request to 1..MAX_ATTEMPTS and defaults to 1", () => {
    expect(clampAttempts(undefined)).toBe(1);
    expect(clampAttempts(0)).toBe(1);
    expect(clampAttempts(-3)).toBe(1);
    expect(clampAttempts(2)).toBe(2);
    expect(clampAttempts(MAX_ATTEMPTS)).toBe(MAX_ATTEMPTS);
    expect(clampAttempts(99)).toBe(MAX_ATTEMPTS);
    expect(clampAttempts(2.9)).toBe(2);
    expect(clampAttempts(NaN)).toBe(1);
  });
});

describe("dispatchTicketAttempts", () => {
  test("dispatching N attempts creates N grouped, pending task_runs", async () => {
    const { store, project, ticket } = setUp();

    const { attemptGroup, launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 3, requester: "alice" },
      undefined,
      mockLauncher()
    );

    expect(launches).toHaveLength(3);
    expect(runs).toHaveLength(3);

    // Every run shares the one group id and starts pending.
    const grouped = getTaskRunsByAttemptGroup(store.db, attemptGroup);
    expect(grouped).toHaveLength(3);
    for (const r of grouped) {
      expect(r.attemptGroup).toBe(attemptGroup);
      expect(r.attemptStatus).toBe("pending");
      expect(r.requester).toBe("alice");
    }
    // Each attempt got its own worktree — no two runs collide.
    expect(new Set(grouped.map((r) => r.worktreePath)).size).toBe(3);

    // The ticket carries the group and is anchored to the first attempt's launch.
    const t = getTicket(store.db, ticket.id)!;
    expect(t.attemptGroup).toBe(attemptGroup);
    expect(t.launchId).toBe(launches[0]!.id);
  });

  test("forces a fresh worktree per attempt (inPlace:false) so an in-place project can't collapse the group", async () => {
    const store = createStore(":memory:");
    // An in-place project: its default resolves a launch's worktree to the one
    // shared repo checkout. Best-of-N must override that per attempt.
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: ["/repo"], inPlace: true });
    const project = getProject(store.db, "p")!;
    const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "the bug" });
    updateTicketStatus(store.db, ticket.id, "approved");

    // A launcher that mimics the real per-worktree resolution: honoring inPlace
    // would reuse the repo path (which then collides across attempts and, in the
    // real launcher, trips the per-worktree guard); a fresh worktree is distinct.
    const seen: Array<boolean | undefined> = [];
    let n = 0;
    const launcher: AttemptLauncher = async (db, req) => {
      seen.push(req.inPlace);
      n += 1;
      const worktreePath = req.inPlace ? "/repo" : `/wt/${req.attemptGroup}/${n}`;
      const launch = createLaunch(db, {
        id: `L-${n}`,
        projectId: req.project.id,
        task: req.label ?? req.task,
        worktreePath,
        branch: `b${n}`,
        baseBranch: req.project.branch,
        tmuxSession: `tm-${n}`,
        status: "running",
        requester: req.requester,
      });
      createTaskRun(db, {
        id: `R-${n}`,
        projectId: req.project.id,
        worktreePath,
        attemptGroup: req.attemptGroup,
      });
      return { launch, log: [] };
    };

    const { attemptGroup, launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket: getTicket(store.db, ticket.id)!, project, attempts: 3 },
      undefined,
      launcher
    );

    // Every attempt was dispatched with inPlace explicitly false — never the
    // project default — so none collapses onto the shared repo path.
    expect(seen).toEqual([false, false, false]);
    expect(launches).toHaveLength(3);
    expect(runs).toHaveLength(3);
    const grouped = getTaskRunsByAttemptGroup(store.db, attemptGroup);
    expect(new Set(grouped.map((r) => r.worktreePath)).size).toBe(3);
  });

  test("clamps the requested count (5 -> MAX_ATTEMPTS)", async () => {
    const { store, project, ticket } = setUp();
    const { attemptGroup } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 5 },
      undefined,
      mockLauncher()
    );
    expect(getTaskRunsByAttemptGroup(store.db, attemptGroup)).toHaveLength(MAX_ATTEMPTS);
  });

  test("refuses the whole dispatch (spawns nothing) when the fleet can't fit all N", async () => {
    const { store, project, ticket } = setUp();
    // Fill the fleet to one slot short of the cap with active (queued) runs.
    for (let i = 0; i < MAX_ACTIVE_TASK_RUNS - 1; i++) {
      createTaskRun(store.db, { id: `busy-${i}`, projectId: "p", worktreePath: `/wt/busy/${i}` });
    }
    const before = countActiveTaskRuns(store.db);

    const inner = mockLauncher();
    let launched = 0;
    const counting: AttemptLauncher = async (...args) => {
      launched += 1;
      return inner(...args);
    };

    // Only 1 slot free, but 2 requested — the pre-check rejects before spawning
    // anything, so no partial group of orphaned agents is left behind.
    await expect(
      dispatchTicketAttempts(store.db, { ticket, project, attempts: 2 }, undefined, counting)
    ).rejects.toThrow(/Too many active task runs/);

    expect(launched).toBe(0);
    expect(getTicket(store.db, ticket.id)!.attemptGroup).toBeUndefined();
    expect(countActiveTaskRuns(store.db)).toBe(before);
  });

  test("a transient launch failure on a later attempt keeps the already-spawned attempts (no orphans)", async () => {
    const { store, project, ticket } = setUp();
    // Attempts 1..2 launch; attempt 3 hits a transient launcher error.
    const inner = mockLauncher();
    let calls = 0;
    const flaky: AttemptLauncher = async (...args) => {
      calls += 1;
      if (calls === 3) throw new Error("git worktree add failed");
      return inner(...args);
    };

    const { attemptGroup, launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 3 },
      undefined,
      flaky
    );

    // The two that launched are kept and returned — not discarded by the throw.
    expect(launches).toHaveLength(2);
    expect(runs).toHaveLength(2);
    // The ticket owns the group and anchors to attempt 1, so the compare/pick UI
    // can find (and stop) the live attempts rather than them being orphaned.
    const t = getTicket(store.db, ticket.id)!;
    expect(t.attemptGroup).toBe(attemptGroup);
    expect(t.launchId).toBe(launches[0]!.id);
    expect(getTaskRunsByAttemptGroup(store.db, attemptGroup)).toHaveLength(2);
  });

  test("a failure on the FIRST attempt leaves the ticket untouched and propagates", async () => {
    const { store, project, ticket } = setUp();
    const failFirst: AttemptLauncher = async () => {
      throw new Error("tmux is not installed");
    };
    await expect(
      dispatchTicketAttempts(store.db, { ticket, project, attempts: 3 }, undefined, failFirst)
    ).rejects.toThrow(/tmux is not installed/);
    // Nothing spawned, so the ticket never gained a group.
    expect(getTicket(store.db, ticket.id)!.attemptGroup).toBeUndefined();
  });

  test("restores the ticket's prior group when a re-dispatch fails to launch anything", async () => {
    const { store, project, ticket } = setUp();
    const { attemptGroup: g1 } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2 },
      undefined,
      mockLauncher()
    );
    expect(getTicket(store.db, ticket.id)!.attemptGroup).toBe(g1);

    // A re-dispatch whose very first attempt throws must not wipe the prior group.
    const reread = getTicket(store.db, ticket.id)!;
    const failFirst: AttemptLauncher = async () => {
      throw new Error("boom");
    };
    await expect(
      dispatchTicketAttempts(store.db, { ticket: reread, project, attempts: 2 }, undefined, failFirst)
    ).rejects.toThrow(/boom/);
    expect(getTicket(store.db, ticket.id)!.attemptGroup).toBe(g1);
  });
});

describe("best-of-N and the delivery pipeline", () => {
  test("attempts launch with the pipeline off; picking turns the winner's run active at coding", async () => {
    const { store, project, ticket } = setUp();
    const inner = mockLauncher();
    const requests: Array<Parameters<AttemptLauncher>[1]> = [];
    // Records each request and starts its pipeline run as launchSession does.
    const launcher: AttemptLauncher = async (db, req, onUpdate, retrieval) => {
      requests.push(req);
      const result = await inner(db, req, onUpdate, retrieval);
      startLaunchPipeline(db, result.launch, {
        reusedWorktree: false,
        scratch: false,
        requester: req.requester,
        pipeline: req.pipeline,
        standupMcp: true,
        attemptGroup: req.attemptGroup,
      });
      return result;
    };
    const { launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 3, requester: "alice" },
      undefined,
      launcher
    );
    expect(requests).toHaveLength(3);
    for (const req of requests) expect(req.pipeline).toBe(false);
    for (const l of launches) expect(getPipelineRunByLaunch(store.db, l.id)?.status).toBe("disabled");

    const frames: WsMessage[] = [];
    const result = pickAttempt(
      store.db,
      { ticketId: ticket.id, taskRunId: runs[1]!.id },
      { broadcast: (m) => void frames.push(m) }
    );

    const winnerRun = getPipelineRunByLaunch(store.db, launches[1]!.id);
    expect(winnerRun).toMatchObject({ status: "active", currentStage: "coding", owner: "alice" });
    expect(result.pipelineRun?.id).toBe(winnerRun!.id);
    expect(frames.some((f) => f.type === "pipeline:updated")).toBe(true);
    for (const loser of [launches[0]!, launches[2]!]) {
      expect(getPipelineRunByLaunch(store.db, loser.id)?.status).toBe("disabled");
    }
  });

  test("a live winner is briefed through a steer; re-picking turns the earlier pick's run off", async () => {
    const { store, project, ticket } = setUp();
    const { launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2, requester: "alice" },
      undefined,
      mockLauncher()
    );
    createSession(store.db, { id: "S-1", projectId: "p", title: "", cwd: runs[0]!.worktreePath, status: "running" });
    attachSessionToTaskRun(store.db, runs[0]!.worktreePath, "S-1");
    updateTaskRunStatus(store.db, runs[0]!.id, "running");
    // The other attempt already finished (so it stays pickable after losing).
    updateTaskRunStatus(store.db, runs[1]!.id, "running");
    updateTaskRunStatus(store.db, runs[1]!.id, "succeeded");
    const frames: WsMessage[] = [];
    const first = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id }, { broadcast: (m) => void frames.push(m) });
    expect(first.pipelineRun).toMatchObject({ status: "active", currentStage: "coding" });
    expect(first.pipelineBriefToType).toBeUndefined();
    const steers = getPendingSteers(store.db, "S-1");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.body).toContain("Delivery pipeline");
    expect(steers[0]!.body).toContain("pipeline_advance");
    expect(frames.some((f) => f.type === "steer:queued")).toBe(true);
    expect(frames.find((f) => f.type === "pipeline:updated")?.audience).toBe("alice");

    // The owner changes their mind: the second attempt (no session attached) wins.
    const second = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[1]!.id });
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)?.status).toBe("disabled");
    expect(second.pipelineRun).toMatchObject({ status: "active", currentStage: "coding" });
    // No session to steer: the caller types the brief into the pane.
    expect(second.pipelineBriefToType).toContain("Delivery pipeline");
  });

  test("a winner whose worker has ended hands its run to the owner", async () => {
    const { store, project, ticket } = setUp();
    const { launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2, requester: "alice" },
      undefined,
      mockLauncher()
    );
    createSession(store.db, { id: "S-done", projectId: "p", title: "", cwd: runs[0]!.worktreePath, status: "done" });
    attachSessionToTaskRun(store.db, runs[0]!.worktreePath, "S-done");
    updateTaskRunStatus(store.db, runs[0]!.id, "running");
    updateTaskRunStatus(store.db, runs[0]!.id, "succeeded");
    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id });
    expect(result.pipelineRun).toMatchObject({ status: "waiting_user", waitingKind: "owner_input", currentStage: "coding" });
    expect(result.pipelineRun?.waitingReason).toBe("the picked attempt's worker has ended — resume it or waive the stages");
    expect(getPendingSteers(store.db, "S-done")).toHaveLength(0);
    expect(result.pipelineBriefToType).toBeUndefined();
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)?.status).toBe("waiting_user");
  });

  test("picking a winner whose launch never started a run creates an active one at coding", async () => {
    const { store, project, ticket } = setUp();
    const { launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2, requester: "alice" },
      undefined,
      mockLauncher()
    );
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)).toBeNull();
    pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id });
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)).toMatchObject({ status: "active", currentStage: "coding" });
    expect(getPipelineRunByLaunch(store.db, launches[1]!.id)).toBeNull();
  });

  /** Dispatches two attempts and attaches a session with `status` to the first. */
  async function withSession(status: "idle" | "running") {
    const env = setUp();
    const { launches, runs } = await dispatchTicketAttempts(
      env.store.db,
      { ticket: env.ticket, project: env.project, attempts: 2, requester: "alice" },
      undefined,
      mockLauncher()
    );
    createSession(env.store.db, { id: "S-1", projectId: "p", title: "", cwd: runs[0]!.worktreePath, status });
    attachSessionToTaskRun(env.store.db, runs[0]!.worktreePath, "S-1");
    updateTaskRunStatus(env.store.db, runs[0]!.id, "running");
    return { ...env, launches, runs };
  }

  test("an idle winner gets the brief typed into its pane instead of a steer it would never receive", async () => {
    const { store, launches, runs, ticket } = await withSession("idle");
    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id });
    expect(result.pipelineRun).toMatchObject({ status: "active", currentStage: "coding" });
    expect(result.pipelineBriefToType).toContain("Delivery pipeline");
    expect(getPendingSteers(store.db, "S-1")).toHaveLength(0);
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)?.status).toBe("active");
  });

  test("an idle winner with no pane to type into hands its run to the owner", async () => {
    const { store, launches, runs, ticket } = await withSession("idle");
    store.db.run("UPDATE launches SET tmux_session = NULL WHERE id = ?", [launches[0]!.id]);
    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id });
    expect(result.pipelineBriefToType).toBeUndefined();
    expect(getPendingSteers(store.db, "S-1")).toHaveLength(0);
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)).toMatchObject({
      status: "waiting_user",
      waitingKind: "owner_input",
      waitingReason: "the picked attempt's worker can't be reached — resume it or waive the stages",
    });
  });

  test("a winner whose worker can't reach the standup MCP server keeps its pipeline off", async () => {
    const { store, project, ticket } = setUp();
    const inner = mockLauncher();
    const launcher: AttemptLauncher = async (db, req, onUpdate, retrieval) => {
      const result = await inner(db, req, onUpdate, retrieval);
      startLaunchPipeline(db, result.launch, {
        reusedWorktree: false,
        scratch: false,
        requester: req.requester,
        pipeline: req.pipeline,
        standupMcp: false,
        attemptGroup: req.attemptGroup,
      });
      return result;
    };
    const { launches, runs } = await dispatchTicketAttempts(store.db, { ticket, project, attempts: 2, requester: "alice" }, undefined, launcher);
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)).toMatchObject({ status: "disabled", disabledReason: "no_mcp" });
    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id });
    expect(result.pipelineRun).toBeUndefined();
    expect(result.pipelineBriefToType).toBeUndefined();
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)).toMatchObject({ status: "disabled", disabledReason: "no_mcp" });
  });

  test("the pick drops a review url recorded before it, so the winner's code_review stage can't take a losing attempt's code review", async () => {
    const { store, runs, ticket } = await withSession("running");
    setReviewUrl(store.db, ticket.id, "https://git.example.com/acme/app/pull/loser");
    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: runs[0]!.id });
    expect(result.ticket.reviewUrl).toBeUndefined();
  });

  test("a lone attempt runs the pipeline from the start: there is no pick ahead of it", async () => {
    const { store, project, ticket } = setUp();
    const inner = mockLauncher();
    const requests: Array<Parameters<AttemptLauncher>[1]> = [];
    const launcher: AttemptLauncher = async (db, req, onUpdate, retrieval) => {
      requests.push(req);
      const result = await inner(db, req, onUpdate, retrieval);
      startLaunchPipeline(db, result.launch, { reusedWorktree: false, scratch: false, pipeline: req.pipeline, standupMcp: true, attemptGroup: req.attemptGroup });
      return result;
    };
    const { launches } = await dispatchTicketAttempts(store.db, { ticket, project, attempts: 1 }, undefined, launcher);
    expect(requests[0]!.pipeline).toBeUndefined();
    expect(getPipelineRunByLaunch(store.db, launches[0]!.id)).toMatchObject({ status: "active", currentStage: "start" });
  });
});

describe("pickAttempt", () => {
  test("marks the chosen run selected, supersedes and cancels the rest, and repoints the ticket", async () => {
    const { store, project, ticket } = setUp();
    const { launches, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 3 },
      undefined,
      mockLauncher()
    );

    // The winning attempt is a live run with an attached session (a realistic
    // mid-flight pick): it should keep its lifecycle status and its branch/session
    // becomes the ticket output.
    const winner = runs[1]!;
    createSession(store.db, { id: "S-win", projectId: "p", title: "", cwd: winner.worktreePath, status: "running" });
    attachSessionToTaskRun(store.db, winner.worktreePath, "S-win");
    updateTaskRunStatus(store.db, winner.id, "running");

    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: winner.id });

    // Winner: selected, lifecycle status preserved (not cancelled).
    expect(result.selected.attemptStatus).toBe("selected");
    expect(getTaskRun(store.db, winner.id)?.status).toBe("running");

    // Losers: superseded on the ledger, and the still-queued ones cancelled.
    expect(result.superseded).toHaveLength(2);
    for (const loser of result.superseded) {
      expect(loser.attemptStatus).toBe("superseded");
      expect(loser.status).toBe("cancelled");
    }

    // The ticket is repointed at the winner's launch + session (feeds Publisher).
    const winnerLaunch = launches[1]!;
    const t = getTicket(store.db, ticket.id)!;
    expect(t.launchId).toBe(winnerLaunch.id);
    expect(t.sessionId).toBe("S-win");
    // The still-live losers' panes are handed back to the caller to stop.
    expect(result.stopLaunches.map((l: Launch) => l.id).sort()).toEqual(
      [launches[0]!.id, launches[2]!.id].sort()
    );
  });

  test("refuses picking a dead (lost/failed/cancelled) attempt and leaves state untouched", async () => {
    const { store, project, ticket } = setUp();
    const { runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2 },
      undefined,
      mockLauncher()
    );
    const anchoredLaunch = getTicket(store.db, ticket.id)!.launchId;

    // The attempt the human tries to pick died — its worktree holds no usable
    // branch, so picking it would repoint the ticket output at a dead branch.
    const dead = runs[1]!;
    updateTaskRunStatus(store.db, dead.id, "lost", { error: "pane gone" });

    expect(() => pickAttempt(store.db, { ticketId: ticket.id, taskRunId: dead.id })).toThrow(
      /lost — pick a live or succeeded attempt/
    );

    // Nothing was mutated: the dead run stays pending (not selected), the other
    // attempt is untouched (not superseded/cancelled), and the ticket still
    // anchors to attempt 1's launch.
    expect(getTaskRun(store.db, dead.id)!.attemptStatus).toBe("pending");
    const survivor = getTaskRun(store.db, runs[0]!.id)!;
    expect(survivor.attemptStatus).toBe("pending");
    expect(survivor.status).not.toBe("cancelled");
    expect(getTicket(store.db, ticket.id)!.launchId).toBe(anchoredLaunch);
  });

  test("clears a stale ticket session when the picked attempt has none attached", async () => {
    const { store, project, ticket } = setUp();
    // The ticket already points at an earlier session (a prior/loser run's).
    setTicketSession(store.db, ticket.id, "S-old");
    const { runs } = await dispatchTicketAttempts(
      store.db,
      { ticket: getTicket(store.db, ticket.id)!, project, attempts: 2 },
      undefined,
      mockLauncher()
    );

    // Pick a live attempt that has NOT attached a session yet.
    const winner = runs[0]!;
    updateTaskRunStatus(store.db, winner.id, "running");
    const result = pickAttempt(store.db, { ticketId: ticket.id, taskRunId: winner.id });

    // The stale session is cleared, not left dangling alongside the winner's launch.
    expect(result.selected.attemptStatus).toBe("selected");
    expect(result.ticket.sessionId).toBeUndefined();
    expect(getTicket(store.db, ticket.id)!.sessionId).toBeUndefined();
  });

  test("rejects a run that is not part of an attempt group", () => {
    const { store } = setUp();
    createTaskRun(store.db, { id: "solo", projectId: "p", worktreePath: "/wt/solo" });
    const t2 = createTicket(store.db, { projectId: "p", lens: "bugs", title: "t2", body: "" });
    expect(() => pickAttempt(store.db, { ticketId: t2.id, taskRunId: "solo" })).toThrow(
      /not part of a best-of-N/
    );
  });

  test("rejects an attempt that belongs to a different ticket", async () => {
    const { store, project, ticket } = setUp();
    const { runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2 },
      undefined,
      mockLauncher()
    );
    const other = createTicket(store.db, { projectId: "p", lens: "bugs", title: "other", body: "" });
    // `other` has its own (different) attempt group.
    await dispatchTicketAttempts(store.db, { ticket: other, project, attempts: 2 }, undefined, mockLauncher());
    expect(() =>
      pickAttempt(store.db, { ticketId: other.id, taskRunId: runs[0]!.id })
    ).toThrow(/different ticket/);
  });

  test("rejects picking a foreign attempt for a ticket that has no group of its own", async () => {
    const { store, project, ticket } = setUp();
    const { runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2 },
      undefined,
      mockLauncher()
    );
    // A never-best-of-N-dispatched ticket: attemptGroup is unset. It must NOT be
    // allowed to repoint at, and cancel, another ticket's group.
    const groupless = createTicket(store.db, { projectId: "p", lens: "bugs", title: "groupless", body: "" });
    expect(getTicket(store.db, groupless.id)!.attemptGroup).toBeUndefined();

    expect(() =>
      pickAttempt(store.db, { ticketId: groupless.id, taskRunId: runs[0]!.id })
    ).toThrow(/different ticket/);

    // The foreign group's runs are untouched — not superseded, not cancelled.
    const foreign = getTaskRun(store.db, runs[0]!.id)!;
    expect(foreign.attemptStatus).toBe("pending");
    expect(foreign.status).not.toBe("cancelled");
  });
});

describe("collectAttemptDiffs", () => {
  test("reads each attempt's worktree diff through the injected seam (no git)", async () => {
    const { store, project, ticket } = setUp();
    const { attemptGroup, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2 },
      undefined,
      mockLauncher()
    );

    // A fake reader keyed by worktree path — proves the collection resolves each
    // attempt's own worktree and never shells out to git.
    const seen: Array<{ path: string; base: string }> = [];
    const fakeReader: WorktreeDiffReader = (worktreePath, baseBranch) => {
      seen.push({ path: worktreePath, base: baseBranch });
      return { diff: `diff for ${worktreePath}`, truncated: false };
    };

    const attempts = await collectAttemptDiffs(store.db, attemptGroup, fakeReader);

    expect(attempts).toHaveLength(2);
    for (const a of attempts) {
      expect(a.diff).toBe(`diff for ${a.run.worktreePath}`);
      expect(a.launch?.worktreePath).toBe(a.run.worktreePath);
      expect(a.diffError).toBeUndefined();
    }
    // The reader was asked for each attempt's worktree, against the base branch.
    expect(seen.map((s) => s.path).sort()).toEqual(runs.map((r) => r.worktreePath).sort());
    expect(seen.every((s) => s.base === "main")).toBe(true);
  });

  test("awaits an async reader (does not block on synchronous spawns)", async () => {
    const { store, project, ticket } = setUp();
    const { attemptGroup, runs } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 2 },
      undefined,
      mockLauncher()
    );

    // An async reader stands in for the real git-diff, which now runs off the
    // event loop (async spawn) rather than blocking it with Bun.spawnSync. The
    // collection must AWAIT each read; a reader whose Promise leaked through
    // unawaited would surface `undefined` diff fields (the pre-fix behavior).
    const asyncReader: WorktreeDiffReader = async (worktreePath) => {
      await Promise.resolve();
      return { diff: `async:${worktreePath}`, truncated: false };
    };

    const attempts = await collectAttemptDiffs(store.db, attemptGroup, asyncReader);
    expect(attempts).toHaveLength(2);
    for (const a of attempts) {
      expect(a.diff).toBe(`async:${a.run.worktreePath}`);
      expect(a.diffError).toBeUndefined();
    }
    expect(attempts.map((a) => a.run.worktreePath).sort()).toEqual(
      runs.map((r) => r.worktreePath).sort()
    );
  });

  test("surfaces a read failure per attempt instead of throwing", async () => {
    const { store, project, ticket } = setUp();
    const { attemptGroup } = await dispatchTicketAttempts(
      store.db,
      { ticket, project, attempts: 1 },
      undefined,
      mockLauncher()
    );
    const failing: WorktreeDiffReader = () => ({ diff: "", error: "worktree gone" });
    const [attempt] = await collectAttemptDiffs(store.db, attemptGroup, failing);
    expect(attempt!.diff).toBe("");
    expect(attempt!.diffError).toBe("worktree gone");
  });
});

describe("gitWorktreeDiff (default reader)", () => {
  // The one place that exercises real git — a throwaway repo under the OS temp
  // dir, fully cleaned up. It guards the regression where new-file work rendered
  // blank because plain `git diff` omits untracked files.
  test("includes untracked (new) files, not just tracked changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-diff-"));
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
      git("init", "-q");
      git("config", "user.email", "t@t.com");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "tracked.txt"), "line1\nline2\n");
      git("add", "tracked.txt");
      git("commit", "-qm", "init");

      // A modified tracked file AND a brand-new untracked file (never `git add`ed).
      writeFileSync(join(dir, "tracked.txt"), "line1\nCHANGED\n");
      writeFileSync(join(dir, "newfile.txt"), "brand\nnew\nfile\n");

      const { diff, error } = await gitWorktreeDiff(dir, "HEAD");
      expect(error).toBeUndefined();
      // Tracked change is present.
      expect(diff).toContain("tracked.txt");
      expect(diff).toContain("CHANGED");
      // The untracked file — the regression this guards — shows as an addition.
      expect(diff).toContain("newfile.txt");
      expect(diff).toContain("new file mode");
      expect(diff).toContain("+brand");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Bounds the per-attempt subprocess fan-out (Hole 3). A worktree with more new
  // files than the cap must NOT spawn a `git diff` for every one of them. Bun.spawn
  // is spied so the assertion is on the exact number of git subprocesses launched,
  // with no real subprocess cost. The spy also catches a revert to the blocking
  // Bun.spawnSync: that would leave THIS spy uncalled (diff spawns = 0) and, since
  // the temp dir is not a git repo, surface a git error — both assertions fail.
  test("caps the untracked-file diffs at MAX_UNTRACKED_DIFFS (bounded spawns)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-diff-cap-"));
    const origSpawn = Bun.spawn;
    const fileCount = MAX_UNTRACKED_DIFFS + 12;
    const untracked = Array.from({ length: fileCount }, (_, i) => `new-${i}.txt`);
    let noIndexDiffs = 0;
    // A canned git: an empty tracked diff, the full untracked list, and a
    // "new file mode" header per `diff --no-index` (which the reader spawns once
    // per untracked file — the count this test bounds).
    Bun.spawn = ((cmd: string[]) => {
      const args = cmd.slice(3); // cmd = ["git", "-C", <dir>, ...args]
      let stdout = "";
      let exitCode = 0;
      if (args[0] === "diff" && args[1] === "--no-index") {
        noIndexDiffs += 1;
        const file = args[args.length - 1];
        stdout = `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..e69de29\n`;
        exitCode = 1; // --no-index exits 1 when the inputs differ (always, vs /dev/null)
      } else if (args[0] === "ls-files") {
        stdout = untracked.join("\0");
      }
      return { stdout, stderr: "", exited: Promise.resolve(exitCode), exitCode };
    }) as unknown as typeof Bun.spawn;

    try {
      const { diff, error } = await gitWorktreeDiff(dir, "HEAD");
      expect(error).toBeUndefined();
      // The reader spawned a git-diff for AT MOST the cap — not one per file.
      expect(noIndexDiffs).toBe(MAX_UNTRACKED_DIFFS);
      expect(noIndexDiffs).toBeLessThan(fileCount);
      // And the rendered output carries exactly that many new-file headers.
      expect(diff.split("new file mode").length - 1).toBe(MAX_UNTRACKED_DIFFS);
    } finally {
      Bun.spawn = origSpawn;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Non-blocking (Hole 3). The diff runs off the event loop (async spawn), so a
  // concurrent timer keeps firing WHILE git runs. Reverted to a blocking
  // Bun.spawnSync, the whole diff would execute synchronously and starve the loop
  // until it finished — the interval could not tick and this test would fail.
  test("runs off the event loop — a concurrent timer keeps ticking during the diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-diff-async-"));
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
      git("init", "-q");
      git("config", "user.email", "t@t.com");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "tracked.txt"), "base\n");
      git("add", "tracked.txt");
      git("commit", "-qm", "init");

      // Enough untracked files that the diff fans out to many sequential git
      // subprocesses — real wall-clock work whose awaits yield the loop.
      for (let i = 0; i < 40; i++) {
        writeFileSync(join(dir, `new-${String(i).padStart(3, "0")}.txt`), "x\n");
      }

      let ticks = 0;
      const interval = setInterval(() => {
        ticks += 1;
      }, 1);
      try {
        const { diff, error } = await gitWorktreeDiff(dir, "HEAD");
        expect(error).toBeUndefined();
        expect(diff).toContain("new file mode");
      } finally {
        clearInterval(interval);
      }
      // The loop stayed live during the diff — a blocking sync spawn would leave
      // this at 0.
      expect(ticks).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
