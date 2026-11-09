import { createHash } from "crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ensurePrivateDir, headlessSettingsDir, writePrivateFileSync } from "./internal-cwd.js";
import { withoutSlotEnv } from "./worker-env.js";

export interface RunClaudeOptions {
  /** Passed as `claude --model`; omitted means the CLI's own default. */
  model?: string;
  /**
   * Working directory for the subprocess. Must be one of Standup's reserved
   * internal cwds (see internal-cwd.ts) — the hook endpoint no-ops on those,
   * so this `claude` invocation cannot fire its own SessionStart/Stop back at
   * the collector and spawn a phantom session (or recurse). Created if absent.
   */
  cwd: string;
  timeoutMs?: number;
  /** Passed as `claude --tools`; "" (default) disables every tool. */
  tools?: string;
  /** Kills the subprocess when it aborts; the call then returns null. */
  signal?: AbortSignal;
  /**
   * Passed as `claude --system-prompt`, replacing Claude Code's own system
   * prompt: a short fixed instruction keeps a classifier call small and fast.
   * It rides on argv, so it must hold nothing private.
   */
  systemPrompt?: string;
  /**
   * Turns extended thinking off (MAX_THINKING_TOKENS=0) for a call that must
   * answer fast: with thinking on, a one-line verdict spent ~700 output tokens
   * and 8–11s, against about 2.4s without.
   */
  noThinking?: boolean;
  /**
   * Adds `--bare`: no CLAUDE.md auto-discovery (user, rules or up the cwd
   * tree), no auto-memory, no hooks or plugins. The prompt is then the only
   * context the model sees beyond the forwarded auth/model settings — for a
   * call whose answer reaches someone other than the host user.
   */
  bare?: boolean;
  /** Spawns the CLI; defaults to Bun.spawn. Injectable so a test reads the argv without a subprocess. */
  spawn?: (argv: string[], options: { cwd: string; stdin: Blob; env: NodeJS.ProcessEnv }) => ClaudeProcess;
}

/** The parts of a spawned CLI process runClaudeText reads. */
export interface ClaudeProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  readonly exitCode: number | null;
  kill(): void;
}

const bunSpawn: NonNullable<RunClaudeOptions["spawn"]> = (argv, options) =>
  Bun.spawn(argv, { ...options, stdout: "pipe", stderr: "pipe" });

/**
 * The argv of one headless call: tools as given (none by default), only the
 * project setting source plus the forwarded auth/model settings, no MCP
 * servers, JSON output, and `--bare` and `--system-prompt` when asked.
 */
export function claudeTextArgv(opts: Pick<RunClaudeOptions, "model" | "tools" | "bare" | "systemPrompt">, settingsArgs: string[] = headlessSettingsArgs()): string[] {
  const argv = [
    "claude",
    "-p",
    "--tools",
    opts.tools ?? "",
    // Drop the `user` setting source so global hooks never fire — otherwise this
    // headless call loads the user's ~/.claude/settings.json and its SessionStart
    // hook registers a phantom session in Standup's own feed — and
    // --strict-mcp-config makes the resulting lack of MCP explicit. Tools are
    // disabled here, so no user hooks/MCP are needed and isolating is safe.
    "--setting-sources",
    "project",
    ...settingsArgs,
    "--strict-mcp-config",
    "--output-format",
    "json",
  ];
  if (opts.bare) argv.push("--bare");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.systemPrompt) argv.push("--system-prompt", opts.systemPrompt);
  return argv;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One headless `claude -p` call, returning its trimmed result text (or null on
 * any failure — non-zero exit, an error result, a timeout, or unparseable
 * output). The single place Standup shells out to the CLI as a cheap model:
 * checkpoint summaries and session titles (auto-checkpoint.ts) and the other
 * ancillary model calls all go through here so the invocation — tools
 * disabled, JSON output, the reserved-cwd guard — is defined once. The
 * prompt goes on stdin rather than argv, where every local user could read it
 * through `ps`.
 */
export async function runClaudeText(
  prompt: string,
  opts: RunClaudeOptions
): Promise<string | null> {
  mkdirSync(opts.cwd, { recursive: true });

  const argv = claudeTextArgv(opts);
  const env = withoutSlotEnv();
  if (opts.noThinking) env.MAX_THINKING_TOKENS = "0";
  const proc = (opts.spawn ?? bunSpawn)(argv, { cwd: opts.cwd, stdin: new Blob([prompt]), env });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abort = () => proc.kill();
  if (opts.signal?.aborted) abort();
  opts.signal?.addEventListener("abort", abort, { once: true });

  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;

    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (parsed.is_error || !parsed.result) return null;

    const result = parsed.result.trim();
    return result || null;
  } catch (err) {
    console.error("[claude-cli] call failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

/**
 * User-settings keys a headless call needs to authenticate and pick a model.
 * `--setting-sources project` drops the whole user source, including the
 * credential exporter and model overrides, so the CLI falls back to whatever
 * ambient AWS credentials happen to be set and fails with Bedrock 403s. Only
 * these keys are forwarded back in — never hooks, permissions, plugins or the
 * status line, which are exactly what the isolation exists to keep out.
 */
const HEADLESS_SETTINGS_KEYS = [
  "awsCredentialExport",
  "awsAuthRefresh",
  "apiKeyHelper",
  "env",
  "modelOverrides",
] as const;

/**
 * The auth/model subset of a parsed user settings file, or null when the
 * value is not an object or carries none of the forwarded keys.
 */
export function pickHeadlessSettings(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of HEADLESS_SETTINGS_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function userSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir || join(homedir(), ".claude"), "settings.json");
}

let settingsCache: { path: string; outDir: string; mtimeMs: number; args: string[] } | undefined;
let warnedProblem: string | undefined;

/**
 * Logs why the forwarded settings are missing, once per distinct reason:
 * without them a headless call loses its auth and model settings, which must
 * never happen silently, but every spawn re-asks.
 */
function warnNotForwarding(problem: string): void {
  if (warnedProblem === problem) return;
  warnedProblem = problem;
  console.warn(`[claude-cli] not forwarding user auth/model settings to headless calls: ${problem}`);
}

/**
 * `["--settings", <file>]` re-injecting the auth/model subset of the user
 * settings file into a `--setting-sources project` call, or `[]` when the file
 * is missing, unparseable, or has none of the keys. The subset — whose `env`
 * block can hold credentials — goes to a 0600 file in a private directory
 * rather than onto argv, where any local user could read it from `ps`. Cached
 * per path and re-read only when the source's mtime changes, since every
 * headless spawn calls this; the file is rewritten only when its content would
 * change.
 */
export function headlessSettingsArgs(
  path: string = userSettingsPath(),
  outDir: string = headlessSettingsDir()
): string[] {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    settingsCache = undefined;
    return [];
  }
  if (
    settingsCache &&
    settingsCache.path === path &&
    settingsCache.outDir === outDir &&
    settingsCache.mtimeMs === mtimeMs &&
    (settingsCache.args.length === 0 || existsSync(settingsCache.args[1]!))
  ) {
    return [...settingsCache.args];
  }

  let picked: Record<string, unknown> | null = null;
  try {
    picked = pickHeadlessSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    warnNotForwarding(`${path} is unreadable: ${(err as Error).message}`);
  }
  let args: string[] = [];
  if (picked) {
    const file = writePrivateSettings(outDir, path, JSON.stringify(picked));
    if (file) args = ["--settings", file];
  }
  settingsCache = { path, outDir, mtimeMs, args };
  return [...args];
}

/**
 * Writes `content` to `<outDir>/settings-<hash of source path>.json` (0600)
 * unless it already holds exactly that, swapping it in by rename so a
 * concurrent spawn never reads a half-written file. Null (with a one-time
 * warning) when the directory is not private or the write fails.
 */
function writePrivateSettings(outDir: string, sourcePath: string, content: string): string | null {
  const unsafe = ensurePrivateDir(outDir);
  if (unsafe) {
    warnNotForwarding(unsafe);
    return null;
  }
  const file = join(outDir, `settings-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 12)}.json`);
  try {
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile() && readFileSync(file, "utf8") === content) {
      chmodSync(file, 0o600);
      return file;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writePrivateFileSync(tmp, content);
    renameSync(tmp, file);
    return file;
  } catch (err) {
    warnNotForwarding(`could not write ${file}: ${(err as Error).message}`);
    return null;
  }
}
