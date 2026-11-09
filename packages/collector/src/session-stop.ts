import type { Database } from "bun:sqlite";
import { cancelAllPendingAsks, clearLaunchReaped, endSession } from "@standup/store";
import type { Launch, WsMessage } from "@standup/shared";
import { stopLaunch } from "./launcher.js";

export interface StopSessionDeps {
  broadcast: (message: WsMessage) => void;
  /** Drops the session's transcript watch (the tailer's unwatch). */
  unwatch?: (sessionId: string) => void;
  /** Closes the launch's pane; defaults to stopLaunch. */
  stopLaunch?: (db: Database, launch: Launch, opts: { pause: boolean }) => Promise<{ ok: boolean; log: string[] }>;
  /**
   * Runs after a deliberate (non-pause) stop has ended the session — the
   * worker hygiene of a closed job, say. A failure is logged, not thrown.
   */
  afterStop?: (launch: Launch) => Promise<unknown> | void;
}

export interface StopSessionOptions {
  /**
   * Why an idle worker is being paused rather than stopped. Set, the launch is
   * kept `running` for resumption and the stop is announced as `launch:reaped`
   * (which Persona reads as a pause, not a lost worker) instead of the
   * `session:status` + `launch:stopped` pair a deliberate stop sends.
   */
  reapReason?: string;
}

/**
 * Stops the agent behind a launched session: closes its pane, ends the
 * session, drops its transcript watch and cancels its pending asks (the
 * process that would answer them is gone). Queued steers and peer messages
 * are left pending: the session id survives, and a resumed agent receives
 * them on its next turn.
 */
export async function stopSession(
  db: Database,
  deps: StopSessionDeps,
  session: { id: string },
  launch: Launch,
  { reapReason }: StopSessionOptions = {}
): Promise<{ ok: boolean; log: string[] }> {
  const pause = reapReason !== undefined;
  const stop = deps.stopLaunch ?? ((d: Database, l: Launch, opts: { pause: boolean }) => stopLaunch(d, l, undefined, opts));
  const result = await stop(db, launch, { pause });
  // A pause that couldn't close the pane leaves the worker as it was.
  if (pause && !result.ok) return result;
  endSession(db, session.id);
  deps.unwatch?.(session.id);

  for (const ask of cancelAllPendingAsks(db, session.id)) {
    deps.broadcast({
      type: "ask:resolved",
      payload: { askId: ask.id, answer: "" },
      timestamp: new Date().toISOString(),
    });
  }

  if (pause) {
    deps.broadcast({
      type: "launch:reaped",
      payload: { launchId: launch.id, sessionId: session.id, reason: reapReason },
      timestamp: new Date().toISOString(),
    });
    return result;
  }
  // A deliberate stop of a paused worker keeps it stopped: nothing resumes it.
  // Cleared from the row, not the caller's copy, which may predate the pause.
  clearLaunchReaped(db, launch.id);
  deps.broadcast({
    type: "session:status",
    payload: { sessionId: session.id, status: "idle" },
    timestamp: new Date().toISOString(),
  });
  deps.broadcast({
    type: "launch:stopped",
    payload: { launchId: launch.id },
    timestamp: new Date().toISOString(),
  });
  if (deps.afterStop) {
    try {
      await deps.afterStop(launch);
    } catch (err) {
      console.error(`[session-stop] after-stop step for launch ${launch.id} failed:`, err);
    }
  }
  return result;
}
