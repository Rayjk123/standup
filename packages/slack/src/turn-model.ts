// Channel-neutral event/turn model over the RichRow vocabulary.
//
// The mirror used to read the DISTILLED transcript (packages/collector/src/
// transcript.ts) — a reader that drops thinking and flattens every tool result
// to one `output` string. This model instead projects the FULL-FIDELITY rich
// feed (RichRow, packages/collector/src/rich-transcript.ts) into an ordered
// stream of surface-agnostic OutputEvents. A renderer for any surface — Slack
// today, a streaming task-card driver next — walks the events in emission ORDER,
// so the think→text→tool interleaving the terminal shows survives everywhere.
//
// A RichRow `tool` splits into two ordered events: a `tool_call` (name + input)
// immediately followed by a `tool_result` (the STRUCTURED outcome — diff hunks,
// bash stdout/stderr, todo items, Read/Write counts). That pairing matches the
// terminal's `⏺ Name(arg)` header + `⎿` result line and gives a streaming
// surface a natural open-card / fill-card boundary.

import type { RichRow, ToolResult } from "./collector-client.js";

interface EventBase {
  /** Stable id carried from the source row (tool rows suffix `#call`/`#result`). */
  id: string;
  /** ISO timestamp of the source row. */
  ts: string;
}

/**
 * A surface-agnostic turn event. `done` is a synthetic lifecycle marker emitted
 * by a streaming driver at turn end (stopStream); it is never derived from a
 * transcript row, so `parseRichTurns` does not produce it.
 */
export type OutputEvent = EventBase &
  (
    | { kind: "user"; text: string; sentBy?: string }
    | { kind: "localCommand"; name: string; args: string; stdout: string }
    | { kind: "taskNotification"; summary: string; status: string }
    | { kind: "thinking"; text: string }
    | { kind: "text"; text: string }
    | { kind: "tool_call"; name: string; input: Record<string, unknown> }
    | { kind: "tool_result"; name: string; result: ToolResult }
    | { kind: "compaction"; trigger: string; preTokens: number; postTokens: number }
    | { kind: "mode"; label: string }
    | { kind: "done" }
  );

/**
 * A turn = a user/local-command prompt plus the assistant work that follows,
 * modeled as an ORDERED event list. An assistant-led turn (the tail window began
 * mid-conversation, so its opening prompt aged out) has no leading prompt event.
 */
export interface Turn {
  /** First event's row id — a stable key across transcript re-reads. */
  key: string;
  /** First event's ISO timestamp, for the live-turn elapsed footer. */
  startedAt?: string;
  events: OutputEvent[];
}

/** One RichRow → its ordered OutputEvent(s), preserving structure. */
function rowToEvents(row: RichRow): OutputEvent[] {
  switch (row.kind) {
    case "user":
      return [{ id: row.id, ts: row.timestamp, kind: "user", text: row.text, sentBy: row.sentBy }];
    case "localCommand":
      return [
        { id: row.id, ts: row.timestamp, kind: "localCommand", name: row.name, args: row.args, stdout: row.stdout },
      ];
    case "taskNotification":
      return [
        { id: row.id, ts: row.timestamp, kind: "taskNotification", summary: row.summary, status: row.status },
      ];
    case "thinking":
      return [{ id: row.id, ts: row.timestamp, kind: "thinking", text: row.text }];
    case "text":
      return [{ id: row.id, ts: row.timestamp, kind: "text", text: row.text }];
    case "tool":
      return [
        { id: `${row.id}#call`, ts: row.timestamp, kind: "tool_call", name: row.name, input: row.input },
        { id: `${row.id}#result`, ts: row.timestamp, kind: "tool_result", name: row.name, result: row.result },
      ];
    case "compaction":
      return [
        {
          id: row.id,
          ts: row.timestamp,
          kind: "compaction",
          trigger: row.trigger,
          preTokens: row.preTokens,
          postTokens: row.postTokens,
        },
      ];
    case "mode":
      return [{ id: row.id, ts: row.timestamp, kind: "mode", label: row.label }];
  }
}

/**
 * Group the ordered rich-row stream into turns. A `user` or `localCommand` row
 * begins a new turn; every other row appends to the current one. The first row
 * of an assistant-led tail opens a turn with no prompt event.
 */
export function parseRichTurns(rows: RichRow[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;

  for (const row of rows) {
    const startsTurn = row.kind === "user" || row.kind === "localCommand";
    if (startsTurn || cur === null) {
      cur = { key: row.id, startedAt: row.timestamp, events: [] };
      turns.push(cur);
    }
    for (const ev of rowToEvents(row)) cur.events.push(ev);
  }
  return turns;
}

/** True when the turn opens with a real prompt (user text or a slash command). */
export function turnHasPrompt(t: Turn): boolean {
  const first = t.events[0];
  return !!first && (first.kind === "user" || first.kind === "localCommand");
}

/** The turn's opening user prompt text, if it began with one (for titling). */
export function turnPromptText(t: Turn): string | undefined {
  const first = t.events[0];
  return first && first.kind === "user" ? first.text : undefined;
}

function resultSig(r: ToolResult): string {
  switch (r.kind) {
    case "pending":
      return "p";
    case "bash":
      return `b${r.stdout.length + r.stderr.length}${r.interrupted ? "!" : ""}`;
    case "diff":
      return `d${r.hunks.reduce((n, h) => n + h.lines.length, 0)}`;
    case "write":
      return `w${r.lineCount}`;
    case "read":
      return `rd${r.numLines ?? ""}`;
    case "todo":
      return `t${r.todos.map((td) => (td.status ?? "")[0] ?? "").join("")}`;
    case "question":
      return `q${r.questions.map((q) => (q.answer ? "a" : "-")).join("")}`;
    case "agent":
      return `ag${r.status ?? ""}`;
    case "text":
      return `tx${r.text.length}${r.isError ? "e" : ""}`;
  }
}

function eventSig(e: OutputEvent): string {
  switch (e.kind) {
    case "user":
      return `u${e.text.length}`;
    case "localCommand":
      return `lc${e.name}${e.args.length}`;
    case "taskNotification":
      return `n${e.status}`;
    case "thinking":
      return `k${e.text.length}`;
    case "text":
      return `t${e.text.length}`;
    case "tool_call":
      return `c${e.name}`;
    case "tool_result":
      return `r${resultSig(e.result)}`;
    case "compaction":
      return "x";
    case "mode":
      return `m${e.label}`;
    case "done":
      return "done";
  }
}

/**
 * Cheap content signature to skip no-op chat.update calls on the live turn. It
 * folds text/thinking lengths and each tool's resolved result (so a pending →
 * resolved transition, or a growing bash log, changes the signature) without
 * serializing whole payloads.
 */
export function turnSignature(t: Turn): string {
  return t.events.map(eventSig).join("|");
}
