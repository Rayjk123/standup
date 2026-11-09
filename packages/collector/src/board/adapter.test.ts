import { describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import { join } from "path";
import { testTempDir } from "../test-support/temp-dirs.js";
import type { BoardTaskFrame, ReviewTunnel, ReviewTunnelUpdatedPayload, WsMessage } from "@standup/shared";
import {
  boardUnrefinedJobIds,
  claimReviewTunnel,
  createCheckpoint,
  createPersonaApproval,
  createPersonaJob,
  createTicket,
  flagPersonaJobWaitingUser,
  getBoardTaskBySource,
  getOrCreatePersonaConsoleThread,
  getPersonaJob,
  getPipelineRun,
  personaJobForLaunch,
  transitionPersonaApproval,
  updatePersonaJob,
  updateLaunchStatus,
  updatePipelineRun,
  updateSessionStatus,
  updateTicketStatus,
  upsertBoardTask,
} from "@standup/store";
import { createBroadcastTap } from "../persona/events.js";
import { REVIEW_LANDED_REASON, markRunWaiting, pipelineStopDecision } from "../pipeline/engine.js";
import { HUMAN_REVIEW_STOP_REASON } from "../review/pipeline-adapter.js";
import { createReviewTunnels, reviewTunnelFrame } from "../review-tunnel/index.js";
import { FakeTunnelSystem } from "../review-tunnel/fake-system.js";
import { EVIDENCE, OWNER, advance, approveHumanReview, makeWorld, submitPacketAsWorker, type World } from "../pipeline/test-world.js";
import { attachBoardAdapter, type BoardAdapterOptions } from "./adapter.js";
import { createBoard } from "./board.js";
import { MAX_BOARD_TASK_FILES } from "./projection.js";

const LIVE_CHECK = {
  environment: "isolated collector on :7791",
  isolation: { ports: [7791], tmuxSocket: "/tmp/standup-live-check.sock" },
  liveSamples: [{ request: "GET /api/health", response: "200 ok", ok: true }],
};

/**
 * A light-pipeline world with the board attached to a broadcast tap. The
 * world's own app and engine record their frames; `replay` puts the new ones
 * through the tap, as the collector's tap would carry them, and settles the
 * adapter. `published` holds the board's own frames.
 */
function boardWorld(world: Parameters<typeof makeWorld>[0] = {}, adapterOpts: Pick<BoardAdapterOptions, "unrefinedLimit"> = {}) {
  const w = makeWorld({ persona: true, reviewArtifact: null, ...world });
  w.changed.files = ["packages/collector/src/x.ts", "packages/store/src/queries/y.ts"];
  const published: WsMessage[] = [];
  const tap = createBroadcastTap((m) => {
    if (m.type === "board:task") published.push(m);
  });
  const board = createBoard({ db: w.store.db, publish: tap.broadcast });
  const diffs: string[] = [];
  const adapter = attachBoardAdapter({
    tap,
    board,
    db: w.store.db,
    changedFiles: async (worktree) => {
      diffs.push(worktree);
      return ["packages/web/src/Board.tsx"];
    },
    // Only flush() drains, so each step reprojects exactly once.
    delayMs: 60_000,
    ...adapterOpts,
  });
  let seen = 0;
  const replay = async (): Promise<WsMessage[]> => {
    const before = published.length;
    for (const frame of w.broadcasts.slice(seen)) tap.broadcast(frame);
    seen = w.broadcasts.length;
    await adapter.flush();
    return published.slice(before);
  };
  const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
  const card = () => getBoardTaskBySource(w.store.db, "job", jobId);
  return { w, tap, board, adapter, published, replay, jobId, card, diffs };
}

async function step(h: ReturnType<typeof boardWorld>, stage: string, evidence?: unknown) {
  const res = await advance(h.w as World, stage, evidence);
  expect(res.status).toBe(200);
  return h.replay();
}

describe("board adapter", () => {
  test("a job's card follows its run start → coding → validation → review → live check → human review → done, one frame per change", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    expect(h.card()).toMatchObject({ status: "queued", stage: "start", owner: "alice", projectId: "proj" });
    expect(h.published).toHaveLength(1);

    const columns: string[] = [];
    const frames: number[] = [];
    for (const [stage, evidence] of [
      ["start", undefined],
      ["coding", EVIDENCE.coding],
      ["validation", EVIDENCE.validationPass],
      ["review", EVIDENCE.reviewClean],
      ["live_check", LIVE_CHECK],
    ] as const) {
      const out = await step(h, stage, evidence);
      frames.push(out.length);
      columns.push(`${h.card()!.status}@${h.card()!.stage}`);
    }
    expect(columns).toEqual([
      "coding@coding",
      "validation@validation",
      "validation@review",
      "live_check@live_check",
      // At human review with no packet yet, the worker is writing it: still validation.
      "validation@human_review",
    ]);
    expect(frames).toEqual([1, 1, 1, 1, 1]);
    expect(h.card()!.waitingOn).toBeUndefined();
    // Each stage move read the launch's diff once, and its files joined the card's areas.
    expect(h.diffs.length).toBe(5);
    expect(h.card()!.areas.files).toEqual(
      expect.arrayContaining(["packages/web/src/Board.tsx", "packages/collector/src/x.ts"])
    );
    expect(h.card()!.areas.packages).toEqual(expect.arrayContaining(["packages/web", "packages/collector"]));
    expect(h.card()!.links.runId).toBe(h.w.run.id);

    // The packet the worker submits waits on the owner: still in review, now on the packet.
    const submitted = await submitPacketAsWorker(h.w);
    expect(submitted.status).toBe(200);
    expect(await h.replay()).toHaveLength(1);
    expect(h.card()).toMatchObject({ status: "in_review", waitingOn: "owner review of the packet" });
    expect(h.card()!.links.packetId).toBeTruthy();

    // The worker stops on its submitted packet: the run waits on the owner's decision, and the
    // card stays in review on the packet rather than moving to waiting.
    expect(pipelineStopDecision(h.w.store.db, h.w.sessionId, h.w.deps)).toBeNull();
    expect(getPipelineRun(h.w.store.db, h.w.run.id)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input", waitingReason: HUMAN_REVIEW_STOP_REASON });
    expect(await h.replay()).toHaveLength(0);
    expect(h.card()).toMatchObject({ status: "in_review", stage: "human_review", waitingOn: "owner review of the packet" });

    // A frame that changes nothing publishes nothing.
    h.tap.broadcast({ type: "pipeline:updated", payload: getPipelineRun(h.w.store.db, h.w.run.id), timestamp: new Date().toISOString() });
    await h.adapter.flush();
    expect(h.published.length).toBe(7);

    const approved = await approveHumanReview(h.w);
    expect(approved.status).toBe(200);
    const out = await h.replay();
    expect(out).toHaveLength(1);
    // The run completed while its worker's session still runs (landing what was approved): the
    // job, still open, awaits Persona's close-out, not coding and not done.
    expect(h.card()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
    // The worker's session going idle changes nothing.
    updateSessionStatus(h.w.store.db, h.w.sessionId, "idle");
    h.tap.broadcast({ type: "session:status", payload: { sessionId: h.w.sessionId, status: "idle" }, timestamp: new Date().toISOString() } as WsMessage);
    await h.adapter.flush();
    expect(h.card()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
    // Cleaning the worker's launch leaves it there.
    updateLaunchStatus(h.w.store.db, h.w.launch.id, "cleaned");
    h.tap.broadcast({ type: "launch:cleaned", payload: { launchId: h.w.launch.id }, timestamp: new Date().toISOString() } as WsMessage);
    await h.adapter.flush();
    expect(h.card()).toMatchObject({ status: "in_review", waitingOn: "Persona to close out" });
    expect(h.card()!.closedAt).toBeUndefined();
    // The finished run's stage is no longer held.
    expect(h.adapter.held().runs).toBe(0);
    const diffsBefore = h.diffs.length;
    h.tap.broadcast({ type: "pipeline:updated", payload: getPipelineRun(h.w.store.db, h.w.run.id), timestamp: new Date().toISOString() });
    await h.adapter.flush();
    expect(h.diffs.length).toBe(diffsBefore);

    // Only closing the job closes the card, and drops the job's held diff files.
    expect(h.adapter.held().jobs).toBe(1);
    const job = updatePersonaJob(h.w.store.db, h.jobId, { status: "done" })!;
    h.tap.broadcast({ type: "persona:job", payload: job, timestamp: new Date().toISOString(), audience: job.owner });
    await h.adapter.flush();
    expect(h.card()!.status).toBe("done");
    expect(h.card()!.closedAt).toBeTruthy();
    expect(h.adapter.held().jobs).toBe(0);
    expect(h.card()!.areas.files).toEqual(expect.arrayContaining(["packages/web/src/Board.tsx"]));

    // Every board frame went to the job's owner, with proof required, and carried the card.
    for (const frame of h.published) {
      expect(frame).toMatchObject({ type: "board:task", audience: "alice", requireProof: true });
      expect((frame.payload as BoardTaskFrame).task?.id).toBe(`job:${h.jobId}`);
    }
  });

  test("a pipeline block the engine raises is Persona deciding in its stage column, never waiting", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    await step(h, "start");
    const atReview = updatePipelineRun(h.w.store.db, h.w.run.id, { currentStage: "code_review" })!;
    h.tap.broadcast({ type: "pipeline:updated", payload: atReview, timestamp: new Date().toISOString() });
    await h.replay();
    // The run at code_review with no packet is the worker opening the code review.
    expect(h.card()).toMatchObject({ status: "validation", stage: "code_review", waitingOn: "code review in progress" });
    expect(markRunWaiting(h.w.store.db, atReview, REVIEW_LANDED_REASON, "owner_input", h.w.deps)).not.toBeNull();
    await h.replay();
    expect(h.card()).toMatchObject({ status: "validation", stage: "code_review", waitingOn: `Persona deciding: ${REVIEW_LANDED_REASON}` });
  });

  test("a worker's hand-off after submitting its packet keeps the card in review", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    for (const [stage, evidence] of [
      ["start", undefined],
      ["coding", EVIDENCE.coding],
      ["validation", EVIDENCE.validationPass],
      ["review", EVIDENCE.reviewClean],
      ["live_check", LIVE_CHECK],
    ] as const) {
      await step(h, stage, evidence);
    }
    expect((await submitPacketAsWorker(h.w)).status).toBe(200);
    expect(pipelineStopDecision(h.w.store.db, h.w.sessionId, h.w.deps)).toBeNull();
    await h.replay();
    expect(h.card()).toMatchObject({ status: "in_review", stage: "human_review", waitingOn: "owner review of the packet" });

    // The worker's turn ends on a report handing the review to the owner: the event router's
    // hand-off check flags the job waiting on them (flagPersonaJobWaitingUser, as flagHandoff
    // does) and publishes it; the job's only action is the packet's review.
    const report = createCheckpoint(h.w.store.db, h.w.sessionId, "self-reported", "Done: the change is on standup/thing and tests are green; ready for your review.");
    const flagged = flagPersonaJobWaitingUser(h.w.store.db, h.jobId, report.id, 'Waiting on the owner — the worker handed off: "ready for your review."');
    expect(flagged).not.toBeNull();
    h.tap.broadcast({ type: "persona:job", payload: flagged, timestamp: new Date().toISOString(), audience: OWNER });
    const job = getPersonaJob(h.w.store.db, h.jobId)!;
    expect(job.status).toBe("waiting_user");
    expect(job.view).toMatchObject({ state: "needs_you", needs: ["waiting"] });
    expect(job.view!.actions!.map((a) => a.kind)).toEqual(["review"]);
    await h.adapter.flush();
    expect(h.card()).toMatchObject({ status: "in_review", stage: "human_review", waitingOn: "owner review of the packet" });
  });

  test("a review tunnel's link appears once it opens and goes once it closes", async () => {
    const worktree = testTempDir("standup-board-rt-");
    mkdirSync(join(worktree, "ui"));
    const h = boardWorld({ worktree, projectOverride: { reviewTunnel: { serve: "node vite --port {port}", dir: "ui" } } });
    h.adapter.reconcile();
    const sys = new FakeTunnelSystem();
    const frames: WsMessage[] = [];
    const tunnels = createReviewTunnels(h.w.store.db, sys, (m) => {
      if (m.type === "review_tunnel:updated") frames.push(m);
      h.tap.broadcast(m);
    });
    const opened = await tunnels.open(getPipelineRun(h.w.store.db, h.w.run.id)!);
    expect("opened" in opened).toBe(true);
    const tunnel = (opened as { opened: ReviewTunnel }).opened;
    // Every record change went out to the tunnel's owner, with proof and so unsequenced.
    expect(frames.map((f) => (f.payload as ReviewTunnelUpdatedPayload).status)).toEqual(["opening", "open"]);
    for (const f of frames) expect(f).toMatchObject({ audience: OWNER, requireProof: true, payload: { launchId: h.w.launch.id } });
    await h.adapter.flush();
    expect(h.card()!.links.tunnelUrl).toBe(tunnel.url);

    expect(tunnels.close(tunnel.id, "manual")).toBe(true);
    expect((frames.at(-1)!.payload as ReviewTunnelUpdatedPayload).status).toBe("closed");
    await h.adapter.flush();
    expect(h.card()!.links.tunnelUrl).toBeUndefined();
  });

  test("a tunnel still opening is not linked", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    const claimed = claimReviewTunnel(h.w.store.db, {
      launchId: h.w.launch.id,
      runId: h.w.run.id,
      jobId: h.jobId,
      owner: OWNER,
      name: "alice-thing",
      url: "https://alice-thing.tunnels.example.test",
      port: 5201,
    });
    if (!("tunnel" in claimed)) throw new Error("the tunnel could not be claimed");
    expect(claimed.tunnel.status).toBe("opening");
    h.tap.broadcast(reviewTunnelFrame(claimed.tunnel)!);
    await h.adapter.flush();
    expect(h.card()!.links.tunnelUrl).toBeUndefined();
  });

  test("a backlog card linking the job follows it through its stages and hides the job's own card", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    const backlog = h.board.upsert({
      source: "backlog",
      sourceId: "item-1",
      owner: OWNER,
      title: "Backlog: ship the thing",
      goal: "the backlog item's own goal",
      status: "queued",
      links: { backlogItemId: "item-1", jobId: h.jobId },
      areas: { files: [], packages: [] },
    });
    // Upserted, it takes the job card's column at once and the job card is published as removed.
    expect(backlog).toMatchObject({ status: "queued", stage: "start", title: "Backlog: ship the thing" });
    expect(h.published.at(-1)).toMatchObject({ payload: { removed: { id: `job:${h.jobId}` } } });
    const backlogCard = () => getBoardTaskBySource(h.w.store.db, "backlog", "item-1")!;
    for (const [stage, evidence, column] of [
      ["start", undefined, "coding"],
      ["coding", EVIDENCE.coding, "validation"],
    ] as const) {
      const frames = await step(h, stage, evidence);
      expect(h.card()!.status).toBe(column);
      expect(backlogCard()).toMatchObject({
        status: column,
        stage: h.card()!.stage,
        title: "Backlog: ship the thing",
        goal: "the backlog item's own goal",
        links: { backlogItemId: "item-1", jobId: h.jobId, runId: h.w.run.id },
      });
      expect(backlogCard().waitingOn).toBe(h.card()!.waitingOn);
      // The job card's change goes out as its removal; the backlog card's as the card.
      expect(frames.map((f) => (f.payload as BoardTaskFrame).removed?.id ?? (f.payload as BoardTaskFrame).task?.id)).toEqual([
        `job:${h.jobId}`,
        "backlog:item-1",
      ]);
    }
    // Board reads show the backlog card in the job's place.
    const listed = h.board.list({ owner: OWNER }).tasks.map((t) => t.id);
    expect(listed).toContain("backlog:item-1");
    expect(listed).not.toContain(`job:${h.jobId}`);
    // Reconcile refreshes a backlog card that drifted from its job.
    upsertBoardTask(h.w.store.db, { ...backlogCard(), status: "queued" });
    h.adapter.reconcile();
    expect(backlogCard().status).toBe("validation");
    // Removing the backlog card shows the job's own card again.
    expect(h.board.remove("backlog", "item-1")).toBe(true);
    expect(h.published.at(-1)).toMatchObject({ payload: { task: { id: `job:${h.jobId}`, status: "validation" } } });
    expect(h.board.list({ owner: OWNER }).tasks.map((t) => t.id)).toContain(`job:${h.jobId}`);
  });

  test("a team-wide backlog card linking the job never takes its private links nor hides its card", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    expect(h.card()!.links.sessionIds?.length).toBeGreaterThan(0);
    const before = h.published.length;
    const backlog = h.board.upsert({
      source: "backlog",
      sourceId: "team-item",
      owner: "",
      title: "Team backlog: ship the thing",
      status: "queued",
      links: { backlogItemId: "team-item", jobId: h.jobId },
      areas: { files: [], packages: [] },
    });
    // Stored as given: none of the job's links, and the job card is not published as removed.
    expect(backlog.links).toEqual({ backlogItemId: "team-item", jobId: h.jobId });
    expect(h.published.slice(before).map((f) => (f.payload as BoardTaskFrame).removed?.id)).not.toContain(`job:${h.jobId}`);
    const frames = await step(h, "start");
    expect(h.card()!.status).toBe("coding");
    const teamCard = getBoardTaskBySource(h.w.store.db, "backlog", "team-item")!;
    expect(teamCard).toMatchObject({ status: "queued", links: { backlogItemId: "team-item", jobId: h.jobId } });
    for (const key of ["sessionIds", "launchIds", "packetId", "tunnelUrl", "codeReview", "runId"] as const) expect(teamCard.links[key]).toBeUndefined();
    // The job's card goes out as itself and stays on its owner's board.
    expect(frames.map((f) => (f.payload as BoardTaskFrame).task?.id)).toContain(`job:${h.jobId}`);
    const listed = h.board.list({ owner: OWNER }).tasks.map((t) => t.id);
    expect(listed).toEqual(expect.arrayContaining([`job:${h.jobId}`, "backlog:team-item"]));
    // Removing the team-wide card reveals nothing: the job card was never hidden.
    const removedAt = h.published.length;
    expect(h.board.remove("backlog", "team-item")).toBe(true);
    expect(h.published.slice(removedAt).map((f) => (f.payload as BoardTaskFrame).task?.id)).not.toContain(`job:${h.jobId}`);
  });

  test("a backlog card that mirrored its owner's job, re-scoped team-wide, keeps none of the job's private links", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    h.board.upsert({
      source: "backlog",
      sourceId: "item-2",
      owner: OWNER,
      title: "Backlog: ship the thing",
      status: "queued",
      links: { backlogItemId: "item-2", jobId: h.jobId },
      areas: { files: [], packages: [] },
    });
    await step(h, "start");
    const mirrored = getBoardTaskBySource(h.w.store.db, "backlog", "item-2")!;
    expect(mirrored.links.sessionIds?.length).toBeGreaterThan(0);
    expect(mirrored.links.runId).toBe(h.w.run.id);
    // Re-upserted team-wide with the links it mirrored.
    const before = h.published.length;
    const { id: _id, createdAt: _c, updatedAt: _u, ...input } = mirrored;
    const rescoped = h.board.upsert({ ...input, owner: "" });
    const want = { backlogItemId: "item-2", jobId: h.jobId };
    expect(rescoped.links).toEqual(want);
    expect(getBoardTaskBySource(h.w.store.db, "backlog", "item-2")!.links).toEqual(want);
    const frame = h.published.slice(before).find((f) => (f.payload as BoardTaskFrame).task?.id === "backlog:item-2");
    expect(frame).toBeDefined();
    expect(frame!.audience).toBeUndefined();
    expect((frame!.payload as BoardTaskFrame).task!.links).toEqual(want);
  });

  test("reconcile refines cards backfilled long ago, oldest first and a bounded batch per boot", () => {
    const h = boardWorld({}, { unrefinedLimit: 1 });
    const db = h.w.store.db;
    const thread = getOrCreatePersonaConsoleThread(db, OWNER);
    const older = createPersonaJob(db, { owner: OWNER, threadId: thread.id, title: "Old job", goal: "g" });
    for (const id of [older.id, h.jobId]) {
      updatePersonaJob(db, id, { status: "done" });
      db.run("UPDATE persona_jobs SET updated_at = '2025-01-01T00:00:00.000Z' WHERE id = ?", [id]);
    }
    // Backfilled cards: the stored status alone, no launchIds; the older job's card first.
    upsertBoardTask(db, { source: "job", sourceId: older.id, owner: OWNER, title: "Old job", status: "done", links: { jobId: older.id }, areas: { files: [], packages: [] } }, "2025-01-01T00:00:00.000Z");
    upsertBoardTask(db, { source: "job", sourceId: h.jobId, owner: OWNER, title: "Job", status: "done", links: { jobId: h.jobId }, areas: { files: [], packages: [] } }, "2025-01-02T00:00:00.000Z");
    expect(boardUnrefinedJobIds(db)).toEqual([older.id, h.jobId]);
    h.adapter.reconcile();
    // The older card is refined (its links now carry launchIds, even empty); the other waits.
    expect(getBoardTaskBySource(db, "job", older.id)!.links.launchIds).toEqual([]);
    expect(getBoardTaskBySource(db, "job", h.jobId)!.links.launchIds).toBeUndefined();
    h.adapter.reconcile();
    expect(getBoardTaskBySource(db, "job", h.jobId)!.links.launchIds).toEqual([h.w.launch.id]);
    expect(boardUnrefinedJobIds(db)).toEqual([]);
  });

  test("a burst of frames for one job reprojects it once; board frames are ignored", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    await advance(h.w, "start");
    // The same frames three times over are one projection, one change.
    const frames = h.w.broadcasts.slice();
    // A board frame back through the tap (recorded again by the tap's base) is not a change to project.
    h.tap.broadcast(h.published[0]!);
    const before = h.published.length;
    for (let i = 0; i < 3; i++) for (const f of frames) h.tap.broadcast(f);
    await h.adapter.flush();
    expect(h.published.length - before).toBe(1);
    expect(h.card()!.status).toBe("coding");
  });

  test("a failed diff is ignored and the card still moves", async () => {
    const w = makeWorld({ persona: true, reviewArtifact: null });
    const published: WsMessage[] = [];
    const tap = createBroadcastTap((m) => {
      if (m.type === "board:task") published.push(m);
    });
    const adapter = attachBoardAdapter({
      tap,
      board: createBoard({ db: w.store.db, publish: tap.broadcast }),
      db: w.store.db,
      changedFiles: async () => {
        throw new Error("not a git checkout");
      },
      delayMs: 60_000,
    });
    await advance(w, "start");
    for (const f of w.broadcasts) tap.broadcast(f);
    await adapter.flush();
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    expect(getBoardTaskBySource(w.store.db, "job", jobId)?.status).toBe("coding");
    expect(published).toHaveLength(1);
  });

  test("ticket frames keep a team-wide card for the ticket, sent to everyone", async () => {
    const h = boardWorld();
    const ticket = createTicket(h.w.store.db, { projectId: "proj", lens: "bugs", title: "Flaky retry", body: "retries twice" });
    h.tap.broadcast({ type: "ticket:new", payload: ticket, timestamp: new Date().toISOString() });
    await h.adapter.flush();
    expect(getBoardTaskBySource(h.w.store.db, "ticket", ticket.id)).toMatchObject({
      owner: "",
      status: "queued",
      waitingOn: "owner approval",
      goal: "retries twice",
    });
    const moved = updateTicketStatus(h.w.store.db, ticket.id, "approved")!;
    h.tap.broadcast({ type: "ticket:updated", payload: moved, timestamp: new Date().toISOString() });
    await h.adapter.flush();
    expect(getBoardTaskBySource(h.w.store.db, "ticket", ticket.id)?.waitingOn).toBeUndefined();
    expect(h.published).toHaveLength(2);
    for (const frame of h.published) expect(frame.audience).toBeUndefined();
  });

  test("an approval card for the job moves its card to waiting on the owner, and deciding it moves it back", async () => {
    const h = boardWorld();
    h.adapter.reconcile();
    await step(h, "start");
    expect(h.card()!.status).toBe("coding");
    const card = createPersonaApproval(h.w.store.db, { owner: "alice", jobId: h.jobId, action: "x", summary: "s", args: {} });
    h.tap.broadcast({ type: "persona:approval", payload: card, timestamp: new Date().toISOString() });
    expect(await h.replay()).toHaveLength(1);
    expect(h.card()).toMatchObject({ status: "waiting", waitingOn: "owner approval" });
    const decided = transitionPersonaApproval(h.w.store.db, card.id, "pending", "approved", { decidedBy: "alice" })!;
    h.tap.broadcast({ type: "persona:approval", payload: decided, timestamp: new Date().toISOString() });
    expect(await h.replay()).toHaveLength(1);
    expect(h.card()!.status).toBe("coding");
    expect(h.card()!.waitingOn).toBeUndefined();
  });

  test("a card stores at most MAX_BOARD_TASK_FILES files, its packages from all of them", async () => {
    const w = makeWorld({ persona: true, reviewArtifact: null });
    const tap = createBroadcastTap(() => {});
    const many = Array.from({ length: 300 }, (_, i) => `packages/p${i % 3}/src/f${String(i).padStart(3, "0")}.ts`);
    const adapter = attachBoardAdapter({
      tap,
      board: createBoard({ db: w.store.db, publish: tap.broadcast }),
      db: w.store.db,
      changedFiles: async () => many,
      delayMs: 60_000,
    });
    await advance(w, "start");
    await advance(w, "coding", EVIDENCE.coding);
    for (const f of w.broadcasts) tap.broadcast(f);
    await adapter.flush();
    const jobId = personaJobForLaunch(w.store.db, w.launch.id)!.job.id;
    const stored = getBoardTaskBySource(w.store.db, "job", jobId)!;
    expect(stored.areas.files.length).toBe(MAX_BOARD_TASK_FILES);
    expect(stored.areas.packages).toEqual(expect.arrayContaining(["packages/p0", "packages/p1", "packages/p2"]));
  });

  test("stop unsubscribes from the tap", async () => {
    const h = boardWorld();
    h.adapter.stop();
    await advance(h.w, "start");
    await h.replay();
    expect(h.published).toHaveLength(0);
    expect(h.card()).toBeNull();
  });
});
