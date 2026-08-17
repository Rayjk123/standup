import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { ClaudeEffort, ClaudeModel, Launch, LaunchKind, Project } from "@standup/shared";
import { createLaunch, updateLaunchStatus, getSetting } from "@standup/store";

/** Built-in fallback when nothing else specifies where worktrees go. */
const DEFAULT_WORKTREE_ROOT = join(
  homedir(),
  ".local",
  "share",
  "standup",
  "worktrees"
);

/** Global-setting key mirrored by GET/PUT /api/settings. */
export const WORKTREE_ROOT_SETTING = "worktree_root";

/** Expands a leading `~` — unlike a shell, `join`/`mkdir` don't. */
function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Where a launch's worktree is created, most specific wins:
 *   1. the project's own `worktreeRoot`
 *   2. the global `worktree_root` setting (set from the UI)
 *   3. the STANDUP_WORKTREE_ROOT env var (the original, pre-setting knob)
 *   4. the built-in default under ~/.local/share
 *
 * Exported so the resolution is testable without spawning a real launch.
 */
export function resolveWorktreeRoot(db: Database, project: Project): string {
  const chosen =
    project.worktreeRoot?.trim() ||
    getSetting(db, WORKTREE_ROOT_SETTING)?.trim() ||
    process.env.STANDUP_WORKTREE_ROOT ||
    DEFAULT_WORKTREE_ROOT;
  return expandTilde(chosen);
}

/** Per-step cap so a wedged setup command can't hang the launch forever. */
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Provisioning gets its own, much longer cap: `brazil workspace create` with
 * a version-set pull (or any real workspace materialization) routinely runs
 * many minutes, well past a setup command. Overridable for slower machines.
 */
const PROVISION_TIMEOUT_MS = process.env.STANDUP_PROVISION_TIMEOUT_MS
  ? parseInt(process.env.STANDUP_PROVISION_TIMEOUT_MS)
  : 30 * 60 * 1000;

/**
 * Appended to a launched agent's opening prompt.
 *
 * Self-reported checkpoints are what make the merged feed readable, but the
 * design notes they "require one line in project instructions" — an agent
 * with the tool available and no instruction simply never calls it, which
 * is exactly what happened: sessions ran for hours producing zero
 * checkpoints.
 *
 * A launched session's prompt is ours to compose, so the instruction goes
 * here rather than depending on the user having set up a CLAUDE.md. For
 * monitored sessions there is no equivalent hook — see
 * docs/agent-instructions.md for the snippet to add manually.
 *
 * Deliberately brief and permissive: a heavy directive would distort the
 * work, and an agent that ignores it still functions, just less visibly.
 */
const CHECKPOINT_INSTRUCTION = `

---
You're running under Standup, a console that shows your progress alongside other agents.
Call the \`checkpoint\` tool when you finish a discrete piece of work (not per tool call) —
a short status line in your own words. Use \`ask_human\` if you need a decision rather than
guessing. Both are optional; they only affect visibility, not correctness.`;

export interface LaunchRequest {
  project: Project;
  task: string;
  /**
   * Short human-readable name for the launch, when `task` is unsuitable as
   * one. `task` doubles as the agent's opening prompt and as the row's
   * display text, which is fine while a prompt is a sentence someone typed
   * — but a bootstrap run's prompt is a page of instructions, and using it
   * unlabelled produced a branch named after its first forty characters and
   * a feed entry that was a wall of text. Launches are meant to be watched
   * and stopped; that is hard to do when you cannot tell them apart.
   *
   * Affects the worktree slug, branch name, and stored task only. The agent
   * still receives the full `task`.
   */
  label?: string;
  /** Passed as `claude --model`; omitted means the CLI's own default. */
  model?: ClaudeModel;
  /** Passed as `claude --effort`; omitted means the CLI's own default. */
  effort?: ClaudeEffort;
  /**
   * worktree = ordinary launch (the default); bootstrap = a knowledge-
   * bootstrap run (phase-7 Step 3). Both take the exact same path below —
   * a real worktree, the setup command, a tmux session — the only
   * difference is what's recorded on the launch row, which is what lets
   * propose_knowledge's gate (server.ts) tell them apart.
   */
  kind?: LaunchKind;
}

/** Builds the trailing `--model`/`--effort` flags for a `claude` invocation. */
function modelEffortFlags(model?: ClaudeModel, effort?: ClaudeEffort): string[] {
  const flags: string[] = [];
  if (model) flags.push("--model", model);
  if (effort) flags.push("--effort", effort);
  return flags;
}

/**
 * Splits a project's `launchArgs` string into argv tokens for the `claude`
 * invocation.
 *
 * These go straight into the process argv (tmux runs `claude` directly, with
 * no shell), so a plain whitespace split is wrong: `--append-system-prompt
 * "be terse"` must stay two tokens, not four. Single and double quotes group
 * a value; everything else splits on whitespace. Deliberately not a full
 * shell parser — no variable expansion, globbing, or escapes — because these
 * are literal CLI flags, not a shell command (that is what `setup` is for).
 */
export function tokenizeArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

export interface LaunchResult {
  launch: Launch;
  /** Human-readable log of what actually ran, surfaced in the UI on failure. */
  log: string[];
}

/** Turns a task description into a filesystem/branch-safe slug. */
function slugify(task: string): string {
  const base = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  // Always suffix: two launches with the same task text must not collide on
  // the same worktree path or branch name.
  return `${base || "task"}-${randomUUID().slice(0, 6)}`;
}

async function run(
  cmd: string[],
  cwd: string,
  log: string[]
): Promise<{ ok: boolean; output: string }> {
  log.push(`$ ${cmd.join(" ")}`);

  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), STEP_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  const output = (stdout + stderr).trim();
  if (output) log.push(output.slice(0, 2000));

  return { ok: proc.exitCode === 0, output };
}

async function runShell(
  script: string,
  cwd: string,
  log: string[],
  extraEnv?: Record<string, string>,
  timeoutMs: number = STEP_TIMEOUT_MS
): Promise<{ ok: boolean; output: string }> {
  // Setup and provision commands come from projects.toml and are shell strings
  // by design ("uv sync && docker compose up -d"), so they need a shell to
  // interpret them. This is the user's own config running on the user's own
  // machine — the same trust level as a Makefile — but it is arbitrary code
  // execution, so it only ever runs on an explicit launch, never on collector
  // startup.
  log.push(`$ ${script}`);

  const proc = Bun.spawn(["/bin/sh", "-c", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  const output = (stdout + stderr).trim();
  if (output) log.push(output.slice(0, 2000));

  return { ok: proc.exitCode === 0, output };
}

export function tmuxAvailable(): boolean {
  return Bun.spawnSync(["which", "tmux"]).exitCode === 0;
}

/**
 * Creates an isolated worktree for a task, runs the project's setup command
 * in it, and starts a detached tmux session running `claude` there.
 *
 * tmux rather than a bare spawn because Claude Code is a TUI: it needs a
 * terminal, and the user needs to be able to attach later
 * (`tmux attach -t <name>`). Detached means the session outlives this
 * request and the collector process.
 *
 * The launch row is written before any slow work so the UI can show
 * "starting" immediately; failures update it in place rather than
 * disappearing.
 */
export async function launchSession(
  db: Database,
  { project, task, label, model, effort, kind }: LaunchRequest
): Promise<LaunchResult> {
  const log: string[] = [];
  const displayName = label ?? task;
  const slug = slugify(displayName);
  const worktreeRoot = resolveWorktreeRoot(db, project);
  const worktreePath = join(worktreeRoot, project.id, slug);
  const tmuxSession = `standup-${project.id}-${slug}`.slice(0, 100);

  // A `provision` command replaces `git worktree add` — the working dir is
  // whatever that command produces (e.g. a whole Brazil workspace), not a git
  // worktree, so there's no branch and cleanup can't be a git op.
  const provisionCmd = project.provision?.trim();
  const usesProvision = !!provisionCmd;
  const branch = usesProvision ? "(provisioned — no worktree)" : `standup/${slug}`;

  // Where the agent actually starts and setup runs. For a provisioned Brazil
  // workspace the package sits at src/<pkg>, so launchSubdir points there.
  const subdir = project.launchSubdir?.trim();
  const launchCwd = subdir ? join(worktreePath, subdir) : worktreePath;

  const repo = project.repos[0];
  if (!repo) {
    throw new Error(
      `Project "${project.id}" has no repos configured — nothing to check out. Add a repos entry in projects.toml.`
    );
  }
  const repoPath = repo.replace(/^~/, homedir());

  // A provision command materializes its own working dir, so repos[0] need
  // not be a checkout on disk (it's only used as $STANDUP_REPO context). The
  // git-worktree path does need it to exist.
  if (!usesProvision && !existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }

  // Check every precondition before creating anything. These used to be
  // checked inline, which meant a missing tmux surfaced only *after* the
  // worktree was created and the setup command had run — leaving an
  // orphaned worktree and branch behind for a failure that was knowable up
  // front.
  if (!tmuxAvailable()) {
    throw new Error(
      "tmux is not installed — launches need it to host the session. " +
        "Run `bun run scripts/check-deps.ts` (installs it via Homebrew), then retry."
    );
  }

  const launch = createLaunch(db, {
    id: randomUUID(),
    kind,
    projectId: project.id,
    // The label when there is one — this is what the console renders.
    task: displayName,
    worktreePath,
    branch,
    baseBranch: project.branch,
    tmuxSession,
    status: "starting",
    model,
    effort,
    provisioned: usesProvision,
  });

  try {
    await mkdir(join(worktreeRoot, project.id), { recursive: true });

    if (usesProvision) {
      // The command runs from the parent and must leave a ready directory at
      // $STANDUP_WORKDIR — for `brazil workspace create` that means
      // `--name "$STANDUP_WORKDIR_NAME"`, which creates ./<name> here.
      const provisioned = await runShell(
        provisionCmd!,
        join(worktreeRoot, project.id),
        log,
        {
          STANDUP_WORKDIR: worktreePath,
          STANDUP_WORKDIR_NAME: slug,
          STANDUP_REPO: repoPath,
          STANDUP_BRANCH: branch,
          STANDUP_PROJECT: project.id,
        },
        PROVISION_TIMEOUT_MS
      );
      if (!provisioned.ok) {
        throw new Error(`provision command failed: ${provisioned.output.slice(0, 400)}`);
      }
      if (!existsSync(worktreePath)) {
        throw new Error(
          `provision command exited 0 but did not create ${worktreePath}. ` +
            `It must produce that exact directory — pass --name "$STANDUP_WORKDIR_NAME" (or create "$STANDUP_WORKDIR").`
        );
      }
    } else {
      // Verify it's actually a git repo before trying to add a worktree, so
      // the error names the real problem instead of a git usage message.
      const isRepo = await run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        repoPath,
        log
      );
      if (!isRepo.ok) {
        throw new Error(`Not a git repository: ${repoPath}`);
      }

      const base = project.branch || "HEAD";
      const worktree = await run(
        ["git", "worktree", "add", "-b", branch, worktreePath, base],
        repoPath,
        log
      );
      if (!worktree.ok) {
        throw new Error(`git worktree add failed: ${worktree.output.slice(0, 300)}`);
      }
    }

    if (subdir && !existsSync(launchCwd)) {
      throw new Error(
        `launchSubdir "${subdir}" does not exist under the working dir (${launchCwd}). ` +
          `Check the provision command produced it.`
      );
    }

    if (project.setup) {
      const setup = await runShell(project.setup, launchCwd, log);
      // Non-fatal: a failed `docker compose up` shouldn't discard a
      // correctly-created worktree. Surface it and let the agent start.
      if (!setup.ok) {
        log.push("[warn] setup command failed — starting the session anyway");
      }
    }

    // Pass the task as the initial prompt so the agent starts on it, and so
    // the session title derives from real work rather than being untitled.
    const spawned = await run(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        launchCwd,
        "claude",
        ...modelEffortFlags(model, effort),
        // Per-project extra flags (e.g. --permission-mode acceptEdits).
        // Ordered before the positional prompt, same as --model/--effort.
        ...tokenizeArgs(project.launchArgs),
        task + CHECKPOINT_INSTRUCTION,
      ],
      launchCwd,
      log
    );
    if (!spawned.ok) {
      throw new Error(`tmux new-session failed: ${spawned.output.slice(0, 300)}`);
    }

    updateLaunchStatus(db, launch.id, "running");
    return { launch: { ...launch, status: "running" }, log };
  } catch (err) {
    const message = (err as Error).message;
    updateLaunchStatus(db, launch.id, "failed", message);
    log.push(`[error] ${message}`);
    return { launch: { ...launch, status: "failed", error: message }, log };
  }
}

/**
 * Adopts an existing session: resumes it under a tmux session Standup owns,
 * converting a monitored session into one it can read, type into, and stop.
 *
 * `claude --resume <id>` reuses the original session id (there is a
 * `--fork-session` flag to opt out), so the resumed process reports the same
 * `session_id` in its hooks. Standup's existing history, checkpoints and
 * events stay attached — which is the whole point, and why forking would be
 * the wrong default here.
 *
 * Runs in the session's original cwd, deliberately **not** a fresh worktree:
 * the conversation being resumed refers to files at those paths, and moving
 * it into a checkout would invalidate its own context.
 *
 * That makes the launch row's `worktreePath` the user's real repository,
 * which is why the row is marked `kind: "adopted"` — `cleanupLaunch` refuses
 * to run `git worktree remove` against those.
 *
 * Only ended sessions can be adopted. Resuming a live one would put two
 * processes on the same transcript, and Standup cannot stop the original
 * because it does not own it.
 */
export async function adoptSession(
  db: Database,
  session: { id: string; cwd: string; title: string; projectId: string; endedAt?: Date }
): Promise<LaunchResult> {
  const log: string[] = [];

  if (!session.endedAt) {
    throw new Error(
      "Only an ended session can be adopted — resuming a live one would run two processes against the same conversation. Stop it in its terminal first."
    );
  }
  if (!existsSync(session.cwd)) {
    throw new Error(`Session's working directory no longer exists: ${session.cwd}`);
  }
  if (!tmuxAvailable()) {
    throw new Error(
      "tmux is not installed — adoption needs it to host the session. Run `bun run scripts/check-deps.ts`, then retry."
    );
  }

  const tmuxSession = `standup-adopt-${session.id.slice(0, 8)}`;

  if (tmuxSessionExists(tmuxSession)) {
    throw new Error(`This session already has a tmux session: ${tmuxSession}`);
  }

  const launch = createLaunch(db, {
    id: randomUUID(),
    kind: "adopted",
    projectId: session.projectId,
    task: session.title || `Resumed session ${session.id.slice(0, 8)}`,
    // The real repo, not a checkout — see the cleanup guard above.
    worktreePath: session.cwd,
    branch: "(adopted — no worktree)",
    tmuxSession,
    sessionId: session.id,
    status: "starting",
  });

  try {
    const spawned = await run(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        session.cwd,
        "claude",
        "--resume",
        session.id,
      ],
      session.cwd,
      log
    );
    if (!spawned.ok) {
      throw new Error(`tmux new-session failed: ${spawned.output.slice(0, 300)}`);
    }

    updateLaunchStatus(db, launch.id, "running");
    return { launch: { ...launch, status: "running" }, log };
  } catch (err) {
    const message = (err as Error).message;
    updateLaunchStatus(db, launch.id, "failed", message);
    log.push(`[error] ${message}`);
    return { launch: { ...launch, status: "failed", error: message }, log };
  }
}

/**
 * Capabilities that exist only for launched sessions.
 *
 * Standup observes monitored sessions but *owns* launched ones — it created
 * their tmux session, so it can read their screen, type into them, and stop
 * them. The access asymmetry runs the other way: you have a terminal for a
 * monitored session and none for a launched one, which is exactly why the
 * launched side needs these.
 *
 * The design calls `tmux send-keys` an escape hatch to avoid building on for
 * "a pane the manager did not launch". These functions all refuse to touch a
 * session Standup didn't start, which keeps that caution intact.
 */

function assertOwned(launch: Launch): string {
  if (!launch.tmuxSession) {
    throw new Error(
      "This launch has no tmux session — it either failed before starting or was already cleaned up."
    );
  }
  return launch.tmuxSession;
}

export function tmuxSessionExists(name: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", name]).exitCode === 0;
}

/** Current visible screen of a launched session. */
export async function captureLaunchOutput(
  launch: Launch,
  lines = 200
): Promise<{ output: string; alive: boolean }> {
  const session = assertOwned(launch);

  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { output: "", alive: false };
  }

  const proc = Bun.spawn(
    // -p prints to stdout; -S -N starts N lines back into scrollback so the
    // reply is still visible after it scrolls past the viewport.
    ["tmux", "capture-pane", "-p", "-t", session, "-S", `-${lines}`],
    { stdout: "pipe", stderr: "pipe" }
  );

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return { output: output.trimEnd(), alive: true };
}

/**
 * Types a line into a launched session, as if the human had typed it in that
 * terminal. Unlike a steer, this lands immediately — which is safe here only
 * because Standup owns the pane and the human explicitly targeted it.
 */
export async function sendToLaunch(
  launch: Launch,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const session = assertOwned(launch);

  if (!tmuxAvailable() || !tmuxSessionExists(session)) {
    return { ok: false, error: "tmux session is no longer running" };
  }

  // Literal (-l) so the text isn't interpreted as key names, then a separate
  // Enter — sending them together would make a message containing "Enter"
  // ambiguous.
  const typed = Bun.spawnSync(["tmux", "send-keys", "-t", session, "-l", text]);
  if (typed.exitCode !== 0) {
    return { ok: false, error: "failed to send text to the session" };
  }

  const submitted = Bun.spawnSync(["tmux", "send-keys", "-t", session, "Enter"]);
  if (submitted.exitCode !== 0) {
    return { ok: false, error: "failed to submit to the session" };
  }

  return { ok: true };
}

/**
 * Stops a launched session, leaving its worktree and branch intact so the
 * work can be inspected or resumed. Distinct from cleanupLaunch, which also
 * removes the worktree.
 */
export async function stopLaunch(
  db: Database,
  launch: Launch
): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const session = launch.tmuxSession;

  if (session && tmuxAvailable() && tmuxSessionExists(session)) {
    await run(["tmux", "kill-session", "-t", session], "/", log);
    log.push(`Stopped ${session}`);
  } else {
    log.push("Session was not running");
  }

  // Back to "starting" would be wrong and "cleaned" implies the worktree is
  // gone, so a stopped-but-intact launch is recorded as failed with a reason.
  updateLaunchStatus(db, launch.id, "failed", "Stopped by you");
  log.push(`Worktree kept at ${launch.worktreePath}`);

  return { ok: true, log };
}

/**
 * Tears down a launch: kills its tmux session and removes the worktree.
 * Deliberately does NOT delete the branch — uncommitted-but-wanted work
 * should survive a cleanup mistake.
 */
export async function cleanupLaunch(
  db: Database,
  launch: Launch,
  project: Project
): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];

  if (launch.tmuxSession && tmuxAvailable()) {
    await run(["tmux", "kill-session", "-t", launch.tmuxSession], "/", log);
  }

  // An adopted launch's "worktree" is the user's actual repository — it was
  // resumed in place rather than checked out. Running `git worktree remove
  // --force` there would attempt to destroy real work. This guard is the
  // reason launches carry a `kind` at all.
  if (launch.kind === "adopted") {
    updateLaunchStatus(db, launch.id, "cleaned");
    log.push(
      `Adopted session — left ${launch.worktreePath} untouched (it is the real repository, not a worktree).`
    );
    return { ok: true, log };
  }

  // A provisioned working dir (a whole Brazil workspace, a clone, …) isn't a
  // git worktree — `git worktree remove` can't touch it. Remove the directory
  // itself, but ONLY if it sits under this project's own worktree root: that
  // is the guarantee it's a dir Standup created, never a real repo a
  // misconfigured provision command left pointing elsewhere.
  if (launch.provisioned) {
    const ownedPrefixRoot = join(resolveWorktreeRoot(db, project), project.id);
    const target = launch.worktreePath;
    if (target && (target === ownedPrefixRoot || target.startsWith(`${ownedPrefixRoot}/`))) {
      const removed = await run(["rm", "-rf", target], "/", log);
      if (!removed.ok) {
        log.push("[warn] failed to remove provisioned dir; remove it manually");
      }
    } else {
      log.push(
        `[warn] refusing to remove ${target} — it is not under this project's worktree root ` +
          `(${ownedPrefixRoot}). Remove it by hand if it really is a Standup working dir.`
      );
    }
    updateLaunchStatus(db, launch.id, "cleaned");
    return { ok: true, log };
  }

  const repo = project.repos[0];
  if (repo) {
    const repoPath = repo.replace(/^~/, homedir());
    const removed = await run(
      ["git", "worktree", "remove", "--force", launch.worktreePath],
      repoPath,
      log
    );
    if (!removed.ok) {
      log.push("[warn] worktree remove failed; it may already be gone");
    }
  }

  updateLaunchStatus(db, launch.id, "cleaned");
  log.push(`Branch ${launch.branch} left in place — delete it manually if unwanted.`);

  return { ok: true, log };
}
