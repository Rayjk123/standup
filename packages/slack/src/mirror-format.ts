// Renders a session turn into Slack from the channel-neutral OutputEvent stream
// (see turn-model.ts), walked in emission ORDER so the think→text→tool
// interleaving the terminal shows survives into Slack. Two surfaces draw from
// the same event model:
//   • the NATIVE streaming path — each event becomes a streaming chunk
//     (markdown_text for prose, a task_update card per tool call);
//   • the non-streaming FALLBACK — each event becomes a Block Kit block, posted
//     or edited in place when chat.startStream is unavailable.
// Pure (no I/O), so both surfaces are golden-testable. All content is redacted.

import type { KnownBlock } from "@slack/types";
import type { ToolResult } from "./collector-client.js";
import type { OutputEvent, Turn } from "./turn-model.js";
import type { StreamChunk, TaskCardChunk } from "./stream-client.js";
import { redact } from "./redact.js";

const SECTION_CAP = 2800; // headroom under Slack's 3000-char section limit
const THINK_CAP = 600; // reasoning has no client-side collapse in Slack — soft-cap it
const OUTPUT_CAP = 1600; // bash/diff/text bodies kept preview-sized in the thread
const STREAM_TEXT_CAP = 3900; // per-chunk cap for streamed assistant prose (headroom under Slack's markdown_text chunk limit)
const MAX_BLOCKS = 45; // headroom under Slack's 50-block message limit
const TITLE_CAP = 140; // task-card / plan title length
const PROMPT_CAP = 900; // mirrored user prompt length

function truncate(s: string, max: number): string {
  const t = s ?? "";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function oneLine(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function blockquote(s: string): string {
  return (s ?? "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function basename(p: string): string {
  const clean = (p ?? "").replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function k(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function fence(body: string): string {
  return "```\n" + truncate(body, OUTPUT_CAP) + "\n```";
}

/** Human-readable duration used in task-card elapsed suffixes and turn footers. */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const ctx = (text: string): KnownBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: truncate(text, SECTION_CAP) }],
});

const section = (text: string): KnownBlock => ({
  type: "section",
  text: { type: "mrkdwn", text: truncate(text, SECTION_CAP) },
});

/** One-line detail for a tool call header, pulled from the call input. */
function toolDetail(input: Record<string, unknown>): string {
  const u = input?.__unparsedToolInput;
  if (u && typeof u === "object") return "⚠ malformed input";
  const i = input ?? {};
  const detail =
    (i.file_path as string) ??
    (i.command as string) ??
    (i.pattern as string) ??
    (i.query as string) ??
    (i.description as string) ??
    "";
  return detail ? truncate(oneLine(String(detail)), 120) : "";
}

// ─── Streaming path — OutputEvent → stream chunks ──────────────────────────

/** A stable task-card id shared by a tool's `#call` and `#result` events. */
export function cardIdFor(eventId: string): string {
  return eventId.replace(/#(call|result)$/, "");
}

/** The plan-mode card title for a turn — its opening prompt, or a working label. */
export function planTitleForTurn(turn: Turn): string {
  for (const e of turn.events) {
    if (e.kind === "user") return truncate(oneLine(redact(e.text)) || "Working…", TITLE_CAP);
    if (e.kind === "localCommand") return truncate(`/${e.name}${e.args ? " " + e.args : ""}`, TITLE_CAP);
  }
  return "Working…";
}

/** A tool call's card title: `Name · detail`, optionally suffixed with elapsed. */
export function toolCardTitle(name: string, input: Record<string, unknown>, elapsedMs?: number): string {
  const detail = redact(toolDetail(input));
  let title = truncate(detail ? `${name} · ${detail}` : name, TITLE_CAP);
  if (elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs > 500) {
    title += ` · ${humanDuration(elapsedMs)}`;
  }
  return title;
}

/** The "is …" thread-status line for an event, or undefined if it sets none. */
export function statusLineForEvent(e: OutputEvent): string | undefined {
  switch (e.kind) {
    case "thinking":
      return "is thinking…";
    case "tool_call":
      return `is running ${e.name}…`;
    case "text":
      return "is responding…";
    default:
      return undefined;
  }
}

/** The streamed markdown body for a resolved tool result, or undefined if none. */
export function resultBodyMarkdown(result: ToolResult): string | undefined {
  switch (result.kind) {
    case "pending":
      return undefined;
    case "bash": {
      const parts: string[] = [];
      if (result.stdout.trim()) parts.push(redact(result.stdout));
      if (result.stderr.trim()) parts.push(`stderr: ${redact(result.stderr)}`);
      if (result.interrupted) parts.push("⚠ interrupted");
      return parts.length ? fence(parts.join("\n")) : "⎿ (no output)";
    }
    case "diff": {
      const lines: string[] = [];
      for (const h of result.hunks) {
        lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        for (const l of h.lines) lines.push(l);
      }
      const head = result.filePath ? `📝 \`${basename(result.filePath)}\`` : "📝 edit";
      return `${head}\n${fence(redact(lines.join("\n")))}`;
    }
    case "write":
      return `⎿ 📝 Wrote ${result.lineCount} lines to \`${basename(result.filePath)}\``;
    case "read": {
      const of = result.totalLines ? ` of ${result.totalLines}` : "";
      const where = result.filePath ? ` · \`${basename(result.filePath)}\`` : "";
      return `⎿ 📖 Read ${result.numLines ?? "?"}${of} lines${where}`;
    }
    case "todo": {
      const lines = result.todos.map((t) => {
        const label = redact(t.content ?? "");
        if (t.status === "completed") return `☑︎ ~${label}~`;
        if (t.status === "in_progress") return `▶ ${label}`;
        return `☐ ${label}`;
      });
      return lines.length ? lines.join("\n") : undefined;
    }
    case "question": {
      const parts = result.questions.map((q) => {
        const opts = q.options.map((o) => `• ${redact(o.label)}`).join("\n");
        const answered = q.answer ? `\n→ *${redact(q.answer)}*` : "";
        return `❓ ${redact(q.question)}${opts ? "\n" + opts : ""}${answered}`;
      });
      return parts.length ? parts.join("\n\n") : undefined;
    }
    case "agent":
      return `⎿ 🤖 → ${result.agentType ?? "agent"}${result.status ? ` · ${result.status}` : ""}`;
    case "text": {
      const body = result.text.trim();
      if (!body) return result.isError ? "⎿ ❌ error" : undefined;
      return `${result.isError ? "❌ " : ""}${fence(redact(body))}`;
    }
  }
}

/** The streamed markdown for a non-tool event, or undefined (tools are cards). */
export function markdownForEvent(e: OutputEvent): string | undefined {
  switch (e.kind) {
    case "user":
      return blockquote(`👤 *you:* ${truncate(redact(e.text), PROMPT_CAP)}`);
    case "localCommand": {
      const head = `⌨️ \`/${e.name}${e.args ? " " + e.args : ""}\``;
      return e.stdout.trim() ? `${head}\n${fence(redact(e.stdout))}` : head;
    }
    case "taskNotification":
      return `${/error|fail/i.test(e.status) ? "❌" : "✅"} 📋 ${redact(e.summary)}`;
    case "thinking": {
      // Same blank→undefined normalization the text case does: a whitespace-only
      // reasoning body has no visible content, so return undefined rather than a
      // bare "> _✻ _" blockquote. turnHasRenderableContent keys off this, so a turn
      // whose only in-window event is a blank thinking block stays content-free and
      // opens no stream.
      const body = truncate(oneLine(redact(e.text)), THINK_CAP);
      return body ? blockquote(`_✻ ${body}_`) : undefined;
    }
    case "text": {
      // Bounded like every sibling chunk — an uncapped multi-KB row would exceed
      // Slack's markdown_text chunk limit and get the whole append rejected. A
      // blank/whitespace-only text block (Claude emits one before going straight
      // to tool use) has no visible body: return undefined so no empty chunk is
      // streamed and turnHasRenderableContent — which keys off this — treats a
      // text-only-but-blank turn as content-free rather than opening a blank stream.
      const body = truncate(redact(e.text), STREAM_TEXT_CAP);
      return body.trim() ? body : undefined;
    }
    case "compaction":
      return `⟲ Conversation compacted (${e.trigger}): ${k(e.preTokens)} → ${k(e.postTokens)} tokens`;
    case "mode": {
      // Same guard, defensively: a mode row with no visible label renders nothing
      // rather than an empty "— —" divider.
      const label = redact(e.label);
      return label.trim() ? `— ${label} —` : undefined;
    }
    case "tool_call":
    case "tool_result":
    case "done":
      return undefined;
  }
}

/**
 * The full ordered chunk list for a COMPLETED turn — streamed as one message
 * then finalized. Tool calls emit a single `complete` card (no in_progress
 * flicker for history) carrying the result body as the card's collapsible
 * `output`, so tool bodies live inside their task block rather than as loose
 * inline code fences.
 */
export function streamChunksForTurn(turn: Turn): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const titleByCard = new Map<string, string>();
  for (const e of turn.events) {
    if (e.kind === "tool_call") {
      titleByCard.set(cardIdFor(e.id), toolCardTitle(e.name, e.input));
      continue;
    }
    if (e.kind === "tool_result") {
      const id = cardIdFor(e.id);
      const title = titleByCard.get(id) ?? e.name;
      const output = resultBodyMarkdown(e.result);
      const card: TaskCardChunk = { type: "task_update", id, title, status: "complete" };
      if (output) card.output = output;
      chunks.push(card);
      continue;
    }
    const md = markdownForEvent(e);
    if (md) chunks.push({ type: "markdown_text", text: md });
  }
  return chunks;
}

// ─── Fallback path — OutputEvent → Block Kit ───────────────────────────────

/** Renders a resolved tool result as its own block(s), per result kind. */
function renderResult(result: ToolResult): KnownBlock[] {
  switch (result.kind) {
    case "pending":
      return [ctx("⎿ ⏳ …")];
    case "bash": {
      const parts: string[] = [];
      if (result.stdout.trim()) parts.push(redact(result.stdout));
      if (result.stderr.trim()) parts.push(`stderr: ${redact(result.stderr)}`);
      if (result.interrupted) parts.push("⚠ interrupted");
      if (parts.length === 0) return [ctx("⎿ (no output)")];
      return [section(fence(parts.join("\n")))];
    }
    case "diff": {
      const lines: string[] = [];
      for (const h of result.hunks) {
        lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        for (const l of h.lines) lines.push(l);
      }
      const head = result.filePath ? `📝 ${basename(result.filePath)}` : "📝 edit";
      return [ctx(head), section(fence(redact(lines.join("\n"))))];
    }
    case "write":
      return [ctx(`⎿ 📝 Wrote ${result.lineCount} lines to \`${basename(result.filePath)}\``)];
    case "read": {
      const of = result.totalLines ? ` of ${result.totalLines}` : "";
      const where = result.filePath ? ` · \`${basename(result.filePath)}\`` : "";
      return [ctx(`⎿ 📖 Read ${result.numLines ?? "?"}${of} lines${where}`)];
    }
    case "todo": {
      const lines = result.todos.map((t) => {
        const label = redact(t.content ?? "");
        if (t.status === "completed") return `☑︎ ~${label}~`;
        if (t.status === "in_progress") return `▶ ${label}`;
        return `☐ ${label}`;
      });
      return lines.length ? [section(lines.join("\n"))] : [];
    }
    case "question": {
      const blocks: KnownBlock[] = [];
      for (const q of result.questions) {
        const opts = q.options.map((o) => `• ${redact(o.label)}`).join("\n");
        const answered = q.answer ? `\n→ *${redact(q.answer)}*` : "";
        blocks.push(section(`❓ ${redact(q.question)}${opts ? "\n" + opts : ""}${answered}`));
      }
      return blocks;
    }
    case "agent":
      return [ctx(`⎿ 🤖 → ${result.agentType ?? "agent"}${result.status ? ` · ${result.status}` : ""}`)];
    case "text": {
      const body = result.text.trim();
      if (!body) return result.isError ? [ctx("⎿ ❌ error")] : [];
      return [section(`${result.isError ? "❌ " : ""}${fence(redact(body))}`)];
    }
  }
}

/** One OutputEvent → its Slack block(s). */
function renderEvent(e: OutputEvent): KnownBlock[] {
  switch (e.kind) {
    case "user":
      return [ctx(`👤 *you:* ${truncate(redact(e.text), PROMPT_CAP)}`)];
    case "localCommand": {
      const head = ctx(`⌨️ \`/${e.name}${e.args ? " " + e.args : ""}\``);
      return e.stdout.trim() ? [head, section(fence(redact(e.stdout)))] : [head];
    }
    case "taskNotification":
      return [ctx(`${/error|fail/i.test(e.status) ? "❌" : "✅"} 📋 ${redact(e.summary)}`)];
    case "thinking":
      return [ctx(`✻ _${truncate(oneLine(redact(e.text)), THINK_CAP)}_`)];
    case "text": {
      // A blank/whitespace-only text block renders no block, so it never posts an
      // empty section (Slack rejects blank section text) in the fallback path.
      const body = redact(e.text);
      return body.trim() ? [section(body)] : [];
    }
    case "tool_call": {
      const detail = toolDetail(e.input);
      return [ctx(`⏺ \`${e.name}\`${detail ? ` ${redact(detail)}` : ""}`)];
    }
    case "tool_result":
      return renderResult(e.result);
    case "compaction":
      return [ctx(`⟲ Conversation compacted (${e.trigger}): ${k(e.preTokens)} → ${k(e.postTokens)} tokens`)];
    case "mode":
      return [ctx(`— ${redact(e.label)} —`)];
    case "done":
      return [];
  }
}

/** Render one turn as ordered Slack blocks, bounded under the block budget. */
export function renderTurn(turn: Turn, footer?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let truncated = false;

  for (const e of turn.events) {
    if (blocks.length >= MAX_BLOCKS - 1) {
      truncated = true;
      break;
    }
    for (const b of renderEvent(e)) {
      if (blocks.length >= MAX_BLOCKS - 1) {
        truncated = true;
        break;
      }
      blocks.push(b);
    }
  }

  if (truncated) {
    blocks.push(ctx("… more in the terminal / Open in Standup"));
  }

  // A turn with nothing renderable (rare) still needs a block for chat.update.
  if (blocks.length === 0) {
    blocks.push(ctx("…"));
  }
  // Live-turn footer (elapsed / context) — only passed for the current turn.
  if (footer) blocks.push(ctx(footer));
  return blocks;
}

/** Plain-text fallback for a turn (notifications / no-blocks clients). */
export function turnFallback(turn: Turn): string {
  for (const e of turn.events) {
    if (e.kind === "user") return `you: ${truncate(redact(e.text), 120)}`;
    if (e.kind === "text") return `claude: ${truncate(redact(e.text), 120)}`;
    if (e.kind === "tool_call") return `claude: ${e.name}`;
  }
  return "session activity";
}
