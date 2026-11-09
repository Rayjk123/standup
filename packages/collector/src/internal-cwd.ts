import { homedir } from "os";
import { dirname, join, resolve } from "path";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";

/**
 * Working directories for `claude` subprocesses Standup spawns for its own
 * purposes, which the hook endpoint ignores entirely.
 *
 * Hooks are installed globally in `~/.claude/settings.json`, so they apply to
 * every `claude` on the machine — including headless `claude -p` calls
 * Standup makes itself. Without a guard, such a subprocess's own Stop event
 * comes back to the collector, which can trigger another subprocess, which
 * fires its own Stop event, recursing without bound — auto-checkpointing's
 * summarizer is one such subprocess.
 *
 * That guard was a single exact-match constant. This generalises it, because
 * a second internal subprocess now exists (draft verification) and matching
 * one hard-coded path would have silently re-opened the loop for it: the
 * failure is not an error, it is an agent quietly recursing while the feed
 * fills with sessions nobody started.
 *
 * These live under a reserved root rather than anywhere near a repository —
 * a subprocess that needs to inspect a checkout is given its path and uses
 * absolute paths from here, rather than running *in* it. Running in the
 * checkout would make its cwd indistinguishable from a real session's.
 */
const INTERNAL_ROOT = internalRoot();

/**
 * The reserved root: `STANDUP_INTERNAL_ROOT` when set (trimmed, non-empty), so
 * a second collector instance (dev/test, alternate ports) keeps its internal
 * subprocesses apart from the primary one's; otherwise
 * `~/.local/share/standup/internal`. Read once at module load — the cwd
 * constants below are derived from it.
 */
export function internalRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STANDUP_INTERNAL_ROOT?.trim();
  return override ? resolve(override) : join(homedir(), ".local", "share", "standup", "internal");
}

/** Auto-checkpoint's summarizer. Unchanged path — it predates this module. */
export const AUTO_CHECKPOINT_CWD = INTERNAL_ROOT;

/** Adversarial verification of a bootstrap draft. */
export const DRAFT_VERIFY_CWD = join(INTERNAL_ROOT, "verify");

/** Automatic contradiction resolution over a flagged doc↔doc pair. */
export const KNOWLEDGE_RESOLVE_CWD = join(INTERNAL_ROOT, "resolve");

/** Daily morning-digest summarization over the last ~24h of work. */
export const DIGEST_CWD = join(INTERNAL_ROOT, "digest");

/** Persona's headless orchestrator turns. */
export const PERSONA_CWD = join(INTERNAL_ROOT, "persona");

/** The second check on Persona's allow of a safety-floor hold (persona/allow-check.ts). */
export const PERSONA_ALLOW_CHECK_CWD = join(INTERNAL_ROOT, "allow-check");

/** The optional model rewrite of a launch brief into injection queries (knowledge-query-rewrite.ts). */
export const INJECTION_QUERY_CWD = join(INTERNAL_ROOT, "query-rewrite");

/** The doc agent's answers to comments on a doc, from the doc alone (docs/answer.ts). */
export const DOC_ANSWER_CWD = join(INTERNAL_ROOT, "doc-answer");

/** Holds multi-line text staged for a tmux paste into a launched session's pane. */
export function paneDeliveryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(internalRoot(env), "pane-send");
}

/** Holds the auth/model settings file forwarded to every headless call. */
export function headlessSettingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(internalRoot(env), "settings");
}

/**
 * Whether a hook payload's cwd belongs to one of Standup's own subprocesses.
 *
 * Prefix-matched on the reserved root so a new internal cwd is covered the
 * moment it is created under it, rather than needing this list updated —
 * which is the mistake that would reintroduce the recursion.
 */
export function isInternalCwd(cwd: string): boolean {
  return internalRoots().some((root) => cwd === root || cwd.startsWith(root + "/"));
}

/**
 * The reserved root as spelled from `homedir()` and as its resolved real path.
 *
 * `homedir()` can be a symlink (e.g. `/home/u` -> `/data/home/u`), while Claude
 * Code reports the subprocess's resolved cwd in hook payloads. Matching only the
 * `homedir()` spelling lets every internal subprocess through as a session.
 */
function internalRoots(): string[] {
  if (!resolvedRoots) {
    let real = INTERNAL_ROOT;
    try {
      real = realpathSync(ensureInternalCwd(INTERNAL_ROOT));
    } catch {
      // Unresolvable root: the literal spelling is all there is to match.
    }
    resolvedRoots = real === INTERNAL_ROOT ? [INTERNAL_ROOT] : [INTERNAL_ROOT, real];
  }
  return resolvedRoots;
}

let resolvedRoots: string[] | undefined;

/**
 * Creates `dir` (and any missing ancestors, the reserved root included) 0700.
 * The internal cwds hold transcripts of Standup's own model calls and sit
 * beside the private directories, so nothing under the root is meant for
 * other local users.
 */
export function ensureInternalCwd(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Group- or world-writable without the sticky bit: anyone with that access can rename entries away. */
function othersCanReplaceEntries(mode: number): boolean {
  return (mode & 0o022) !== 0 && (mode & 0o1000) === 0;
}

function octal(mode: number): string {
  return (mode & 0o7777).toString(8);
}

/**
 * Null when every directory from `/` down to `path` is one only we (or root)
 * could rearrange, otherwise why not. A directory owned by someone else that
 * group/others can write to (and is not sticky) lets them swap whatever sits
 * below it. A symlink along the way must belong to us or root, since its
 * owner can repoint it. Directories we own are accepted whatever their mode —
 * how we share our own tree is ours to choose, and the two levels holding
 * secrets are tightened separately.
 */
export function unsafeAncestor(path: string, uid: number): string | null {
  const parts = path.split("/").filter(Boolean);
  let current = "/";
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) current = join(current, parts[i - 1]!);
    const st = lstatSync(current);
    if (st.isSymbolicLink()) {
      if (st.uid !== uid && st.uid !== 0) return `${current} is a symlink owned by uid ${st.uid}`;
      continue;
    }
    if (st.uid !== uid && othersCanReplaceEntries(st.mode)) {
      return `${current} is owned by uid ${st.uid} and writable by group or others (mode ${octal(st.mode)})`;
    }
  }
  return null;
}

/** Restricts a directory we own to 0700; false when the mode would not stick. */
function restrictTo0700(path: string, mode: number): boolean {
  if ((mode & 0o077) === 0) return true;
  chmodSync(path, 0o700);
  return (statSync(path).mode & 0o077) === 0;
}

/**
 * Creates `dir` (0700) if absent and checks it is safe to hold secrets — the
 * persona token, the forwarded settings `env` block. Returns null when it is,
 * otherwise the reason it is not.
 *
 * `dir` must be a directory we own; it is tightened to 0700 whatever its mode
 * (a umask of 002 creates directories 0775), and so is its parent when we own
 * it, since whoever can write there could swap `dir` itself.
 * Every directory and symlink on the way from `/` — along the literal path and
 * the resolved one — is checked by `unsafeAncestor`: one owned by someone else
 * that others can write to refuses the directory, since files planted below
 * it, such as a symlink where a config file is written, cannot be trusted.
 */
export function ensurePrivateDir(dir: string): string | null {
  try {
    const abs = resolve(dir);
    mkdirSync(abs, { recursive: true, mode: 0o700 });
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const real = realpathSync(abs);
    const st = statSync(real);
    if (!st.isDirectory()) return `${dir} is not a directory`;
    if (uid === undefined) return null;
    if (st.uid !== uid) return `${dir} is owned by uid ${st.uid}, not ${uid}`;

    const parent = dirname(real);
    const parentSt = statSync(parent);
    if (parentSt.uid === uid && !restrictTo0700(parent, parentSt.mode)) {
      return `${parent} could not be restricted to 0700`;
    }
    const unsafe = unsafeAncestor(abs, uid) ?? (real === abs ? null : unsafeAncestor(real, uid));
    if (unsafe) return unsafe;

    if (!restrictTo0700(real, st.mode)) return `${dir} could not be restricted to 0700`;
    return null;
  } catch (err) {
    return `${dir} is unusable: ${(err as Error).message}`;
  }
}

/**
 * Writes `content` to `path` as a fresh 0600 file. Whatever was at `path` is
 * unlinked first and the new file is opened O_CREAT|O_EXCL|O_NOFOLLOW, so a
 * symlink planted there is replaced rather than followed, and the mode is set
 * on the descriptor so the umask cannot widen it.
 */
export function writePrivateFileSync(path: string, content: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
