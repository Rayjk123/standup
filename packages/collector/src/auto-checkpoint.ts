import { mkdirSync } from "fs";
import type { Database } from "bun:sqlite";
import { AUTO_CHECKPOINT_CWD } from "./internal-cwd.js";
import { createCheckpoint, getSetting, setSetting } from "@standup/store";
import type { Checkpoint } from "@standup/shared";
import { readTranscript, transcriptPathForSession } from "./transcript.js";

/**
 * Auto-checkpointing: agents only show up in the feed if they call
 * `checkpoint` themselves, and nothing makes them do that unless they're
 * told to (see docs/agent-instructions.md) — a monitored session with no
 * CLAUDE.md snippet checkpoints nothing, ever, no matter how much work it
 * does. This fills that gap from the outside: at every turn boundary, a
 * cheap model reads what's new in the transcript since the last check and
 * decides whether it was checkpoint-worthy.
 *
 * Off by default. A Haiku call through the `claude` CLI costs real money —
 * mostly cache-creation overhead from Claude Code's own system prompt, not
 * the actual summarization — every time it fires, across every session.
 * Toggle via the global setting rather than env var, so it can be switched
 * off live if it gets expensive or noisy without restarting the collector.
 */

const SETTING_KEY = "auto_checkpoint_enabled";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SUMMARIZE_TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 12_000; // keeps the prompt — and its cost — bounded
const MAX_SUMMARY_CHARS = 280;
const MAX_TITLE_CHARS = 70; // a title, not a sentence
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
 * fires its own Stop event, recursing without bound. Verified live: this
 * happened for real, three generations deep, before the setting was
 * manually flipped back off cut it short.
 */
export { AUTO_CHECKPOINT_CWD };

// Per-session watermark: the transcript message already considered as of the
// last fire, so a repeated call only sees what's new. In-memory, like the
// other per-session live state in this file's siblings (checkpointedTodos,
// nudge cooldowns) — a collector restart just means the next fire re-reads
// a bit of already-seen transcript, not that it misses anything.
const lastSeenUuid = new Map<string, string>();

export function isAutoCheckpointEnabled(db: Database): boolean {
  return getSetting(db, SETTING_KEY) === "1";
}

export function setAutoCheckpointEnabled(db: Database, enabled: boolean): void {
  setSetting(db, SETTING_KEY, enabled ? "1" : "0");
}

export function clearAutoCheckpointState(sessionId: string): void {
  lastSeenUuid.delete(sessionId);
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

  const page = await readTranscript(path, 60);
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
 * One `claude -p` Haiku call, returning its trimmed text (or null on any
 * failure). Always runs from AUTO_CHECKPOINT_CWD — the reserved cwd server.ts
 * no-ops on — so this subprocess's own SessionStart/Stop hooks don't create a
 * phantom session or, worse, recurse. Shared by every cheap-model use here
 * (checkpoint summaries, session titles).
 */
async function runHaiku(
  prompt: string,
  timeoutMs = SUMMARIZE_TIMEOUT_MS
): Promise<string | null> {
  mkdirSync(AUTO_CHECKPOINT_CWD, { recursive: true });

  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", HAIKU_MODEL, "--tools", "", "--output-format", "json"],
    { cwd: AUTO_CHECKPOINT_CWD, stdout: "pipe", stderr: "pipe" }
  );
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;

    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (parsed.is_error || !parsed.result) return null;

    const result = parsed.result.trim();
    return result || null;
  } catch (err) {
    console.error("[haiku] call failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function summarize(transcript: string): Promise<string | null> {
  const prompt =
    "Here is a slice of an AI coding agent's conversation with its user. " +
    "In one sentence, state what was accomplished, decided, or blocked on. " +
    'If nothing checkpoint-worthy happened yet — routine back-and-forth, no ' +
    'clear outcome — reply with exactly: NONE\n\n' +
    transcript;

  const result = await runHaiku(prompt);
  if (!result || result.toUpperCase() === "NONE") return null;

  return result.length > MAX_SUMMARY_CHARS
    ? `${result.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : result;
}

/**
 * A short, task-specific session title generated from the first user message.
 *
 * Used in place of "the first 150 characters of the prompt" when
 * auto-checkpoint is on (the same cheap-model budget the user already opted
 * into). Returns null on any failure so the caller can fall back to the plain
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

  const result = await runHaiku(prompt);
  return result ? cleanTitle(result) : null;
}

/**
 * Normalizes a model-produced title: strips surrounding quotes/backticks and a
 * trailing period (models add these despite the instruction), then caps the
 * length. Returns null if nothing usable is left. Pure, so it's unit-testable
 * without spawning a model.
 */
export function cleanTitle(raw: string): string | null {
  const title = raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!title) return null;

  return title.length > MAX_TITLE_CHARS
    ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…`
    : title;
}
