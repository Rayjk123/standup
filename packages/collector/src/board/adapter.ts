import type { Database } from "bun:sqlite";
import type { Launch, PipelineRun, ReviewTunnelUpdatedPayload, ReviewUpdatedPayload, Ticket, WsMessage } from "@standup/shared";
import { isOpenBoardStatus } from "@standup/shared";
import {
  MAX_UNREFINED_BOARD_JOBS,
  boardJobIdsToReconcile,
  boardTicketIdsToReconcile,
  boardUnrefinedJobIds,
  listBoardTasksByJob,
  getAsk,
  getBoardTaskBySource,
  getLaunch,
  getPipelineRun,
  getReviewPacket,
  getTicket,
  personaJobForLaunch,
  personaJobForSession,
} from "@standup/store";
import type { BroadcastTap } from "../persona/events.js";
import type { Board } from "./board.js";
import { MAX_BOARD_TASK_FILES, currentStageKind, projectJobTask, projectTicketTask } from "./projection.js";

/** How long a burst of frames for one task is gathered before it is reprojected once. */
const DEFAULT_DELAY_MS = 25;
/** How far back reconcile reaches for closed jobs. */
const RECONCILE_CLOSED_MS = 24 * 60 * 60 * 1000;

export interface BoardAdapterOptions {
  tap: Pick<BroadcastTap, "subscribe">;
  board: Board;
  db: Database;
  /** A launch worktree's changed files against its base branch (runners.ts gitChangedFiles). */
  changedFiles?: (worktreePath: string, baseBranch: string | undefined) => Promise<string[]>;
  /** The coalescing delay; 0 reprojects on the next microtask. */
  delayMs?: number;
  /** How many never-projected job cards one reconcile refines (default MAX_UNREFINED_BOARD_JOBS). */
  unrefinedLimit?: number;
}

export interface BoardAdapter {
  /**
   * Reprojects every open job and ticket, the jobs closed in the last day,
   * the jobs backlog cards link (and so those cards), and a bounded batch of
   * job cards never projected (backfilled ones), oldest first.
   */
  reconcile(): void;
  /** Settles every git diff in flight, then reprojects whatever is pending, now. */
  flush(): Promise<void>;
  /** Unsubscribes from the tap and drops anything pending. */
  stop(): void;
  /** How many runs' stages and jobs' diff files the adapter holds in memory. */
  held(): { runs: number; jobs: number };
}

type Key = { kind: "job"; id: string } | { kind: "ticket"; id: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The one place events feed the board. It subscribes once to the broadcast
 * tap every producer goes through, maps each frame to the Persona job (or
 * ticket) it changes, and reprojects that task from the store — a burst of
 * frames for one task reprojects it once. A launch's git diff is read only
 * when its pipeline run moves to another stage, never per frame, and joins
 * the job's areas; a failed diff is ignored. Its own `board:task` frames are
 * ignored.
 */
export function attachBoardAdapter(opts: BoardAdapterOptions): BoardAdapter {
  const { board, db } = opts;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const unrefinedLimit = opts.unrefinedLimit ?? MAX_UNREFINED_BOARD_JOBS;
  const pending = new Map<string, Key>();
  /** Each run's stage when last seen, so only a stage move reads a diff. */
  const lastStage = new Map<string, string>();
  /** Files the launches' git diffs named, per job. */
  const gitFiles = new Map<string, Set<string>>();
  const diffs = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let microtask = false;
  let stopped = false;

  const project = (key: Key): void => {
    if (key.kind === "ticket") {
      const ticket = getTicket(db, key.id);
      if (ticket) board.upsert(projectTicketTask(ticket));
      else board.remove("ticket", key.id);
      return;
    }
    let files = gitFiles.get(key.id);
    if (!files) {
      // What earlier diffs found survives a restart through the stored card.
      files = new Set(getBoardTaskBySource(db, "job", key.id)?.areas.files ?? []);
      gitFiles.set(key.id, files);
    }
    const input = projectJobTask(db, key.id, { extraFiles: files });
    if (input) {
      board.upsert(input);
      // Each backlog card working the job follows it (the board mirrors the job card onto it).
      for (const backlog of listBoardTasksByJob(db, key.id)) board.upsert(backlog);
    } else board.remove("job", key.id);
    // A closed or gone job reads no more diffs; its stored card keeps the files.
    if (!input || !isOpenBoardStatus(input.status)) gitFiles.delete(key.id);
  };

  const drain = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    microtask = false;
    const keys = [...pending.values()];
    pending.clear();
    for (const key of keys) {
      try {
        project(key);
      } catch (err) {
        console.error(`[board] projecting ${key.kind} ${key.id} failed:`, err);
      }
    }
  };

  const schedule = (key: Key): void => {
    if (stopped) return;
    pending.set(`${key.kind}:${key.id}`, key);
    if (delayMs <= 0) {
      if (!microtask) {
        microtask = true;
        queueMicrotask(() => {
          if (microtask) drain();
        });
      }
      return;
    }
    if (!timer) timer = setTimeout(drain, delayMs);
  };

  const scheduleJob = (jobId: string | undefined): void => {
    if (jobId) schedule({ kind: "job", id: jobId });
  };
  const jobOfLaunch = (launchId: string | undefined): string | undefined =>
    launchId ? personaJobForLaunch(db, launchId)?.job.id : undefined;
  const jobOfSession = (sessionId: string | undefined): string | undefined =>
    sessionId ? personaJobForSession(db, sessionId)?.job.id : undefined;

  /** Reads the launch's diff into the job's areas, then reprojects the job. */
  const readDiff = (jobId: string, launchId: string): void => {
    const changedFiles = opts.changedFiles;
    if (!changedFiles) return;
    const launch = getLaunch(db, launchId);
    if (!launch?.worktreePath) return;
    const run = (async () => {
      try {
        const files = await changedFiles(launch.worktreePath, launch.baseBranch);
        const known = gitFiles.get(jobId) ?? new Set(getBoardTaskBySource(db, "job", jobId)?.areas.files ?? []);
        for (const f of files) {
          if (known.size >= MAX_BOARD_TASK_FILES) break;
          known.add(f);
        }
        gitFiles.set(jobId, known);
        scheduleJob(jobId);
      } catch {
        // No diff to add (the worktree is gone, or has no base): the card keeps what it has.
      }
    })();
    diffs.add(run);
    void run.finally(() => diffs.delete(run));
  };

  const onRun = (run: PipelineRun | null | undefined): void => {
    if (!run?.id || !run.launchId) return;
    const jobId = jobOfLaunch(run.launchId);
    const before = lastStage.get(run.id);
    const finished = run.status === "complete" || run.status === "disabled";
    // A finished run moves no further, so its stage is forgotten.
    if (finished) lastStage.delete(run.id);
    else lastStage.set(run.id, run.currentStage);
    if (!jobId) return;
    scheduleJob(jobId);
    // A run first seen past its start (after a restart) counts as having moved, once — unless it has finished.
    const moved = before !== undefined ? before !== run.currentStage : !finished && currentStageKind(run) !== "start";
    if (moved) readDiff(jobId, run.launchId);
  };

  const onFrame = (message: WsMessage): void => {
    if (message.type === "board:task") return;
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    switch (message.type) {
      case "persona:job":
        scheduleJob(str(payload.id));
        return;
      case "persona:approval":
        // A card raised, decided or expired for a job moves it into or out of waiting on its owner.
        scheduleJob(str(payload.jobId));
        return;
      case "pipeline:updated":
        onRun(payload as unknown as PipelineRun);
        return;
      case "pipeline:blocked":
      case "pipeline:parked": {
        scheduleJob(str(payload.jobId));
        const runId = str(payload.runId);
        if (runId) onRun(getPipelineRun(db, runId));
        return;
      }
      case "review:updated": {
        const { packetId, owner } = payload as unknown as ReviewUpdatedPayload;
        if (!packetId || !owner) return;
        const packet = getReviewPacket(db, packetId, owner);
        scheduleJob(packet?.jobId ?? jobOfLaunch(packet?.launchId ?? undefined));
        return;
      }
      case "plan:updated":
        scheduleJob(jobOfLaunch(str(payload.launchId)));
        return;
      case "launch:started":
        scheduleJob(jobOfLaunch(str((payload as unknown as Launch).id)));
        return;
      case "launch:stopped":
      case "launch:cleaned":
        scheduleJob(jobOfLaunch(str(payload.launchId)));
        return;
      case "ask:new":
      case "session:status":
      case "session:end":
        scheduleJob(jobOfSession(str(payload.sessionId)));
        return;
      case "ask:resolved": {
        const askId = str(payload.askId);
        scheduleJob(jobOfSession(askId ? getAsk(db, askId)?.sessionId : undefined));
        return;
      }
      case "review_tunnel:updated": {
        const { jobId, launchId } = payload as Partial<ReviewTunnelUpdatedPayload>;
        scheduleJob(str(jobId) ?? jobOfLaunch(str(launchId)));
        return;
      }
      case "ticket:new":
      case "ticket:updated": {
        const id = str((payload as unknown as Ticket).id);
        if (id) schedule({ kind: "ticket", id });
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = opts.tap.subscribe((message) => {
    try {
      onFrame(message);
    } catch (err) {
      console.error(`[board] handling ${message.type} failed:`, err);
    }
  });

  return {
    reconcile() {
      const since = new Date(Date.now() - RECONCILE_CLOSED_MS).toISOString();
      for (const id of boardJobIdsToReconcile(db, since)) pending.set(`job:${id}`, { kind: "job", id });
      // Cards backfilled from a job's stored status alone are refined once, a bounded batch per boot.
      for (const id of boardUnrefinedJobIds(db, unrefinedLimit)) pending.set(`job:${id}`, { kind: "job", id });
      for (const id of boardTicketIdsToReconcile(db)) pending.set(`ticket:${id}`, { kind: "ticket", id });
      drain();
    },
    async flush() {
      while (diffs.size > 0) await Promise.all([...diffs]);
      drain();
    },
    stop() {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
    held() {
      return { runs: lastStage.size, jobs: gitFiles.size };
    },
  };
}
