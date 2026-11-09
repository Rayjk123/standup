import type { Database } from "bun:sqlite";
import {
  getActiveSessions,
  getLaunchBySession,
  getCodexLaunches,
  getLaunch,
  updateLaunchStatus,
  endSession,
  cancelAllPendingAsks,
  getActiveTaskRunByWorktree,
  updateTaskRunStatus,
  getPendingAsksBySession,
  createCheckpoint,
  endStaleSession,
  launchHookAuthRetired,
} from "@standup/store";
import type { Ask, Checkpoint, Launch, Session, WsMessage } from "@standup/shared";
import { drainLaunchQueue, stepTimeoutMs, tmuxSessionExists } from "./launcher.js";
import { sessionTmux } from "./tmux-launch.js";
import { workerEnv } from "./worker-env.js";
import { launchQueue } from "./host-headroom.js";
import { isIdleNoticeAsk } from "./persona/events.js";
import { lastActivityMs } from "./session-recovery.js";
import { openDescendants } from "./session-close.js";
import { workerCopies } from "./worker-copies.js";

export interface ReapedSession {
  sessionId: string;
  cancelledAsks: Ask[];
  /** Ended as stale rather than plainly (a copy may still run it). */
  stale?: boolean;
}

/**
 * Reaps launched sessions whose tmux pane has gone away.
 *
 * SessionEnd only fires when Claude Code exits and actually delivers the hook.
 * A pane killed out-of-band (tmux kill-session, closing the terminal, a hard
 * kill) delivers nothing, so the session row keeps `ended_at IS NULL` and any
 * pending ask it raised sits in "Needs you" forever — the process that would
 * answer it is gone. Nothing else notices, because blocking is otherwise only
 * observed as hooks arrive and a dead session sends no more hooks.
 *
 * Only launched sessions are checked: Standup owns their tmux pane, so its
 * absence is authoritative. A monitored session belongs to the human's own
 * terminal — it may not be in tmux at all, and reaching into it is exactly
 * what the design declines to do.
 *
 * A session resumed by hand outside its launch (resumedOutsideLaunch) is
 * skipped too: its launch's pane says nothing about it, and ending it here
 * would mark it ended for a resume while it runs. endStaleMonitoredSessions
 * treats it as monitored.
 */
export function reapDeadSessions(
  db: Database,
  // Injectable for tests; production uses the real tmux liveness probe.
  sessionExists: (name: string) => boolean = tmuxSessionExists,
  // Whether a copy of the session runs outside its launch (worker-copies.ts).
  handCopySeen: (sessionId: string) => boolean = (id) => workerCopies.handCopySeen(id)
): ReapedSession[] {
  const reaped: ReapedSession[] = [];

  for (const session of getActiveSessions(db)) {
    const launch = getLaunchBySession(db, session.id);
    // No launch, or a launch that never got a pane (failed before start) /
    // was already cleaned — nothing to check liveness against.
    if (!launch?.tmuxSession) continue;
    if (resumedOutsideLaunch(db, session, launch)) continue;
    if (sessionExists(launch.tmuxSession)) continue;

    // The pane is gone but a copy resumed by hand sent tokenless hooks no
    // worker paired: end it as stale, so Resume refuses it while that copy
    // runs, and its next recorded hook revives it as resumed outside.
    const stale = handCopySeen(session.id);
    if (stale) endStaleSession(db, session.id);
    else endSession(db, session.id);
    workerCopies.forget(session.id);
    const cancelledAsks = cancelAllPendingAsks(db, session.id);
    reaped.push({ sessionId: session.id, cancelledAsks, ...(stale ? { stale: true } : {}) });
  }

  return reaped;
}

/**
 * Whether a launched session now runs outside its launch: hooks revived it
 * while the launch could not have sent them (Session.revivedOutsideLaunch),
 * or its latest events came without the launch's hook token (a retired
 * proof).
 */
export function resumedOutsideLaunch(db: Database, session: Session, launch: Launch): boolean {
  return !!session.revivedOutsideLaunch || launchHookAuthRetired(db, launch.id);
}

/**
 * Fails Codex launches whose tmux pane has died before they ever produced an
 * observable session — the reaper's counterpart for a harness that posts no
 * hooks.
 *
 * A Codex run's session row is created by CodexObserver from the run's JSONL event
 * stream (its `thread.started`), not by a SessionStart hook. If the pane dies
 * before that event — or before any observer sees it — no session ever forms, so
 * reapDeadSessions (which walks getActiveSessions) never touches it and the launch
 * reads `running` forever, keeping the run in the active fleet view. This backstop
 * marks such a sessionless, pane-dead Codex launch `failed`. A launch that DID
 * attach a session is left to reapDeadSessions above, exactly as a Claude launch.
 */
export function reapDeadCodexLaunches(
  db: Database,
  // Injectable for tests; production uses the real tmux liveness probe.
  sessionExists: (name: string) => boolean = tmuxSessionExists
): Launch[] {
  const failed: Launch[] = [];

  for (const launch of getCodexLaunches(db, { activeOnly: true })) {
    // A launch that already attached a session is owned by reapDeadSessions.
    if (launch.sessionId) continue;
    // Only a launch that reached `running` has actually spawned its pane. A
    // `starting` launch is still provisioning: its tmux session name is reserved
    // at row-creation but the pane doesn't exist yet, so a probe reports it
    // absent — that is "not launched yet", not "died". Failing it here would abort
    // a launch mid-provision, so leave `starting` rows to finish starting.
    if (launch.status !== "running") continue;
    // No pane recorded — nothing to probe.
    if (!launch.tmuxSession) continue;
    if (sessionExists(launch.tmuxSession)) continue;

    updateLaunchStatus(db, launch.id, "failed", "codex exec exited before starting a session");
    const updated = getLaunch(db, launch.id);
    if (updated) failed.push(updated);
  }

  return failed;
}

const HOUR_MS = 60 * 60 * 1000;

export interface MonitoredStaleThresholds {
  enabled: boolean;
  /** Silence after which a monitored session is ended. */
  staleMs: number;
  /** Silence after which a monitored session a human owes an answer is ended. */
  waitingMs: number;
}

/**
 * Neither threshold goes below this: a session idle at its prompt between
 * turns would otherwise be ended, revived and ended again every tick.
 */
export const MIN_MONITORED_STALE_MS = 10 * 60 * 1000;

/**
 * STANDUP_MONITORED_REAP=0 disables; STANDUP_MONITORED_STALE_MS (default 6h)
 * and STANDUP_MONITORED_WAITING_STALE_MS (default 24h), each a whole number of
 * milliseconds and at least MIN_MONITORED_STALE_MS. The waiting threshold is
 * never shorter than the plain one.
 */
export function monitoredStaleThresholds(env: Record<string, string | undefined> = process.env): MonitoredStaleThresholds {
  const ms = (raw: string | undefined, fallback: number) =>
    /^\d+$/.test(raw?.trim() ?? "") ? Math.max(MIN_MONITORED_STALE_MS, Number(raw!.trim())) : fallback;
  const staleMs = ms(env.STANDUP_MONITORED_STALE_MS, 6 * HOUR_MS);
  return {
    enabled: env.STANDUP_MONITORED_REAP?.trim() !== "0",
    staleMs,
    waitingMs: Math.max(staleMs, ms(env.STANDUP_MONITORED_WAITING_STALE_MS, 24 * HOUR_MS)),
  };
}

/** The most monitored sessions one sweep ends (newest-started first); the rest wait for the next tick. */
export const MAX_STALE_ENDS_PER_SWEEP = 20;

export interface StaleEndedSession extends ReapedSession {
  /** The structural checkpoint recording the end on the session's feed. */
  checkpoint: Checkpoint;
  /** How long the session had been silent when it was ended. */
  silentMs: number;
  /** When it last showed activity (latest event or transcript write), else its start. */
  lastActivityAt: Date;
  /** Open subagent sessions under it, ended with it. */
  endedChildren: string[];
}

/**
 * Ends monitored sessions that went silent without a SessionEnd hook.
 *
 * A monitored session (the owner's own terminal, an import) has no
 * Standup-owned pane, so reapDeadSessions can't see it die, and Claude Code
 * hook payloads carry no PID. Silence is the only signal: no hook event and no
 * transcript write (`lastActivityMs`) for `staleMs`, measured from the start
 * when it has neither. A session a human owes an answer may simply be
 * unanswered, so it gets `waitingMs` instead: status `waiting` (which a turn
 * the Stop classifier read as a question also sets, idle notice or not), or a
 * pending ask other than an idle notice.
 *
 * Each end is recorded as a structural checkpoint on the session's feed, not
 * an event, so the session's recency (the newest event or transcript row)
 * stays where it was. An end is a guess — the process may be alive at an idle
 * prompt — so it is marked `end_reason = 'stale'`, which adoptSession refuses
 * to resume. A wrong one mostly corrects itself: the session's next hook
 * revives the row (ensureSession) and clears the mark. Its subagent rows stay
 * ended, and the asks cancelled with it are not restored.
 *
 * Any session with a launch is skipped: launched workers have their own
 * lifecycle (reapDeadSessions, the idle reaper, the resync). The exception is
 * a session resumed by hand outside its launch (resumedOutsideLaunch), which
 * makes it a monitored session.
 */
export function endStaleMonitoredSessions(
  db: Database,
  {
    now = Date.now(),
    thresholds = monitoredStaleThresholds(),
    maxEnds = MAX_STALE_ENDS_PER_SWEEP,
  }: { now?: number; thresholds?: MonitoredStaleThresholds; maxEnds?: number } = {}
): StaleEndedSession[] {
  const ended: StaleEndedSession[] = [];
  if (!thresholds.enabled) return ended;

  for (const session of getActiveSessions(db)) {
    if (ended.length >= maxEnds) break;
    const launch = getLaunchBySession(db, session.id);
    if (launch && !resumedOutsideLaunch(db, session, launch)) continue;

    const last = lastActivityMs(db, session.id) ?? startedAtMs(db, session.id);
    if (last === null) continue;
    const silentMs = now - last;
    const limit = owesHumanAnswer(db, session) ? thresholds.waitingMs : thresholds.staleMs;
    if (silentMs < limit) continue;

    // One transaction per session, so a failed write leaves it active for the
    // next sweep rather than ended without its checkpoint, and the sessions
    // already ended this sweep are still returned for their broadcasts.
    try {
      ended.push(
        db.transaction(() => {
          const endedChildren = openDescendants(db, session.id);
          const ids = [session.id, ...endedChildren];
          for (const id of ids) endStaleSession(db, id);
          const checkpoint = createCheckpoint(
            db,
            session.id,
            "structural",
            `Ended (stale): no hook event or transcript write for ${formatSilence(silentMs)}; its next hook revives it.`
          );
          return {
            sessionId: session.id,
            cancelledAsks: ids.flatMap((id) => cancelAllPendingAsks(db, id)),
            checkpoint,
            silentMs,
            lastActivityAt: new Date(last),
            endedChildren,
          };
        })()
      );
    } catch (err) {
      console.error(`[reaper] ending stale monitored session ${session.id} failed: ${(err as Error).message}`);
    }
  }
  return ended;
}

function formatSilence(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

function owesHumanAnswer(db: Database, session: Session): boolean {
  return session.status === "waiting" || getPendingAsksBySession(db, session.id).some((ask) => !isIdleNoticeAsk(ask));
}

/** `started_at` read as UTC; Session.startedAt parses SQLite's zone-less text as local time. */
function startedAtMs(db: Database, sessionId: string): number | null {
  const row = db.query("SELECT started_at FROM sessions WHERE id = ?").get(sessionId) as { started_at: string | null } | null;
  const ms = sqliteUtcMs(row?.started_at ?? null, NaN);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The default of launcher.ts's PROVISION_TIMEOUT_MS; reaper.test.ts checks it
 * still matches launcher.ts.
 */
export const LAUNCHER_PROVISION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a launch may sit in one `starting` phase before the reaper fails it:
 * past the longest step the launcher allows (provision, STANDUP_PROVISION_TIMEOUT_MS)
 * plus a setup step (the launcher's own step cap, STANDUP_STEP_TIMEOUT_MS) and
 * five minutes of slack, the detached work behind it has hung or died.
 * STANDUP_STALE_STARTING_MS overrides the whole threshold.
 */
export function staleStartingMs(env: Record<string, string | undefined>): number {
  const provision = envMs(env.STANDUP_PROVISION_TIMEOUT_MS, LAUNCHER_PROVISION_TIMEOUT_MS);
  return envMs(env.STANDUP_STALE_STARTING_MS, provision + stepTimeoutMs(env) + 5 * 60 * 1000);
}

export const STALE_STARTING_LAUNCH_MS = staleStartingMs(process.env);

function envMs(raw: string | undefined, fallback: number): number {
  const value = parseInt(raw ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The reason recorded on a launch the previous collector process left mid-start. */
export const STRANDED_STARTING_LAUNCH_REASON =
  "The collector restarted while this launch was still starting, so the work setting it up stopped. Launch it again.";

function staleStartingReason(phase: string | null, maxAgeMs: number): string {
  const minutes = Math.round(maxAgeMs / 60_000);
  return `This launch made no progress for ${minutes} minutes while ${phase ?? "starting"}, so it was given up. Launch it again.`;
}

/** SQLite's `datetime('now')` text is UTC without a zone marker; a missing or unreadable value reads as `fallbackMs`. */
function sqliteUtcMs(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

/**
 * When each `starting` launch entered the phase it is in now. The launches
 * table records the phase but not when it changed, so the reaper notes the
 * moment it first sees each phase; a launch it has not seen before is timed
 * from its creation. The tick runs every few seconds, so a phase change is
 * seen within one interval of happening.
 */
export class StartingPhaseClock {
  private seen = new Map<string, { phase: string | null; sinceMs: number }>();

  /** When `launchId` entered `phase`, as of `nowMs`. */
  since(launchId: string, phase: string | null, createdMs: number, nowMs: number): number {
    const prior = this.seen.get(launchId);
    if (prior && prior.phase === phase) return prior.sinceMs;
    const sinceMs = prior ? nowMs : createdMs;
    this.seen.set(launchId, { phase, sinceMs });
    return sinceMs;
  }

  /**
   * Restarts `launchId`'s time at `nowMs`. Used while the queue holds a
   * launch, so time spent waiting for room never counts once it is released
   * (its row reads `queued` until its first step records a new phase).
   */
  restart(launchId: string, phase: string | null, nowMs: number): void {
    this.seen.set(launchId, { phase, sinceMs: nowMs });
  }

  /** Forgets every launch not in `liveIds` (it left `starting`). */
  retain(liveIds: Set<string>): void {
    for (const id of this.seen.keys()) if (!liveIds.has(id)) this.seen.delete(id);
  }
}

const startingPhaseClock = new StartingPhaseClock();

/**
 * Cancels the active task run in a launch's worktree, the same way the
 * launcher does when a launch is stopped. An adopted launch never opened a run
 * of its own and its path is the shared repo, so it is skipped. Cancelling the
 * run also makes a launch's detached work, should it still be going, abandon
 * the launch instead of spawning a pane.
 */
function cancelLaunchTaskRun(db: Database, launch: Launch): void {
  if (launch.kind === "adopted") return;
  const run = getActiveTaskRunByWorktree(db, launch.worktreePath);
  if (run) updateTaskRunStatus(db, run.id, "cancelled");
}

/**
 * Kills a starting launch's pane when one is up. A launch is `starting` until
 * its opening prompt is delivered, so its pane can already exist (and tmux
 * outlives a collector restart); failing the row without killing it would
 * leave an agent running that nothing supervises.
 */
export async function killStartingPane(
  session: string,
  // Injectable for tests; production probes and kills on whichever tmux server holds the session.
  deps: { exists?: (session: string) => boolean; run?: (argv: string[]) => Promise<{ ok: boolean; output: string }> } = {}
): Promise<{ ok: boolean; output: string }> {
  if (!(deps.exists ?? tmuxSessionExists)(session)) return { ok: true, output: "" };
  return (deps.run ?? runTmux)(sessionTmux(session, "kill-session", "-t", `=${session}`));
}

async function runTmux(argv: string[]): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: workerEnv() });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { ok: proc.exitCode === 0, output: (stdout + stderr).trim() };
}

export interface FailStartingDeps {
  /** Kills the launch's pane if it is up; defaults to killStartingPane. */
  killPane?: (session: string) => Promise<{ ok: boolean; output: string }>;
  log?: Pick<Console, "error">;
}

/**
 * Fails each launch in `ids` with `reason`: the row is failed, any pane it
 * already has is killed and its task run is cancelled. A launch that can't be
 * failed is logged and skipped, so one bad row doesn't stop the rest.
 */
function failStartingLaunches(db: Database, ids: string[], reasonFor: (id: string) => string, deps: FailStartingDeps): Launch[] {
  const killPane = deps.killPane ?? killStartingPane;
  const log = deps.log ?? console;
  const failed: Launch[] = [];
  for (const id of ids) {
    try {
      const launch = getLaunch(db, id);
      if (!launch) continue;
      updateLaunchStatus(db, id, "failed", reasonFor(id));
      cancelLaunchTaskRun(db, launch);
      if (launch.tmuxSession) {
        const paneError = (detail: string) =>
          log.error(`[reaper] could not kill the pane of starting launch ${id}: ${detail}`);
        void Promise.resolve()
          .then(() => killPane(launch.tmuxSession!))
          .then((killed) => {
            if (!killed.ok) paneError(killed.output || "tmux kill-session failed");
          })
          .catch((err) => paneError((err as Error).message));
      }
      const updated = getLaunch(db, id);
      if (updated) failed.push(updated);
    } catch (err) {
      log.error(`[reaper] could not fail starting launch ${id}: ${(err as Error).message}`);
    }
  }
  return failed;
}

export interface StaleStartingOptions extends FailStartingDeps {
  now?: number;
  maxAgeMs?: number;
  /** Whether the in-process host-headroom queue still holds the launch. */
  isQueued?: (launchId: string) => boolean;
  clock?: StartingPhaseClock;
}

/**
 * Fails launches stuck in `starting`. A launch's provisioning, build and pane
 * spawn run as detached work in the collector; if that work hangs past its
 * step caps or dies without settling the row, nothing else moves it, and a
 * `starting` row counts against Persona's active cap for as long as it stays.
 * A launch is failed once it has sat in its current phase for `maxAgeMs`,
 * unless the host-headroom queue still holds it (waiting for room is not
 * stuck). Any pane it has is killed and its task run cancelled, as a stop would.
 */
export function failStaleStartingLaunches(db: Database, opts: StaleStartingOptions = {}): Launch[] {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? STALE_STARTING_LAUNCH_MS;
  const isQueued = opts.isQueued ?? ((id: string) => launchQueue.describe(id) !== null);
  const clock = opts.clock ?? startingPhaseClock;

  const rows = db
    .query(`SELECT id, phase, created_at FROM launches WHERE status = 'starting'`)
    .all() as Array<{ id: string; phase: string | null; created_at: string | null }>;
  const stale = new Map<string, string | null>();
  for (const row of rows) {
    if (isQueued(row.id)) {
      clock.restart(row.id, row.phase, now);
      continue;
    }
    const sinceMs = clock.since(row.id, row.phase, sqliteUtcMs(row.created_at, now), now);
    if (now - sinceMs >= maxAgeMs) stale.set(row.id, row.phase);
  }
  clock.retain(new Set(rows.map((r) => r.id)));
  return failStartingLaunches(db, [...stale.keys()], (id) => staleStartingReason(stale.get(id) ?? null, maxAgeMs), opts);
}

/**
 * Fails every launch a previous collector process left `starting` outside the
 * queue (provisioning, building or spawning its pane). That work ran detached
 * in the old process and died with it, so nothing would ever finish these
 * rows; a pane one already spawned is killed. Queued rows are
 * failStrandedQueuedLaunches' (launcher.ts). Called once at startup, before
 * any launch of this process exists.
 */
export function failStrandedStartingLaunches(db: Database, deps: FailStartingDeps = {}): Launch[] {
  const rows = db
    .query(`SELECT id FROM launches WHERE status = 'starting' AND (phase IS NULL OR phase != 'queued')`)
    .all() as Array<{ id: string }>;
  return failStartingLaunches(db, rows.map((r) => r.id), () => STRANDED_STARTING_LAUNCH_REASON, deps);
}

export interface ReaperTickDeps {
  db: Database;
  broadcast: (message: WsMessage) => void;
  /** Drops the transcript watcher of a reaped session. */
  unwatch: (sessionId: string) => void;
  /** Kicks off the stale running-session resync; it settles on its own. */
  resync?: () => void;
  reapDeadSessions?: (db: Database) => ReapedSession[];
  endStaleMonitoredSessions?: (db: Database) => StaleEndedSession[];
  reapDeadCodexLaunches?: (db: Database) => Launch[];
  failStaleStartingLaunches?: (db: Database) => Launch[];
  drainLaunchQueue?: (db: Database) => string[];
  log?: Pick<Console, "log" | "error">;
}

/**
 * One pass of the collector's maintenance interval. Each step is isolated: a
 * step that throws is logged and the rest still run, and the host-headroom
 * queue is always drained last, so one bad row can't keep queued launches
 * from ever starting.
 */
export function reaperTick(deps: ReaperTickDeps): void {
  const { db, broadcast } = deps;
  const log = deps.log ?? console;
  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error(`[reaper] ${name} failed: ${(err as Error).message}`);
    }
  };
  const broadcastLaunch = (launch: Launch) =>
    broadcast({ type: "launch:started", payload: launch, timestamp: new Date().toISOString() });

  step("dead-session reap", () => {
    const reaped = (deps.reapDeadSessions ?? reapDeadSessions)(db);
    for (const { sessionId, cancelledAsks, stale } of reaped) {
      // A reaped session ended out-of-band (dead tmux pane, no SessionEnd hook),
      // so nothing else drops its watcher — do it here alongside its session:end.
      deps.unwatch(sessionId);
      for (const ask of cancelledAsks) {
        broadcast({
          type: "ask:resolved",
          payload: { askId: ask.id, answer: "" },
          timestamp: new Date().toISOString(),
        });
      }
      broadcast({
        type: "session:end",
        payload: { sessionId, ...(stale ? { endReason: "stale" } : {}) },
        timestamp: new Date().toISOString(),
      });
    }
    if (reaped.length > 0) log.log(`[reaper] Reaped ${reaped.length} dead launched session(s)`);
  });

  // A monitored session has no Standup-owned pane to check, so one that exits
  // without SessionEnd is only noticed by its silence.
  step("stale monitored session end", () => {
    const ended = (deps.endStaleMonitoredSessions ?? endStaleMonitoredSessions)(db);
    const now = new Date().toISOString();
    for (const { sessionId, cancelledAsks, checkpoint, silentMs, lastActivityAt, endedChildren } of ended) {
      for (const id of [...endedChildren, sessionId]) deps.unwatch(id);
      for (const ask of cancelledAsks) {
        broadcast({ type: "ask:resolved", payload: { askId: ask.id, answer: "" }, timestamp: now });
      }
      broadcast({ type: "checkpoint:new", payload: checkpoint, timestamp: now });
      // `endReason` lets the Slack mirror close the thread without a marker post.
      for (const id of [...endedChildren, sessionId]) {
        broadcast({ type: "session:end", payload: { sessionId: id, endReason: "stale" }, timestamp: now });
      }
      log.log(
        `[reaper] Ended monitored session ${sessionId} as stale: silent ${formatSilence(silentMs)} ` +
          `since ${lastActivityAt.toISOString()}, no SessionEnd; ` +
          `${endedChildren.length} subagent(s) ended, ${cancelledAsks.length} ask(s) cancelled`
      );
    }
  });

  // Codex posts no SessionEnd hook and forms its session from its own event
  // stream; a run whose pane dies before that stream ever started a session has
  // no session row for the step above to reap, so it would read `running` forever.
  // The observer fails those promptly while watching; this is the backstop.
  step("dead codex launch reap", () => {
    const failedCodex = (deps.reapDeadCodexLaunches ?? reapDeadCodexLaunches)(db);
    for (const launch of failedCodex) broadcastLaunch(launch);
    if (failedCodex.length > 0) log.log(`[reaper] Failed ${failedCodex.length} sessionless dead codex launch(es)`);
  });

  step("stale starting launch sweep", () => {
    const stale = (deps.failStaleStartingLaunches ?? failStaleStartingLaunches)(db);
    for (const launch of stale) {
      broadcastLaunch(launch);
      log.log(`[reaper] Failed launch ${launch.id}: stuck starting`);
    }
  });

  // A turn ended by an interrupt fires no Stop hook, so a session can read
  // `running` while its pane sits at the prompt; the resync settles those.
  if (deps.resync) step("stale-session resync", deps.resync);

  // Launches queued for host headroom start here, oldest first, once the host
  // has room again; each then broadcasts its own phase and status changes.
  step("launch queue drain", () => {
    const released = (deps.drainLaunchQueue ?? drainLaunchQueue)(db);
    if (released.length > 0) {
      log.log(`[launch-queue] Started ${released.length} queued launch(es); the host has room`);
    }
  });
}
