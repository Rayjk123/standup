import type { Database } from "bun:sqlite";
import {
  cancelAsk,
  getActiveSessions,
  getSurfacedAsksBySession,
  updateSessionStatus,
  isLaunchedSession,
} from "@standup/store";
import type { Ask } from "@standup/shared";
import {
  askStandsFor,
  createPermissionAsk,
  describeCall,
  describeCandidates,
  noticeTarget,
  noticeToolName,
  retirePermissionAsks,
} from "./held-call.js";
import { IDLE_NOTICE_GATE } from "./persona/policy.js";

/** How many of a session's newest events are searched for the main thread's latest. */
const MAIN_THREAD_SCAN = 200;

/** Whether a recorded event came from a subagent (its payload names one). */
function subagentEvent(payloadJson: string): boolean {
  try {
    const agentId = (JSON.parse(payloadJson) as { agent_id?: unknown }).agent_id;
    return typeof agentId === "string" && agentId !== "";
  } catch {
    return false;
  }
}

/**
 * Re-derives blocked state from the stored event stream at startup.
 *
 * Blocking is otherwise detected only as a Notification hook arrives. That
 * makes it invisible in two ordinary cases: the collector restarted while an
 * agent sat on a prompt, and the detection shipped after the prompt already
 * fired. Either way a launched agent waits forever with nothing on screen to
 * say so — precisely the failure the console exists to prevent.
 *
 * A session counts as still blocked when its most recent event is a blocking
 * Notification. Any later event means it moved on, so nothing is raised.
 */
export interface ReconcileOptions {
  /**
   * Whether Persona will be able to act for a session it owns this boot
   * (running and not paused). Such a worker's idle notice is not raised:
   * Persona is its owner-of-record and reads the worker's state itself. A real
   * permission prompt still surfaces.
   */
  personaOwned?: (sessionId: string) => boolean;
}

export function reconcileBlockedSessions(db: Database, opts: ReconcileOptions = {}): Ask[] {
  const raised: Ask[] = [];

  for (const session of getActiveSessions(db)) {
    // Monitored sessions are excluded for the same reason the live path
    // excludes them: their human is sitting at that terminal, and an idle
    // prompt there is just a turn ending.
    if (!isLaunchedSession(db, session.id)) continue;
    // Asks whose call ended while the collector was down go first, so they
    // can't stand in for a dialog that is still open.
    retirePermissionAsks(db, session.id);
    // A prompt Persona holds claimed while it types the answer counts as
    // pending: it still stands for its dialog (see claimPendingAsk).
    const pending = getSurfacedAsksBySession(db, session.id);

    // The main thread's latest event: background subagents keep recording
    // their own calls after a notice, which says nothing about the dialog.
    const recent = db
      .query(
        `SELECT type, payload_json
           FROM events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?`
      )
      .all(session.id, MAIN_THREAD_SCAN) as Array<{ type: string; payload_json: string }>;
    const latest = recent.find((e) => !subagentEvent(e.payload_json));

    if (!latest || latest.type !== "Notification") continue;

    let notificationType = "";
    let message = "";
    try {
      const payload = JSON.parse(latest.payload_json) as {
        notification_type?: string;
        message?: string;
      };
      notificationType = payload.notification_type ?? "";
      message = payload.message ?? "";
    } catch {
      continue;
    }

    if (notificationType !== "idle_prompt" && notificationType !== "permission_prompt") {
      continue;
    }
    const isIdle = notificationType === "idle_prompt";
    // The call the notice is about, when one can be told (see noticeTarget).
    const target = isIdle ? null : noticeTarget(db, session.id, noticeToolName(message));
    // An idle notice is moot behind any pending ask; a real permission dialog
    // still needs its own row behind a pending question or idle notice.
    const surfaced = target
      ? pending.some((a) => a.kind === "permission_prompt" && a.gate !== IDLE_NOTICE_GATE && askStandsFor(db, a, target))
      : pending.length > 0;
    if (surfaced) continue;
    if (isIdle && opts.personaOwned?.(session.id)) continue;
    // The turn-end classifier already judged this idle notice's turn finished.
    if (isIdle && session.status === "done") continue;
    // One dialog shows at a time: a permission ask for another dialog is moot.
    if (target) {
      for (const moot of pending) if (moot.kind === "permission_prompt" && moot.gate !== IDLE_NOTICE_GATE) cancelAsk(db, moot.id);
    }

    const detail =
      (target ? (target.call ? describeCall(target.call) : describeCandidates(db, session.id, target.candidates)) : null) ||
      message ||
      "Waiting for your input";
    const ask = createPermissionAsk(
      db,
      session.id,
      `${detail} — this session was launched by the console, so nobody is at its terminal.`,
      target,
      isIdle ? { gate: IDLE_NOTICE_GATE } : {}
    );
    updateSessionStatus(db, session.id, "waiting");
    raised.push(ask);
  }

  return raised;
}
