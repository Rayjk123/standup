import { spawnSync } from "child_process";
import { mkdirSync, readdirSync } from "fs";
import { join } from "path";

/*
 * Worker worktrees of a repository share its `.git/hooks`, so a hook the owner
 * installed for their own checkout (a redeploy on `post-checkout`, say) runs on
 * every worker's commit or checkout, and the safety floor holds each one. The
 * launcher points each worker worktree at an empty hooks dir of its own
 * through per-worktree config, which leaves the repository's other checkouts
 * untouched. The dir sits in Standup's data dir, where the floor stops a
 * worker from writing, so it stays empty.
 */

/** The empty hooks dir worker worktrees use, under Standup's data dir. */
export function workerHooksDir(standupDataDir: string): string {
  return join(standupDataDir, "worker-hooks");
}

/** The git config writes that isolate a worktree's hooks, as `git config` arguments. */
export function hooksIsolationConfig(hooksDir: string): string[][] {
  return [
    ["extensions.worktreeConfig", "true"],
    ["--worktree", "core.hooksPath", hooksDir],
  ];
}

export interface IsolateResult {
  ok: boolean;
  /** Why it failed, when it did. */
  error?: string;
}

/**
 * Creates `hooksDir` when it is missing and refuses one that holds anything,
 * since whatever is in it would run as a worktree's hooks.
 */
export function ensureEmptyHooksDir(hooksDir: string): IsolateResult {
  try {
    mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
    const entries = readdirSync(hooksDir);
    if (entries.length > 0) return { ok: false, error: `${hooksDir} is not empty (${entries.slice(0, 3).join(", ")})` };
  } catch (err) {
    return { ok: false, error: `cannot prepare ${hooksDir}: ${(err as Error).message}` };
  }
  return { ok: true };
}

/**
 * Points the worktree at `hooksDir` for its hooks (see ensureEmptyHooksDir):
 * enables `extensions.worktreeConfig` and sets `core.hooksPath` in the
 * worktree's own config.
 */
export function isolateWorktreeHooks(worktreePath: string, hooksDir: string): IsolateResult {
  const prepared = ensureEmptyHooksDir(hooksDir);
  if (!prepared.ok) return prepared;
  for (const args of hooksIsolationConfig(hooksDir)) {
    const res = spawnSync("git", ["-C", worktreePath, "config", ...args], { encoding: "utf8", timeout: 15_000 });
    if (res.status !== 0) {
      return { ok: false, error: `git config ${args.join(" ")} failed: ${(res.stderr || res.error?.message || "").trim().slice(0, 300)}` };
    }
  }
  return { ok: true };
}
