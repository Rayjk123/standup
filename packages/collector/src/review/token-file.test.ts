import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WORKER_TOKEN_FILE_ENV, WORKER_TOKEN_HEADER } from "@standup/shared";
import { createLaunch, createStore, getLaunchByReviewTokenHash, getLaunchReviewTokenHash, upsertProject } from "@standup/store";
import { workerTokensDir } from "@standup/shared/owner-token";
import { workerTokenHeaders } from "../../../mcp/src/tools.js";
import { workerTokenHash } from "../floor/gate.js";
import { buildSpawnArgv } from "../launcher.js";
import { issueReviewToken, removeReviewToken, reviewTokenEnv, reviewTokenPath } from "./token-file.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "review-token-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  for (const id of ["launch-1", "launch-2"]) {
    createLaunch(store.db, { id, projectId: "p", task: "t", worktreePath: "/wt", branch: "b", status: "running" });
  }
  return { root, dataDir, store };
}

describe("launch review token files", () => {
  test("the file is 0600 in a 0700 dir, and only its hash is on the launch", () => {
    const w = world();
    const path = issueReviewToken(w.store.db, w.dataDir, "launch-1");
    expect(path).toBe(join(workerTokensDir(w.dataDir), "launch-1"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(workerTokensDir(w.dataDir)).mode & 0o777).toBe(0o700);
    const token = readFileSync(path, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(getLaunchReviewTokenHash(w.store.db, "launch-1")).toBe(workerTokenHash(token));
    expect(getLaunchByReviewTokenHash(w.store.db, workerTokenHash(token))?.id).toBe("launch-1");
    expect(getLaunchByReviewTokenHash(w.store.db, workerTokenHash("nope"))).toBeNull();
    // Nothing but the token file is left in the dir.
    expect(readdirSync(workerTokensDir(w.dataDir))).toEqual(["launch-1"]);
  });

  test("each launch gets its own token; reissuing replaces the old one", () => {
    const w = world();
    const one = readFileSync(issueReviewToken(w.store.db, w.dataDir, "launch-1"), "utf8");
    const two = readFileSync(issueReviewToken(w.store.db, w.dataDir, "launch-2"), "utf8");
    expect(one).not.toBe(two);
    const again = readFileSync(issueReviewToken(w.store.db, w.dataDir, "launch-1"), "utf8");
    expect(again).not.toBe(one);
    expect(getLaunchByReviewTokenHash(w.store.db, workerTokenHash(one))).toBeNull();
  });

  test("a loose token dir is tightened; a symlinked one is refused", () => {
    const w = world();
    mkdirSync(workerTokensDir(w.dataDir), { recursive: true, mode: 0o755 });
    chmodSync(workerTokensDir(w.dataDir), 0o755);
    issueReviewToken(w.store.db, w.dataDir, "launch-1");
    expect(statSync(workerTokensDir(w.dataDir)).mode & 0o777).toBe(0o700);

    const other = world();
    const elsewhere = join(other.root, "elsewhere");
    mkdirSync(other.dataDir, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, workerTokensDir(other.dataDir));
    expect(() => issueReviewToken(other.store.db, other.dataDir, "launch-1")).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("an id that could name a path elsewhere is refused", () => {
    const w = world();
    for (const id of ["../x", ".hidden", "a/b", ""]) expect(() => reviewTokenPath(w.dataDir, id)).toThrow();
  });

  test("cleanup removes the file", () => {
    const w = world();
    const path = issueReviewToken(w.store.db, w.dataDir, "launch-1");
    removeReviewToken(w.dataDir, "launch-1");
    expect(existsSync(path)).toBe(false);
    removeReviewToken(w.dataDir, "../nope");
  });

  test("the token is nowhere in the spawn argv or env; the MCP server reads it from the file and sends it", () => {
    const w = world();
    const path = issueReviewToken(w.store.db, w.dataDir, "launch-1");
    const token = readFileSync(path, "utf8");
    const env = reviewTokenEnv(path);
    expect(env).toEqual({ [WORKER_TOKEN_FILE_ENV]: path });
    const argv = buildSpawnArgv("claude", {
      tmuxSession: "s",
      launchCwd: "/wt",
      workspaceRoot: "/wt",
      prompt: "p",
      launchId: "launch-1",
      isScratch: false,
      workerTokenFile: path,
    });
    expect(argv.join("\0")).not.toContain(token);
    expect(JSON.stringify(env)).not.toContain(token);
    expect(workerTokenHeaders(env)).toEqual({ [WORKER_TOKEN_HEADER]: token });
  });
});
