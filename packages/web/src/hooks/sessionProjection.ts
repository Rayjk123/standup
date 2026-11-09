import type { TranscriptMessage, ToolCall } from "./useTranscript";
import type { RichRow, ToolResult, DiffHunk, AskQuestion } from "./useRichTranscript";

/**
 * Client-side session projection (Phase 7 — Concept 3).
 *
 * A pure reducer that folds a session's ordered transcript records — served by
 * the Phase-2 `transcript_events` log — into the two display shapes the UI
 * already renders: readable message cards (see transcript.ts) and the
 * full-fidelity rich row stream (see rich-transcript.ts). It is a browser-safe
 * PORT of those two server parsers, kept dependency-light so a client can
 * reconstruct the same transcript the collector would.
 *
 * The reducer is total over the accumulated record set: callers fetch only the
 * delta past their cursor and append it, then re-fold. Folding the whole set is
 * what gives "patch a pending tool row → resolved in place" for free — when a
 * tool_result arrives in a later record, the tool row is re-classified from
 * `pending` to its resolved kind, and its stable id (`uuid:blockIndex`) lets
 * React reconcile it in place rather than re-mount the stream.
 */

/** The raw JSONL record shape, mirroring collector's transcript.ts `Raw`. */
export interface RawRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  /** Present on an optimistic/reconciled reply: the actor who sent it. */
  sentBy?: string;
  mode?: string;
  permissionMode?: string;
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  toolUseResult?: unknown;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, number>;
  };
}

export interface SessionProjection {
  messages: TranscriptMessage[];
  rows: RichRow[];
  outputTokens: number;
  contextTokens: number;
  model?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Displayable prose out of a content field — thinking blocks excluded. */
function extractText(content: unknown): string {
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

/** Extended-thinking prose out of a content field. */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b) => !!b && typeof b === "object" && (b as { type?: string }).type === "thinking"
    )
    .map((b) => {
      const bb = b as { thinking?: unknown; text?: unknown };
      if (typeof bb.thinking === "string") return bb.thinking;
      if (typeof bb.text === "string") return bb.text;
      return "";
    })
    .join("\n")
    .trim();
}

function isToolResultOnly(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (b) => !!b && typeof b === "object" && (b as { type?: string }).type === "tool_result"
  );
}

interface TaskNotification {
  summary: string;
  status: string;
}

/** Recognizes an injected `<task-notification>` and pulls summary + status. */
function parseTaskNotification(content: unknown): TaskNotification | null {
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

interface LocalCommand {
  name: string;
  args: string;
  stdout: string;
}

interface LocalCommandMatch {
  command: LocalCommand;
  consumed: number;
}

/** Detects a local-command triple (caveat, name/args, stdout) at `raws[i]`. */
function detectLocalCommand(raws: RawRecord[], i: number): LocalCommandMatch | null {
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

// ---------------------------------------------------------------------------
// Message cards (port of transcript.ts parseLines)
// ---------------------------------------------------------------------------

interface ToolResultInfo {
  text: string;
  isError: boolean;
}

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
      map.set(b.tool_use_id, { text: extractText(b.content), isError: !!b.is_error });
    }
  }
  return map;
}

function extractToolCalls(
  content: unknown,
  results: Map<string, ToolResultInfo>
): ToolCall[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b) => !!b && typeof b === "object" && (b as { type?: string }).type === "tool_use"
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
    model: raw.message?.model,
    sentBy: raw.type === "user" ? raw.sentBy : undefined,
  };
}

function reduceMessages(raws: RawRecord[]): TranscriptMessage[] {
  const results = extractToolResults(raws);
  const messages: TranscriptMessage[] = [];
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

// ---------------------------------------------------------------------------
// Rich rows (port of rich-transcript.ts parseRows)
// ---------------------------------------------------------------------------

interface ToolOutcome {
  text: string;
  isError: boolean;
  sidecar: unknown;
}

function buildOutcomeMap(raws: RawRecord[]): Map<string, ToolOutcome> {
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
        text: extractText(b.content),
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
    return { kind: "question", questions: parseQuestions(input, outcome?.sidecar) };
  }
  if (!outcome) return { kind: "pending" };

  const s = outcome.sidecar;
  const obj =
    s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null;

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
    if (typeof obj.content === "string") {
      return {
        kind: "write",
        filePath: str(obj.filePath),
        lineCount: obj.content.split("\n").length,
      };
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

function reduceRows(raws: RawRecord[]): {
  rows: RichRow[];
  outputTokens: number;
  contextTokens: number;
  model?: string;
} {
  const outcomes = buildOutcomeMap(raws);
  const rows: RichRow[] = [];
  let outputTokens = 0;
  let contextTokens = 0;
  let model: string | undefined;
  const countedMessages = new Set<string>();
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
        rows.push({
          id,
          kind: "taskNotification",
          timestamp: ts,
          summary: notif.summary,
          status: notif.status,
        });
        continue;
      }

      const text = extractText(content);
      if (text.trim()) rows.push({ id, kind: "user", timestamp: ts, text, sentBy: raw.sentBy });
      continue;
    }

    if (raw.type === "assistant") {
      const usage = raw.message?.usage;
      if (usage) {
        const messageId = raw.message?.id;
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
          const t = (
            typeof b.thinking === "string"
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

/** Folds the accumulated records into both display projections at once. */
export function reduceSessionProjection(records: RawRecord[]): SessionProjection {
  const { rows, outputTokens, contextTokens, model } = reduceRows(records);
  return {
    messages: reduceMessages(records),
    rows,
    outputTokens,
    contextTokens,
    model,
  };
}

/**
 * The rich-row projection only (rows + token/model totals). The terminal view
 * never uses the message-card shape, so it folds just this — skipping the
 * reduceMessages pass on every delta.
 */
export function reduceSessionRows(records: RawRecord[]): {
  rows: RichRow[];
  outputTokens: number;
  contextTokens: number;
  model?: string;
} {
  return reduceRows(records);
}
