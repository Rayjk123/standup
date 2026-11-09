import { existsSync } from "fs";
import {
  readTail,
  withReadSlot,
  parseTaskNotification,
  detectLocalCommand,
  recordBelongsToSession,
  type RawRecord,
} from "./transcript.js";

/**
 * Full-fidelity reader for Claude Code's session transcript — the "terminal
 * mode" companion to transcript.ts.
 *
 * Where transcript.ts distills the session into readable message cards (prose
 * only, tools flattened, thinking folded), this reader preserves what the TUI
 * actually renders: intra-turn block order (thinking → text → tool), the
 * `toolUseResult` sidecar (structuredPatch diffs, split stdout/stderr, Read
 * line counts), and the out-of-band records the card view drops entirely —
 * compaction boundaries and mode changes. It is additive: transcript.ts is
 * untouched and still backs the card view.
 *
 * The output is a flat, file-ordered list of RichRow — each row is one line the
 * terminal view draws — rather than a message tree, because the TUI itself is a
 * flat stream of `⏺`/`⎿`/`>` lines and Claude Code writes each block as its own
 * record.
 */

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each prefixed ` ` (context), `+` (added), or `-` (removed). */
  lines: string[];
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
  /** The chosen option label(s) once answered; undefined while pending. */
  answer?: string;
}

export type ToolResult =
  | { kind: "bash"; stdout: string; stderr: string; interrupted: boolean }
  | { kind: "diff"; filePath: string; hunks: DiffHunk[] }
  | { kind: "write"; filePath: string; lineCount: number }
  | { kind: "read"; filePath: string; numLines?: number; totalLines?: number }
  | { kind: "todo"; todos: { content?: string; status?: string }[] }
  | { kind: "question"; questions: AskQuestion[] }
  | { kind: "agent"; agentType?: string; status?: string }
  | { kind: "text"; text: string; isError: boolean }
  | { kind: "pending" };

interface RowBase {
  id: string;
  timestamp: string;
}

export type RichRow =
  | (RowBase & { kind: "user"; text: string; sentBy?: string })
  | (RowBase & { kind: "localCommand"; name: string; args: string; stdout: string })
  | (RowBase & { kind: "taskNotification"; summary: string; status: string })
  | (RowBase & { kind: "thinking"; text: string })
  | (RowBase & { kind: "text"; text: string })
  | (RowBase & {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      result: ToolResult;
    })
  | (RowBase & { kind: "compaction"; trigger: string; preTokens: number; postTokens: number })
  | (RowBase & { kind: "mode"; label: string });

export interface RichTranscriptPage {
  rows: RichRow[];
  /** More rows exist within the loaded window that paging can still reveal. */
  hasMore: boolean;
  /**
   * The window is a tail of a larger file — history before it exists on disk
   * but is not reachable by paging yet (a fixed byte budget, see readTail).
   * Distinct from hasMore so the view can note it without a dead-end button.
   */
  truncated: boolean;
  totalRows: number;
  outputTokens: number;
  contextTokens: number;
  model?: string;
}

interface Raw extends RawRecord {
  subtype?: string;
  mode?: string;
  permissionMode?: string;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
  };
  toolUseResult?: unknown;
}

interface ToolOutcome {
  text: string;
  isError: boolean;
  sidecar: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Prose out of a tool_result / message content field. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
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
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (b) =>
      !!b && typeof b === "object" && (b as { type?: string }).type === "tool_result"
  );
}

/**
 * tool_result blocks and their structured `toolUseResult` sidecar both live on
 * a following `user` record. Scanned once so each tool_use can find its own
 * outcome by id.
 */
function buildOutcomeMap(raws: Raw[]): Map<string, ToolOutcome> {
  const map = new Map<string, ToolOutcome>();
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
        text: textOf(b.content),
        isError: !!b.is_error,
        sidecar: raw.toolUseResult,
      });
    }
  }
  return map;
}

function normalizeHunks(patch: unknown): DiffHunk[] {
  if (!Array.isArray(patch)) return [];
  return patch.map((h) => {
    const hunk = (h ?? {}) as Record<string, unknown>;
    return {
      oldStart: num(hunk.oldStart) ?? 0,
      oldLines: num(hunk.oldLines) ?? 0,
      newStart: num(hunk.newStart) ?? 0,
      newLines: num(hunk.newLines) ?? 0,
      lines: Array.isArray(hunk.lines) ? hunk.lines.map((l) => String(l)) : [],
    };
  });
}

const DIFF_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * Pulls the questions (and any chosen answers) out of an AskUserQuestion call.
 * The prompt lives in the call input and is present even while the question is
 * pending — which is exactly when it must be shown — so this never depends on
 * a result. Answers, when present, arrive in the sidecar keyed by question text.
 */
function parseQuestions(input: Record<string, unknown>, sidecar: unknown): AskQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const answers =
    sidecar &&
    typeof sidecar === "object" &&
    !Array.isArray(sidecar) &&
    typeof (sidecar as Record<string, unknown>).answers === "object"
      ? ((sidecar as Record<string, unknown>).answers as Record<string, unknown>)
      : {};

  return raw.map((q) => {
    const qq = (q ?? {}) as Record<string, unknown>;
    const question = str(qq.question);
    const options = Array.isArray(qq.options)
      ? qq.options.map((o) => {
          const oo = (o ?? {}) as Record<string, unknown>;
          return {
            label: str(oo.label),
            description: typeof oo.description === "string" ? oo.description : undefined,
          };
        })
      : [];
    const a = answers[question];
    const answer =
      typeof a === "string" ? a : Array.isArray(a) ? a.map(String).join(", ") : undefined;
    return {
      question,
      header: typeof qq.header === "string" ? qq.header : undefined,
      multiSelect: !!qq.multiSelect,
      options,
      answer,
    };
  });
}

/** Maps a tool call's raw outcome onto the typed result the renderer draws. */
function classifyResult(
  name: string,
  input: Record<string, unknown>,
  outcome: ToolOutcome | undefined
): ToolResult {
  if (name === "TodoWrite") {
    const todos = Array.isArray(input.todos)
      ? (input.todos as { content?: string; status?: string }[])
      : [];
    return { kind: "todo", todos };
  }
  if (name === "AskUserQuestion") {
    // Rendered from the input, which carries the prompt even while pending.
    return { kind: "question", questions: parseQuestions(input, outcome?.sidecar) };
  }
  if (!outcome) return { kind: "pending" };

  const s = outcome.sidecar;
  const obj = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null;

  if (name === "Bash" && obj) {
    return {
      kind: "bash",
      stdout: str(obj.stdout),
      stderr: str(obj.stderr),
      interrupted: !!obj.interrupted,
    };
  }
  if (DIFF_TOOLS.has(name) && obj) {
    const patch = Array.isArray(obj.structuredPatch) ? obj.structuredPatch : [];
    if (patch.length > 0) {
      return { kind: "diff", filePath: str(obj.filePath), hunks: normalizeHunks(patch) };
    }
    // A file creation carries an empty patch; the new text is in `content`, so
    // it would otherwise render as a blank diff. Surface it as a line count.
    if (typeof obj.content === "string") {
      return { kind: "write", filePath: str(obj.filePath), lineCount: obj.content.split("\n").length };
    }
  }
  if (name === "Read" && obj && obj.file && typeof obj.file === "object") {
    const f = obj.file as Record<string, unknown>;
    return {
      kind: "read",
      filePath: str(f.filePath),
      numLines: num(f.numLines),
      totalLines: num(f.totalLines),
    };
  }
  if (name === "Agent" || name === "Task") {
    return {
      kind: "agent",
      agentType: obj?.agentType ? str(obj.agentType) : undefined,
      status: obj?.status ? str(obj.status) : undefined,
    };
  }
  return { kind: "text", text: outcome.text, isError: outcome.isError };
}

export function parseRows(lines: string[], sessionId?: string): {
  rows: RichRow[];
  outputTokens: number;
  contextTokens: number;
  model?: string;
} {
  const raws: Raw[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Raw;
      // A resumed/compacted transcript copies the parent conversation's turns
      // into this file, each keeping its original sessionId — drop those so one
      // session's rows never render into another's view (see recordBelongsToSession).
      if (!recordBelongsToSession(raw, sessionId)) continue;
      raws.push(raw);
    } catch {
      // A truncated or unrecognized record is skipped, never fatal.
    }
  }

  const outcomes = buildOutcomeMap(raws);
  const rows: RichRow[] = [];
  let outputTokens = 0;
  let contextTokens = 0;
  let model: string | undefined;
  // One logical assistant message is written as several records (one per
  // content block), each stamped with the same message-level usage. Output
  // tokens are additive, so count each message id once; context is a
  // point-in-time reading, so last-write-wins is already correct.
  const countedMessages = new Set<string>();
  // Mode records repeat on nearly every event; only a change is worth a banner.
  // The first value seen in the window is the baseline, emitted silently.
  let prevMode: string | null = null;
  let prevPerm: string | null = null;

  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    const ts = raw.timestamp ?? "";
    const id = raw.uuid ?? String(i);

    if (raw.type === "system" && raw.subtype === "compact_boundary") {
      const m = raw.compactMetadata ?? {};
      rows.push({
        id,
        kind: "compaction",
        timestamp: ts,
        trigger: str(m.trigger) || "auto",
        preTokens: num(m.preTokens) ?? 0,
        postTokens: num(m.postTokens) ?? 0,
      });
      continue;
    }

    if (raw.type === "mode") {
      if (raw.mode) {
        if (prevMode !== null && raw.mode !== prevMode) {
          rows.push({ id, kind: "mode", timestamp: ts, label: `mode: ${raw.mode}` });
        }
        prevMode = raw.mode;
      }
      continue;
    }

    if (raw.type === "permission-mode") {
      if (raw.permissionMode) {
        if (prevPerm !== null && raw.permissionMode !== prevPerm) {
          rows.push({
            id,
            kind: "mode",
            timestamp: ts,
            label: `permissions: ${raw.permissionMode}`,
          });
        }
        prevPerm = raw.permissionMode;
      }
      continue;
    }

    if (raw.type === "user") {
      const content = raw.message?.content;
      if (isToolResultOnly(content)) continue;

      const local = detectLocalCommand(raws, i);
      if (local) {
        rows.push({
          id,
          kind: "localCommand",
          timestamp: ts,
          name: local.command.name,
          args: local.command.args,
          stdout: local.command.stdout,
        });
        i += local.consumed;
        continue;
      }

      const notif = parseTaskNotification(content);
      if (notif) {
        rows.push({ id, kind: "taskNotification", timestamp: ts, summary: notif.summary, status: notif.status });
        continue;
      }

      const text = textOf(content);
      if (text.trim()) rows.push({ id, kind: "user", timestamp: ts, text, sentBy: raw.sentBy });
      continue;
    }

    if (raw.type === "assistant") {
      const usage = raw.message?.usage;
      if (usage) {
        const messageId = (raw.message as { id?: string }).id;
        if (!messageId || !countedMessages.has(messageId)) {
          outputTokens += num(usage.output_tokens) ?? 0;
          if (messageId) countedMessages.add(messageId);
        }
        const ctx =
          (num(usage.input_tokens) ?? 0) +
          (num(usage.cache_read_input_tokens) ?? 0) +
          (num(usage.cache_creation_input_tokens) ?? 0);
        if (ctx) contextTokens = ctx;
        if (raw.message?.model) model = raw.message.model;
      }

      const content = raw.message?.content;
      if (!Array.isArray(content)) continue;

      content.forEach((block, bi) => {
        if (!block || typeof block !== "object") return;
        const b = block as {
          type?: string;
          text?: unknown;
          thinking?: unknown;
          id?: string;
          name?: string;
          input?: unknown;
        };
        const rowId = `${id}:${bi}`;
        if (b.type === "thinking") {
          const t = (typeof b.thinking === "string"
            ? b.thinking
            : typeof b.text === "string"
              ? b.text
              : ""
          ).trim();
          if (t) rows.push({ id: rowId, kind: "thinking", timestamp: ts, text: t });
        } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          rows.push({ id: rowId, kind: "text", timestamp: ts, text: b.text });
        } else if (b.type === "tool_use") {
          const input = (b.input as Record<string, unknown>) ?? {};
          const name = b.name ?? "tool";
          rows.push({
            id: rowId,
            kind: "tool",
            timestamp: ts,
            name,
            input,
            result: classifyResult(name, input, b.id ? outcomes.get(b.id) : undefined),
          });
        }
      });
      continue;
    }
  }

  return { rows, outputTokens, contextTokens, model };
}

export async function readRichTranscript(
  transcriptPath: string,
  limit = 60,
  sessionId?: string
): Promise<RichTranscriptPage> {
  const empty: RichTranscriptPage = {
    rows: [],
    hasMore: false,
    truncated: false,
    totalRows: 0,
    outputTokens: 0,
    contextTokens: 0,
  };

  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  try {
    // Held inside a shared read slot, tail and parse both, so the Slack
    // mirror's resync over every thread can't hold a tail per thread at once.
    return await withReadSlot(async () => {
      const { text, partial } = await readTail(transcriptPath);
      const lines = text.split("\n");
      if (partial) lines.shift();

      const { rows, outputTokens, contextTokens, model } = parseRows(lines, sessionId);
      const windowed = rows.slice(-limit);

      return {
        rows: windowed,
        // Only advertise paging for rows we can actually still return from the
        // loaded window; `truncated` separately flags history beyond the tail.
        hasMore: rows.length > windowed.length,
        truncated: partial,
        totalRows: rows.length,
        outputTokens,
        contextTokens,
        model,
      };
    });
  } catch (err) {
    console.error(`[rich-transcript] Failed to read ${transcriptPath}:`, err);
    return empty;
  }
}
