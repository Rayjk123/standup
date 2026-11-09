import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import {
  getActiveSessions,
  getLaunchBySession,
  getPendingAsksBySession,
  getPendingMessages,
  getPendingSteers,
  getSession,
  insertEvent,
  updateSessionStatus,
} from "@standup/store";
import type { Ask, Launch, SessionStatus, WsMessage } from "@standup/shared";
import { capturePaneSync, sendToLaunch, tmuxAvailable, tmuxSessionExists } from "./launcher.js";
import { sessionTmux } from "./tmux-launch.js";
import { isIdleNoticeAsk } from "./persona/events.js";
import { transcriptPathForSession } from "./transcript.js";

/**
 * Recovering a launched Claude session whose recorded state no longer matches
 * its pane.
 *
 * Claude Code fires no `Stop` hook when a turn ends through an interrupt (Esc,
 * or a rejected permission dialog), and no `PostToolUse` for the tool call it
 * cut off. Left alone the session row stays `running`, the unmatched
 * `PreToolUse` reads as a tool still in flight, and queued steers wait for a
 * `UserPromptSubmit` that never comes — the worker sits at an empty prompt that
 * nothing will type into. The pane is the ground truth, so these helpers read
 * it, settle the row to what it shows, and start the next turn when steers or
 * messages are waiting.
 *
 * They only ever send Escape to a non-permission dialog and type one fixed
 * wake line at an idle prompt. A permission or safety-floor dialog, or a
 * pending question, is left for the ask flow to answer.
 */

/** What a Claude Code pane is showing, read from its visible screen. */
export type PaneState =
  /** At its input prompt. `composer` is whatever text sits in the input box. */
  | { kind: "idle"; composer: string; interrupted: boolean }
  /** Mid-turn: the working spinner is up. */
  | { kind: "busy" }
  /** A tool-permission dialog. Answered only through the ask flow. */
  | { kind: "permission" }
  /** An AskUserQuestion modal. Answered only through the ask flow. */
  | { kind: "question" }
  /** Some other menu or overlay with no input box; Escape closes it. */
  | { kind: "dialog" }
  | { kind: "unknown" };

// How far up from the bottom of the screen each signal is looked for. A
// dialog, the spinner and the input box all render in the live area at the
// bottom; text further up is transcript, which can quote any of them.
const DIALOG_REGION_LINES = 16;
const SPINNER_REGION_LINES = 12;
const COMPOSER_REGION_LINES = 30;
const SPINNER_ABOVE_COMPOSER_LINES = 4;

const PERMISSION_MARKERS = [
  /\bDo you want to\b/i,
  /\bYes, and don'?t ask again\b/i,
  /\bNo, and tell Claude what to do differently\b/i,
  // Any menu offering "Yes" is treated as a permission dialog, whatever its wording.
  /^[\s│]*(?:❯|›|>)?\s*\d+\.\s+Yes\b/,
];
const QUESTION_MARKERS = [/\bSubmit answers\b/i, /\bReady to submit\b/i, /\bType something\b/i];
const SPINNER_LINE = /^\s*[^\s\w]\s+\S[^(]*…\s*\((?:[^)]*\b\d+[smh]\b|[^)]*esc to interrupt)/i;
const BUSY_MARKERS = [/\besc to interrupt\b/i, /\bRunning \w+ hooks?…/i];
const MENU_OPTION = /^[\s│]*(?:❯|›|>)?\s*\d+\.\s+\S/;
const DIALOG_FOOTER = /\bEsc to (?:cancel|go back|close|exit)\b/i;
const RULE_LINE = /^[\s╭╰]*[─━]{8,}/;
const COMPOSER_LINE = /^[\s│]*❯(?:\s+(.*?))?[\s│]*$/;
const BOXED_COMPOSER_LINE = /^\s*│\s*>(?:\s+(.*?))?\s*│\s*$/;
const INTERRUPTED_MARKER = /\[Request interrupted by user|\bInterrupted\b.*\bWhat should Claude do instead/i;
// Claude Code's dim placeholder text, which an unstyled capture can't tell from typed text.
const PLACEHOLDER = /^Try "/;

/** Classifies a captured Claude Code screen. Pure, so each case is unit-testable. */
export function classifyClaudePane(screen: string): PaneState {
  const lines = screen.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { kind: "unknown" };
  const tail = (n: number) => lines.slice(-n);

  const dialogRegion = tail(DIALOG_REGION_LINES);
  const hasMenu = dialogRegion.some((l) => MENU_OPTION.test(l));
  // A permission dialog is its question plus numbered options; the question
  // alone may just be the worker's own prose above an idle prompt.
  if (hasMenu && dialogRegion.some((l) => PERMISSION_MARKERS.some((m) => m.test(l)))) return { kind: "permission" };
  if (dialogRegion.some((l) => QUESTION_MARKERS.some((m) => m.test(l)))) return { kind: "question" };

  const found = findComposer(lines);
  // The spinner sits just above the input box; a subagent list or other panel
  // can push the box itself well up from the bottom.
  const spinnerRegion = found
    ? [...lines.slice(Math.max(0, found.index - SPINNER_ABOVE_COMPOSER_LINES), found.index), ...tail(SPINNER_REGION_LINES)]
    : tail(SPINNER_REGION_LINES);
  if (spinnerRegion.some((l) => SPINNER_LINE.test(l) || BUSY_MARKERS.some((m) => m.test(l)))) return { kind: "busy" };

  const composer = found?.text ?? null;
  if (composer === null) {
    const menu = hasMenu || dialogRegion.some((l) => DIALOG_FOOTER.test(l));
    return menu ? { kind: "dialog" } : { kind: "unknown" };
  }
  const text = PLACEHOLDER.test(composer) ? "" : composer;
  return { kind: "idle", composer: text, interrupted: lines.some((l) => INTERRUPTED_MARKER.test(l)) };
}

/** The input box's line and text, or null when no input box is drawn near the bottom of the screen. */
function findComposer(lines: string[]): { index: number; text: string } | null {
  const start = Math.max(0, lines.length - COMPOSER_REGION_LINES);
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i]!;
    if (MENU_OPTION.test(line)) continue;
    const match = COMPOSER_LINE.exec(line) ?? BOXED_COMPOSER_LINE.exec(line);
    if (!match) continue;
    // The input box sits under a horizontal rule (or the top of its box).
    const above = lines.slice(Math.max(0, i - 2), i);
    if (!above.some((l) => RULE_LINE.test(l))) continue;
    return { index: i, text: (match[1] ?? "").trim() };
  }
  return null;
}

/** The line typed into an idle pane so its queued steers and messages ride the next turn's prompt hook. */
export const WAKE_PROMPT =
  "Standup queued instructions for you while you were stopped; they are attached to this message. Read them and continue.";

/** The pane side of recovery, injectable so tests drive a scripted screen instead of tmux. */
export interface PaneDriver {
  exists(session: string): boolean;
  capture(session: string): string;
  sendKey(session: string, key: string): boolean;
  type(launch: Launch, text: string): Promise<{ ok: boolean; error?: string }>;
  sleep(ms: number): Promise<void>;
}

export const tmuxPaneDriver: PaneDriver = {
  exists: (session) => tmuxAvailable() && tmuxSessionExists(session),
  capture: (session) => capturePaneSync(session),
  sendKey: (session, key) => Bun.spawnSync(sessionTmux(session, "send-keys", "-t", session, key)).exitCode === 0,
  type: (launch, text) => sendToLaunch(launch, text),
  sleep: (ms) => Bun.sleep(ms),
};

export interface RecoveryDeps {
  db: Database;
  broadcast: (message: WsMessage) => void;
  pane: PaneDriver;
}

export interface SettleResult {
  /** Steers plus mailbox messages that were waiting when the wake line went in. */
  delivered: number;
  /** Why the waiting items could not be started, when there were some. */
  deliveryError?: string;
}

/** Asks that something real is waiting on: anything but the collector's own idle notice. */
function blockingAsks(db: Database, sessionId: string): Ask[] {
  return getPendingAsksBySession(db, sessionId).filter((a) => !isIdleNoticeAsk(a));
}

function setStatus(deps: RecoveryDeps, sessionId: string, status: SessionStatus): void {
  if (getSession(deps.db, sessionId)?.status === status) return;
  updateSessionStatus(deps.db, sessionId, status);
  deps.broadcast({ type: "session:status", payload: { sessionId, status }, timestamp: new Date().toISOString() });
}

/**
 * Records that a session's turn ended without a Stop hook and settles it idle,
 * then types the wake line when steers or messages are waiting for a next turn.
 * Only called once the pane has been read as idle at its prompt.
 *
 * The turn end is recorded as a `Stop` event marked `standup_settled`, because
 * that is the boundary every reader of the event stream already honours: the
 * cut-off `PreToolUse` before it no longer reads as a tool in flight.
 */
export async function settleIdle(
  deps: RecoveryDeps,
  sessionId: string,
  launch: Launch,
  reason: "interrupted" | "resynced" | "recovered" | "resumed" | "queued"
): Promise<SettleResult> {
  insertEvent(deps.db, sessionId, "Stop", { hook_event_name: "Stop", session_id: sessionId, standup_settled: reason });
  setStatus(deps, sessionId, "idle");

  const waiting = getPendingSteers(deps.db, sessionId).length + getPendingMessages(deps.db, sessionId).length;
  // Codex takes no typed prompt and has no prompt hook to carry the steers.
  if (waiting === 0 || launch.harness === "codex" || !launch.tmuxSession) return { delivered: 0 };
  const sent = await deps.pane.type(launch, WAKE_PROMPT);
  if (!sent.ok) return { delivered: 0, deliveryError: sent.error ?? "could not type into the session" };
  // The prompt hook claims the steers and marks the session running.
  return { delivered: waiting };
}

/**
 * Starts a live worker's next turn when its pane sits idle at the prompt, so
 * the steers and messages queued for it are read now rather than whenever it
 * next prompts. A paused worker (the queued steer resumes it), a busy pane, a
 * dialog, a pending ask or a gone pane is left alone, as is a session another
 * call is already starting. Returns null when nothing was started.
 */
export async function startQueuedIfIdle(deps: RecoveryDeps, sessionId: string, launch: Launch): Promise<SettleResult | null> {
  const pane = launch.tmuxSession;
  if (!pane || launch.harness === "codex" || launch.reapedAt || startingQueued.has(sessionId) || !deps.pane.exists(pane)) return null;
  if (blockingAsks(deps.db, sessionId).length > 0) return null;
  if (classifyClaudePane(deps.pane.capture(pane)).kind !== "idle") return null;
  startingQueued.add(sessionId);
  try {
    return await settleIdle(deps, sessionId, launch, "queued");
  } finally {
    startingQueued.delete(sessionId);
  }
}

/** Sessions startQueuedIfIdle is typing the wake line into. */
const startingQueued = new Set<string>();

/**
 * After an interrupt key, waits (bounded) for the pane to come back to its
 * prompt and settles the session there. Returns null when it didn't — still
 * busy, on a dialog, or gone — leaving the status for the resync sweep or
 * recover_session to correct.
 */
export async function settleAfterInterrupt(
  deps: RecoveryDeps,
  sessionId: string,
  launch: Launch,
  { timeoutMs = 5_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<SettleResult | null> {
  const session = launch.tmuxSession;
  if (!session) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!deps.pane.exists(session)) return null;
    const state = classifyClaudePane(deps.pane.capture(session));
    if (state.kind === "idle" && blockingAsks(deps.db, sessionId).length === 0) {
      return settleIdle(deps, sessionId, launch, "interrupted");
    }
    if (Date.now() >= deadline) return null;
    await deps.pane.sleep(pollMs);
  }
}

export interface RecoverResult {
  /** What the pane showed when recovery finished. */
  state: PaneState["kind"] | "gone";
  status?: SessionStatus;
  /** Keys sent, in order. */
  keys: string[];
  delivered: number;
  /** A plain account for the caller. */
  detail: string;
}

/** Bound on Escapes sent to close stacked dialogs; more than this is not a dialog Escape closes. */
const MAX_DISMISSALS = 2;

/**
 * Reads a launched session's pane and brings its recorded state in line with
 * it: closes a non-permission dialog with Escape, settles an idle prompt
 * (starting the next turn when steers or messages wait), and reports a busy
 * pane, a permission dialog or a pending ask without touching it.
 */
export async function recoverSession(deps: RecoveryDeps, sessionId: string, launch: Launch): Promise<RecoverResult> {
  const keys: string[] = [];
  const pane = launch.tmuxSession;
  if (!pane || !deps.pane.exists(pane)) {
    return { state: "gone", keys, delivered: 0, detail: "the worker's tmux pane is no longer running" };
  }

  const asks = blockingAsks(deps.db, sessionId);
  if (asks.length > 0) {
    setStatus(deps, sessionId, "waiting");
    const ids = asks.map((a) => a.id).join(", ");
    return {
      state: classifyClaudePane(deps.pane.capture(pane)).kind,
      status: "waiting",
      keys,
      delivered: 0,
      detail: `the worker is waiting on ask ${ids}; answer it with answer_ask — the pane was left untouched`,
    };
  }

  for (let round = 0; ; round++) {
    const state = classifyClaudePane(deps.pane.capture(pane));
    switch (state.kind) {
      case "permission":
      case "question":
        setStatus(deps, sessionId, "waiting");
        return {
          state: state.kind,
          status: "waiting",
          keys,
          delivered: 0,
          detail:
            state.kind === "permission"
              ? "the pane shows a tool-permission dialog with no pending ask; it was left untouched — it is answered through the ask flow"
              : "the pane shows a question modal; it was left untouched — answer it with answer_ask",
        };
      case "busy":
        setStatus(deps, sessionId, "running");
        return { state: "busy", status: "running", keys, delivered: 0, detail: "the worker is mid-turn (its spinner is up); nothing to recover" };
      case "dialog":
        if (round >= MAX_DISMISSALS) {
          return { state: "dialog", keys, delivered: 0, detail: "a dialog is still open after Escape; the pane was left as is" };
        }
        if (!deps.pane.sendKey(pane, "Escape")) {
          return { state: "dialog", keys, delivered: 0, detail: "could not send Escape to close the dialog" };
        }
        keys.push("Escape");
        await deps.pane.sleep(500);
        continue;
      case "idle": {
        const settled = await settleIdle(deps, sessionId, launch, "recovered");
        const status = getSession(deps.db, sessionId)?.status;
        const parts = [`the worker is at its prompt${state.interrupted ? " after an interrupt" : ""}; status set to idle`];
        if (settled.delivered > 0) parts.push(`started its next turn with ${settled.delivered} queued item(s)`);
        if (settled.deliveryError) parts.push(`the queued items were not started: ${settled.deliveryError}`);
        if (state.composer) parts.push(`its input box held: ${JSON.stringify(state.composer.slice(0, 200))}`);
        return { state: "idle", status, keys, delivered: settled.delivered, detail: parts.join("; ") };
      }
      default:
        return {
          state: "unknown",
          keys,
          delivered: 0,
          detail: "the pane's screen wasn't recognized as a prompt, dialog or running turn; it was left as is",
        };
    }
  }
}

/** When a session last showed activity: its newest hook event or transcript write, in ms. */
export function lastActivityMs(db: Database, sessionId: string): number | null {
  const row = db
    .query("SELECT MAX(created_at) AS at FROM events WHERE session_id = ?")
    .get(sessionId) as { at: string | null } | null;
  // SQLite's datetime('now') is UTC without a zone marker.
  let latest = row?.at ? Date.parse(`${row.at.replace(" ", "T")}Z`) : NaN;
  const path = transcriptPathForSession(db, sessionId);
  if (path) {
    try {
      latest = Math.max(Number.isNaN(latest) ? 0 : latest, statSync(path).mtimeMs);
    } catch {
      // A missing transcript leaves the event time as the only signal.
    }
  }
  return Number.isNaN(latest) ? null : latest;
}

/** How long a `running` session must be silent before its pane is checked: STANDUP_STALE_RUNNING_MS, else 3 min. */
export function staleRunningMs(): number {
  const parsed = parseInt(process.env.STANDUP_STALE_RUNNING_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3 * 60_000;
}

/**
 * The reaper's resync: every launched Claude session recorded `running` whose
 * transcript and events have been silent for `staleMs`, has nothing pending
 * on it, and whose pane shows the idle prompt is settled idle (and woken when
 * steers or messages wait). A busy pane, a dialog or a pending ask is left
 * alone. Returns the ids it settled.
 */
export async function resyncStaleRunningSessions(
  deps: RecoveryDeps,
  { staleMs = staleRunningMs(), now = Date.now() }: { staleMs?: number; now?: number } = {}
): Promise<string[]> {
  const settled: string[] = [];
  for (const session of getActiveSessions(deps.db)) {
    if (session.status !== "running" || session.kind === "subagent") continue;
    const launch = getLaunchBySession(deps.db, session.id);
    if (!launch?.tmuxSession || launch.harness === "codex") continue;
    const last = lastActivityMs(deps.db, session.id);
    if (last === null || now - last < staleMs) continue;
    if (blockingAsks(deps.db, session.id).length > 0) continue;
    if (!deps.pane.exists(launch.tmuxSession)) continue;
    const state = classifyClaudePane(deps.pane.capture(launch.tmuxSession));
    if (state.kind !== "idle") continue;
    await settleIdle(deps, session.id, launch, "resynced");
    settled.push(session.id);
  }
  return settled;
}
