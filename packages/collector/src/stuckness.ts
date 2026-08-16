import type { Database } from "bun:sqlite";
import { getEventsBySession } from "@standup/store";
import { STUCKNESS } from "@standup/shared";
import type { ToolUsePayload } from "@standup/shared";

export interface StucknessSignal {
  /** Stable key for cooldown bookkeeping — one per topic, per session. */
  topic: string;
  /** Shown to the human in the feed, not to the agent. */
  reason: string;
}

/**
 * Cheap heuristics over the event stream. The design is explicit that a
 * watcher model over every tool call is too expensive and too noisy — these
 * gate that spend: only once a heuristic fires is it worth doing anything
 * more expensive.
 *
 * Every heuristic here is computed from events already in SQLite. Nothing
 * calls a model, and nothing blocks the agent.
 */

/** How many recent events each heuristic looks back over. */
const WINDOW = 60;

interface ToolEvent {
  seq: number;
  name: string;
  input: Record<string, unknown>;
  response?: unknown;
  isPost: boolean;
}

function recentToolEvents(db: Database, sessionId: string): ToolEvent[] {
  const events = getEventsBySession(db, sessionId, WINDOW, 0);
  const tail = events.slice(-WINDOW);

  return tail
    .filter((e) => e.type === "PreToolUse" || e.type === "PostToolUse")
    .map((e) => {
      const p = e.payload as unknown as ToolUsePayload;
      return {
        seq: e.seq,
        name: p.tool_name ?? "",
        input: p.tool_input ?? {},
        response: p.tool_response,
        isPost: e.type === "PostToolUse",
      };
    });
}

function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    try {
      return JSON.stringify(response);
    } catch {
      return "";
    }
  }
  return "";
}

/** Same search pattern run repeatedly, coming back empty each time. */
function repeatedEmptySearch(events: ToolEvent[]): StucknessSignal | null {
  const emptyByPattern = new Map<string, number>();

  for (const event of events) {
    if (!event.isPost) continue;
    if (!["Grep", "Glob", "ripgrep"].includes(event.name)) continue;

    const pattern = String(event.input.pattern ?? event.input.query ?? "");
    if (!pattern) continue;

    const text = responseText(event.response);
    const looksEmpty =
      text === "" ||
      /no matches|no files found|found 0 |"matches":\s*\[\]/i.test(text);
    if (!looksEmpty) continue;

    const count = (emptyByPattern.get(pattern) ?? 0) + 1;
    emptyByPattern.set(pattern, count);

    if (count >= STUCKNESS.REPEATED_EMPTY_SEARCH) {
      return {
        topic: "search",
        reason: `Searched for "${pattern.slice(0, 40)}" ${count}× with no results`,
      };
    }
  }

  return null;
}

/** A run of failing shell commands. */
function consecutiveBashFailures(events: ToolEvent[]): StucknessSignal | null {
  let streak = 0;

  for (const event of events) {
    if (!event.isPost || event.name !== "Bash") continue;

    const text = responseText(event.response);
    // Bash tool responses don't carry a structured exit code, so fall back
    // to the error markers the harness includes on failure.
    const failed = /"is_error":\s*true|exit code [1-9]|command not found|No such file/i.test(
      text
    );

    streak = failed ? streak + 1 : 0;
    if (streak >= STUCKNESS.CONSECUTIVE_BASH_FAILURES) {
      return {
        topic: "bash",
        reason: `${streak} consecutive failing shell commands`,
      };
    }
  }

  return null;
}

/** Lots of reading, no writing — looking rather than progressing. */
function readOnlyChain(events: ToolEvent[]): StucknessSignal | null {
  const WRITES = new Set(["Edit", "Write", "NotebookEdit"]);
  let readsSinceWrite = 0;

  for (const event of events) {
    if (event.isPost) continue;
    if (WRITES.has(event.name)) {
      readsSinceWrite = 0;
      continue;
    }
    readsSinceWrite++;
  }

  if (readsSinceWrite >= STUCKNESS.READ_ONLY_TOOL_CHAIN) {
    return {
      topic: "reading",
      reason: `${readsSinceWrite} tool calls without an edit`,
    };
  }

  return null;
}

/** The same file read over and over inside one stretch of work. */
function repeatedFileReads(events: ToolEvent[]): StucknessSignal | null {
  const reads = new Map<string, number>();

  for (const event of events) {
    if (event.isPost || event.name !== "Read") continue;
    const path = String(event.input.file_path ?? "");
    if (!path) continue;

    const count = (reads.get(path) ?? 0) + 1;
    reads.set(path, count);

    if (count >= STUCKNESS.FILE_REREAD_THRESHOLD) {
      return {
        topic: "reread",
        reason: `Read ${path.split("/").pop()} ${count}× in this stretch`,
      };
    }
  }

  return null;
}

export function detectStuckness(
  db: Database,
  sessionId: string
): StucknessSignal | null {
  const events = recentToolEvents(db, sessionId);
  if (events.length < 5) return null;

  // Ordered most- to least- specific: a precise signal makes a better nudge
  // than "you've been reading a while".
  return (
    repeatedEmptySearch(events) ??
    consecutiveBashFailures(events) ??
    repeatedFileReads(events) ??
    readOnlyChain(events)
  );
}
