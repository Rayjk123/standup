import { existsSync } from "fs";
import { stat, open } from "fs/promises";

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

export interface TranscriptMessage {
  uuid: string;
  role: TranscriptRole;
  timestamp: string;
  /** Prose only — thinking blocks are excluded, see extractText. */
  text: string;
  toolCalls: TranscriptToolCall[];
  /** Set instead of `text` when this record is a merged local-command triple. */
  localCommand?: LocalCommand;
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

interface RawRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
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
 * `thinking` blocks are deliberately dropped: they are the agent's internal
 * reasoning, they dominate the byte count, and showing them in a session
 * review turns a readable conversation into a wall of text.
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

const LOCAL_COMMAND_CAVEAT_RE = /^<local-command-caveat>/;
const LOCAL_COMMAND_NAME_RE =
  /<command-name>([^<]*)<\/command-name>\s*<command-message>([^<]*)<\/command-message>\s*<command-args>([^<]*)<\/command-args>/;
const LOCAL_COMMAND_STDOUT_RE = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

function rawText(raw: RawRecord): string {
  const content = raw.message?.content;
  return typeof content === "string" ? content : "";
}

function toMessage(
  raw: RawRecord,
  results: Map<string, ToolResultInfo>
): TranscriptMessage | null {
  if (raw.type !== "user" && raw.type !== "assistant") return null;

  const content = raw.message?.content;
  if (raw.type === "user" && isToolResultOnly(content)) return null;

  const text = extractText(content);
  const toolCalls = extractToolCalls(content, results);
  if (!text && toolCalls.length === 0) return null;

  const usage = raw.message?.usage;

  return {
    uuid: raw.uuid ?? "",
    role: raw.type,
    timestamp: raw.timestamp ?? "",
    text,
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

function parseLines(lines: string[]): TranscriptMessage[] {
  const raws: RawRecord[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      raws.push(JSON.parse(line) as RawRecord);
    } catch {
      // Truncated or unrecognized record — skipping one line is always
      // preferable to failing the whole read.
    }
  }

  const results = extractToolResults(raws);
  const messages: TranscriptMessage[] = [];

  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (raw.type !== "user") {
      const message = toMessage(raw, results);
      if (message) messages.push(message);
      continue;
    }

    // A local-command caveat is always followed by the name/args record and
    // then the stdout record, each its own line — see LocalCommand above.
    // Detected on the caveat and consumes the next two lines so they don't
    // also get pushed as their own (unreadable) entries.
    if (LOCAL_COMMAND_CAVEAT_RE.test(rawText(raw))) {
      const nameRaw = raws[i + 1];
      const stdoutRaw = raws[i + 2];
      const nameMatch =
        nameRaw?.type === "user" ? rawText(nameRaw).match(LOCAL_COMMAND_NAME_RE) : null;
      const stdoutMatch =
        stdoutRaw?.type === "user"
          ? rawText(stdoutRaw).match(LOCAL_COMMAND_STDOUT_RE)
          : null;

      if (nameMatch) {
        messages.push({
          uuid: raw.uuid ?? "",
          role: "user",
          timestamp: raw.timestamp ?? "",
          text: "",
          toolCalls: [],
          localCommand: {
            name: nameMatch[1],
            args: nameMatch[3],
            stdout: stdoutMatch?.[1] ?? "",
          },
        });
        i += stdoutMatch ? 2 : 1;
        continue;
      }
    }

    const message = toMessage(raw, results);
    if (message) messages.push(message);
  }

  return messages;
}

/** Reads the last `bytes` of a file, dropping a partial first line. */
async function readTail(
  path: string,
  bytes: number = TAIL_BYTES
): Promise<{ text: string; partial: boolean }> {
  const { size } = await stat(path);
  const start = Math.max(0, size - bytes);

  const handle = await open(path, "r");
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), partial: start > 0 };
  } finally {
    await handle.close();
  }
}

export async function readTranscript(
  transcriptPath: string,
  limit = 60
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
    const { text, partial } = await readTail(transcriptPath);
    const lines = text.split("\n");
    // A tail read almost certainly starts mid-record.
    if (partial) lines.shift();

    const all = parseLines(lines);
    const messages = all.slice(-limit);

    return {
      messages,
      hasMore: partial || all.length > messages.length,
      totalMessages: all.length,
      outputTokens: all.reduce((sum, m) => sum + (m.outputTokens ?? 0), 0),
      contextTokens:
        [...all].reverse().find((m) => m.contextTokens)?.contextTokens ?? 0,
    };
  } catch (err) {
    console.error(`[transcript] Failed to read ${transcriptPath}:`, err);
    return empty;
  }
}

/**
 * The transcript path recorded on a session's most recent event.
 *
 * Taken from the event stream rather than derived from cwd: the encoding of
 * a path into a directory name is an implementation detail, and hooks hand
 * us the real value on every payload.
 */
export function transcriptPathForSession(
  db: import("bun:sqlite").Database,
  sessionId: string
): string | null {
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
 * `{"level":"medium"}`, not a bare string.
 */
export function currentEffortForSession(
  db: import("bun:sqlite").Database,
  sessionId: string
): string | null {
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
    const { text, partial } = await readTail(transcriptPath, MODEL_TAIL_BYTES);
    const lines = text.split("\n");
    if (partial) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as RawRecord;
        const model = raw.message?.model;
        if (model && model !== "<synthetic>") return model;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}
