import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

/**
 * Working directories for `claude` subprocesses Standup spawns for its own
 * purposes, which the hook endpoint ignores entirely.
 *
 * Hooks are installed globally in `~/.claude/settings.json`, so they apply to
 * every `claude` on the machine — including headless `claude -p` calls
 * Standup makes itself. Without a guard, such a subprocess's own Stop event
 * comes back to the collector, which can trigger another subprocess, which
 * fires its own Stop event. Auto-checkpointing did exactly this, three
 * generations deep, before someone flipped the setting off.
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
const INTERNAL_ROOT = join(homedir(), ".local", "share", "standup", "internal");

/** Auto-checkpoint's summarizer. Unchanged path — it predates this module. */
export const AUTO_CHECKPOINT_CWD = INTERNAL_ROOT;

/** Adversarial verification of a bootstrap draft. */
export const DRAFT_VERIFY_CWD = join(INTERNAL_ROOT, "verify");

/**
 * Whether a hook payload's cwd belongs to one of Standup's own subprocesses.
 *
 * Prefix-matched on the reserved root so a new internal cwd is covered the
 * moment it is created under it, rather than needing this list updated —
 * which is the mistake that would reintroduce the recursion.
 */
export function isInternalCwd(cwd: string): boolean {
  return cwd === INTERNAL_ROOT || cwd.startsWith(INTERNAL_ROOT + "/");
}

export function ensureInternalCwd(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
