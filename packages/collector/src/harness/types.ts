/**
 * Harness-agnostic seam for the agent CLIs Standup drives.
 *
 * Claude Code is the default harness: it is observed through hooks + its JSONL
 * transcript (`transcript.ts` / `rich-transcript.ts`) and launched by
 * `launcher.ts`, and that path is unchanged. This module defines the common
 * surface a *second* harness (Codex) implements so its launch and its event
 * stream can be built and parsed without the rest of the collector caring which
 * CLI produced them. It is additive — nothing here alters the Claude path.
 *
 * A `NormalizedEvent` is the lowest common denominator across harnesses: the
 * same Standup concepts `rich-transcript.ts` already fills for Claude (session
 * identity, turn boundaries, assistant prose, reasoning, tool/command activity,
 * file diffs, plans, per-turn token usage), expressed once so a later item can
 * feed either harness's stream into the same views and telemetry.
 */

/**
 * Per-turn token usage in a harness-neutral shape. Field meanings follow the
 * Codex `turn.completed.usage` contract (`input_tokens`, `cached_input_tokens`,
 * `cache_write_input_tokens`, `output_tokens`), which is the reconciliation target: `cachedInputTokens` and `cacheWriteInputTokens` are
 * SUBSETS of `inputTokens` (already counted inside it), NOT additive — unlike
 * Claude, whose input / cache-read / cache-creation legs are disjoint. See
 * `codexUsageToRecord` for the mapping onto the cost model in `usage.ts`.
 */
export interface NormalizedUsage {
  /** Total prompt tokens sent this turn — inclusive of the cache legs below. */
  inputTokens: number;
  /** Prompt tokens served from cache; a subset of `inputTokens`. */
  cachedInputTokens: number;
  /** Prompt tokens written to cache this turn; a subset of `inputTokens`. */
  cacheWriteInputTokens: number;
  /** Completion tokens produced this turn. */
  outputTokens: number;
  /** Reasoning tokens; a subset of `outputTokens`. */
  reasoningOutputTokens: number;
}

/** A single tool/command activity, discriminated by the kind of tool. */
export type NormalizedTool =
  | {
      kind: "command";
      command?: string;
      cwd?: string;
      aggregatedOutput?: string;
      exitCode?: number;
      status?: string;
      durationMs?: number;
    }
  | {
      kind: "mcp";
      server?: string;
      tool?: string;
      arguments?: unknown;
      result?: unknown;
      error?: unknown;
      status?: string;
      durationMs?: number;
    }
  | { kind: "web-search"; query?: string; action?: string }
  | { kind: "function"; name?: string; namespace?: string; output?: unknown }
  | { kind: "dynamic"; tool?: string; namespace?: string; status?: string; durationMs?: number }
  /** An item whose type is a tool but is out of the parser's known contract. */
  | { kind: "other"; toolType: string; item: Record<string, unknown> };

/** One file edited within a `file-change` event. */
export interface NormalizedFileChange {
  path: string;
  /**
   * add / delete / update, decoded from Codex's discriminated `kind` object
   * (`{ type, move_path? }`); `unknown` when the wire carried a shape the parser
   * did not recognize.
   */
  changeKind: "add" | "delete" | "update" | "unknown";
  /** Rename target on an `update`, else null/absent. */
  movePath?: string | null;
  /** Unified-diff text (Codex emits a diff string, not structured hunks). */
  diff?: string;
}

/**
 * A turn/stream failure, classified from Codex's `TurnError.codexErrorInfo`
 * where present. `retryable` marks the transient connection class (the four
 * object-tagged `{ httpStatusCode }` variants); a permanent rejection such as
 * `activeTurnNotSteerable` is not retryable.
 */
export interface NormalizedError {
  message: string;
  /** The `codexErrorInfo` variant name, when the payload carried one. */
  code?: string;
  retryable?: boolean;
  httpStatusCode?: number | null;
  additionalDetails?: string;
}

/**
 * A single harness event mapped onto Standup's concepts. `unknown` is the
 * pass-through for a well-formed envelope whose item/type is out of contract —
 * the parser never throws on and never silently swallows those.
 */
export type NormalizedEvent =
  | { kind: "session-started"; sessionId: string }
  | { kind: "turn-started" }
  | { kind: "turn-completed"; usage?: NormalizedUsage }
  | { kind: "turn-failed"; error: NormalizedError }
  | { kind: "assistant-message"; itemId?: string; text: string }
  | { kind: "reasoning"; itemId?: string; text: string }
  | { kind: "tool"; itemId?: string; tool: NormalizedTool }
  | { kind: "file-change"; itemId?: string; changes: NormalizedFileChange[] }
  | { kind: "plan"; itemId?: string; text: string }
  | { kind: "user-message"; itemId?: string; text: string }
  | { kind: "stream-error"; message: string; willRetry?: boolean }
  | { kind: "unknown"; eventType: string; raw: unknown };

/**
 * A streaming parser over a harness process's stdout. Feed decoded chunks as
 * they arrive; each call returns the events completed by that chunk. It tolerates
 * lines split across chunk boundaries — a trailing partial line is buffered until
 * the next chunk completes it — and `end()` flushes any final unterminated line.
 */
export interface StreamParser {
  /** Consume a decoded stdout chunk; returns events completed by it. */
  push(chunk: string): NormalizedEvent[];
  /** Flush a buffered final line (stream closed without a trailing newline). */
  end(): NormalizedEvent[];
}

/** What a harness needs in order to spawn a headless session in a worktree. */
export interface HarnessLaunchSpec {
  /**
   * The working root the session runs in. For Codex this is the WORKSPACE ROOT
   * (the launcher passes the worktree root, not the launchSubdir) — used as both
   * `codex -C` and the tmux pane cwd — so a multi-package workspace agent
   * starts at and can write across the whole workspace, not one package.
   */
  cwd: string;
  /** The opening prompt, delivered to the CLI as its prompt argument. */
  prompt: string;
  /** tmux session name Standup owns the pane under. */
  tmuxSession: string;
  /** Stable id used to name the transient prompt file. */
  launchId: string;
  /** Model id passed through to the CLI; omitted means the CLI's own default. */
  model?: string;
  /**
   * Reasoning-effort level passed through to the harness; omitted means the
   * CLI's own default. Codex applies it as a `-c model_reasoning_effort=<level>`
   * config override (see buildCodexArgv).
   */
  reasoningEffort?: string;
  /** Extra CLI argv tokens (a project's launch flags), inserted before the prompt. */
  extraArgs?: string[];
  /**
   * Where to persist the harness's machine-readable event stream (stdout) for
   * telemetry, tee'd from the pane. The Codex adapter routes `codex exec --json`
   * stdout here so fleet telemetry can reconcile the run's token usage. Omitted
   * leaves stdout only in the pane (no sidecar).
   */
  eventLogPath?: string;
}

/**
 * The common contract every harness implements: build the detached-tmux launch
 * command for a headless session, and create a parser for that session's event
 * stream. Claude's existing launch/observe path predates this seam and is not
 * retrofitted onto it here.
 */
export interface HarnessAdapter {
  /** Stable identifier, e.g. `"claude"` or `"codex"`. */
  readonly id: string;
  /** The `tmux new-session …` argv that launches a headless session. */
  buildLaunchCommand(spec: HarnessLaunchSpec): string[];
  /** A fresh streaming parser for one session's stdout. */
  createParser(): StreamParser;
}
