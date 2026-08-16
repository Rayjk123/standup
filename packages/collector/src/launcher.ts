import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { Launch, Project } from "@standup/shared";
import { createLaunch, updateLaunchStatus } from "@standup/store";

const WORKTREE_ROOT =
  process.env.STANDUP_WORKTREE_ROOT ??
  join(homedir(), ".local", "share", "standup", "worktrees");

/** Per-step cap so a wedged setup command can't hang the launch forever. */
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

export interface LaunchRequest {
  project: Project;
  task: string;
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
  log: string[]
): Promise<{ ok: boolean; output: string }> {
  // Setup commands come from projects.toml and are shell strings by design
  // ("uv sync && docker compose up -d"), so they need a shell to interpret
  // them. This is the user's own config running on the user's own machine —
  // the same trust level as a Makefile — but it is arbitrary code execution,
  // so it only ever runs on an explicit launch, never on collector startup.
  log.push(`$ ${script}`);

  const proc = Bun.spawn(["/bin/sh", "-c", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  { project, task }: LaunchRequest
): Promise<LaunchResult> {
  const log: string[] = [];
  const slug = slugify(task);
  const branch = `standup/${slug}`;
  const worktreePath = join(WORKTREE_ROOT, project.id, slug);
  const tmuxSession = `standup-${project.id}-${slug}`.slice(0, 100);

  const repo = project.repos[0];
  if (!repo) {
    throw new Error(
      `Project "${project.id}" has no repos configured — nothing to check out. Add a repos entry in projects.toml.`
    );
  }
  const repoPath = repo.replace(/^~/, homedir());

  if (!existsSync(repoPath)) {
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
    projectId: project.id,
    task,
    worktreePath,
    branch,
    baseBranch: project.branch,
    tmuxSession,
    status: "starting",
  });

  try {
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

    await mkdir(join(WORKTREE_ROOT, project.id), { recursive: true });

    const base = project.branch || "HEAD";
    const worktree = await run(
      ["git", "worktree", "add", "-b", branch, worktreePath, base],
      repoPath,
      log
    );
    if (!worktree.ok) {
      throw new Error(`git worktree add failed: ${worktree.output.slice(0, 300)}`);
    }

    if (project.setup) {
      const setup = await runShell(project.setup, worktreePath, log);
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
        worktreePath,
        "claude",
        task,
      ],
      worktreePath,
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
