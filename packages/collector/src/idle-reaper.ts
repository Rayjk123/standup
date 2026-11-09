import type { Database } from "bun:sqlite";
import {
  clearLaunchReaped,
  createCheckpoint,
  getActiveSessions,
  getLaunch,
  getLaunchBySession,
  getPendingAsksBySession,
  getPendingMessages,
  getPendingSteers,
  getPlanApprovalByLaunch,
  getRecentEventsBySession,
  getSession,
  launchHasPendingApproval,
  markLaunchReaped,
  personaJobForSession,
} from "@standup/store";
import type { Launch, PersonaJob, Session, WsMessage } from "@standup/shared";
import { isIdleNoticeAsk } from "./persona/events.js";
import { classifyClaudePane, lastActivityMs, type PaneDriver } from "./session-recovery.js";
import { workerTmux } from "./tmux-launch.js";
import { openSubagents } from "./turn-end-guard.js";

/*
 * Pausing idle workers to free the host.
 *
 * A launched Claude worker sitting at its prompt holds a full `claude`
 * process (and its MCP servers) for as long as its pane lives, which on a
 * busy host is what runs it out of memory. A worker that has been idle past
 * a threshold, with nothing waiting on it, is stopped and marked reaped; the
 * next message to it resumes the same launch (launch-resume.ts).
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface IdleReapThresholds {
  enabled: boolean;
  /** Idle time before a worker is paused. */
  idleMs: number;
  /** Idle time before a worker whose Persona job is closed is paused. */
  closedJobMs: number;
}

/** STANDUP_IDLE_REAP=0 disables; STANDUP_IDLE_REAP_MS (default 2h) and STANDUP_IDLE_REAP_CLOSED_MS (default 15m). */
export function idleReapThresholds(env: Record<string, string | undefined> = process.env): IdleReapThresholds {
  const ms = (name: string, fallback: number) => {
    const parsed = parseInt(env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    enabled: env.STANDUP_IDLE_REAP?.trim() !== "0",
    idleMs: ms("STANDUP_IDLE_REAP_MS", 2 * HOUR_MS),
    closedJobMs: ms("STANDUP_IDLE_REAP_CLOSED_MS", 15 * MINUTE_MS),
  };
}

export interface IdleReaperDeps {
  now?: () => number;
  /** Pane reads; the collector's tmux driver in production. */
  pane: Pick<PaneDriver, "exists" | "capture">;
  /** Whether the session is on the workers' tmux server, the only one a pause kills on; defaults to tmux. */
  onWorkerServer?: (session: string) => boolean;
  /** Whether a tmux client is attached to the launch's session (someone is watching it); defaults to tmux. */
  attached?: (launch: Launch) => boolean;
  /** Pauses the worker (stopSession with a reap reason). */
  stop: (session: Session, launch: Launch, reason: string) => Promise<void>;
  /** Resumes a paused worker for work queued on it (wakeForQueued). */
  wake?: (sessionId: string) => Promise<unknown>;
  /** Posts a system line in the job's thread. */
  post?: (job: PersonaJob, text: string) => void;
  broadcast?: (message: WsMessage) => void;
  env?: Record<string, string | undefined>;
}

export interface ReapCandidate {
  session: Session;
  launch: Launch;
  /** How long the worker has been idle. */
  idleMs: number;
  job: PersonaJob | null;
  jobClosed: boolean;
}

const CLOSED_JOB = new Set(["done", "failed", "cancelled"]);
/** Launch kinds whose worker Standup started for a task; an adopted one is the owner's own conversation. */
const REAPABLE_KINDS = new Set(["worktree", "bootstrap"]);
/** Claude Code's footer while background shells or tasks it started are still running. */
const BACKGROUND_FOOTER = /\b\d+\s+(?:background\s+(?:tasks?|shells?|bash(?:es)?)|shells?)\b/i;
const FOOTER_LINES = 4;

/**
 * Whether the session is inside a tool call: its newest PreToolUse has no
 * matching PostToolUse, and no Stop or new prompt came after it.
 */
function toolCallInFlight(db: Database, sessionId: string): boolean {
  const events = getRecentEventsBySession(db, sessionId, 60);
  const finished = new Set<string>();
  let unmatchedPosts = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const type = e.type as string;
    if (type === "UserPromptSubmit" || type === "Stop") return false;
    const id = (e.payload as { tool_use_id?: unknown }).tool_use_id;
    const toolUseId = typeof id === "string" ? id : undefined;
    if (type === "PostToolUse" || type === "PostToolUseFailure") {
      if (toolUseId) finished.add(toolUseId);
      else unmatchedPosts++;
      continue;
    }
    if (type === "PreToolUse") {
      if (toolUseId && finished.has(toolUseId)) continue;
      if (!toolUseId && unmatchedPosts > 0) {
        unmatchedPosts--;
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Whether the pane's footer shows background shells or tasks still running. */
function backgroundWorkShown(screen: string): boolean {
  const lines = screen.split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-FOOTER_LINES).some((l) => BACKGROUND_FOOTER.test(l));
}

/** Steers or mailbox messages queued for the session. */
function queuedWork(db: Database, sessionId: string): boolean {
  return getPendingSteers(db, sessionId).length > 0 || getPendingMessages(db, sessionId).length > 0;
}

/** Whether something still waits on the worker, so it must stay up. */
function somethingPending(db: Database, session: Session, launch: Launch, now: number): boolean {
  if (getPendingAsksBySession(db, session.id).some((a) => !isIdleNoticeAsk(a))) return true;
  const plan = getPlanApprovalByLaunch(db, launch.id);
  if (plan && (plan.status === "awaiting_plan" || plan.status === "awaiting_approval")) return true;
  if (launchHasPendingApproval(db, launch.id, session.id)) return true;
  if (queuedWork(db, session.id)) return true;
  if (toolCallInFlight(db, session.id)) return true;
  return openSubagents(db, session.id, now).length > 0;
}

function sessionOnWorkerServer(session: string): boolean {
  return Bun.spawnSync(workerTmux("has-session", "-t", `=${session}`), { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/**
 * Whether a tmux client is attached to the launch's session on the workers'
 * server. A read that fails counts as attached, which keeps the worker up.
 */
function sessionAttached(launch: Launch): boolean {
  if (!launch.tmuxSession) return false;
  const res = Bun.spawnSync(workerTmux("display-message", "-p", "-t", `=${launch.tmuxSession}:`, "#{session_attached}"), {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return true;
  const clients = parseInt(res.stdout.toString().trim(), 10);
  return !Number.isFinite(clients) || clients > 0;
}

/**
 * The candidate `session` is, or null when it isn't one, cheapest checks
 * first and the tmux reads last (see findReapable).
 */
function reapCandidate(
  db: Database,
  session: Session,
  deps: IdleReaperDeps,
  thresholds: IdleReapThresholds,
  now: number
): ReapCandidate | null {
  if (session.endedAt || session.kind === "subagent" || session.parentSessionId) return null;
  if (session.status !== "idle" && session.status !== "done") return null;
  const launch = getLaunchBySession(db, session.id);
  if (!launch?.tmuxSession || launch.status !== "running" || launch.reapedAt) return null;
  if (launch.harness === "codex" || !REAPABLE_KINDS.has(launch.kind) || launch.keepAlive) return null;

  const owned = personaJobForSession(db, session.id);
  const job = owned?.job ?? null;
  const jobClosed = !!job && CLOSED_JOB.has(job.status);
  const last = lastActivityMs(db, session.id);
  if (last === null) return null;
  const idleMs = now - last;
  if (idleMs < (jobClosed ? thresholds.closedJobMs : thresholds.idleMs)) return null;

  if (somethingPending(db, session, launch, now)) return null;
  if (!deps.pane.exists(launch.tmuxSession)) return null;
  // A pause kills only on the workers' server; a worker on another one would
  // be marked and unmarked every tick without ever being paused.
  if (!(deps.onWorkerServer ?? sessionOnWorkerServer)(launch.tmuxSession)) return null;
  const screen = deps.pane.capture(launch.tmuxSession);
  const pane = classifyClaudePane(screen);
  // Text in the composer is a message someone is still writing.
  if (pane.kind !== "idle" || pane.composer !== "" || backgroundWorkShown(screen)) return null;
  if ((deps.attached ?? sessionAttached)(launch)) return null;
  return { session, launch, idleMs, job, jobClosed };
}

/**
 * The launched workers idle long enough to pause. A candidate is a running
 * Claude worktree/bootstrap launch not marked keep-alive, whose root session
 * is live and settled (idle or done) with nothing pending on it — no ask,
 * plan, approval card, steer, mailbox message, tool call or open subagent —
 * whose pane is on the workers' tmux server with no client attached and shows
 * the idle prompt with an empty composer and no background work, and which
 * has been silent for the threshold (the shorter one once its Persona job is
 * closed).
 */
export function findReapable(db: Database, deps: IdleReaperDeps): ReapCandidate[] {
  const thresholds = idleReapThresholds(deps.env);
  if (!thresholds.enabled) return [];
  const now = (deps.now ?? Date.now)();
  const found: ReapCandidate[] = [];
  for (const session of getActiveSessions(db)) {
    const candidate = reapCandidate(db, session, deps, thresholds, now);
    if (candidate) found.push(candidate);
  }
  return found;
}

/** Pauses in progress, per launch id: each settles once its pane is closed (or the pause failed). */
const pausesInFlight = new Map<string, Promise<void>>();

/** Resolves once a pause in progress on the launch has settled; at once when none is. */
export function pauseSettled(launchId: string): Promise<void> {
  return pausesInFlight.get(launchId) ?? Promise.resolve();
}

/** A duration as the reaper reports it: "2h", "1h 30m", "15m". */
export function formatIdle(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Pauses one worker: marks the launch reaped (first, so the stop's own frames
 * read as a pause), stops it, records a structural checkpoint on the session
 * and posts one system line in its job's thread. False, with the mark
 * cleared, when the stop fails.
 */
async function pause(db: Database, deps: IdleReaperDeps, candidate: ReapCandidate): Promise<boolean> {
  const { session, launch, job } = candidate;
  const idle = formatIdle(candidate.idleMs);
  const reason = `idle ${idle}`;
  markLaunchReaped(db, launch.id, reason);
  try {
    await deps.stop(session, launch, reason);
  } catch (err) {
    clearLaunchReaped(db, launch.id);
    console.error(`[idle-reaper] pausing ${session.id.slice(0, 8)} failed: ${(err as Error).message}`);
    return false;
  }
  try {
    const checkpoint = createCheckpoint(
      db,
      session.id,
      "structural",
      `Paused after ${idle} idle to free memory; resumes on the next message.`
    );
    deps.broadcast?.({ type: "checkpoint:new", payload: checkpoint, timestamp: new Date().toISOString() });
    if (job) deps.post?.(job, `Paused worker "${session.title || session.id.slice(0, 8)}" after ${idle} idle; it resumes on the next message.`);
  } catch (err) {
    console.error(`[idle-reaper] recording the pause of ${session.id.slice(0, 8)} failed: ${(err as Error).message}`);
  }
  return true;
}

/**
 * Pauses every worker findReapable returns, each checked again on fresh reads
 * just before its pause (the list goes stale while earlier ones are paused).
 * A stop that fails is logged and the rest go on. A resume asked for while a
 * pause runs waits for it (pauseSettled); a steer or message queued after the
 * check but before the mark has no wake of its own, so the worker is woken
 * for it once its pause settles. Returns those paused.
 */
export async function reapIdleWorkers(db: Database, deps: IdleReaperDeps): Promise<ReapCandidate[]> {
  const reaped: ReapCandidate[] = [];
  const thresholds = idleReapThresholds(deps.env);
  for (const listed of findReapable(db, deps)) {
    const fresh = getSession(db, listed.session.id);
    const candidate = fresh ? reapCandidate(db, fresh, deps, thresholds, (deps.now ?? Date.now)()) : null;
    if (!candidate) continue;
    const { session, launch } = candidate;
    // Registered before the pause starts, so a resume asked for from inside
    // the stop itself still waits for it.
    let settle!: () => void;
    pausesInFlight.set(launch.id, new Promise<void>((resolve) => (settle = resolve)));
    let paused = false;
    try {
      paused = await pause(db, deps, candidate);
    } finally {
      pausesInFlight.delete(launch.id);
      settle();
    }
    if (!paused) continue;
    reaped.push(candidate);
    if (deps.wake && queuedWork(db, session.id) && getLaunch(db, launch.id)?.reapedAt) {
      try {
        await deps.wake(session.id);
      } catch (err) {
        console.error(`[idle-reaper] resuming ${session.id.slice(0, 8)} for queued work failed: ${(err as Error).message}`);
      }
    }
  }
  return reaped;
}

/** A reaper tick that never overlaps the previous one: a tick while one runs returns no workers. */
export function createIdleReaper(db: Database, deps: IdleReaperDeps): { tick(): Promise<ReapCandidate[]> } {
  let running = false;
  return {
    async tick() {
      if (running) return [];
      running = true;
      try {
        return await reapIdleWorkers(db, deps);
      } finally {
        running = false;
      }
    },
  };
}
