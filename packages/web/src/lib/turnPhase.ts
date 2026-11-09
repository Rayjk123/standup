/**
 * "The agent is working" — the live phase a transcript view shows at its tail
 * while a turn is still running.
 *
 * The Slack mirror already tells you this: its thread status line reads "is
 * thinking…" / "is running Bash…" / "is responding…" as the turn moves
 * (statusLineForEvent in slack/src/mirror-format.ts). The console had no
 * equivalent — between the poll that shows a tool call and the poll that shows
 * its result nothing on screen moves, so a session that is busy reads as stuck.
 * This derives the same phase from the transcript itself, so both readers agree
 * without a new server signal.
 *
 * The phase comes from the LAST thing in the transcript, since a turn is only
 * ever appended to: a prompt with nothing after it means the agent has it and
 * hasn't answered yet; an unresolved tool call means that tool is running; a
 * resolved one means the agent has the result and is going again; the turn's own
 * prose is where it comes to rest and waits for you. Pure so it can be tested
 * without a component harness (the pattern launchOptions.ts uses).
 */

/** The tail of the transcript, reduced to just what names the phase. */
export type ActivityTail =
  | { kind: "prompt" }
  | { kind: "thinking" }
  | { kind: "text" }
  | { kind: "tool"; name: string; pending: boolean }
  | { kind: "other" };

export interface TurnPhase {
  /** What the agent is doing, phrased for display: "thinking", "running Bash". */
  label: string;
  /** How long it has been at it, for the ticking elapsed counter. */
  sinceMs: number;
}

/**
 * How long the tail can sit unchanged before the indicator stops claiming the
 * agent is working. Past this the transcript has gone quiet mid-turn, which is
 * stalled rather than busy — and the silence meter owns that story. Without the
 * cutoff, a session killed mid-tool would spin "working" forever.
 */
export const PHASE_STALE_MS = 5 * 60_000;

/**
 * The live phase to show, or null when there is nothing to claim: the session
 * ended, it is blocked on a question (the ask panel is the story then, not a
 * spinner), the turn has come to rest on the agent's own prose, or the tail has
 * gone stale (see PHASE_STALE_MS).
 */
export function turnPhase(input: {
  tail?: ActivityTail;
  /** The tail row's timestamp — an ISO string or epoch ms. */
  tailAt?: string | number;
  sessionEnded: boolean;
  /** A pending ask: the agent is waiting on a human, not working. */
  blocked?: boolean;
  now: number;
}): TurnPhase | null {
  const { tail, tailAt, sessionEnded, blocked, now } = input;
  if (sessionEnded || blocked || !tail) return null;
  const label = phaseLabel(tail);
  if (!label) return null;
  const at = tailAt === undefined ? NaN : new Date(tailAt).getTime();
  // No usable timestamp: claim nothing. A live turn always carries a fresh
  // tail time; a missing one instead means a reattached (resumed) session
  // whose last row is an old prompt with no time — indistinguishable here from
  // a real turn, and returning a phase would let the indicator tick off its
  // own mount clock forever ("working…" that never ends). The staleness cutoff
  // below can't guard this case because there's no anchor to measure against.
  if (!Number.isFinite(at)) return null;
  const sinceMs = Math.max(0, now - at);
  if (sinceMs > PHASE_STALE_MS) return null;
  return { label, sinceMs };
}

function phaseLabel(tail: ActivityTail): string | null {
  switch (tail.kind) {
    case "prompt":
      return "working";
    case "thinking":
      return "thinking";
    case "tool":
      // A resolved call is not the end of the turn — the agent has the result and
      // is deciding what comes next, which the transcript won't show until it acts.
      return tail.pending ? `running ${tail.name}` : "working";
    case "text":
    case "other":
      return null;
  }
}

/** The tail of the rich row stream — the terminal view's vocabulary. */
export function richRowTail(row: {
  kind: string;
  name?: string;
  result?: { kind: string };
}): ActivityTail {
  switch (row.kind) {
    case "user":
      return { kind: "prompt" };
    case "thinking":
      return { kind: "thinking" };
    case "text":
      return { kind: "text" };
    case "tool":
      return { kind: "tool", name: row.name ?? "a tool", pending: row.result?.kind === "pending" };
    default:
      // A compaction / mode / task-notification row says nothing about the phase,
      // but it only ever lands mid-turn — the agent is still going.
      return { kind: "prompt" };
  }
}

/** The tail of the message-card stream — the card view's vocabulary. */
export function messageTail(message: {
  role: "user" | "assistant";
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; output?: string }[];
}): ActivityTail {
  if (message.role === "user") return { kind: "prompt" };
  const calls = message.toolCalls ?? [];
  // A card folds a whole assistant turn, so an unresolved call inside it is the
  // live one no matter what prose arrived alongside.
  const pending = calls.find((c) => c.output === undefined);
  if (pending) return { kind: "tool", name: pending.name, pending: true };
  if (calls.length > 0) {
    return { kind: "tool", name: calls[calls.length - 1].name, pending: false };
  }
  if (message.text) return { kind: "text" };
  if (message.thinking) return { kind: "thinking" };
  return { kind: "other" };
}
