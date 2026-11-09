import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { workerTmuxSocket } from "@standup/shared/owner-token";
import { ensureScratchDir } from "./scratch-dirs.js";
import { shquote } from "./shell.js";

/** The longest tmux label a worker's own server is likely to use, for the socket-length check in paneTmuxDir. */
const LABEL_ROOM = "standup-workers";

/**
 * A tmux command on the server that hosts the workers' panes. Its socket is
 * `<dataDir>/tmux/workers` (workerTmuxSocket): not under /tmp, so no bare
 * `tmux`, `-L <name>` or TMUX_TMPDIR in a worker reaches it.
 */
export function workerTmux(...args: string[]): string[] {
  return ["tmux", "-S", workerTmuxSocket(), ...args];
}

/** The longest socket path tmux accepts: sun_path is 104 bytes on macOS (108 on Linux), less the NUL. */
const SUN_PATH_MAX = 103;

/**
 * Makes the workers' socket dir before a pane starts there, since tmux
 * creates a socket but not its dir: a 0700 dir of this user's, and nothing
 * else (not a link, not open to others). Only that dir is touched, not the
 * data dir around it. Throws, failing the launch with the reason, when it
 * can't be, or when the socket path is too long for tmux.
 */
function prepareWorkerSocketDir(): void {
  const socket = workerTmuxSocket();
  if (socket.length > SUN_PATH_MAX) throw new Error(`the workers' tmux socket ${socket} is longer than a socket path can be (${SUN_PATH_MAX} bytes); use a shorter data dir`);
  privateDir(dirname(socket), "the workers' tmux socket dir");
}

/** Creates `dir` 0700 (and its missing parents) and checks it is a real dir of this user's that no one else can open. */
function privateDir(dir: string, what: string): string {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error(`${what} ${dir} is not a private directory of this user's, so the workers' tmux can't be kept off the shared servers`);
  }
  return dir;
}

/**
 * The launch's own TMUX_TMPDIR. tmux looks up a bare `tmux …` (no -L/-S, no
 * `$TMUX`) and a `-L <name>` socket under TMUX_TMPDIR, so in a worker pane
 * both reach servers inside this dir, which hold nothing but what the worker
 * started itself. It carries the uid, so another user's dir of the same name
 * never collides, and lives under the temp dir unless a socket below it
 * (resolved, as tmux resolves TMUX_TMPDIR) wouldn't fit in sun_path; then
 * under /tmp. It stays when the launch ends: a process the worker detached
 * may still run with it, and without it that process's tmux would fall back
 * to /tmp, where the default server is.
 */
export function paneTmuxDir(launchId: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const name = `standup-tmux-${uid}-${launchId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
  const root = tmpdir();
  let resolved = root;
  try {
    resolved = realpathSync(root);
  } catch {
    // An unresolvable temp dir is measured as written.
  }
  const longest = join(resolved, name, `tmux-${uid}`, LABEL_ROOM).length;
  return join(longest <= SUN_PATH_MAX ? root : "/tmp", name);
}

/**
 * Creates paneTmuxDir(launchId) as a 0700 directory of this user's, before the
 * pane starts: tmux ignores a TMUX_TMPDIR that isn't a directory and falls back
 * to /tmp, where the default server lives. Throws when the path is anything
 * else (a symlink, someone else's, open to others), so the launch fails rather
 * than run with a TMUX_TMPDIR tmux would skip.
 */
export function preparePaneTmuxDir(launchId: string): string {
  return privateDir(paneTmuxDir(launchId), "the worker's TMUX_TMPDIR");
}

/**
 * Prefixed to a worker pane's command. tmux sets `$TMUX` and `$TMUX_PANE` in
 * every pane it starts, and with `$TMUX` a bare `tmux kill-server` in the
 * worker would reach the workers' server; removed, and with the launch's own
 * TMUX_TMPDIR (paneTmuxDir), it reaches a server in that dir instead.
 * With `scratchDir`, TMPDIR, TMP and TEMP name it too, so the worker's temp
 * files land in its launch's disk-backed scratch dir (ensureScratchDir), not
 * a /tmp that may be RAM.
 */
export function paneEnv(tmuxDir: string, scratchDir?: string): string[] {
  const scratch = scratchDir ? [`TMPDIR=${scratchDir}`, `TMP=${scratchDir}`, `TEMP=${scratchDir}`] : [];
  return ["env", "-u", "TMUX", "-u", "TMUX_PANE", `TMUX_TMPDIR=${tmuxDir}`, ...scratch];
}

/**
 * The tmux command for the legacy server: the one a launch's session may be
 * on instead of the workers' server, which is the server named in the
 * collector's `$TMUX`, else the one tmux finds from TMUX_TMPDIR. The collector
 * spawns tmux without `$TMUX` (workerEnv), so the socket is named outright.
 */
function legacyTmux(): string[] {
  const socket = process.env.TMUX?.split(",")[0];
  return socket ? ["tmux", "-S", socket] : ["tmux"];
}

/** A tmux call on the legacy server must not hold up the collector when that server is slow or wedged. */
const LEGACY_TIMEOUT_MS = 2_000;
const quiet = { stdout: "ignore", stderr: "ignore" } as const;
let legacy: Set<string> | null = null;
let legacyReadAt = 0;
/** How long a listing of the legacy server's sessions is used before it is read again. */
const LEGACY_RELIST_MS = 30_000;
/** How soon a liveness check that finds a session nowhere may list the legacy server again. */
const LEGACY_MISS_RELIST_MS = 5_000;

/** Whether a spawn ran out of time (or was killed) rather than answering. */
function timedOut(res: { exitCode: number | null; exitedDueToTimeout?: boolean }): boolean {
  return res.exitedDueToTimeout === true || res.exitCode === null;
}

/**
 * The sessions on the legacy server, as last listed: only these are looked
 * for there. The list is read again every LEGACY_RELIST_MS, or after
 * `maxAgeMs` when a caller needs it fresher, which picks up sessions an older
 * collector still starts there during a handoff. A listing that times out
 * keeps the last one: a slow server is not an empty one.
 */
function legacySessions(maxAgeMs = LEGACY_RELIST_MS): Set<string> {
  const now = Date.now();
  if (!legacy || now - legacyReadAt >= maxAgeMs) {
    const res = Bun.spawnSync([...legacyTmux(), "list-sessions", "-F", "#{session_name}"], { stdout: "pipe", stderr: "ignore", timeout: LEGACY_TIMEOUT_MS });
    legacyReadAt = now;
    if (!timedOut(res) || !legacy) legacy = new Set(res.exitCode === 0 ? (res.stdout?.toString() ?? "").split("\n").filter(Boolean) : []);
  }
  return legacy;
}

function onWorkerServer(session: string): boolean {
  return Bun.spawnSync(workerTmux("has-session", "-t", `=${session}`), quiet).exitCode === 0;
}

/** Whether a listed session is still on the legacy server; one that doesn't answer in time is taken to be. */
function onLegacyServer(session: string): boolean {
  const res = Bun.spawnSync([...legacyTmux(), "has-session", "-t", `=${session}`], { ...quiet, timeout: LEGACY_TIMEOUT_MS });
  return res.exitCode === 0 || timedOut(res);
}

/**
 * The tmux command for a session wherever it lives: on the workers' server,
 * or, for a listed session (legacySessions) not there, on the legacy server
 * (legacyTmux). Every new launch is on the workers' server.
 */
export function sessionTmux(session: string, ...args: string[]): string[] {
  if (legacySessions().has(session) && !onWorkerServer(session) && onLegacyServer(session)) return [...legacyTmux(), ...args];
  return workerTmux(...args);
}

/**
 * Whether a launch's session is alive on either server. One found on neither
 * has the legacy listing read again first (at most every
 * LEGACY_MISS_RELIST_MS), so a session an older collector just started there
 * isn't reported dead.
 */
export function sessionAlive(session: string): boolean {
  if (onWorkerServer(session)) return true;
  if (legacySessions().has(session) && onLegacyServer(session)) return true;
  return legacySessions(LEGACY_MISS_RELIST_MS).has(session) && onLegacyServer(session);
}

export interface TmuxLaunchOptions {
  /**
   * Redirect the launched process's stdin from `/dev/null`. Claude Code is a TUI
   * that reads its pane's stdin, so it leaves this unset. A headless harness that
   * receives its whole prompt as an argument (e.g. `codex exec "<prompt>"`) sets
   * it so the child never blocks reading additional input from a stdin it does
   * not use — `codex exec` otherwise treats a live stdin as more prompt input.
   */
  closeStdin?: boolean;
  /**
   * Tee the launched process's stdout to this file while still showing it in the
   * pane. A headless harness that streams a machine-readable event log on stdout
   * (e.g. `codex exec --json`) sets it so the collector can read the run's event
   * stream back for telemetry — Codex's analogue of Claude's JSONL transcript —
   * without losing the live pane view. Omitted leaves stdout going only to the
   * pane, and the command keeps its `exec` form. stderr is left on the pane
   * either way.
   */
  logFile?: string;
  /** Whose scratch dir becomes the pane's TMPDIR; defaults to the launch's own id. */
  scratchId?: string;
  /**
   * Override the command that runs AFTER the opening prompt has been read into
   * the shell variable `$P`. Receives the shell reference to that variable
   * (`"$P"`) and returns the command string to run in its place. A single-turn
   * harness leaves this unset and gets the default `exec <cli> "$P"` (or the
   * `tee`-to-`logFile` pipeline). A MULTI-TURN harness (Codex) sets it to a loop
   * that runs the CLI once then resumes it across turns until done — so the whole
   * loop still rides the same temp-file prompt + detached-tmux machinery. When
   * set, `harnessArgv`, `closeStdin`, and `logFile` are the builder's own concern
   * (it composes stdin redirection and any teeing itself).
   */
  buildRun?: (promptRef: string) => string;
}

/**
 * Builds the detached-tmux `new-session` argv that hosts a harness CLI in a
 * worktree, delivering the opening prompt via a temp file.
 *
 * The initial prompt can be large (a pasted payload, a long spec) and tmux caps
 * the command line it accepts at ~16 KB, so passing the prompt directly on the
 * `new-session` line fails with "command too long". Instead the prompt is
 * written to a temp file and the session runs a short `sh -c` that reads it at
 * runtime, deletes it, and execs the harness CLI with the content as one
 * argument. The tmux command stays tiny regardless of prompt size, and the
 * prompt reaches the CLI byte-for-byte (command substitution only trims trailing
 * newlines).
 *
 * `harnessArgv` is the CLI invocation without the prompt (e.g. `claude --model
 * …` or `codex exec --json …`); the prompt is appended as the final positional
 * argument. Shared by every harness so the temp-file + quoting discipline lives
 * in one place. The pane runs on the workers' server with paneEnv for
 * `launchId`'s dir, which this creates (preparePaneTmuxDir), and with the
 * scratch dir of `opts.scratchId ?? launchId` as its TMPDIR, which this
 * creates too (ensureScratchDir).
 */
export function buildLaunchArgv(
  tmuxSession: string,
  launchCwd: string,
  harnessArgv: string[],
  prompt: string,
  launchId: string,
  opts: TmuxLaunchOptions = {}
): string[] {
  // The dirs first: if one can't be made, no prompt file is left behind.
  prepareWorkerSocketDir();
  const paneDir = preparePaneTmuxDir(launchId);
  const scratchDir = ensureScratchDir(opts.scratchId ?? launchId);
  const promptFile = join(tmpdir(), `standup-prompt-${launchId}.txt`);
  writeFileSync(promptFile, prompt, "utf8");
  const qf = shquote(promptFile);
  const harnessCmd = harnessArgv.map(shquote).join(" ");
  const stdinRedirect = opts.closeStdin ? " </dev/null" : "";
  // With a log file the harness's stdout is piped through `tee` so it lands in
  // both the pane and the file; a pipeline can't be `exec`ed as one process, so
  // the `exec` optimization is dropped for that form. Without one, `exec`
  // replaces the shell with the harness so no wrapper process lingers.
  const run = opts.buildRun
    ? opts.buildRun('"$P"')
    : opts.logFile
      ? `${harnessCmd} "$P"${stdinRedirect} | tee ${shquote(opts.logFile)}`
      : `exec ${harnessCmd} "$P"${stdinRedirect}`;
  const cmd = `P="$(cat ${qf})"; rm -f ${qf}; ${run}`;
  return workerTmux("new-session", "-d", "-s", tmuxSession, "-c", launchCwd, ...paneEnv(paneDir, scratchDir), "sh", "-c", cmd);
}

/**
 * Builds the detached-tmux `new-session` argv that hosts an INTERACTIVE harness
 * CLI in `launchCwd`, with NO opening prompt on the command line.
 *
 * Unlike buildLaunchArgv, the prompt is not passed as a trailing positional
 * argument: the caller delivers it after the pane is ready via `tmux send-keys`
 * (see the launcher's opening-prompt delivery). This is how Claude Code must be
 * launched under a `claude` wrapper script that silently DROPS a positional
 * prompt — the session then opens interactively at an empty prompt and the task
 * is never submitted. Typing it into the ready input box is what actually starts
 * the run.
 *
 * tmux runs the CLI directly (no `sh -c` wrapper and no temp-file dance, since
 * there is no prompt to smuggle past the command-length limit), so `harnessArgv`
 * — the CLI invocation such as `claude --model … --permission-mode
 * bypassPermissions --settings '{…}' …` — goes straight into the pane's argv.
 * tmux execs a multi-argument command directly, so each element (the inline
 * `--settings` JSON included) reaches the CLI as one argument with no shell
 * quoting involved. `env` is set on the session (`-e NAME=VALUE`, each its own
 * argument), so the CLI and everything it spawns start with it. The pane runs
 * on the workers' server with paneEnv for `launchId`'s dir. This creates that
 * dir (preparePaneTmuxDir), so the TMUX_TMPDIR the argv names is one that
 * exists, the workers' socket dir, and the scratch dir of `scratchId` (the
 * launch's own id unless given) that becomes the pane's TMPDIR
 * (ensureScratchDir); apart from those it is pure, so the argv is
 * unit-testable.
 */
export function buildInteractiveLaunchArgv(
  tmuxSession: string,
  launchCwd: string,
  harnessArgv: string[],
  launchId: string,
  env: Record<string, string> = {},
  scratchId: string = launchId
): string[] {
  prepareWorkerSocketDir();
  const pane = paneEnv(preparePaneTmuxDir(launchId), ensureScratchDir(scratchId));
  return workerTmux("new-session", "-d", "-s", tmuxSession, "-c", launchCwd, ...tmuxEnvFlags(env), ...pane, ...harnessArgv);
}

/** `-e NAME=VALUE` for each entry, for `tmux new-session`. */
export function tmuxEnvFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}
