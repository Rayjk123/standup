import type { Database } from "bun:sqlite";
import { AUTO_CHECKPOINT_CWD } from "./internal-cwd.js";
import { runClaudeText } from "./claude-cli.js";
import { claudeDecider, type RunModel } from "./decider/claude.js";
import { runDecision, type DecisionContext } from "./decider/run.js";
import {
  createCheckpoint,
  getSetting,
  setSetting,
  getSession,
  getLaunchBySession,
  upgradeSessionTitle,
} from "@standup/store";
import type { Checkpoint } from "@standup/shared";
import { capTitle } from "@standup/shared";
import { readTranscript, transcriptPathForSession } from "./transcript.js";

/**
 * Auto-checkpointing: agents only show up in the feed if they call
 * `checkpoint` themselves, and nothing makes them do that unless they're
 * told to (see docs/agent-instructions.md) — a monitored session with no
 * CLAUDE.md snippet checkpoints nothing, ever, no matter how much work it
 * does. This fills that gap from the outside: at every turn boundary, a
 * model reads what's new in the transcript since the last check and decides
 * whether it was checkpoint-worthy.
 *
 * Always on. Each `claude` CLI call costs real money — mostly cache-creation
 * overhead from Claude Code's own system prompt, not the actual summarization —
 * every time it fires, across every session, and the checkpoint summary runs on
 * a stronger model (below) than the terse ancillary calls.
 */

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
// The checkpoint summary is the one auto-generated line a human actually reads
// in the feed, so it runs on a stronger model than the terse ancillary calls
// (session titles, turn classification, which stay on
// Haiku). Override with STANDUP_CHECKPOINT_MODEL — e.g. back to the Haiku id to
// trade summary richness for cost.
const CHECKPOINT_MODEL = process.env.STANDUP_CHECKPOINT_MODEL ?? "claude-sonnet-5";
const SUMMARIZE_TIMEOUT_MS = 30_000;
const CHECKPOINT_TIMEOUT_MS = 60_000; // a stronger model on a richer prompt needs more headroom
const MAX_TRANSCRIPT_CHARS = 12_000; // keeps the prompt — and its cost — bounded
const MAX_SUMMARY_CHARS = 280;
const MAX_CHECKPOINT_CHARS = 700; // a real checkpoint, not a single sentence — richer than the ancillary cap
const MAX_TITLE_INPUT_CHARS = 4_000; // enough of the first message to title it

/**
 * The one cwd the summarizer subprocess ever runs from — never a real
 * project directory. Standup's hooks are installed globally
 * (~/.claude/settings.json applies to every `claude` invocation, not just
 * interactive ones — see scripts/setup-hooks.ts), so this subprocess fires
 * its own SessionStart/Stop hooks back at the collector exactly like a real
 * session would. server.ts's hook handler checks the incoming cwd against
 * this constant and no-ops entirely for it — no session row, no events —
 * which is what breaks the loop: without that guard, the subprocess's own
 * Stop event would trigger another auto-checkpoint call on itself, which
 * fires its own Stop event, recursing without bound.
 */
export { AUTO_CHECKPOINT_CWD };

// Per-session watermark: the transcript message already considered as of the
// last fire, so a repeated call only sees what's new. In-memory, like the
// other per-session live state in this file's siblings (checkpointedTodos,
// nudge cooldowns) — a collector restart just means the next fire re-reads
// a bit of already-seen transcript, not that it misses anything.
const lastSeenUuid = new Map<string, string>();

// Sessions whose latest turn end the classifier has judged. The coarse
// "launched idle → needs you" rule stands down only for these, so a failed or
// still-running classifier call never leaves an idle launch unflagged.
const judgedTurnEnds = new Set<string>();
// Each session's latest turn boundary, so a verdict that lands after the next
// boundary is not taken as that one's. Numbers come from one collector-wide
// counter, so a session whose state was cleared never reuses an in-flight
// turn's number.
const latestTurns = new Map<string, number>();
let turnCounter = 0;

export function clearAutoCheckpointState(sessionId: string): void {
  lastSeenUuid.delete(sessionId);
  judgedTurnEnds.delete(sessionId);
  latestTurns.delete(sessionId);
}

/**
 * Forgets the last turn end's verdict; called at each turn boundary (a turn
 * end, or a new prompt). Returns the boundary's number for classifyTurnEnd.
 */
export function beginTurnEnd(sessionId: string): number {
  judgedTurnEnds.delete(sessionId);
  const turn = ++turnCounter;
  latestTurns.set(sessionId, turn);
  return turn;
}

/** True while `turn` is still the session's latest turn boundary. */
export function isLatestTurn(sessionId: string, turn: number): boolean {
  return latestTurns.get(sessionId) === turn;
}

/** True once classifyTurnEnd has judged the session's latest turn end. */
export function turnEndJudged(sessionId: string): boolean {
  return judgedTurnEnds.has(sessionId);
}

/**
 * Fire-and-forget from the hook path: reads the transcript delta since the
 * last fire, asks Haiku whether it's checkpoint-worthy, and returns a new
 * checkpoint if so. Takes a couple of seconds (subprocess + model call) —
 * callers must not await this before responding to the hook, or every turn
 * boundary gets slower for the agent.
 */
export async function maybeAutoCheckpoint(
  db: Database,
  sessionId: string
): Promise<Checkpoint | null> {
  const path = transcriptPathForSession(db, sessionId);
  if (!path) return null;

  const page = await readTranscript(path, 60, sessionId);
  const lastUuid = lastSeenUuid.get(sessionId);
  const startIdx = lastUuid
    ? page.messages.findIndex((m) => m.uuid === lastUuid) + 1
    : 0;
  const delta = page.messages.slice(startIdx);
  if (delta.length === 0) return null;

  lastSeenUuid.set(sessionId, delta[delta.length - 1].uuid);

  const transcript = delta
    .map((m) => {
      if (m.localCommand) return `${m.role}: ran /${m.localCommand.name}`;
      const tools = m.toolCalls.map((c) => c.name).join(", ");
      const parts = [m.text, tools && `[used: ${tools}]`].filter(Boolean);
      return parts.length ? `${m.role}: ${parts.join(" ")}` : null;
    })
    .filter((line): line is string => !!line)
    .join("\n\n")
    .slice(0, MAX_TRANSCRIPT_CHARS);

  if (!transcript.trim()) return null;

  const summary = await summarize(transcript);
  if (!summary) return null;

  return createCheckpoint(db, sessionId, "auto", summary);
}

/**
 * One `claude -p` model call, returning its trimmed text (or null on any
 * failure). Always runs from AUTO_CHECKPOINT_CWD — the reserved cwd server.ts
 * no-ops on — so this subprocess's own SessionStart/Stop hooks don't create a
 * phantom session or, worse, recurse. Defaults to Haiku for the cheap ancillary
 * uses (session titles, block explanations, turn classification); the checkpoint
 * summarizer passes CHECKPOINT_MODEL for a more substantive summary. Exported so
 * launch-time project inference (project-inference.ts) can reuse the same
 * cheap-model call path.
 */
export async function runModel(
  prompt: string,
  {
    model = HAIKU_MODEL,
    timeoutMs = SUMMARIZE_TIMEOUT_MS,
  }: { model?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  return runClaudeText(prompt, {
    model,
    cwd: AUTO_CHECKPOINT_CWD,
    timeoutMs,
  });
}

async function summarize(transcript: string): Promise<string | null> {
  const prompt =
    "Here is a slice of an AI coding agent's conversation with its user. " +
    "Write a substantive checkpoint of this slice for a teammate skimming a feed: " +
    "lead with the concrete outcome (what was built, changed, decided, or blocked on), " +
    "name the specific files, components, or decisions involved, and note the rationale " +
    "or what's next when it's there. Two to four tight sentences (or terse bullet lines) — " +
    "specific and skimmable, no preamble or filler. " +
    "If nothing checkpoint-worthy happened yet — routine back-and-forth, no clear outcome — " +
    "reply with exactly: NONE\n\n" +
    transcript;

  const result = await runModel(prompt, {
    model: CHECKPOINT_MODEL,
    timeoutMs: CHECKPOINT_TIMEOUT_MS,
  });
  if (!result || result.toUpperCase() === "NONE") return null;

  return result.length > MAX_CHECKPOINT_CHARS
    ? `${result.slice(0, MAX_CHECKPOINT_CHARS - 1)}…`
    : result;
}

/**
 * A short, task-specific session title generated from the first user message.
 *
 * Used in place of "the first 150 characters of the prompt" while the title
 * summarizer is on (isTitleSummaryEnabled). Returns null on any failure so the caller can fall back to the plain
 * truncation. Based on the first message only — deliberately not the whole
 * transcript — so it's cheap and stable, and can run the moment the session
 * starts rather than waiting for work to accumulate.
 */
export async function generateSessionTitle(
  firstMessage: string
): Promise<string | null> {
  const prompt =
    "Below is the first message a user sent to an AI coding agent. Write a " +
    "concise title for the session it begins: 3 to 8 words, specific to the " +
    "task, with no surrounding quotes and no trailing punctuation. Reply with " +
    "ONLY the title.\n\n" +
    firstMessage.slice(0, MAX_TITLE_INPUT_CHARS);

  const result = await runModel(prompt);
  return result ? cleanTitle(result) : null;
}

/**
 * Classifies how a session's turn ended: is the agent waiting on the human,
 * finished, or just idle mid-exchange? Drives the needs-you surfacing
 * (for launched AND monitored sessions) and the distinct 'done' status.
 *
 * A verdict marks turn end `turn` judged (turnEndJudged) while it is still the
 * latest turn boundary (beginTurnEnd); with none (no
 * transcript, or the model call failed) the collector keeps its coarse default
 * (launched idle → needs-you, monitored → nothing). Reads the recent
 * transcript, not the whole thing.
 */
export async function classifyTurnEnd(
  db: Database,
  sessionId: string,
  turn: number
): Promise<{ state: "needs_you" | "done" | "idle"; reason: string } | null> {
  const path = transcriptPathForSession(db, sessionId);
  if (!path) return null;

  const page = await readTranscript(path, 12, sessionId);
  const transcript = page.messages
    .slice(-6)
    .map((m) => {
      const tools = m.toolCalls.map((c) => c.name).join(", ");
      const parts = [m.text, tools && `[used: ${tools}]`].filter(Boolean);
      return parts.length ? `${m.role}: ${parts.join(" ")}` : null;
    })
    .filter((line): line is string => !!line)
    .join("\n\n")
    .slice(-MAX_TRANSCRIPT_CHARS);
  if (!transcript.trim()) return null;

  const result = await decideTurnEnd(
    { db, sessionId, alias: getLaunchBySession(db, sessionId)?.launchedBy ?? null },
    transcript
  );
  if (result && isLatestTurn(sessionId, turn)) judgedTurnEnds.add(sessionId);
  return result;
}

/**
 * The turn-end decision itself, from a transcript tail, through the Decider
 * port for routing and audit, on this claude prompt. `runModel` is injectable
 * for tests.
 */
export async function decideTurnEnd(
  ctx: DecisionContext,
  transcript: string,
  runModel?: RunModel
): Promise<{ state: "needs_you" | "done" | "idle"; reason: string } | null> {
  const prompt =
    "An AI coding agent just ended its turn. From the recent conversation, " +
    "classify its state as exactly one of these labels:\n" +
    "NEEDS_YOU — it asked the user a question, or needs a decision, approval, or " +
    "input to continue.\n" +
    "DONE — it finished the requested work and has nothing pending.\n" +
    "IDLE — it stopped without clearly finishing or asking (e.g. mid-exchange).\n\n" +
    "Reply with the label on the first line (exactly NEEDS_YOU, DONE, or IDLE), " +
    "then a one-sentence reason.\n\n" +
    transcript;

  const outcome = await runDecision(
    ctx,
    {
      kind: "turn_end",
      state: transcript,
      question: "How did the AI coding agent's turn end?",
      options: TURN_END_OPTIONS,
    },
    {
      claude: claudeDecider({
        runModel,
        prompt: () => prompt,
        parse: (raw) => {
          const parsed = parseTurnEnd(raw);
          return { choice: TURN_END_KEYS[parsed.state], confidence: null, reason: parsed.reason };
        },
      }),
      claudeTimeoutMs: SUMMARIZE_TIMEOUT_MS,
    }
  );
  if (!outcome.answer) return null;
  const state = (Object.keys(TURN_END_KEYS) as Array<keyof typeof TURN_END_KEYS>).find(
    (s) => TURN_END_KEYS[s] === outcome.answer!.choice
  );
  return { state: state ?? "idle", reason: outcome.answer.reason ?? "" };
}

const TURN_END_KEYS = { needs_you: "NEEDS_YOU", done: "DONE", idle: "IDLE" } as const;
const TURN_END_OPTIONS: Record<string, string> = {
  NEEDS_YOU: "It asked the user a question, or needs a decision, approval, or input to continue.",
  DONE: "It finished the requested work and has nothing pending.",
  IDLE: "It stopped without clearly finishing or asking (e.g. mid-exchange).",
};

/**
 * Parses the classifier's reply — a label line (NEEDS_YOU / DONE / IDLE) plus
 * a reason — into a typed state. Unknown/garbled labels fall back to 'idle',
 * the do-nothing state. Pure, so the branch logic is unit-testable without a
 * model call.
 */
export function parseTurnEnd(raw: string): {
  state: "needs_you" | "done" | "idle";
  reason: string;
} {
  const lines = raw.split("\n");
  const label = (lines[0] ?? "").trim().toUpperCase();
  const rest = lines.slice(1).join(" ").trim();
  const reason = (rest || lines[0] || "").trim();
  const state = label.includes("NEEDS")
    ? "needs_you"
    : label.includes("DONE")
      ? "done"
      : "idle";
  const capped =
    reason.length > MAX_SUMMARY_CHARS ? `${reason.slice(0, MAX_SUMMARY_CHARS - 1)}…` : reason;
  return { state, reason: capped };
}

/**
 * Normalizes a model-produced title: strips surrounding quotes/backticks and a
 * trailing period (models add these despite the instruction), then caps the
 * length. Returns null if nothing usable is left. Pure, so it's unit-testable
 * without spawning a model.
 */
export function cleanTitle(raw: string): string | null {
  const stripped = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!stripped) return null;

  return capTitle(stripped);
}

/**
 * Whether the async title summarizer runs. DEFAULT ON — a fresh install
 * summarizes, since a succinct task-specific title is what the user expects.
 * Titling the first prompt is cheap (one Haiku call, once per session). Only an
 * explicit "0" disables it.
 */
const TITLE_SUMMARY_SETTING_KEY = "title_summary_enabled";

export function isTitleSummaryEnabled(db: Database): boolean {
  return getSetting(db, TITLE_SUMMARY_SETTING_KEY) !== "0";
}

export function setTitleSummaryEnabled(db: Database, enabled: boolean): void {
  setSetting(db, TITLE_SUMMARY_SETTING_KEY, enabled ? "1" : "0");
}

// Sessions whose title has already been handed to the summarizer, so a
// monitored session's later prompts (setInitialTitle fires on every one) don't
// re-fire the Haiku call. In-memory like the other per-session live state here;
// a collector restart just lets a still-open session be summarized once more,
// landing the same kind of title. Cleared on /clear and SessionEnd.
const titleSummaryScheduled = new Set<string>();

export function clearTitleSummaryState(sessionId: string): void {
  titleSummaryScheduled.delete(sessionId);
}

export interface TitleSummaryOptions {
  /** The title generator; injectable so the summarize path is testable without a model call. */
  generate?: (firstMessage: string) => Promise<string | null>;
  /** Called once, after the title is actually upgraded, to nudge clients to refetch. */
  onUpgraded?: (sessionId: string) => void;
}

/**
 * Upgrades a session's just-stored (capped, raw) title to a succinct Haiku one,
 * off the hook's critical path — for launched sessions as much as monitored
 * ones. This is the write-once relaxation the launched case needs: ensureSession
 * already stamped the capped task as the title, so updateSessionTitle's IS-NULL
 * guard would skip it forever; here the async upgrade overwrites that title in
 * place (guarded on it not having moved on — see upgradeSessionTitle).
 *
 * No-op — leaving the capped title as the final one — when: the setting is off;
 * this session was already summarized this run; the current title already fits
 * (a short label or short prompt is a fine title, only a truncated wall of text
 * is worth a model call); or the generator returns nothing / throws / times out.
 * Returns the new title when it upgraded, else null.
 */
export async function maybeSummarizeTitle(
  db: Database,
  sessionId: string,
  rawInput: string,
  options: TitleSummaryOptions = {}
): Promise<string | null> {
  if (!isTitleSummaryEnabled(db)) return null;
  if (titleSummaryScheduled.has(sessionId)) return null;

  const current = getSession(db, sessionId)?.title ?? "";
  // Only a title that had to be truncated is a wall of text worth a model call;
  // a short one — a launch label, a one-line prompt — is already a good title
  // (this also skips a labeled launch, whose short label never truncates). Gate
  // on whether the source input actually overran the cap, NOT on a trailing
  // ellipsis char: a short title that literally ends in "…" was not truncated.
  const collapsedInput = rawInput.replace(/\s+/g, " ").trim();
  if (capTitle(collapsedInput) === collapsedInput) return null;

  titleSummaryScheduled.add(sessionId);

  const generate = options.generate ?? generateSessionTitle;
  let title: string | null = null;
  try {
    title = await generate(rawInput);
  } catch {
    title = null;
  }
  if (!title) return null;

  const upgraded = upgradeSessionTitle(db, sessionId, title, current);
  if (upgraded) options.onUpgraded?.(sessionId);
  return upgraded ? title : null;
}
