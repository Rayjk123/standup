import { existsSync } from "fs";
import { stat, open } from "fs/promises";
import { createHash } from "crypto";
import type { Database } from "bun:sqlite";
import {
  appendEvent,
  getLatestEventMark,
  headSeq,
  reconcilePendingReply,
  type LatestEventMark,
} from "@standup/store";

/**
 * Reader for Claude Code's session transcripts.
 *
 * See docs/claude-code-internals.md for the format. Two properties drive
 * the design here:
 *
 *   - The transcript is *complete*, covering the whole session including
 *     anything before Standup started observing. A session monitored from
 *     halfway through still yields full history.
 *   - It is large — 8 MB / 4000+ lines for one working session — so it is
 *     read tail-first and paginated, never parsed whole per request.
 *
 * The format is undocumented and can change between versions, so every
 * record is parsed defensively: anything unrecognized is skipped rather
 * than throwing, and a failure degrades to an empty transcript instead of
 * taking down the request.
 */

export type TranscriptRole = "user" | "assistant";

export interface TranscriptToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The matching tool_result's text, if one arrived — undefined while pending. */
  output?: string;
  isError?: boolean;
}

/**
 * A slash command run through Claude Code's `!`/`/` passthrough — `/model`,
 * `/login`, etc. These arrive as three separate consecutive `user` records
 * whose content is an XML-ish tag string, not a structured field: a
 * `<local-command-caveat>`, one carrying `<command-name>`/
 * `<command-message>`/`<command-args>`, and a `<local-command-stdout>`.
 * Detected and merged into one entry rather than shown as raw tags, or as
 * three separate "you" turns for what is really one action.
 */
export interface LocalCommand {
  name: string;
  args: string;
  stdout: string;
}

/**
 * A background-task completion the harness injects as a `user` record whose
 * content is a `<task-notification>` XML blob — task id, output-file path, a
 * one-line `<summary>`, and a `<result>` that can be tens of thousands of
 * characters. Claude Code's own TUI collapses this to the summary line, so the
 * whole payload is parsed down to `{ summary, status }` rather than dumped as
 * something the human said.
 */
export interface TaskNotification {
  summary: string;
  status: string;
}

export interface TranscriptMessage {
  uuid: string;
  role: TranscriptRole;
  timestamp: string;
  /** Prose only — thinking blocks are excluded, see extractText. */
  text: string;
  /**
   * Extended-thinking prose, kept separate from `text`. Undefined when the
   * turn had none. See extractThinking — the default view ignores it, the
   * terminal view surfaces it the way Claude Code's own TUI does.
   */
  thinking?: string;
  toolCalls: TranscriptToolCall[];
  /** Set instead of `text` when this record is a merged local-command triple. */
  localCommand?: LocalCommand;
  /** Set instead of `text` when this record is an injected task-notification. */
  taskNotification?: TaskNotification;
  /** Output tokens for this message; additive across a session. */
  outputTokens?: number;
  /** Context size at this turn; a point-in-time reading, not additive. */
  contextTokens?: number;
  model?: string;
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  /** True when older messages exist before the returned window. */
  hasMore: boolean;
  totalMessages: number;
  /**
   * Sum of output tokens — the one usage figure that is genuinely additive
   * across a conversation.
   *
   * Input and cache-read counts are *not* summable: every turn re-sends the
   * whole history, so adding them across messages counts the same context
   * once per turn. Doing that naively reported 43M tokens for a session that
   * had used a small fraction of that.
   */
  outputTokens: number;
  /** Context size at the most recent turn — a point-in-time reading. */
  contextTokens: number;
}

/** Bytes read from the end of the file when tailing. */
const TAIL_BYTES = 512 * 1024;

export interface RawRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  /**
   * The session this record belongs to. Claude Code stamps it on every real
   * record (see docs/claude-code-internals.md). A record whose `sessionId`
   * differs from the session that owns the file is a foreign conversation
   * copied in (resume/compaction copies the parent turns, each keeping its
   * original id) and must not be attributed to this session.
   */
  sessionId?: string;
  /** Present on an optimistic/reconciled reply: the actor who sent it. */
  sentBy?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, number>;
  };
}

/**
 * Pulls displayable prose out of a content field.
 *
 * `thinking` blocks are excluded here and captured separately by
 * extractThinking: the default transcript view keeps `text` prose-only so it
 * reads as a conversation, while the terminal view can surface the reasoning
 * the way Claude Code's own TUI does.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string"
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Pulls extended-thinking prose out of a content field. A thinking block is
 * `{ type: "thinking", thinking: "…" }`; some records instead carry the text
 * under `text`, so both are accepted defensively.
 */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "thinking"
    )
    .map((block) => {
      const b = block as { thinking?: unknown; text?: unknown };
      if (typeof b.thinking === "string") return b.thinking;
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .join("\n")
    .trim();
}

interface ToolResultInfo {
  text: string;
  isError: boolean;
}

function extractToolCalls(
  content: unknown,
  results: Map<string, ToolResultInfo>
): TranscriptToolCall[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter(
      (block) =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use"
    )
    .map((block) => {
      const b = block as { id?: string; name?: string; input?: unknown };
      const result = b.id ? results.get(b.id) : undefined;
      return {
        id: b.id ?? "",
        name: b.name ?? "unknown",
        input: (b.input as Record<string, unknown>) ?? {},
        output: result?.text,
        isError: result?.isError,
      };
    });
}

/**
 * tool_result blocks live on the *next* `user` record, keyed by
 * `tool_use_id` rather than nested under the tool call itself. Scanned once
 * up front so each tool_use can look its own result up by id.
 */
function extractToolResults(raws: RawRecord[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();

  for (const raw of raws) {
    if (raw.type !== "user") continue;
    const content = raw.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      map.set(b.tool_use_id, {
        text: extractText(b.content),
        isError: !!b.is_error,
      });
    }
  }

  return map;
}

/**
 * Whether a transcript record belongs to `sessionId`.
 *
 * A single JSONL file can legitimately hold more than one session's records:
 * Claude Code's resume/compaction copies the parent conversation into the new
 * file, and every copied record keeps its ORIGINAL `sessionId`. Rendering the
 * whole file would then leak another session's turns into this session's view
 * (its Slack thread, its durable event log). Filtering by the owning session's
 * id is the per-session isolation guard.
 *
 * A record with no `sessionId` is an un-attributable out-of-band UI-state line
 * (mode / permission-mode / last-prompt) — kept, since it carries no foreign
 * identity to reject and dropping it would lose the mode/permission banners.
 * With no `sessionId` requested (undefined) the filter is a no-op.
 */
export function recordBelongsToSession(
  raw: { sessionId?: string },
  sessionId: string | undefined
): boolean {
  if (!sessionId) return true;
  if (typeof raw.sessionId !== "string" || raw.sessionId === "") return true;
  return raw.sessionId === sessionId;
}

/**
 * A `user` record is not always a human turn: tool results are delivered as
 * user messages too, and rendering those as things the human said is
 * actively misleading.
 */
function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "tool_result"
  );
}

/**
 * Recognizes an injected `<task-notification>` record and pulls out just the
 * summary and status. Returns null for anything else, and for a notification
 * whose summary can't be found — falling back to the normal text path is
 * better than rendering an empty entry.
 */
export function parseTaskNotification(content: unknown): TaskNotification | null {
  const text = typeof content === "string" ? content : extractText(content);
  if (!/^\s*<task-notification>/.test(text)) return null;

  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  if (!summary) return null;
  const status = text.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ?? "";
  return { summary, status };
}

const LOCAL_COMMAND_CAVEAT_RE = /^<local-command-caveat>/;
const LOCAL_COMMAND_NAME_RE =
  /<command-name>([^<]*)<\/command-name>\s*<command-message>([^<]*)<\/command-message>\s*<command-args>([^<]*)<\/command-args>/;
const LOCAL_COMMAND_STDOUT_RE = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

function rawText(raw: RawRecord): string {
  const content = raw.message?.content;
  return typeof content === "string" ? content : "";
}

export interface LocalCommandMatch {
  command: LocalCommand;
  /** Extra records consumed after the caveat record — 2 with stdout, else 1. */
  consumed: number;
}

/**
 * Detects a local-command triple starting at `raws[i]` (caveat, then the
 * name/args record, then stdout) and merges it into one LocalCommand. Returns
 * null when `raws[i]` is not a local-command caveat. Shared by both transcript
 * readers so the merge logic lives in one place.
 */
export function detectLocalCommand(
  raws: RawRecord[],
  i: number
): LocalCommandMatch | null {
  const raw = raws[i];
  if (raw?.type !== "user" || !LOCAL_COMMAND_CAVEAT_RE.test(rawText(raw))) return null;

  const nameRaw = raws[i + 1];
  const nameMatch =
    nameRaw?.type === "user" ? rawText(nameRaw).match(LOCAL_COMMAND_NAME_RE) : null;
  if (!nameMatch) return null;

  const stdoutRaw = raws[i + 2];
  const stdoutMatch =
    stdoutRaw?.type === "user" ? rawText(stdoutRaw).match(LOCAL_COMMAND_STDOUT_RE) : null;

  return {
    command: { name: nameMatch[1], args: nameMatch[3], stdout: stdoutMatch?.[1] ?? "" },
    consumed: stdoutMatch ? 2 : 1,
  };
}

function toMessage(
  raw: RawRecord,
  results: Map<string, ToolResultInfo>
): TranscriptMessage | null {
  if (raw.type !== "user" && raw.type !== "assistant") return null;

  const content = raw.message?.content;
  if (raw.type === "user" && isToolResultOnly(content)) return null;

  if (raw.type === "user") {
    const notification = parseTaskNotification(content);
    if (notification) {
      return {
        uuid: raw.uuid ?? "",
        role: "user",
        timestamp: raw.timestamp ?? "",
        text: "",
        toolCalls: [],
        taskNotification: notification,
      };
    }
  }

  const text = extractText(content);
  const toolCalls = extractToolCalls(content, results);
  const thinking = extractThinking(content);
  // A record with nothing displayable and no reasoning is noise. Thinking
  // alone is kept: Claude Code writes it as its own record ahead of the turn
  // it belongs to, and parseLines folds it onto that following message.
  if (!text && toolCalls.length === 0 && !thinking) return null;

  const usage = raw.message?.usage;

  return {
    uuid: raw.uuid ?? "",
    role: raw.type,
    timestamp: raw.timestamp ?? "",
    text,
    thinking: thinking || undefined,
    toolCalls,
    outputTokens: usage?.output_tokens,
    contextTokens: usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      : undefined,
    model: raw.message?.model,
  };
}

function parseLines(lines: string[], sessionId?: string): TranscriptMessage[] {
  const raws: RawRecord[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as RawRecord;
      if (!recordBelongsToSession(raw, sessionId)) continue;
      raws.push(raw);
    } catch {
      // Truncated or unrecognized record — skipping one line is always
      // preferable to failing the whole read.
    }
  }

  const results = extractToolResults(raws);
  const messages: TranscriptMessage[] = [];
  // Thinking arrives in its own record just before the turn it belongs to,
  // so it is held here and folded onto the next message that has real content.
  let pendingThinking = "";

  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (raw.type !== "user") {
      const message = toMessage(raw, results);
      if (!message) continue;

      const thinkingOnly = !message.text && message.toolCalls.length === 0;
      if (thinkingOnly && message.thinking) {
        pendingThinking = pendingThinking
          ? `${pendingThinking}\n${message.thinking}`
          : message.thinking;
        continue;
      }

      if (pendingThinking) {
        message.thinking = message.thinking
          ? `${pendingThinking}\n${message.thinking}`
          : pendingThinking;
        pendingThinking = "";
      }
      messages.push(message);
      continue;
    }

    // A local-command caveat is followed by the name/args record and then the
    // stdout record; merged into one entry and the extra records consumed so
    // they don't also get pushed as their own (unreadable) entries.
    const local = detectLocalCommand(raws, i);
    if (local) {
      messages.push({
        uuid: raw.uuid ?? "",
        role: "user",
        timestamp: raw.timestamp ?? "",
        text: "",
        toolCalls: [],
        localCommand: local.command,
      });
      i += local.consumed;
      continue;
    }

    const message = toMessage(raw, results);
    if (message) messages.push(message);
  }

  return messages;
}

/** Reads the last `bytes` of a file, dropping a partial first line. */
export async function readTail(
  path: string,
  bytes: number = TAIL_BYTES
): Promise<{ text: string; partial: boolean }> {
  const { size } = await stat(path);
  const start = Math.max(0, size - bytes);

  const handle = await open(path, "r");
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    noteRead(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), partial: start > 0 };
  } finally {
    await handle.close();
  }
}

/** Bytes read per step when walking a transcript forward during ingest. */
export const INGEST_CHUNK_BYTES = 1024 * 1024;

/** Bytes read per step when scanning a transcript backward for its model. */
const MODEL_CHUNK_BYTES = 64 * 1024;

/**
 * How many transcript reads may hold a buffer at once, across every session.
 * A burst of cold ingests (a restart, or a viewer opening a host with
 * thousands of sessions) otherwise reads every file at once; with the cap,
 * transcript memory is bounded by this many chunks however many sessions are
 * busy. A slot is held per chunk, not per file, so a 300 MB backfill cannot
 * starve a live session's small delta. The per-request tail reads
 * (readTranscript, readRichTranscript) share the same slots.
 */
const MAX_CONCURRENT_READS = 4;

let activeReads = 0;
const readWaiters: Array<() => void> = [];

/**
 * Running totals of transcript reads: bytes read, the largest single read,
 * and the most slots held at once. Tests pin the memory bounds against these.
 */
export const transcriptReadStats = { bytes: 0, largestRead: 0, peakSlots: 0 };

export function resetTranscriptReadStats(): void {
  transcriptReadStats.bytes = 0;
  transcriptReadStats.largestRead = 0;
  transcriptReadStats.peakSlots = activeReads;
}

function noteRead(length: number): void {
  transcriptReadStats.bytes += length;
  if (length > transcriptReadStats.largestRead) transcriptReadStats.largestRead = length;
}

export async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeReads < MAX_CONCURRENT_READS) activeReads++;
  else await new Promise<void>((resolve) => readWaiters.push(resolve));
  if (activeReads > transcriptReadStats.peakSlots) transcriptReadStats.peakSlots = activeReads;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter, so the count never dips and
    // lets a newcomer jump the queue.
    const next = readWaiters.shift();
    if (next) next();
    else activeReads--;
  }
}

/**
 * Walks a file forward from byte `offset` to `end` in chunks of whole lines,
 * calling `onChunk` with each chunk's text and the offset just past it. A
 * trailing record still being written (no closing newline yet) is held back,
 * so the next walk picks it up once complete. `offset` past `end` (a
 * truncated/rotated file) restarts from 0. Returns the offset the next walk
 * resumes from.
 *
 * Unlike readTail, this walks forward from a newline boundary, so it never
 * starts mid-record and, driven by a per-session offset, captures every
 * appended record exactly once no matter how far an append-only JSONL grew
 * between reads. Memory is one chunk at a time, not the whole delta: a cold
 * ingest of a 300 MB transcript holds about `chunkBytes`, not 300 MB of buffer
 * plus its decoded string. A single line longer than a chunk widens that read
 * until the line fits.
 */
export async function walkLinesFrom(
  path: string,
  offset: number,
  end: number,
  onChunk: (text: string, nextOffset: number) => void,
  chunkBytes: number = INGEST_CHUNK_BYTES
): Promise<number> {
  let pos = offset > end || offset < 0 ? 0 : offset;
  if (pos >= end) return end;

  const handle = await open(path, "r");
  try {
    let want = chunkBytes;
    while (pos < end) {
      const step = await withReadSlot(async () => {
        const length = Math.min(want, end - pos);
        const buffer = Buffer.alloc(length);
        noteRead(length);
        const { bytesRead } = await handle.read(buffer, 0, length, pos);
        const filled = buffer.subarray(0, bytesRead);
        const lastNewline = filled.lastIndexOf(10);
        if (lastNewline >= 0) {
          const next = pos + lastNewline + 1;
          onChunk(filled.subarray(0, lastNewline + 1).toString("utf8"), next);
          pos = next;
        }
        return { advanced: lastNewline >= 0, short: bytesRead < length };
      });
      // A short read means the file shrank under the walk; stop, and the next
      // walk sees the new size and restarts from 0.
      if (step.short) break;
      if (step.advanced) {
        want = chunkBytes;
        continue;
      }
      // No newline in the window: either the rest is a record still being
      // written, or one line is longer than the window.
      if (pos + want >= end) break;
      want *= 2;
    }
    return pos;
  } finally {
    await handle.close();
  }
}

export async function readTranscript(
  transcriptPath: string,
  limit = 60,
  sessionId?: string
): Promise<TranscriptPage> {
  const empty: TranscriptPage = {
    messages: [],
    hasMore: false,
    totalMessages: 0,
    outputTokens: 0,
    contextTokens: 0,
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  try {
    // The tail and everything parsed from it are held inside a read slot, so a
    // burst of these (a resync over every thread) can't hold more than a few
    // tails at once.
    return await withReadSlot(async () => {
      const { text, partial } = await readTail(transcriptPath);
      const lines = text.split("\n");
      // A tail read almost certainly starts mid-record.
      if (partial) lines.shift();

      const all = parseLines(lines, sessionId);
      const messages = all.slice(-limit);

      return {
        messages,
        hasMore: partial || all.length > messages.length,
        totalMessages: all.length,
        outputTokens: all.reduce((sum, m) => sum + (m.outputTokens ?? 0), 0),
        contextTokens:
          [...all].reverse().find((m) => m.contextTokens)?.contextTokens ?? 0,
      };
    });
  } catch (err) {
    console.error(`[transcript] Failed to read ${transcriptPath}:`, err);
    return empty;
  }
}

/**
 * transcriptPathForSession and currentEffortForSession answers, per database
 * and session, valid while the session's newest event is `mark`. Each lookup
 * scans the session's events newest-first until a payload carries the field,
 * which for a field never present (Codex sessions, payloads predating
 * `effort`) is every event; events only append, so the answer can change only
 * when the newest event does. An ended session therefore never re-scans.
 * Entries go when a lookup finds the session has no events, and on
 * retainTranscriptMemos with the full session list, so deleted sessions don't
 * accumulate.
 */
interface SessionLookupMemo {
  mark: LatestEventMark;
  path?: string | null;
  effort?: string | null;
}

const lookupMemos = new WeakMap<Database, Map<string, SessionLookupMemo>>();

/**
 * The memo entry for `sessionId` at `mark` (fetched when not given), reset
 * when the mark moved. Null when the session has no events, in which case
 * every lookup answers null without a scan.
 */
function lookupMemo(
  db: Database,
  sessionId: string,
  mark: LatestEventMark | null | undefined
): SessionLookupMemo | null {
  let bySession = lookupMemos.get(db);
  if (!bySession) {
    bySession = new Map();
    lookupMemos.set(db, bySession);
  }
  const current = mark === undefined ? getLatestEventMark(db, sessionId) : mark;
  if (!current) {
    bySession.delete(sessionId);
    return null;
  }
  let entry = bySession.get(sessionId);
  if (!entry || entry.mark.seq !== current.seq || entry.mark.id !== current.id) {
    entry = { mark: current };
    bySession.set(sessionId, entry);
  }
  return entry;
}

/** Drops memoized lookups for every session not in `sessionIds` — call it with the full session list. */
export function retainTranscriptMemos(db: Database, sessionIds: Iterable<string>): void {
  const bySession = lookupMemos.get(db);
  if (!bySession) return;
  const keep = new Set(sessionIds);
  for (const id of bySession.keys()) if (!keep.has(id)) bySession.delete(id);
}

/** How many sessions hold memoized lookups for `db`. */
export function transcriptMemoSize(db: Database): number {
  return lookupMemos.get(db)?.size ?? 0;
}

/**
 * The transcript path recorded on a session's most recent event.
 *
 * Taken from the event stream rather than derived from cwd: the encoding of
 * a path into a directory name is an implementation detail, and hooks hand
 * us the real value on every payload. `mark` is the session's newest event
 * when the caller already has it (see getLatestEventMarks); otherwise it is
 * read here.
 */
export function transcriptPathForSession(
  db: Database,
  sessionId: string,
  mark?: LatestEventMark | null
): string | null {
  const memo = lookupMemo(db, sessionId, mark);
  if (!memo) return null;
  if (memo.path === undefined) memo.path = scanTranscriptPath(db, sessionId);
  return memo.path;
}

function scanTranscriptPath(db: Database, sessionId: string): string | null {
  const row = db
    .query(
      `SELECT json_extract(payload_json, '$.transcript_path') AS path
         FROM events
        WHERE session_id = ?
          AND json_extract(payload_json, '$.transcript_path') IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`
    )
    .get(sessionId) as { path: string | null } | null;

  return row?.path ?? null;
}

/**
 * The effort level off the most recent hook payload for a session.
 *
 * Hook payloads carry `effort` on every event (see
 * docs/claude-code-internals.md), so unlike the value chosen at launch this
 * reflects a mid-session `/effort` change. Undocumented field — read
 * defensively, same as transcriptPathForSession. Observed shape is an object,
 * `{"level":"medium"}`, not a bare string. `mark` as for transcriptPathForSession.
 */
export function currentEffortForSession(
  db: Database,
  sessionId: string,
  mark?: LatestEventMark | null
): string | null {
  const memo = lookupMemo(db, sessionId, mark);
  if (!memo) return null;
  if (memo.effort === undefined) memo.effort = scanEffort(db, sessionId);
  return memo.effort;
}

function scanEffort(db: Database, sessionId: string): string | null {
  const row = db
    .query(
      `SELECT json_extract(payload_json, '$.effort.level') AS level
         FROM events
        WHERE session_id = ?
          AND json_extract(payload_json, '$.effort.level') IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`
    )
    .get(sessionId) as { level: string | null } | null;

  return row?.level ?? null;
}

/**
 * Bytes read when tailing for the last message's model. A single message
 * (tool input/output, especially) can run well past 16 KB, so a small tail
 * risks landing entirely inside non-assistant records (queue-operation,
 * plain user text) with no model field at all — matches TAIL_BYTES so it's
 * exactly as reliable as the full transcript read.
 */
const MODEL_TAIL_BYTES = TAIL_BYTES;

/**
 * The model off the most recent real assistant turn in a session's
 * transcript.
 *
 * Unlike effort, `model` never appears on a hook payload — it's only in the
 * transcript, one per message (see TranscriptMessage.model). A small tail
 * read is enough since we only need the last one, not the whole history.
 * `<synthetic>` is a placeholder Claude Code writes on tool-only turns with
 * no real model call, so it's skipped rather than reported as current.
 */
export async function currentModelForSession(
  transcriptPath: string | null
): Promise<string | null> {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  try {
    const { size } = await stat(transcriptPath);
    const cached = modelCache.get(transcriptPath);
    if (cached && cached.scannedTo === size) return modelInTail(cached, size);

    const inFlight = modelLookups.get(transcriptPath);
    if (inFlight) return await inFlight;

    const lookup = lookUpModel(transcriptPath, size, cached).finally(() => {
      modelLookups.delete(transcriptPath);
    });
    modelLookups.set(transcriptPath, lookup);
    return await lookup;
  } catch {
    return null;
  }
}

/**
 * The model last seen in a transcript, and how far into the file that answer
 * covers: `scannedTo` is the end of the last whole line scanned. The session
 * list asks for every session's model on every poll, so the answer is kept
 * per path and only the bytes appended since `scannedTo` are scanned again;
 * an unchanged file costs one stat. Ingest feeds it too (see
 * noteIngestedModel), so an active session's model is usually known without
 * any extra read.
 *
 * `modelAt` is the byte offset where the model's line starts. The answer is
 * the same as reading the last MODEL_TAIL_BYTES fresh: a model whose line
 * starts before that window reads as none (see modelInTail), however the
 * cache came to know it.
 */
interface ModelEntry {
  scannedTo: number;
  model: string | null;
  modelAt: number;
}
const modelCache = new Map<string, ModelEntry>();
const modelLookups = new Map<string, Promise<string | null>>();

/**
 * A fresh tail read drops its first line whenever it doesn't start at byte 0,
 * even a whole one, so a line starting exactly at the window's start is out.
 */
function modelInTail(entry: ModelEntry, size: number): string | null {
  if (!entry.model) return null;
  const windowStart = size - MODEL_TAIL_BYTES;
  return windowStart <= 0 || entry.modelAt > windowStart ? entry.model : null;
}

async function lookUpModel(
  path: string,
  size: number,
  cached: ModelEntry | undefined
): Promise<string | null> {
  // A cache entry past EOF means the file was truncated or replaced: rescan.
  const from = cached && cached.scannedTo <= size ? cached.scannedTo : 0;
  const start = Math.max(from, size - MODEL_TAIL_BYTES);
  const found = await withReadSlot(() => scanBackForModel(path, start, size));
  // Nothing new in the scanned bytes: the earlier answer still stands, as far
  // as its line is still inside the tail window.
  const entry: ModelEntry = found.model
    ? found
    : {
        scannedTo: found.scannedTo,
        model: from > 0 && cached ? cached.model : null,
        modelAt: from > 0 && cached ? cached.modelAt : -1,
      };
  // Ingest may have recorded a later answer while this scan ran.
  const latest = modelCache.get(path);
  if (latest && latest !== cached && latest.scannedTo > entry.scannedTo) {
    return modelInTail(latest, size);
  }
  modelCache.set(path, entry);
  return modelInTail(entry, size);
}

/**
 * Scans `[start, end)` of a file backward, a chunk at a time, for the most
 * recent real assistant model, stopping at the first one found. `scannedTo`
 * is the end of the last whole line in the range (or `start` when it has
 * none), so a record still being written is scanned again once it lands;
 * `modelAt` is where the found model's line starts (-1 when none).
 */
async function scanBackForModel(
  path: string,
  start: number,
  end: number
): Promise<ModelEntry> {
  const handle = await open(path, "r");
  try {
    let pos = end;
    let complete = -1;
    // Bytes from the earliest newline seen back to the chunk start: the tail
    // of a line whose beginning hasn't been read yet.
    let carry: Buffer = Buffer.alloc(0);
    while (pos > start) {
      const length = Math.min(MODEL_CHUNK_BYTES, pos - start);
      pos -= length;
      const chunk = Buffer.alloc(length);
      noteRead(length);
      const { bytesRead } = await handle.read(chunk, 0, length, pos);
      const read = chunk.subarray(0, bytesRead);
      if (complete < 0) {
        const nl = read.lastIndexOf(10);
        if (nl >= 0) complete = pos + nl + 1;
      }
      const window = carry.length ? Buffer.concat([read, carry]) : read;
      const firstNewline = pos > start ? window.indexOf(10) : -1;
      if (pos > start && firstNewline < 0) {
        // Still inside one line; its start is further back.
        carry = Buffer.from(window);
        continue;
      }
      // Whole lines in the window, newest first; `window` starts at file
      // offset `pos`.
      let lineEnd = window.length;
      while (lineEnd > firstNewline + 1) {
        // A negative offset would search from the buffer's end, so guard it.
        const nl = lineEnd >= 2 ? window.lastIndexOf(10, lineEnd - 2) : -1;
        const lineStart = nl > firstNewline ? nl + 1 : firstNewline + 1;
        const model = modelOfLine(window.subarray(lineStart, lineEnd).toString("utf8"));
        if (model) {
          return { model, modelAt: pos + lineStart, scannedTo: complete < 0 ? start : complete };
        }
        lineEnd = lineStart;
      }
      carry = firstNewline >= 0 ? Buffer.from(window.subarray(0, firstNewline)) : Buffer.alloc(0);
    }
    return { model: null, modelAt: -1, scannedTo: complete < 0 ? start : complete };
  } finally {
    await handle.close();
  }
}

/** A real assistant model off one JSONL line, or null; `<synthetic>` is skipped. */
function modelOfLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const model = (JSON.parse(trimmed) as RawRecord).message?.model;
    return model && model !== "<synthetic>" ? model : null;
  } catch {
    return null;
  }
}

/**
 * Records what an ingest pass over `[from, to)` learned about a transcript's
 * model: the newest one it saw and where its line starts. A pass that found
 * one sets it outright; a pass that found none extends a cached answer only
 * when it picked up exactly where that answer left off, so the cache never
 * claims bytes nobody scanned.
 */
function noteIngestedModel(
  path: string,
  from: number,
  to: number,
  seen: { model: string; at: number } | null
): void {
  const cached = modelCache.get(path);
  // A lookup that already scanned further knows a later answer.
  if (cached && cached.scannedTo > to) return;
  if (seen) {
    modelCache.set(path, { scannedTo: to, model: seen.model, modelAt: seen.at });
    return;
  }
  if (from === 0) modelCache.set(path, { scannedTo: to, model: null, modelAt: -1 });
  else if (cached && cached.scannedTo >= from && cached.scannedTo < to) cached.scannedTo = to;
}

/**
 * Per-session ingest state: the stat (mtime + size) of the last-ingested
 * transcript file plus the byte `offset` the next read resumes from. The stat
 * lets a later ingest skip a file that hasn't changed — the same lazy stat-gate
 * KnowledgeSync uses to make "reconcile on every read" cheap; the offset lets
 * it read only the newly-appended bytes rather than a fixed tail window.
 *
 * In-memory only, so it is empty after a collector restart. That is safe: a
 * cold entry reads from offset 0 and re-scans the whole file, and appendEvent
 * dedups by uuid — so a missed gate (or a restart) only re-parses, it never
 * double-appends and never leaves a gap. The offset advances after every
 * chunk, so a pass that fails partway resumes where it stopped rather than
 * re-reading from 0; the stat is only recorded once a pass reaches the end.
 * Keyed to the path it was read from: a session whose transcript moves to a
 * new file starts that file from 0.
 */
const ingestStat = new Map<
  string,
  { path: string; mtimeMs: number; size: number; offset: number }
>();

/**
 * Ingest passes per session, so only one walks a session's file at a time.
 * Hooks fire without waiting for each other (a tool loop sends several a
 * second) and each one ingests; without this, every concurrent call on a cold
 * session read the same whole file in parallel. A call that arrives while a
 * pass runs joins the single pass queued behind it, which starts once the
 * current one ends and so sees every byte the joiners were called about. A
 * call for a different file or filter queues its own pass instead of joining.
 */
const ingestLanes = new Map<
  string,
  { tail: Promise<IngestResult>; queued: Promise<IngestResult> | null; queuedKey: string }
>();

export interface IngestResult {
  /** The session's head seq after this ingest. */
  head: number;
  /** How many records this call newly appended (0 when nothing changed). */
  appended: number;
}

/**
 * The stable dedup id for a transcript record.
 *
 * A record's own JSONL `uuid` is used when present. The out-of-band UI-state
 * lines (mode / permission-mode / last-prompt) carry none, yet they are
 * renderable — rich-transcript emits the mode/permission-change banners from
 * them — so they must live in the durable log too, not be dropped. For those a
 * `synthetic:`-prefixed content hash of the raw JSONL line stands in: it is
 * deterministic, so re-ingesting the same line resolves to the same id and
 * dedups, and it can never collide with a real UUID (dashed, 36 chars) or a
 * send-path idempotency key. Two byte-identical uuid-less lines collapse to one
 * seq, which is correct — they encode the same UI state.
 */
export function eventIdForRecord(raw: RawRecord, line: string): string {
  if (typeof raw.uuid === "string" && raw.uuid) return raw.uuid;
  return `synthetic:${createHash("sha256").update(line).digest("hex")}`;
}

/**
 * The prose of a plain user message, or null for anything that isn't one (an
 * assistant turn, a tool-result-only user record, an empty message). Used to
 * match an ingested record against a pending optimistic reply of the same text.
 */
function userReplyText(raw: RawRecord): string | null {
  if (raw.type !== "user") return null;
  const content = raw.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b &&
          typeof b === "object" &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: string }).text === "string"
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

/**
 * Mirrors a session's JSONL transcript into the durable transcript_events log,
 * appending any record not already logged (dedup by the record's JSONL uuid).
 * JSONL is the ingest source; the event log is the canonical served state — a
 * complete mirror, not a tail. This is what a projection reducer or a
 * late-joining device reads, so it must hold every record from the true first.
 *
 * Reads forward from the last-ingested byte offset (offset 0 on a cold entry),
 * so it captures every appended record exactly once no matter how far the file
 * grew between ingests — seq=1 is the true first record and there is never a
 * skipped-window hole, unlike a fixed tail read. Every parseable record is
 * mirrored: those with a JSONL uuid dedup on it, and the out-of-band UI-state
 * lines that carry none (mode / permission-mode / last-prompt) are kept too,
 * keyed by a content hash of their raw line (see eventIdForRecord) so the log
 * stays a complete mirror and re-ingesting the same line dedups rather than
 * duplicating. Stat-gated and defensive: an unchanged file is a no-op, and any
 * error leaves the log as-is.
 *
 * `options.skipSessionFilter` mirrors a dedicated per-session file (a subagent
 * child's own transcript) under `sessionId` WITHOUT the cross-session isolation
 * filter — its records carry a different real UUID than the synthetic child id,
 * so filtering by the storage key would drop them all. Off by default.
 *
 * One pass at a time per session (see ingestLanes). A call that joins a queued
 * pass gets that pass's head with `appended: 0`; only the call that queued it
 * reports what it appended, so callers that broadcast on `appended > 0` nudge
 * clients once per pass rather than once per joiner.
 */
export function ingestTranscriptEvents(
  db: Database,
  sessionId: string,
  transcriptPath: string | null,
  options?: { skipSessionFilter?: boolean }
): Promise<IngestResult> {
  const key = `${options?.skipSessionFilter ? 1 : 0}:${transcriptPath ?? ""}`;
  const lane = ingestLanes.get(sessionId);
  if (lane?.queued && lane.queuedKey === key) {
    return lane.queued.then((r) => ({ head: r.head, appended: 0 }));
  }
  const prior = lane?.tail ?? Promise.resolve();
  const pass: Promise<IngestResult> = prior
    .catch(() => undefined)
    .then(() => {
      const current = ingestLanes.get(sessionId);
      if (current?.queued === pass) current.queued = null;
      return ingestPass(db, sessionId, transcriptPath, options);
    })
    .finally(() => {
      if (ingestLanes.get(sessionId)?.tail === pass) ingestLanes.delete(sessionId);
    });
  if (lane) {
    lane.tail = pass;
    lane.queued = pass;
    lane.queuedKey = key;
  } else {
    ingestLanes.set(sessionId, { tail: pass, queued: pass, queuedKey: key });
  }
  return pass;
}

async function ingestPass(
  db: Database,
  sessionId: string,
  transcriptPath: string | null,
  options?: { skipSessionFilter?: boolean }
): Promise<IngestResult> {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { head: headSeq(db, sessionId), appended: 0 };
  }

  try {
    const { mtimeMs, size } = await stat(transcriptPath);
    const prev = ingestStat.get(sessionId);
    const samePath = prev?.path === transcriptPath;
    if (prev && samePath && prev.mtimeMs === mtimeMs && prev.size === size) {
      return { head: headSeq(db, sessionId), appended: 0 };
    }

    const from = prev && samePath && prev.offset <= size ? prev.offset : 0;
    let appended = 0;
    let lastModel: { model: string; at: number } | null = null;
    const nextOffset = await walkLinesFrom(transcriptPath, from, size, (text, chunkEnd) => {
      let lineStart = chunkEnd - Buffer.byteLength(text, "utf8");
      for (const line of text.split("\n")) {
        const record = ingestLine(db, sessionId, line, options);
        if (record.model) lastModel = { model: record.model, at: lineStart };
        if (record.appended) appended++;
        lineStart += Buffer.byteLength(line, "utf8") + 1;
      }
      // Progress survives a failure on a later chunk; the stat gate stays
      // open (-1) until the pass reaches the end.
      ingestStat.set(sessionId, { path: transcriptPath, mtimeMs: -1, size: -1, offset: chunkEnd });
    });

    noteIngestedModel(transcriptPath, from, nextOffset, lastModel);
    ingestStat.set(sessionId, { path: transcriptPath, mtimeMs, size, offset: nextOffset });
    return { head: headSeq(db, sessionId), appended };
  } catch (err) {
    console.error(`[transcript] Failed to ingest ${transcriptPath}:`, err);
    return { head: headSeq(db, sessionId), appended: 0 };
  }
}

/**
 * Mirrors one JSONL line into the durable log. Returns whether it appended (or
 * reconciled) an event, and the line's real assistant model, if any, for the
 * model cache — taken before the session filter, as currentModelForSession
 * reads the whole file.
 */
function ingestLine(
  db: Database,
  sessionId: string,
  line: string,
  options?: { skipSessionFilter?: boolean }
): { appended: boolean; model: string | null } {
  if (!line.trim()) return { appended: false, model: null };
  let raw: RawRecord;
  try {
    raw = JSON.parse(line) as RawRecord;
  } catch {
    return { appended: false, model: null };
  }
  const recordModel = raw.message?.model;
  const model = recordModel && recordModel !== "<synthetic>" ? recordModel : null;
  // Never stamp another session's record under this session in the durable
  // log — a resumed/compacted file carries the parent conversation's turns,
  // each keeping its original sessionId (see recordBelongsToSession).
  // `skipSessionFilter` turns this off for a dedicated per-session file: a
  // subagent child's own transcript is keyed by the synthetic child id
  // `${parent}:${agentId}`, but its records carry the parent's (or the
  // subagent's) real UUID, so filtering by the storage key would reject
  // every record. The file is exclusively that subagent's, so it stores
  // under the child id unfiltered.
  const filterId = options?.skipSessionFilter ? undefined : sessionId;
  if (!recordBelongsToSession(raw, filterId)) return { appended: false, model };
  const eventId = eventIdForRecord(raw, line);
  // Reconcile a real user record against an optimistic pending reply of the
  // same text first: it rewrites that event in place rather than appending a
  // second copy of the message the sender already saw.
  const replyText = userReplyText(raw);
  if (
    replyText &&
    reconcilePendingReply(db, sessionId, { text: replyText, eventId, event: raw })
  ) {
    return { appended: true, model };
  }
  return { appended: appendEvent(db, sessionId, { eventId, event: raw }).inserted, model };
}
