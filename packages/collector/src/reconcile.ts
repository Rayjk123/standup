import type { Database } from "bun:sqlite";
import {
  getActiveSessions,
  getPendingAsksBySession,
  createAsk,
  updateSessionStatus,
  isLaunchedSession,
} from "@standup/store";
import type { Ask } from "@standup/shared";

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
export function reconcileBlockedSessions(db: Database): Ask[] {
  const raised: Ask[] = [];

  for (const session of getActiveSessions(db)) {
    // Monitored sessions are excluded for the same reason the live path
    // excludes them: their human is sitting at that terminal, and an idle
    // prompt there is just a turn ending.
    if (!isLaunchedSession(db, session.id)) continue;
    if (getPendingAsksBySession(db, session.id).length > 0) continue;

    const latest = db
      .query(
        `SELECT type, payload_json
           FROM events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(session.id) as { type: string; payload_json: string } | null;

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

    const detail = message || "Waiting for your input";
    const ask = createAsk(
      db,
      session.id,
      "permission_prompt",
      `${detail} — this session was launched by the console, so nobody is at its terminal.`
    );
    updateSessionStatus(db, session.id, "waiting");
    raised.push(ask);
  }

  return raised;
}
