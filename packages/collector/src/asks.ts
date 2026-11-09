import type { Database } from "bun:sqlite";
import type { Ask, WsMessage } from "@standup/shared";
import { getAsk, getPendingAsksBySession, getSession, timeoutPendingAsk, updateSessionStatus } from "@standup/store";
import { ASK_HUMAN_DEFAULT_TIMEOUT_S, ASK_HUMAN_MAX_TIMEOUT_S } from "@standup/shared";
import { DrainReleasedError, processDrain, sleepUnlessReleased } from "./drain.js";

const POLL_INTERVAL_MS = 500;

export interface AskResolution {
  answer: string;
  timedOut: boolean;
  /** The waiter's client disconnected before the ask resolved; the ask is left as it is. */
  abandoned?: boolean;
}

/** The ask's resolution once it is no longer pending, else undefined. */
function settledResolution(db: Database, askId: string): AskResolution | undefined {
  const ask = getAsk(db, askId);
  // Row vanished — treat as timed out rather than hanging forever.
  if (!ask) return { answer: "", timedOut: true };
  if (ask.status === "answered") return { answer: ask.answer ?? "", timedOut: false };
  if (ask.status === "cancelled" || ask.status === "timeout") return { answer: "", timedOut: true };
  return undefined;
}

/**
 * Long-polls the asks table until the row is answered or the timeout elapses.
 * Holds the HTTP handler open — this is what gives ask_human its blocking
 * semantics without the agent polling or guessing.
 *
 * Throws DrainReleasedError as soon as `drainSignal` aborts (the collector is
 * shutting down for a restart), unless the ask resolved since the last poll,
 * whose resolution is returned instead. A pending ask is left pending: the
 * caller's retry re-attaches to it by request id on the next leader.
 *
 * When `clientSignal` aborts (the caller's HTTP client went away), it returns
 * `abandoned` at once, whatever the row says: nobody is left to hand an
 * answer to, and the ask is left for the caller to settle.
 */
export async function waitForAskResolution(
  db: Database,
  askId: string,
  timeoutSeconds = ASK_HUMAN_DEFAULT_TIMEOUT_S,
  drainSignal: AbortSignal = processDrain.signal,
  clientSignal?: AbortSignal
): Promise<AskResolution> {
  const timeoutMs = Math.min(timeoutSeconds, ASK_HUMAN_MAX_TIMEOUT_S) * 1000;
  const deadline = Date.now() + timeoutMs;
  const abandoned = (): boolean => !drainSignal.aborted && !!clientSignal?.aborted;
  const released = clientSignal ? AbortSignal.any([drainSignal, clientSignal]) : drainSignal;

  while (Date.now() < deadline) {
    if (abandoned()) return { answer: "", timedOut: false, abandoned: true };
    const settled = settledResolution(db, askId);
    if (settled) return settled;

    try {
      await sleepUnlessReleased(POLL_INTERVAL_MS, released);
    } catch (err) {
      if (err instanceof DrainReleasedError) {
        if (abandoned()) return { answer: "", timedOut: false, abandoned: true };
        // An answer that landed since the last poll is delivered now rather
        // than making the caller re-attach just to collect it.
        const late = settledResolution(db, askId);
        if (late) return late;
      }
      throw err;
    }
  }

  // Deadline passed without resolution — mark it so the UI stops showing it
  // as pending. An answer that landed since the last poll stands.
  timeoutPendingAsk(db, askId);
  return settledResolution(db, askId) ?? { answer: "", timedOut: true };
}

/**
 * Tells every console and the Slack bridge that `ask` timed out (the same
 * `ask:resolved` with no answer a dismissal sends), and puts its session back
 * to running when it was waiting on nothing else.
 */
export function announceAskTimedOut(db: Database, broadcast: (message: WsMessage) => void, ask: Pick<Ask, "id" | "sessionId">): void {
  announceAskResolved(db, broadcast, ask, "");
}

/**
 * Tells every console and the Slack bridge that `ask` was resolved with
 * `answer` (as the resolve route does), and puts its session back to running
 * when it was waiting on nothing else.
 */
export function announceAskResolved(
  db: Database,
  broadcast: (message: WsMessage) => void,
  ask: Pick<Ask, "id" | "sessionId">,
  answer: string
): void {
  const timestamp = new Date().toISOString();
  broadcast({ type: "ask:resolved", payload: { askId: ask.id, answer }, timestamp });
  const session = getSession(db, ask.sessionId);
  if (session?.status !== "waiting" || getPendingAsksBySession(db, ask.sessionId).length > 0) return;
  updateSessionStatus(db, ask.sessionId, "running");
  broadcast({ type: "session:status", payload: { sessionId: ask.sessionId, status: "running" }, timestamp });
}
