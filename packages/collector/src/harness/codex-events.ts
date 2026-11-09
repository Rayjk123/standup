import type { UsageRecord } from "../usage.js";
import type {
  NormalizedError,
  NormalizedEvent,
  NormalizedFileChange,
  NormalizedUsage,
  StreamParser,
} from "./types.js";

/**
 * Streaming parser for a `codex exec --json` stdout stream: one JSON object per
 * line, `thread.started` (with `thread_id`), then per turn `turn.started`,
 * `item.started` / `item.updated` / `item.completed` (each carrying an `item`
 * with an `id` and a `type` such as `agent_message`, `reasoning`,
 * `command_execution`, `file_change`), and `turn.completed` (with `usage`) or
 * `turn.failed` / `error`. It maps the JSONL event stream onto
 * `NormalizedEvent`s and is deliberately defensive: every line is parsed in
 * isolation, a line split across chunk boundaries is buffered, and anything the
 * contract does not cover — non-JSON noise, a partial line, an unknown event or
 * item type — is skipped or passed through as `unknown`, never thrown.
 *
 * The exec wire is snake_case (`thread_id`, `input_tokens`, `agent_message`); the
 * accessors below read the snake form and fall back to the camelCase app-server
 * spelling so a build that emits either shape still parses.
 */

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strU(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numU(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Codex `turn.completed.usage` → `NormalizedUsage`. Returns undefined when the
 * turn carried no usage object. Reads all five observed snake_case fields (and
 * tolerates extras) with a camelCase fallback; missing numbers coerce to 0.
 */
export function mapCodexUsage(raw: unknown): NormalizedUsage | undefined {
  if (!isObject(raw)) return undefined;
  return {
    inputTokens: num(raw.input_tokens ?? raw.inputTokens),
    cachedInputTokens: num(raw.cached_input_tokens ?? raw.cachedInputTokens),
    cacheWriteInputTokens: num(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens),
    outputTokens: num(raw.output_tokens ?? raw.outputTokens),
    reasoningOutputTokens: num(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens),
  };
}

/**
 * Reconciles a `NormalizedUsage` onto the `UsageRecord` cost model in usage.ts.
 *
 * Codex's `input_tokens` is INCLUSIVE of both cache legs (they are subsets of it,
 * not additive), so the base-rate portion billed fresh is what remains after
 * removing them. That decomposition maps onto the token legs of `UsageRecord` —
 * fresh input, `cachedInputTokens` as a cache read, `cacheWriteInputTokens` as a
 * cache creation — and keeps `aggregateUsage`'s total at `input_tokens +
 * output_tokens` rather than double-counting the cache legs the way summing
 * Codex's raw fields would. The record is tagged `provider: "openai"` so those
 * legs price at OpenAI/Codex rates: unlike Claude, a Codex cache write carries no
 * cache-creation premium (see CACHE_WRITE_MULTIPLIER in usage.ts). Values are
 * clamped at zero in case the reported subsets ever exceed the inclusive total.
 */
export function codexUsageToRecord(usage: NormalizedUsage, model?: string): UsageRecord {
  const cacheReadTokens = Math.max(0, usage.cachedInputTokens);
  const cacheCreationTokens = Math.max(0, usage.cacheWriteInputTokens);
  const inputTokens = Math.max(0, usage.inputTokens - cacheReadTokens - cacheCreationTokens);
  return {
    model,
    provider: "openai",
    inputTokens,
    outputTokens: Math.max(0, usage.outputTokens),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/** The four transient/connection `codexErrorInfo` variants worth retrying. */
const RETRYABLE_CONNECTION_VARIANTS = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

/**
 * Classifies a Codex `TurnError` into a `NormalizedError`. `codexErrorInfo` is a
 * mixed union: 13 bare-string variants, 4 object-tagged connection variants
 * shaped `{ "<name>": { httpStatusCode } }`, and one object-tagged
 * `activeTurnNotSteerable` shaped `{ turnKind }`. So we branch on string vs.
 * object rather than string-comparing (an object-tagged name never equals its
 * key), and read the payload by the variant's own shape. Only the four
 * connection variants are marked retryable.
 */
function classifyCodexError(raw: unknown): NormalizedError {
  const err = isObject(raw) ? raw : {};
  const message = str(err.message) || "codex turn failed";
  const additionalDetails = strU(err.additional_details ?? err.additionalDetails);
  const info = err.codex_error_info ?? err.codexErrorInfo;

  if (typeof info === "string") {
    return { message, code: info, retryable: false, additionalDetails };
  }
  if (isObject(info)) {
    const code = Object.keys(info)[0];
    const payload = code ? info[code] : undefined;
    if (code && RETRYABLE_CONNECTION_VARIANTS.has(code)) {
      const http = isObject(payload)
        ? payload.httpStatusCode ?? payload.http_status_code
        : undefined;
      return {
        message,
        code,
        retryable: true,
        httpStatusCode: typeof http === "number" ? http : null,
        additionalDetails,
      };
    }
    // Non-retryable object-tagged variant (e.g. activeTurnNotSteerable{turnKind}):
    // surface the turn kind in details rather than reading a httpStatusCode that
    // does not exist on it.
    const turnKind = isObject(payload) ? strU(payload.turnKind ?? payload.turn_kind) : undefined;
    return {
      message,
      code,
      retryable: false,
      additionalDetails: additionalDetails ?? (turnKind ? `turnKind=${turnKind}` : undefined),
    };
  }
  return { message, retryable: false, additionalDetails };
}

/** Top-level `error` stream event → `stream-error` (flat or nested payload). */
function mapStreamError(obj: Record<string, unknown>): NormalizedEvent {
  const nested = obj.error;
  const message =
    strU(obj.message) ??
    (isObject(nested) ? str(nested.message) : typeof nested === "string" ? nested : "");
  const willRetryRaw = obj.will_retry ?? obj.willRetry;
  return {
    kind: "stream-error",
    message: message || "codex stream error",
    willRetry: typeof willRetryRaw === "boolean" ? willRetryRaw : undefined,
  };
}

/** reasoning item → its `summary[]` + `content[]` prose, joined. */
function reasoningText(item: Record<string, unknown>): string {
  const parts = [...stringArray(item.summary), ...stringArray(item.content)];
  if (parts.length > 0) return parts.join("\n").trim();
  return str(item.text).trim();
}

/** plan / todo_list item → a single text blob (either `text` or formatted items). */
function planText(item: Record<string, unknown>): string {
  const text = str(item.text).trim();
  if (text) return text;
  if (Array.isArray(item.items)) {
    return item.items
      .map((entry) => {
        const e = isObject(entry) ? entry : {};
        const status = strU(e.status);
        const content = str(e.content ?? e.text);
        return status ? `[${status}] ${content}` : content;
      })
      .join("\n")
      .trim();
  }
  return "";
}

/** user_message item → its echoed prompt text. */
function userText(item: Record<string, unknown>): string {
  const text = str(item.text).trim();
  if (text) return text;
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : isObject(block) ? str(block.text) : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

/** Codex `file_change.changes[]` → `NormalizedFileChange[]`. */
function mapFileChanges(raw: unknown): NormalizedFileChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const c = isObject(entry) ? entry : {};
    const kind = c.kind;
    let changeKind: NormalizedFileChange["changeKind"] = "unknown";
    let movePath: string | null | undefined;
    if (typeof kind === "string") {
      changeKind = normalizeChangeKind(kind);
    } else if (isObject(kind)) {
      changeKind = normalizeChangeKind(str(kind.type));
      const mp = kind.move_path ?? kind.movePath;
      movePath = typeof mp === "string" ? mp : mp === null ? null : undefined;
    }
    return { path: str(c.path), changeKind, movePath, diff: strU(c.diff) };
  });
}

function normalizeChangeKind(type: string): NormalizedFileChange["changeKind"] {
  return type === "add" || type === "delete" || type === "update" ? type : "unknown";
}

/**
 * `item.completed.item` → the matching `NormalizedEvent`. An item whose type is
 * outside the catalog is passed through as `unknown` (keyed by its item type)
 * rather than dropped, so nothing is silently lost.
 */
function mapItemCompleted(raw: unknown): NormalizedEvent | null {
  if (!isObject(raw)) return null;
  const itemType = str(raw.type);
  const itemId = strU(raw.id);

  switch (itemType) {
    case "agent_message":
      return { kind: "assistant-message", itemId, text: str(raw.text) };
    case "reasoning":
      return { kind: "reasoning", itemId, text: reasoningText(raw) };
    case "command_execution":
      return {
        kind: "tool",
        itemId,
        tool: {
          kind: "command",
          command: strU(raw.command),
          cwd: strU(raw.cwd),
          aggregatedOutput: strU(raw.aggregated_output ?? raw.aggregatedOutput),
          exitCode: numU(raw.exit_code ?? raw.exitCode),
          status: strU(raw.status),
          durationMs: numU(raw.duration_ms ?? raw.durationMs),
        },
      };
    case "file_change":
      return { kind: "file-change", itemId, changes: mapFileChanges(raw.changes) };
    case "mcp_tool_call":
      return {
        kind: "tool",
        itemId,
        tool: {
          kind: "mcp",
          server: strU(raw.server),
          tool: strU(raw.tool),
          arguments: raw.arguments,
          result: raw.result,
          error: raw.error,
          status: strU(raw.status),
          durationMs: numU(raw.duration_ms ?? raw.durationMs),
        },
      };
    case "web_search":
      return {
        kind: "tool",
        itemId,
        tool: { kind: "web-search", query: strU(raw.query), action: strU(raw.action) },
      };
    case "function_call_output":
      return {
        kind: "tool",
        itemId,
        tool: {
          kind: "function",
          name: strU(raw.name),
          namespace: strU(raw.namespace),
          output: raw.output,
        },
      };
    case "dynamic_tool_call":
      return {
        kind: "tool",
        itemId,
        tool: {
          kind: "dynamic",
          tool: strU(raw.tool),
          namespace: strU(raw.namespace),
          status: strU(raw.status),
          durationMs: numU(raw.duration_ms ?? raw.durationMs),
        },
      };
    case "plan":
    case "todo_list":
      return { kind: "plan", itemId, text: planText(raw) };
    case "user_message":
      return { kind: "user-message", itemId, text: userText(raw) };
    default:
      return { kind: "unknown", eventType: `item.completed:${itemType}`, raw };
  }
}

/**
 * Parses one line of the exec stream into a `NormalizedEvent`, or null when the
 * line carries nothing to emit: blank, non-JSON noise, a non-object, or an
 * envelope with no `type`. A well-formed envelope with an unrecognized `type` is
 * passed through as `unknown`. Never throws.
 */
export function parseCodexLine(line: string): NormalizedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const type = str(parsed.type);
  if (!type) return null;

  try {
    switch (type) {
      case "thread.started": {
        const sessionId = str(parsed.thread_id ?? parsed.threadId);
        return sessionId
          ? { kind: "session-started", sessionId }
          : { kind: "unknown", eventType: type, raw: parsed };
      }
      case "turn.started":
        return { kind: "turn-started" };
      case "turn.completed": {
        // The app-server has no distinct turn.failed method: it models a failed
        // turn as turn.completed carrying Turn.status="failed" and a populated
        // Turn.error. A failed turn is surfaced as turn-failed (error classified,
        // usage dropped) rather than a clean completion; a normal turn.completed
        // carries neither signal and maps to turn-completed with its usage.
        const status = strU(parsed.status);
        const error = parsed.error;
        if (status === "failed" || (isObject(error) && Object.keys(error).length > 0)) {
          return { kind: "turn-failed", error: classifyCodexError(error) };
        }
        return { kind: "turn-completed", usage: mapCodexUsage(parsed.usage) };
      }
      case "turn.failed":
        return { kind: "turn-failed", error: classifyCodexError(parsed.error) };
      case "error":
        return mapStreamError(parsed);
      case "item.completed":
        return mapItemCompleted(parsed.item);
      case "item.started":
      case "item.updated":
        // In-progress notifications are optional and their content is repeated on
        // item.completed, so they are ignored to avoid double-counting an item.
        return null;
      default:
        return { kind: "unknown", eventType: type, raw: parsed };
    }
  } catch {
    // A parseable-but-malformed payload must never crash the stream.
    return null;
  }
}

/**
 * Streaming parser over a `codex exec --json` stdout. Buffers a trailing partial
 * line across `push` calls; `end` flushes a final unterminated line. See
 * parseCodexLine for the per-line rules.
 */
export class CodexEventParser implements StreamParser {
  private buffer = "";

  push(chunk: string): NormalizedEvent[] {
    this.buffer += chunk;
    const events: NormalizedEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const event = parseCodexLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  end(): NormalizedEvent[] {
    const line = this.buffer;
    this.buffer = "";
    const event = parseCodexLine(line);
    return event ? [event] : [];
  }
}
