import type { Database } from "bun:sqlite";
import type { TaskRun, WsMessage } from "@standup/shared";
import { reconcileLostTaskRuns } from "@standup/store";
import { syncTicketForTerminalRun } from "./task-ticket-sync.js";

export interface TaskRunSweepDeps {
  /** tmux-pane liveness probe (the collector's tmuxSessionExists in production). */
  sessionExists: (tmuxSession: string) => boolean;
  broadcast: (message: WsMessage) => void;
}

/**
 * Reconciliation sweep: marks dead `running` task runs `lost` and pushes the
 * transition to every connected client. The ledger analog of the reaper.
 *
 * Broadcasts a `task:updated` frame for EVERY reaped run — ticket-backed or an
 * ad-hoc launch with no ticket — so the fleet/board sees the dead agent flip
 * from `running` to `lost` immediately instead of showing it alive until the
 * next reconnect. A run that was implementing a ticket additionally resolves
 * its card (stamping the failure reason) via `syncTicketForTerminalRun`, and
 * that ticket update is broadcast too. The sweep passes no `reviewTransition`
 * since it only ever sees failed/lost runs. Returns the lost runs.
 */
export function sweepLostTaskRuns(db: Database, deps: TaskRunSweepDeps): TaskRun[] {
  const lost = reconcileLostTaskRuns(db, { sessionExists: deps.sessionExists });
  for (const run of lost) {
    deps.broadcast({
      type: "task:updated",
      payload: run,
      timestamp: new Date().toISOString(),
    });
    const ticket = syncTicketForTerminalRun(db, run);
    if (ticket) {
      deps.broadcast({
        type: "ticket:updated",
        payload: ticket,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return lost;
}
