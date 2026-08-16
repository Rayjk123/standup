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
}

export interface TranscriptMessage {
  uuid: string;
  role: TranscriptRole;
  timestamp: string;
  /** Prose only — thinking blocks are excluded, see extractText. */
  text: string;
  toolCalls: TranscriptToolCall[];
  /** Present on assistant messages that reported usage. */
  tokens?: number;
  model?: string;
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  /** True when older messages exist before the returned window. */
  hasMore: boolean;
  totalMessages: number;
  totalTokens: number;
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

function extractToolCalls(content: unknown): TranscriptToolCall[] {
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
      return {
        id: b.id ?? "",
        name: b.name ?? "unknown",
        input: (b.input as Record<string, unknown>) ?? {},
      };
    });
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

function toMessage(raw: RawRecord): TranscriptMessage | null {
  if (raw.type !== "user" && raw.type !== "assistant") return null;

  const content = raw.message?.content;
  if (raw.type === "user" && isToolResultOnly(content)) return null;

  const text = extractText(content);
  const toolCalls = extractToolCalls(content);
  if (!text && toolCalls.length === 0) return null;

  const usage = raw.message?.usage;
  const tokens = usage
    ? (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    : undefined;

  return {
    uuid: raw.uuid ?? "",
    role: raw.type,
    timestamp: raw.timestamp ?? "",
    text,
    toolCalls,
    tokens,
    model: raw.message?.model,
  };
}

function parseLines(lines: string[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = toMessage(JSON.parse(line) as RawRecord);
      if (message) messages.push(message);
    } catch {
      // Truncated or unrecognized record — skipping one line is always
      // preferable to failing the whole read.
    }
  }

  return messages;
}

/** Reads the last `TAIL_BYTES` of a file, dropping a partial first line. */
async function readTail(path: string): Promise<{ text: string; partial: boolean }> {
  const { size } = await stat(path);
  const start = Math.max(0, size - TAIL_BYTES);

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
    totalTokens: 0,
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
      totalTokens: all.reduce((sum, m) => sum + (m.tokens ?? 0), 0),
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
