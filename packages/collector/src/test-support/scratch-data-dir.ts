import { afterAll, beforeAll } from "bun:test";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { scratchDataDirBase } from "@standup/store";

const KEYS = ["DB_PATH", "STANDUP_WORKTREE_ROOT", "CLAUDE_CONFIG_DIR"] as const;

export interface ScratchDataDir {
  /** The mkdtemp root, which is also the data dir; set once `beforeAll` has run. */
  root: string;
  /** The scratch DB path DB_PATH points at. */
  dbPath: string;
  /** The scratch worktree root STANDUP_WORKTREE_ROOT points at. */
  worktreeRoot: string;
}

/**
 * Gives a suite that drives a real launch its own data dir under a mkdtemp
 * root for the length of the file:
 *   - DB_PATH, and so the data dir its launch's tmux socket, worker tokens and
 *     review media resolve under;
 *   - STANDUP_WORKTREE_ROOT, where the launch's worktree or scratch dir is made;
 *   - CLAUDE_CONFIG_DIR, where the launch pre-accepts folder trust in
 *     `.claude.json`.
 * `afterAll` restores the env and removes the root, so nothing a launch writes
 * outlives the suite or reaches the owner's data dir or Claude config.
 */
export function useScratchDataDir(prefix: string): ScratchDataDir {
  const dir: ScratchDataDir = { root: "", dbPath: "", worktreeRoot: "" };
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir.root = await mkdtemp(join(scratchDataDirBase(`${prefix}-`), `${prefix}-`));
    dir.dbPath = join(dir.root, "standup.db");
    dir.worktreeRoot = join(dir.root, "worktrees");
    process.env.DB_PATH = dir.dbPath;
    process.env.STANDUP_WORKTREE_ROOT = dir.worktreeRoot;
    process.env.CLAUDE_CONFIG_DIR = join(dir.root, "claude");
    await mkdir(process.env.CLAUDE_CONFIG_DIR);
  });

  afterAll(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir.root) await rm(dir.root, { recursive: true, force: true });
  });

  return dir;
}
