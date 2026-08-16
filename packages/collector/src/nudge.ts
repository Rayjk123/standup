import type { Database } from "bun:sqlite";
import { STUCKNESS } from "@standup/shared";
import { detectStuckness, type StucknessSignal } from "./stuckness.js";

/**
 * Proactive nudging (Phase 6). Off unless STANDUP_NUDGE=1.
 *
 * The design rejects the obvious version of this — detect stuckness, inject
 * the answer — for three reasons: latency (the answer must land inside a
 * hook's window), context pollution (a false positive derails an agent that
 * was fine), and feedback loops (the injected content generates events that
 * trigger another injection).
 *
 * So this pushes a *nudge*, never content: one line telling the agent that
 * an expert exists. The agent decides whether to call `ask_expert`. That
 * keeps the cost of a false positive to a single ignorable sentence.
 */

const ENABLED = process.env.STANDUP_NUDGE === "1";

/** Per session+topic, so a nudge about failing tests doesn't mute one about search. */
const lastNudgedAt = new Map<string, number>();
/** Per session per turn, as a backstop against a runaway loop. */
const nudgesThisTurn = new Map<string, number>();
const MAX_NUDGES_PER_TURN = 2;

export function isNudgingEnabled(): boolean {
  return ENABLED;
}

/** Called at turn boundaries so per-turn caps mean something. */
export function resetTurnNudges(sessionId: string): void {
  nudgesThisTurn.delete(sessionId);
}

export function clearNudgeState(sessionId: string): void {
  nudgesThisTurn.delete(sessionId);
  for (const key of [...lastNudgedAt.keys()]) {
    if (key.startsWith(`${sessionId}:`)) lastNudgedAt.delete(key);
  }
}

function offCooldown(sessionId: string, topic: string): boolean {
  const key = `${sessionId}:${topic}`;
  const last = lastNudgedAt.get(key);
  if (last === undefined) return true;
  return Date.now() - last >= STUCKNESS.NUDGE_COOLDOWN_MINUTES * 60_000;
}

function markNudged(sessionId: string, topic: string): void {
  lastNudgedAt.set(`${sessionId}:${topic}`, Date.now());
  nudgesThisTurn.set(sessionId, (nudgesThisTurn.get(sessionId) ?? 0) + 1);
}

function nudgeText(signal: StucknessSignal): string {
  const hint =
    signal.topic === "search"
      ? "search_knowledge may cover this if it's a convention or intent question"
      : signal.topic === "bash"
        ? "search_knowledge may have the project's setup or test conventions"
        : "ask_expert can search project knowledge and code together";

  return `A repo expert is available for this project — ${hint}. Call it if you're blocked; ignore this if you're not.`;
}

export interface NudgeResult {
  text: string;
  signal: StucknessSignal;
}

/**
 * Evaluates a session and returns nudge text if it's warranted. Returns null
 * far more often than not — that's the intent.
 *
 * Never throws: this runs inside hook handling, where an exception would
 * degrade the read path over an optional feature.
 */
export function maybeNudge(
  db: Database,
  sessionId: string
): NudgeResult | null {
  if (!ENABLED) return null;

  try {
    if ((nudgesThisTurn.get(sessionId) ?? 0) >= MAX_NUDGES_PER_TURN) return null;

    const signal = detectStuckness(db, sessionId);
    if (!signal) return null;
    if (!offCooldown(sessionId, signal.topic)) return null;

    markNudged(sessionId, signal.topic);
    return { text: nudgeText(signal), signal };
  } catch (err) {
    console.error("[nudge] detection failed:", err);
    return null;
  }
}
