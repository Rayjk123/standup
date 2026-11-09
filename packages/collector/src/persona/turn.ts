import { readFileSync, renameSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { PersonaAttachmentMime } from "@standup/shared";
import { headlessSettingsArgs } from "../claude-cli.js";
import { ensurePrivateDir, writePrivateFileSync } from "../internal-cwd.js";
import { withoutSlotEnv } from "../worker-env.js";
import { killProcessGroup } from "../drain.js";

/** An image shown to Persona with the turn's prompt, after a `[label]` text block naming it. */
export interface TurnImage {
  mimeType: PersonaAttachmentMime;
  base64: string;
  label: string;
}

/** One Persona turn to run. */
export interface TurnInput {
  prompt: string;
  /** Images shown with the prompt, in order; none keeps stdin plain text. */
  images?: TurnImage[];
  /** Passed through a 0600 file as `--append-system-prompt-file`. */
  systemPrompt: string;
  /** Continue this Claude session; absent starts a fresh one. */
  resumeSessionId?: string;
  model: string;
  effort: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
  /** Auto-compact at this percent of the context window; absent keeps the CLI default. */
  autoCompactPct?: number;
}

export type TurnResult =
  | ({
      ok: true;
      /** The turn's final message text, untrimmed. */
      text: string;
      /** When the final message has no text: the last main-thread model call's text, if any had some. */
      earlierText?: string;
      sessionId: string;
      /** Input + cache tokens of the last model call — the live context size. */
      contextTokens?: number;
      /** The largest context window among the turn's models (`modelUsage[*].contextWindow`). */
      contextWindow?: number;
    } & ResultSpend)
  | ({
      ok: false;
      error: string;
      /** The CLI rejected `resumeSessionId` as unknown — retry fresh. */
      sessionNotFound?: boolean;
      /**
       * The API refused the request over its images or its size (an image it
       * couldn't process, too many or too large images, a request too large)
       * — retry on a fresh session, whose history carries no images.
       */
      mediaRejected?: boolean;
      /**
       * The CLI's diagnostics (its error report, `errors[]`, all of stderr)
       * name a transient failure of the model's credentials, rate limits,
       * service or network (isTransientTurnError) — one a later retry may get
       * past.
       */
      transient?: boolean;
      /** killRunning ended the turn (a collector shutdown), not the turn itself failing. */
      killed?: boolean;
    } & ResultSpend);

/**
 * Runs one turn. Must never throw — every failure is `{ ok: false }`.
 * `killRunning`, when present, kills every turn still running (each one's
 * whole process group) and returns how many it signalled; the collector calls
 * it on shutdown so no turn outlives the process that started it. A turn it
 * kills resolves `{ ok: false, killed: true }`.
 */
export type TurnRunner = ((input: TurnInput) => Promise<TurnResult>) & { killRunning?: () => number };

/** The parts of a spawned turn process the runner uses. */
export interface TurnProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): void;
}

/** How the runner starts a turn: `detached` makes the turn lead its own process group. */
export type TurnSpawn = (
  argv: string[],
  options: { cwd: string; stdin: Blob; env: Record<string, string>; detached: true }
) => TurnProcess;

const defaultTurnSpawn: TurnSpawn = (argv, options) =>
  Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" });

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  iterations?: UsageBlock[];
}

function promptTokens(usage: UsageBlock | undefined): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const total =
    (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return total > 0 ? total : undefined;
}

const SESSION_NOT_FOUND = /no conversation found|session[^\n]{0,40}not found|no such session/i;

/**
 * How the API (direct or through Bedrock) words a refusal over a request's
 * images or size, each anchored to the API's own error wording so a stack
 * frame or an id that happens to contain "413" doesn't match.
 */
const MEDIA_REJECTION: readonly RegExp[] = [
  /\bAPI Error: 413\b/i,
  /\brequest_too_large\b/i,
  /\bRequest (Entity )?too large\b/i,
  /\bRequest exceeds the maximum size\b/i,
  /\bCould not process image\b/i,
  /\bimage exceeds \d+ ?[KM]B maximum\b/i,
  /\bimage dimensions exceed max allowed size\b/i,
  /\bToo many images\b/i,
  /\bA maximum of \d+ images\b/i,
  /\bInput image is invalid\b/i,
  /\bimage\.source\.base64[^\n]{0,40}\b(exceeds?|invalid|dimensions?)\b/i,
];

/** Whether `text` (an error the CLI reported) says the API refused the request over its images or size. */
export function isMediaRejection(text: string): boolean {
  return MEDIA_REJECTION.some((pattern) => pattern.test(text));
}

/**
 * How a failed turn words a failure of the model's credentials, rate limits,
 * service or network — one that can clear by itself (credentials refreshed, a
 * throttle lifting, the service or link coming back) — rather than one in the
 * request or the turn itself.
 */
const TRANSIENT_TURN_ERROR: readonly RegExp[] = [
  // Credentials: the CLI's own auth report, and expired AWS / API tokens.
  /\bauthentication failed\b/i,
  /\bFailed to authenticate\b/i,
  /\brefresh your (AWS )?credentials\b/i,
  /\b(security )?token[^\n]{0,60}\bexpired\b/i,
  /\bExpired(Token|Credentials?)(Exception)?\b/,
  /\bUnrecognizedClientException\b/,
  /\bCould not load credentials from any providers\b/i,
  /\bCredentialsProviderError\b/,
  /\bUnable to locate credentials\b/i,
  /\bAPI Error: 401\b/i,
  /\bauthentication_error\b/i,
  // Throttling and overload.
  /\bAPI Error: 429\b/i,
  /\bAPI Error: 529\b/i,
  /\bThrottl(ed|ing)(Exception)?\b/i,
  /\brate[ _]limit(ed|_error)?\b/i,
  /\bToo many requests\b/i,
  /\boverloaded(_error)?\b/i,
  /\bServiceQuotaExceeded\b/i,
  // The service failing.
  /\bAPI Error: (408|5\d\d)\b/i,
  /\bModel(Timeout|StreamError)Exception\b/,
  /\b(Internal server error|Service Unavailable|Bad Gateway|Gateway Time-?out)\b/i,
  /\bapi_error\b/,
  /\b(ServiceUnavailable|InternalServer|ModelNotReady)(Exception)?\b/,
  // The network.
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b/,
  /\bsocket hang up\b/i,
  /\bUND_ERR_(CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)\b/,
  /\bother side closed\b/i,
  /\bfetch failed\b/i,
  /\bConnection (error|reset|refused|timed out)\b/i,
  /\bnetwork (error|is unreachable)\b/i,
  /\bRequest timed out\b/i,
];

/**
 * Whether `text` (a failed turn's diagnostics) names a transient failure of
 * the model's credentials, rate limits, service or network, which a later
 * retry may get past. A refused request (bad input, too large, an unknown
 * model) or a crash is not transient; nor is a turn's own timeout, which the
 * runner reports without asking this.
 */
export function isTransientTurnError(text: string): boolean {
  return TRANSIENT_TURN_ERROR.some((pattern) => pattern.test(text));
}

/**
 * The error text of a failed run that may say why the API refused it: the
 * CLI's `errors[]` and stderr, and the result text only when it is the CLI's
 * own "API Error" report (never a model reply, which may quote anything).
 */
function rejectionDiagnostic(result: string | undefined, errors: readonly string[], stderr: string): string {
  const fromResult = result && /^\s*API Error/i.test(result) ? [result] : [];
  return [...fromResult, ...errors, stderr].join("\n");
}

interface StreamEvent {
  type?: unknown;
  subtype?: unknown;
  parent_tool_use_id?: unknown;
  message?: { id?: unknown; model?: unknown; content?: unknown; usage?: UsageBlock };
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  errors?: unknown;
  usage?: UsageBlock;
  total_cost_usd?: unknown;
  modelUsage?: unknown;
}

/**
 * The largest `contextWindow` in a result's `modelUsage` map, or undefined.
 * The largest, because a turn's side calls may use a smaller model than the
 * main one, and a rotation size taken from the smaller window would fire
 * before the main session's own compaction.
 */
function largestContextWindow(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let largest: number | undefined;
  for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
    const window = (entry as { contextWindow?: unknown } | null)?.contextWindow;
    if (typeof window === "number" && Number.isFinite(window) && window > 0 && (largest === undefined || window > largest)) {
      largest = window;
    }
  }
  return largest;
}

/** What a result event reports a turn spent; each field absent when it reports none. */
interface ResultSpend {
  /**
   * `total_cost_usd` as reported. On a `--resume` of the session the CLI ran
   * last in this cwd it restores that session's cost, so this is then the
   * session's running total, not the turn's (see PersonaRuntime.recordTurn).
   */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  /** The Claude session the result belongs to. */
  claudeSessionId?: string;
}

/** The cost, billed tokens and main model a result event reports; each absent when it reports none. */
function resultSpend(result: StreamEvent): ResultSpend {
  const out: ResultSpend = {};
  if (typeof result.session_id === "string" && result.session_id) out.claudeSessionId = result.session_id;
  if (typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)) out.costUsd = result.total_cost_usd;
  const usage = result.usage;
  if (usage && typeof usage === "object") {
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (input > 0) out.inputTokens = input;
    if (typeof usage.output_tokens === "number") out.outputTokens = usage.output_tokens;
  }
  if (result.modelUsage && typeof result.modelUsage === "object") {
    let top: { model: string; cost: number } | undefined;
    for (const [model, u] of Object.entries(result.modelUsage as Record<string, unknown>)) {
      const cost = u && typeof u === "object" ? (u as { costUSD?: unknown }).costUSD : undefined;
      const value = typeof cost === "number" ? cost : 0;
      if (!top || value > top.cost) top = { model, cost: value };
    }
    if (top) out.model = top.model;
  }
  return out;
}

/** The text the CLI puts in a model call whose own blocks were all empty. */
const NO_CONTENT_PLACEHOLDER = "(no content)";
/** The model the CLI names on messages it wrote itself (API errors, "No response requested."). */
const SYNTHETIC_MODEL = "<synthetic>";

/** The model-written text blocks of an assistant event's message, joined; empty when it has none. */
function assistantText(event: StreamEvent): string {
  const content = event.message?.content;
  if (!Array.isArray(content) || event.message?.model === SYNTHETIC_MODEL) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .filter((t) => t.trim() !== NO_CONTENT_PLACEHOLDER)
    .join("\n\n");
}

/**
 * Parses `claude -p --output-format stream-json --verbose` stdout (plus stderr
 * and exit code) into a TurnResult. The final `result` event carries the reply,
 * session id, error flag and cost. Its `result` is only the last model call's
 * text, which is blank when Persona wrote its reply beside a tool call (a
 * `commit` for the follow-up it promised, say) and then ended with no text;
 * `earlierText` then carries the last main-thread model call that had text.
 * Its `usage` sums every model call of the
 * turn, so the live context size is taken instead from the last main-thread
 * `assistant` event — that call's prompt (input + cache read + cache creation)
 * is exactly the conversation as it now stands. A single `--output-format
 * json` object parses too (it is a lone result event).
 *
 * `sessionNotFound` is set only for a failed run that was resuming a session
 * and whose CLI diagnostics (stderr, `errors[]`) say the session is unknown —
 * never from the model's reply, which may mention anything.
 */
export function parseTurnOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  opts: { resumed?: boolean } = {}
): TurnResult {
  let result: StreamEvent | undefined;
  let lastAssistantUsage: UsageBlock | undefined;
  // The CLI prints each content block of a model call as its own event, all with the call's message id.
  let lastText: { id: unknown; parts: string[] } | undefined;
  let parsedAny = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    parsedAny = true;
    if (event.type === "assistant" && !event.parent_tool_use_id) {
      if (event.message?.usage) lastAssistantUsage = event.message.usage;
      const text = assistantText(event);
      if (text.trim()) {
        const id = event.message?.id;
        if (lastText && id !== undefined && lastText.id === id) lastText.parts.push(text);
        else lastText = { id, parts: [text] };
      }
    } else if (
      event.type === "result" ||
      (event.type === undefined && ("result" in event || "session_id" in event || "is_error" in event))
    ) {
      result = event;
    }
  }

  const failed = exitCode !== 0 || result?.is_error === true;
  if (failed && opts.resumed) {
    const errors = Array.isArray(result?.errors) ? result!.errors.filter((e): e is string => typeof e === "string") : [];
    const diagnostic = [...errors, stderr].join("\n").trim();
    if (SESSION_NOT_FOUND.test(diagnostic)) {
      return {
        ok: false,
        error: oneLine(diagnostic) || "session not found",
        sessionNotFound: true,
        ...(result ? resultSpend(result) : {}),
      };
    }
  }
  if (!result) {
    const detail = parsedAny ? "" : stdout;
    return {
      ok: false,
      error: oneLine(stderr || detail) || `claude exited ${exitCode ?? "abnormally"} with no result`,
      ...(isMediaRejection(rejectionDiagnostic(detail, [], stderr)) ? { mediaRejected: true } : {}),
      ...(isTransientTurnError([detail, stderr].join("\n")) ? { transient: true } : {}),
    };
  }
  if (failed) {
    const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
    const reason =
      typeof result.result === "string" && result.result.trim() ? result.result : errors.join("\n") || stderr;
    const diagnostic = rejectionDiagnostic(typeof result.result === "string" ? result.result : undefined, errors, stderr);
    // A result the CLI flags is_error is its own error report; on a mere
    // non-zero exit the result is the model's reply, which may quote anything.
    const report = result.is_error === true && typeof result.result === "string" ? [result.result] : [];
    return {
      ok: false,
      error: oneLine(reason) || `claude exited ${exitCode}`,
      ...(isMediaRejection(diagnostic) ? { mediaRejected: true } : {}),
      ...(isTransientTurnError([...report, ...errors, stderr].join("\n")) ? { transient: true } : {}),
      ...resultSpend(result),
    };
  }
  if (typeof result.session_id !== "string" || !result.session_id) {
    return { ok: false, error: "claude returned no session id", ...resultSpend(result) };
  }
  const iterations = result.usage?.iterations;
  const contextTokens =
    promptTokens(lastAssistantUsage) ??
    (Array.isArray(iterations) && iterations.length > 0
      ? promptTokens(iterations[iterations.length - 1])
      : promptTokens(result.usage));
  const resultText = typeof result.result === "string" ? result.result : "";
  return {
    ok: true,
    text: resultText,
    ...(!resultText.trim() && lastText ? { earlierText: lastText.parts.join("\n\n") } : {}),
    sessionId: result.session_id,
    contextTokens,
    contextWindow: largestContextWindow(result.modelUsage),
    ...resultSpend(result),
  };
}

function oneLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** Absolute path to packages/mcp/src/index.ts, resolved from this module. */
export function mcpEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mcp", "src", "index.ts");
}

export interface ClaudeTurnRunnerOptions {
  /** Reserved internal cwd the subprocess runs in, so the hook endpoint ignores it. */
  cwd: string;
  /** Base URL of this collector, handed to the persona-mode MCP proxy. */
  collectorUrl: string;
  /** The runtime's persona token, which authenticates the proxy's tool calls. */
  token: string;
  claudeBin?: string;
  /** Grace between SIGTERM and SIGKILL once a turn times out. */
  killGraceMs?: number;
  /** Starts a turn process (default Bun.spawn with piped stdout and stderr). */
  spawn?: TurnSpawn;
  /** Kills a running turn's process group on killRunning (default killProcessGroup with SIGKILL). */
  killGroup?: (pid: number) => void;
}

/** Writes `content` to `path` as a 0600 file, swapped in by rename. */
function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writePrivateFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * What the turn writes to the CLI's stdin: the prompt as plain text, or, when
 * the turn shows images, one stream-json `user` message (the prompt, then a
 * `[label]` text block and an image block per image) for
 * `--input-format stream-json`.
 */
export function buildTurnStdin(input: Pick<TurnInput, "prompt" | "images">): string {
  if (!input.images || input.images.length === 0) return input.prompt;
  const content: unknown[] = [{ type: "text", text: input.prompt }];
  for (const image of input.images) {
    content.push(
      { type: "text", text: `[${image.label}]` },
      { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } }
    );
  }
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** The argv of one Persona turn; the prompt itself goes on stdin (buildTurnStdin). */
export function buildTurnArgv(
  input: TurnInput,
  paths: { claudeBin: string; systemPromptPath: string; mcpConfigPath: string; settingsArgs: string[] }
): string[] {
  const argv = [paths.claudeBin, "-p"];
  if (input.resumeSessionId) argv.push("--resume", input.resumeSessionId);
  if (input.images && input.images.length > 0) argv.push("--input-format", "stream-json");
  argv.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--append-system-prompt-file",
    paths.systemPromptPath,
    // No built-in tools at all: Persona reads and acts only through the
    // Standup MCP, so it cannot read arbitrary files and echo them back.
    "--tools",
    "",
    "--allowedTools",
    "mcp__standup",
    "--permission-mode",
    "default",
    "--mcp-config",
    paths.mcpConfigPath,
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    ...paths.settingsArgs
  );
  if (input.maxBudgetUsd !== undefined) argv.push("--max-budget-usd", String(input.maxBudgetUsd));
  return argv;
}

/**
 * The environment of one Persona turn: `base` (the collector's env without its
 * slot vars) plus `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` when the turn sets an
 * auto-compact percent, which also drops `DISABLE_AUTO_COMPACT` and
 * `DISABLE_COMPACT` so nothing turns it off. The CLI reads that var on every compaction check and
 * compacts at that percent of the window (never later than its default
 * threshold), so it applies to this process only and no global setting moves.
 */
export function buildTurnEnv(
  input: Pick<TurnInput, "autoCompactPct">,
  base: Record<string, string> = withoutSlotEnv()
): Record<string, string> {
  const env = { ...base };
  if (input.autoCompactPct !== undefined) {
    delete env.DISABLE_AUTO_COMPACT;
    delete env.DISABLE_COMPACT;
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(input.autoCompactPct);
  }
  return env;
}

/**
 * User-settings env keys that would override a turn's auto-compact percent:
 * the CLI applies a `--settings` file's `env` over the spawn env.
 */
export const COMPACTION_SETTINGS_ENV_KEYS = ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "DISABLE_AUTO_COMPACT", "DISABLE_COMPACT"] as const;

/**
 * The forwarded `--settings` args for a turn that sets an auto-compact percent:
 * unchanged when the forwarded file's `env` has none of
 * COMPACTION_SETTINGS_ENV_KEYS, else `--settings <dir>/settings.json`, a 0600
 * copy without them, so Persona's percent is the one the CLI uses. A turn with
 * no percent, or a file that can't be read, keeps the args as they are.
 */
export function withoutCompactionSettingsEnv(settingsArgs: string[], dir: string): string[] {
  const path = join(dir, "settings.json");
  // The copy may hold credentials from the env block, so none outlives its use.
  const unchanged = () => {
    rmSync(path, { force: true });
    return settingsArgs;
  };
  const source = settingsArgs[0] === "--settings" ? settingsArgs[1] : undefined;
  if (!source) return unchanged();
  let settings: { env?: unknown };
  try {
    settings = JSON.parse(readFileSync(source, "utf8")) as { env?: unknown };
  } catch {
    return unchanged();
  }
  const env = settings.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return unchanged();
  const kept = Object.fromEntries(
    Object.entries(env).filter(([key]) => !(COMPACTION_SETTINGS_ENV_KEYS as readonly string[]).includes(key))
  );
  if (Object.keys(kept).length === Object.keys(env).length) return unchanged();
  writePrivateFile(path, JSON.stringify({ ...settings, env: kept }));
  return ["--settings", path];
}

/**
 * The production TurnRunner: one headless `claude -p` per turn, resumed onto
 * Persona's session, with the persona-mode Standup MCP server as its only
 * tool source. Nothing sensitive rides on argv (visible to every local user
 * through `ps`, and bounded in size): the prompt goes on stdin, and the system
 * prompt, the MCP config (which carries the persona token) and the forwarded
 * settings are 0600 files in private directories. A cwd that is not private
 * fails every turn rather than writing the token where others could read it.
 *
 * Each turn leads its own process group (its MCP server and anything else it
 * starts belong to it), which killRunning kills whole: a turn left running when
 * the collector stops could otherwise keep calling tools against the next
 * leader and repeat actions it already took.
 */
export function createClaudeTurnRunner(opts: ClaudeTurnRunnerOptions): TurnRunner {
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const spawn = opts.spawn ?? defaultTurnSpawn;
  const killGroup = opts.killGroup ?? ((pid: number) => killProcessGroup(pid, "SIGKILL"));
  const running = new Set<number>();
  const killed = new Set<number>();
  const run = async (input: TurnInput): Promise<TurnResult> => {
    try {
      const unsafe = ensurePrivateDir(opts.cwd);
      if (unsafe) {
        console.warn(`[persona] refusing to run a turn: ${unsafe}`);
        return { ok: false, error: `refusing to run Persona: ${unsafe}` };
      }
      const mcpConfigPath = join(opts.cwd, "mcp-config.json");
      writePrivateFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            standup: {
              type: "stdio",
              command: process.execPath,
              args: ["run", mcpEntryPath()],
              env: { COLLECTOR_URL: opts.collectorUrl, STANDUP_PERSONA_TOKEN: opts.token },
            },
          },
        })
      );
      const systemPromptPath = join(opts.cwd, "system-prompt.md");
      writePrivateFile(systemPromptPath, input.systemPrompt);

      const argv = buildTurnArgv(input, {
        claudeBin: opts.claudeBin ?? "claude",
        systemPromptPath,
        mcpConfigPath,
        settingsArgs:
          input.autoCompactPct === undefined
            ? headlessSettingsArgs()
            : withoutCompactionSettingsEnv(headlessSettingsArgs(), opts.cwd),
      });
      const proc = spawn(argv, {
        cwd: opts.cwd,
        stdin: new Blob([buildTurnStdin(input)]),
        env: buildTurnEnv(input),
        detached: true,
      });
      running.add(proc.pid);

      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let abandon!: () => void;
      const abandoned = new Promise<"abandoned">((resolve) => (abandon = () => resolve("abandoned")));
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          proc.kill("SIGKILL");
          // A grandchild holding the pipes open must not hang the turn loop.
          setTimeout(abandon, killGraceMs);
        }, killGraceMs);
      }, input.timeoutMs);
      try {
        const outcome = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
          abandoned,
        ]);
        // A turn that finished just as killRunning reached it keeps its result.
        const finished =
          outcome === "abandoned" ? null : parseTurnOutput(outcome[0], outcome[1], proc.exitCode, { resumed: !!input.resumeSessionId });
        if (finished?.ok && !timedOut) return finished;
        if (killed.has(proc.pid)) return { ok: false, error: "turn killed on shutdown", killed: true };
        if (timedOut || !finished) {
          return { ok: false, error: `turn timed out after ${Math.round(input.timeoutMs / 1000)}s` };
        }
        return finished;
      } finally {
        running.delete(proc.pid);
        killed.delete(proc.pid);
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message || "could not run claude" };
    }
  };
  const killRunning = (): number => {
    const pids = [...running];
    for (const pid of pids) {
      killed.add(pid);
      killGroup(pid);
    }
    return pids.length;
  };
  return Object.assign(run, { killRunning });
}
