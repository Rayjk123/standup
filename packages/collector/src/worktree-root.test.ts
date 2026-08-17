import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { createStore, setSetting } from "@standup/store";
import type { Project } from "@standup/shared";
import { resolveWorktreeRoot, WORKTREE_ROOT_SETTING } from "./launcher.js";

/**
 * Where a launched worktree lands, most-specific wins: per-project override,
 * then the global setting, then STANDUP_WORKTREE_ROOT, then the built-in
 * default — with a leading ~ expanded either way.
 */

const DEFAULT = join(homedir(), ".local", "share", "standup", "worktrees");

function project(worktreeRoot?: string): Project {
  return { id: "p", name: "p", branch: "main", repos: [], worktreeRoot };
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.STANDUP_WORKTREE_ROOT;
  delete process.env.STANDUP_WORKTREE_ROOT;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = savedEnv;
});

describe("resolveWorktreeRoot precedence", () => {
  test("falls back to the built-in default when nothing is set", () => {
    const store = createStore(":memory:");
    expect(resolveWorktreeRoot(store.db, project())).toBe(DEFAULT);
  });

  test("STANDUP_WORKTREE_ROOT beats the default", () => {
    process.env.STANDUP_WORKTREE_ROOT = "/env/root";
    const store = createStore(":memory:");
    expect(resolveWorktreeRoot(store.db, project())).toBe("/env/root");
  });

  test("the global setting beats the env var", () => {
    process.env.STANDUP_WORKTREE_ROOT = "/env/root";
    const store = createStore(":memory:");
    setSetting(store.db, WORKTREE_ROOT_SETTING, "/global/root");
    expect(resolveWorktreeRoot(store.db, project())).toBe("/global/root");
  });

  test("the project override beats the global setting", () => {
    const store = createStore(":memory:");
    setSetting(store.db, WORKTREE_ROOT_SETTING, "/global/root");
    expect(resolveWorktreeRoot(store.db, project("/proj/root"))).toBe("/proj/root");
  });

  test("an empty global setting is ignored, not treated as a path", () => {
    process.env.STANDUP_WORKTREE_ROOT = "/env/root";
    const store = createStore(":memory:");
    setSetting(store.db, WORKTREE_ROOT_SETTING, "");
    expect(resolveWorktreeRoot(store.db, project())).toBe("/env/root");
  });

  test("expands a leading ~ in whichever value wins", () => {
    const store = createStore(":memory:");
    expect(resolveWorktreeRoot(store.db, project("~/workplace/wt"))).toBe(
      join(homedir(), "workplace", "wt")
    );
  });
});
