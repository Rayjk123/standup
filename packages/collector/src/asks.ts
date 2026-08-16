import type { Database } from "bun:sqlite";
import { getAsk, timeoutAsk } from "@standup/store";
import { ASK_HUMAN_DEFAULT_TIMEOUT_S, ASK_HUMAN_MAX_TIMEOUT_S } from "@standup/shared";

const POLL_INTERVAL_MS = 500;

export interface AskResolution {
  answer: string;
  timedOut: boolean;
}

/**
 * Long-polls the asks table until the row is answered or the timeout elapses.
 * Holds the HTTP handler open — this is what gives ask_human its blocking
 * semantics without the agent polling or guessing.
 */
export async function waitForAskResolution(
  db: Database,
  askId: string,
  timeoutSeconds = ASK_HUMAN_DEFAULT_TIMEOUT_S
): Promise<AskResolution> {
  const timeoutMs = Math.min(timeoutSeconds, ASK_HUMAN_MAX_TIMEOUT_S) * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ask = getAsk(db, askId);

    if (!ask) {
      // Row vanished — treat as timed out rather than hanging forever.
      return { answer: "", timedOut: true };
    }

    if (ask.status === "answered") {
      return { answer: ask.answer ?? "", timedOut: false };
    }

    if (ask.status === "cancelled" || ask.status === "timeout") {
      return { answer: "", timedOut: true };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Deadline passed without resolution — mark it so the UI stops showing it as pending.
  timeoutAsk(db, askId);
  return { answer: "", timedOut: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
