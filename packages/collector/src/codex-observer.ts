import { openSync, fstatSync, readSync, closeSync } from "fs";
import type { Database } from "bun:sqlite";
import {
  getCodexLaunches,
  getLaunch,
  getSession,
  createSession,
  attachSessionToLaunch,
  attachSessionToTaskRun,
  setSessionCreatedActor,
  endSession,
  appendEvent,
  headSeq,
  updateLaunchStatus,
} from "@standup/store";
import type { Launch, WsMessage } from "@standup/shared";
import { capTitle } from "@standup/shared";
import { CodexHarnessAdapter } from "./harness/codex.js";
import type {
  HarnessAdapter,
  NormalizedEvent,
  NormalizedFileChange,
  NormalizedTool,
  NormalizedUsage,
  StreamParser,
} from "./harness/types.js";
import { tmuxSessionExists } from "./launcher.js";

type Broadcast = (message: WsMessage) => void;

/** One record to append to a session's transcript log, with its stable id. */
interface MappedRecord {
  /** Stable per-launch event id — appendEvent dedups on it. */
  eventId: string;
  /** A Claude-JSONL-shaped record the web/session projection already renders. */
  record: unknown;
}

/** A tool result payload rendered to text for the transcript projection. */
function renderResult(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** The tool name an MCP call is shown under, mirroring Claude's `mcp__srv__tool`. */
function mcpToolName(tool: Extract<NormalizedTool, { kind: "mcp" }>): string {
  if (tool.server && tool.tool) return `mcp__${tool.server}__${tool.tool}`;
  return tool.tool ?? tool.server ?? "mcp";
}

/**
 * Maps a `NormalizedTool` onto the Claude tool_use/tool_result shape the session
 * projection classifies: `name` picks the render (Bash → bash panel, etc.),
 * `input` is the call, `output`/`isError` the result text, and `sidecar` the
 * structured `toolUseResult` a Bash/diff render reads.
 */
function describeTool(tool: NormalizedTool): {
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  sidecar?: unknown;
} {
  switch (tool.kind) {
    case "command":
      return {
        name: "Bash",
        input: { command: tool.command ?? "" },
        output: tool.aggregatedOutput ?? "",
        isError: typeof tool.exitCode === "number" ? tool.exitCode !== 0 : false,
        // The projection renders a `bash` panel from these fields on toolUseResult.
        sidecar: { stdout: tool.aggregatedOutput ?? "", stderr: "", interrupted: false },
      };
    case "mcp":
      return {
        name: mcpToolName(tool),
        input: (tool.arguments as Record<string, unknown>) ?? {},
        output: renderResult(tool.error ?? tool.result),
        isError: tool.error != null,
      };
    case "web-search":
      return {
        name: "WebSearch",
        input: { query: tool.query ?? "", action: tool.action ?? "" },
        output: "",
        isError: false,
      };
    case "function":
      return {
        name: tool.name ?? "function",
        input: tool.namespace ? { namespace: tool.namespace } : {},
        output: renderResult(tool.output),
        isError: false,
      };
    case "dynamic":
      return {
        name: tool.tool ?? "dynamic",
        input: tool.namespace ? { namespace: tool.namespace } : {},
        output: tool.status ?? "",
        isError: false,
      };
    case "other":
      return { name: tool.toolType, input: tool.item, output: "", isError: false };
  }
}

/**
 * Folds a Codex session's `NormalizedEvent` stream into the Claude-JSONL record
 * shape Standup already stores and both the web and mirror project (see
 * hooks/sessionProjection.ts and transcript.ts). A Codex run posts no hooks, so
 * this is how its assistant prose, reasoning, tool/command activity, file changes,
 * user turns and per-turn token usage reach the same transcript views a Claude
 * session's do.
 *
 * Each record carries a per-launch `eventId` from a monotonic counter advanced in
 * parse order (`codex:<launchId>:<n>`); a tool_use and its tool_result share a
 * `tool_use_id` so the projection pairs them. Because the sidecar is append-only
 * and the parse is deterministic, that id is a stable function of a record's
 * position in the stream: re-parsing the sidecar from the start re-derives the
 * same id for the same record, so appendEvent dedups an already-logged record
 * rather than duplicating it. That is what lets the observer resume losslessly by
 * re-reading from byte 0 (see CodexObserver.discover). `startId` offsets the
 * counter for a caller that maps only a suffix of the stream; a whole-stream
 * mapper leaves it 0.
 */
export class CodexTranscriptMapper {
  private n: number;

  constructor(
    private readonly launchId: string,
    startId = 0
  ) {
    this.n = startId;
  }

  private nextId(): string {
    return `codex:${this.launchId}:${this.n++}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private assistant(content: unknown[], usage?: Record<string, number>): MappedRecord {
    const eventId = this.nextId();
    const message: Record<string, unknown> = { role: "assistant", content };
    if (usage) message.usage = usage;
    return {
      eventId,
      record: { type: "assistant", uuid: eventId, timestamp: this.now(), message },
    };
  }

  private userText(text: string): MappedRecord {
    const eventId = this.nextId();
    return {
      eventId,
      record: {
        type: "user",
        uuid: eventId,
        timestamp: this.now(),
        message: { role: "user", content: text },
      },
    };
  }

  private toolResult(
    toolUseId: string,
    content: string,
    isError: boolean,
    sidecar?: unknown
  ): MappedRecord {
    const eventId = this.nextId();
    const record: Record<string, unknown> = {
      type: "user",
      uuid: eventId,
      timestamp: this.now(),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
    };
    if (sidecar !== undefined) record.toolUseResult = sidecar;
    return { eventId, record };
  }

  /**
   * Codex's `input_tokens` is inclusive of both cache legs (they are subsets, not
   * additive), so decompose it the way codex-events.ts's codexUsageToRecord does:
   * fresh input is what remains after removing the cache legs. The projection sums
   * context as input + cache_read + cache_creation, so this keeps that total at
   * Codex's inclusive input_tokens rather than double-counting the cache legs.
   */
  private usageRecord(u: NormalizedUsage): MappedRecord {
    const cacheRead = Math.max(0, u.cachedInputTokens);
    const cacheCreation = Math.max(0, u.cacheWriteInputTokens);
    const input = Math.max(0, u.inputTokens - cacheRead - cacheCreation);
    return this.assistant([], {
      input_tokens: input,
      output_tokens: Math.max(0, u.outputTokens),
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreation,
    });
  }

  private toolRecords(tool: NormalizedTool): MappedRecord[] {
    const toolUseId = `codextool:${this.launchId}:${this.n}`;
    const { name, input, output, isError, sidecar } = describeTool(tool);
    return [
      this.assistant([{ type: "tool_use", id: toolUseId, name, input }]),
      this.toolResult(toolUseId, output, isError, sidecar),
    ];
  }

  private fileChangeRecords(changes: NormalizedFileChange[]): MappedRecord[] {
    if (changes.length === 0) return [];
    const toolUseId = `codextool:${this.launchId}:${this.n}`;
    const summary = changes
      .map((c) => `${c.changeKind} ${c.path}${c.movePath ? ` -> ${c.movePath}` : ""}`)
      .join("\n");
    const diffs = changes
      .map((c) => c.diff)
      .filter((d): d is string => !!d)
      .join("\n\n");
    const text = diffs ? `${summary}\n\n${diffs}` : summary;
    return [
      this.assistant([{ type: "tool_use", id: toolUseId, name: "ApplyPatch", input: { changes } }]),
      this.toolResult(toolUseId, text, false),
    ];
  }

  /** Maps one `NormalizedEvent` to zero or more transcript records. */
  map(event: NormalizedEvent): MappedRecord[] {
    switch (event.kind) {
      case "assistant-message":
        return event.text.trim() ? [this.assistant([{ type: "text", text: event.text }])] : [];
      case "reasoning":
        return event.text.trim()
          ? [this.assistant([{ type: "thinking", thinking: event.text }])]
          : [];
      case "plan":
        return event.text.trim() ? [this.assistant([{ type: "text", text: event.text }])] : [];
      case "user-message":
        return event.text.trim() ? [this.userText(event.text)] : [];
      case "tool":
        return this.toolRecords(event.tool);
      case "file-change":
        return this.fileChangeRecords(event.changes);
      case "turn-completed":
        return event.usage ? [this.usageRecord(event.usage)] : [];
      case "turn-failed":
        return [this.assistant([{ type: "text", text: `⚠ turn failed: ${event.error.message}` }])];
      case "stream-error":
        return [this.assistant([{ type: "text", text: `⚠ stream error: ${event.message}` }])];
      // Session identity is handled by the observer; turn boundaries and
      // out-of-contract envelopes carry nothing to render.
      case "session-started":
      case "turn-started":
      case "unknown":
        return [];
    }
  }
}

/** Per-launch tail + parse state. */
interface CodexWatch {
  launchId: string;
  path: string;
  parser: StreamParser;
  mapper: CodexTranscriptMapper;
  /** Bytes of the sidecar already consumed. */
  offset: number;
  /** The session created from this run's stream, once `thread.started` arrives. */
  sessionId: string | null;
  /** The provider's error when the run's latest turn failed before any work; cleared when a turn starts or works. */
  lastTurnError?: string;
  /** Whether the latest turn has completed any work item yet. */
  lastTurnWorked?: boolean;
}

/** The most of a provider's error a failed launch keeps; the transcript has the whole text. */
const LAUNCH_ERROR_MAX_CHARS = 300;

/** The event kinds that are the agent doing work, as opposed to turn bookkeeping or the prompt echo. */
const WORK_EVENT_KINDS = new Set<NormalizedEvent["kind"]>(["assistant-message", "reasoning", "tool", "file-change", "plan"]);

export interface CodexObserverOptions {
  /** The harness whose parser decodes the sidecar; defaults to Codex. */
  adapter?: HarnessAdapter;
  /** tmux liveness probe; injectable for tests. */
  sessionExists?: (name: string) => boolean;
  /** Poll cadence for the shared tick. */
  pollMs?: number;
}

/**
 * Observes running Codex launches by tailing the JSONL sidecar their
 * `codex exec --json` stdout is tee'd to, routing it through the harness
 * adapter's `StreamParser` (the observation half of the HarnessAdapter seam).
 *
 * A Codex run posts no Standup hooks, so nothing else would ever create a session
 * for it: this creates one from the stream's `thread.started`, attaches it to the
 * launch, and appends the run's activity as transcript events so the feed and
 * transcript views render it live — the Codex analogue of the hook + JSONL path
 * that observes a Claude session. When the pane dies it ends the session (or, if
 * the run died before it ever started one, fails the launch) so the run leaves the
 * active fleet the same way a reaped Claude session does.
 *
 * Discovery is by polling the store (getCodexLaunches) rather than a launch-time
 * callback, so a run that was live across a collector restart is picked back up;
 * an already-attached launch is baselined to the sidecar's current end so history
 * isn't re-ingested, matching the transcript tailer's growth-only rule.
 */
export class CodexObserver {
  private readonly db: Database;
  private readonly broadcast: Broadcast;
  private readonly adapter: HarnessAdapter;
  private readonly sessionExists: (name: string) => boolean;
  private readonly pollMs: number;
  private readonly watched = new Map<string, CodexWatch>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database, broadcast: Broadcast, opts: CodexObserverOptions = {}) {
    this.db = db;
    this.broadcast = broadcast;
    this.adapter = opts.adapter ?? new CodexHarnessAdapter();
    this.sessionExists = opts.sessionExists ?? tmuxSessionExists;
    this.pollMs = opts.pollMs ?? 1000;
  }

  /** Start the shared poll. Idempotent. */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.tick(), this.pollMs);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
  }

  /** Stop polling and drop every watch. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.watched.clear();
  }

  get watchCount(): number {
    return this.watched.size;
  }

  /**
   * One poll pass: pick up newly-live Codex launches, then ingest each watched
   * launch's new sidecar bytes and finalize any whose pane has died. Exposed so a
   * test can drive it deterministically without the poll clock.
   */
  tick(): void {
    this.discover();
    for (const watch of [...this.watched.values()]) {
      try {
        this.pump(watch);
      } catch {
        // One malformed sidecar or a mid-teardown store must not abort the pass
        // for the other watched launches.
      }
    }
  }

  private discover(): void {
    for (const launch of getCodexLaunches(this.db, { activeOnly: true })) {
      if (!launch.codexEventLog || this.watched.has(launch.id)) continue;
      // Always tail from the start of the sidecar with a fresh counter. Re-reading
      // it from byte 0 re-mints each record's deterministic id
      // (`codex:<launchId>:<n>` in parse order), so appendEvent dedups the records
      // already persisted for this session and appends only genuinely new ones.
      // That is the same read-from-0 + dedup-by-stable-id rule the Claude
      // transcript tailer resumes on, and it is lossless across a collector
      // restart: an already-attached launch (its session formed before the
      // restart) re-ingests its history as dedup hits, while any events written to
      // the sidecar but not yet ingested when the process went down are still
      // picked up. Baselining a resumed launch to the sidecar's current EOF would
      // instead silently drop that un-ingested tail.
      this.watched.set(launch.id, {
        launchId: launch.id,
        path: launch.codexEventLog,
        parser: this.adapter.createParser(),
        mapper: new CodexTranscriptMapper(launch.id),
        offset: 0,
        sessionId: launch.sessionId ?? null,
      });
    }
  }

  private pump(watch: CodexWatch): void {
    const launch = getLaunch(this.db, watch.launchId);
    if (!launch || (launch.status !== "running" && launch.status !== "starting")) {
      // The launch reached a terminal state by another path (manual stop/cleanup);
      // stop watching — its pane and possibly its worktree are gone.
      this.watched.delete(watch.launchId);
      return;
    }
    // A launch reserves its tmux session name at row-creation but spawns the
    // pane only after provisioning, flipping to `running` the instant it does
    // (setLaunchPhase never touches status). So while the row is still `starting`
    // a missing pane means "not launched yet", NOT "died" — finalizing then would
    // kill a launch mid-provision (its sidecar doesn't even exist yet). Treat a
    // vanished pane as a dead run only once the launch reached `running`, i.e. the
    // pane was actually spawned.
    const paneGone =
      launch.status === "running" &&
      !!launch.tmuxSession &&
      !this.sessionExists(launch.tmuxSession);

    const events: NormalizedEvent[] = [];
    const delta = this.readDelta(watch, paneGone);
    if (delta) {
      watch.offset += delta.consumed;
      events.push(...watch.parser.push(delta.text));
    }
    // The pane is gone — flush any buffered final line before finalizing.
    if (paneGone) events.push(...watch.parser.end());

    if (events.length > 0) this.consume(watch, events, launch);
    if (paneGone) this.finalize(watch, launch);
  }

  /**
   * Reads the sidecar bytes past `offset`. In steady state it stops at the last
   * complete line (a partial trailing line is left for the next tick, so a UTF-8
   * multibyte split across the read boundary is never decoded mid-line). On the
   * final drain it reads to EOF. Returns null when the file isn't present yet or
   * has no new complete line.
   */
  private readDelta(watch: CodexWatch, toEof: boolean): { text: string; consumed: number } | null {
    let fd: number;
    try {
      fd = openSync(watch.path, "r");
    } catch {
      return null; // sidecar not created yet
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= watch.offset) return null;
      const length = size - watch.offset;
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, watch.offset);
      let slice = buf.subarray(0, read);
      let consumed = read;
      if (!toEof) {
        const lastNewline = slice.lastIndexOf(0x0a);
        if (lastNewline < 0) return null; // no complete line yet
        slice = slice.subarray(0, lastNewline + 1);
        consumed = lastNewline + 1;
      }
      return { text: slice.toString("utf8"), consumed };
    } finally {
      closeSync(fd);
    }
  }

  private consume(watch: CodexWatch, events: NormalizedEvent[], launch: Launch): void {
    let sessionCreated = false;
    let appended = false;

    for (const event of events) {
      if (event.kind === "session-started" && !watch.sessionId) {
        watch.sessionId = this.ensureSession(launch, event.sessionId);
        sessionCreated = true;
      }
      if (event.kind === "turn-started") {
        watch.lastTurnError = undefined;
        watch.lastTurnWorked = false;
      } else if (WORK_EVENT_KINDS.has(event.kind)) {
        watch.lastTurnWorked = true;
      } else if (event.kind === "turn-failed" && !watch.lastTurnWorked) {
        watch.lastTurnError = event.error.message;
      }

      const records = watch.mapper.map(event);
      if (records.length === 0) continue;

      // A renderable event before thread.started should not happen, but never drop
      // it: fall back to a launch-keyed session id so nothing is lost.
      if (!watch.sessionId) {
        watch.sessionId = this.ensureSession(launch, `codex-${launch.id}`);
        sessionCreated = true;
      }

      for (const { eventId, record } of records) {
        if (appendEvent(this.db, watch.sessionId, { eventId, event: record }).inserted) {
          appended = true;
        }
      }
    }

    if (sessionCreated) this.broadcastSessions();
    if ((sessionCreated || appended) && watch.sessionId) this.nudge(watch.sessionId);
  }

  private ensureSession(launch: Launch, sessionId: string): string {
    if (!getSession(this.db, sessionId)) {
      createSession(this.db, {
        id: sessionId,
        projectId: launch.projectId,
        title: capTitle(launch.task),
        cwd: launch.worktreePath,
        status: "running",
      });
      // Link the launch (and its ledger run) to this session so ownership,
      // report_task and the reaper/sweep can key off it exactly as for Claude.
      attachSessionToLaunch(this.db, launch.id, sessionId);
      attachSessionToTaskRun(this.db, launch.worktreePath, sessionId);
      if (launch.requester) setSessionCreatedActor(this.db, sessionId, launch.requester);
      // The launch row now carries its session: push it, as the Claude hook path does, so
      // listeners keyed on the launch (its feed card, its job's board card) see the binding.
      const attached = getLaunch(this.db, launch.id);
      if (attached) this.emit({ type: "launch:started", payload: attached });
    }
    return sessionId;
  }

  private finalize(watch: CodexWatch, launch: Launch): void {
    if (watch.sessionId) {
      const session = getSession(this.db, watch.sessionId);
      if (session && !session.endedAt) {
        endSession(this.db, watch.sessionId);
        this.emit({ type: "session:end", payload: { sessionId: watch.sessionId } });
        this.broadcastSessions();
      }
      // A run whose last turn failed before doing any work ended on the
      // provider's error (an unreachable model, a denied account), not on
      // finished work: fail the launch with that error so it reads as failed.
      if (watch.lastTurnError) {
        const detail =
          watch.lastTurnError.length > LAUNCH_ERROR_MAX_CHARS
            ? `${watch.lastTurnError.slice(0, LAUNCH_ERROR_MAX_CHARS)}…`
            : watch.lastTurnError;
        updateLaunchStatus(this.db, launch.id, "failed", `codex turn failed: ${detail}`);
        const updated = getLaunch(this.db, launch.id);
        if (updated) this.emit({ type: "launch:started", payload: updated });
      }
    } else {
      // The pane died before Codex emitted thread.started, so no session ever
      // formed — the run produced nothing observable. Fail the launch so it leaves
      // the active fleet rather than reading `running` forever.
      updateLaunchStatus(
        this.db,
        launch.id,
        "failed",
        "codex exec exited before starting a session"
      );
      const updated = getLaunch(this.db, launch.id);
      if (updated) this.emit({ type: "launch:started", payload: updated });
    }
    this.watched.delete(watch.launchId);
  }

  private broadcastSessions(): void {
    this.emit({ type: "session:status", payload: {} });
  }

  private nudge(sessionId: string): void {
    try {
      this.emit({ type: "session:event", payload: { sessionId, seq: headSeq(this.db, sessionId) } });
    } catch {
      // headSeq hits the db; if the store closed under a test teardown, swallow
      // rather than throw out of a timer — the nudge is best-effort live sugar.
    }
  }

  private emit(message: Omit<WsMessage, "timestamp">): void {
    this.broadcast({ ...message, timestamp: new Date().toISOString() } as WsMessage);
  }
}
