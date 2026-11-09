import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, createStore, getSession, insertEvent, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";
import {
  projectIdForPath,
  resetSessionProjectCaches,
  resolveSessionProject,
  transcriptWorkingDirs,
} from "./session-project.js";

/**
 * A session registered under scratch (started from a non-repo cwd such as $HOME)
 * is re-homed from any path it touches that names a project — notably a launch
 * worktree `standup-worktrees/<project>/<slug>/...` reached as an additional
 * working directory — and the move persists on the session row.
 */

const root = mkdtempSync(join(tmpdir(), "standup-session-project-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HOME = join(root, "home");
const WORKTREE_ROOT = join(root, "code", "standup-worktrees");
const PROJECT = "orchard-ledger";
const WORKTREE = join(WORKTREE_ROOT, PROJECT, "add-csv-export-3f9a10", "src", "Pkg");
mkdirSync(HOME, { recursive: true });
mkdirSync(WORKTREE, { recursive: true });

let transcriptSeq = 0;

function environmentLine(workingDirectory: string, additional: string[]): string {
  return JSON.stringify({
    type: "attachment",
    attachment: {
      type: "environment",
      snapshot: {
        workingDirectory,
        isWorktree: false,
        isGitRepo: false,
        additionalWorkingDirectories: additional,
        platform: "linux",
      },
    },
  });
}

function writeTranscript(lines: string[]): string {
  const path = join(root, `t-${++transcriptSeq}.jsonl`);
  writeFileSync(path, lines.map((l) => l + "\n").join(""));
  return path;
}

function setUp(): Store {
  resetSessionProjectCaches();
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
  upsertProject(store.db, {
    id: PROJECT,
    name: "Orchard Ledger",
    branch: "main",
    repos: [],
    worktreeRoot: WORKTREE_ROOT,
  });
  return store;
}

function scratchSession(store: Store, id: string, transcriptPath?: string) {
  createSession(store.db, { id, projectId: "scratch", title: id, cwd: HOME, status: "running" });
  if (transcriptPath) {
    insertEvent(store.db, id, "UserPromptSubmit", {
      session_id: id,
      cwd: HOME,
      transcript_path: transcriptPath,
      hook_event_name: "UserPromptSubmit",
    });
  }
}

describe("projectIdForPath", () => {
  beforeEach(() => resetSessionProjectCaches());

  test("a path under <worktreeRoot>/<project>/ names the project", () => {
    const store = setUp();
    expect(projectIdForPath(store.db, WORKTREE)).toBe(PROJECT);
    expect(projectIdForPath(store.db, HOME)).toBeNull();
  });

  test("a literal standup-worktrees/<project>/ segment names a registered project", () => {
    const store = setUp();
    upsertProject(store.db, { id: "tidepool", name: "Tidepool", branch: "main", repos: [] });
    expect(projectIdForPath(store.db, "/elsewhere/standup-worktrees/tidepool/some-slug/src")).toBe(
      "tidepool"
    );
    expect(projectIdForPath(store.db, "/elsewhere/standup-worktrees/unregistered/x")).toBeNull();
  });
});

describe("transcriptWorkingDirs", () => {
  test("returns every snapshot's dirs, newest first, and picks up appended snapshots", () => {
    const path = writeTranscript([
      environmentLine(WORKTREE, [WORKTREE]),
      JSON.stringify({ type: "user", cwd: HOME }),
    ]);
    expect(transcriptWorkingDirs(path)).toEqual([WORKTREE]);
    appendFileSync(path, environmentLine(HOME, ["/extra"]) + "\n");
    expect(transcriptWorkingDirs(path)).toEqual([HOME, "/extra", WORKTREE]);
  });

  test("empty for a missing file", () => {
    expect(transcriptWorkingDirs(join(root, "absent.jsonl"))).toEqual([]);
  });
});

describe("resolveSessionProject", () => {
  test("re-homes a $HOME session from its additional working directory and persists it", () => {
    const store = setUp();
    scratchSession(store, "s1", writeTranscript([environmentLine(HOME, [WORKTREE])]));

    const first = resolveSessionProject(store.db, "s1", { paths: [HOME] });
    expect(first).toEqual({ projectId: PROJECT, moved: true });
    expect(getSession(store.db, "s1")?.projectId).toBe(PROJECT);

    // Survives later calls from an unrelated cwd, with no warning.
    const again = resolveSessionProject(store.db, "s1", { paths: ["/tmp"] });
    expect(again).toEqual({ projectId: PROJECT, moved: false });
  });

  test("re-homes from a hook cwd that moved into the worktree", () => {
    const store = setUp();
    scratchSession(store, "s2");
    insertEvent(store.db, "s2", "PreToolUse", {
      session_id: "s2",
      cwd: WORKTREE,
      hook_event_name: "PreToolUse",
    });
    expect(resolveSessionProject(store.db, "s2").projectId).toBe(PROJECT);
  });

  test("subagents inherit: scratch children move with the parent, and a child defers to its parent", () => {
    const store = setUp();
    scratchSession(store, "p", writeTranscript([environmentLine(HOME, [WORKTREE])]));
    createSession(store.db, {
      id: "p:a1",
      projectId: "scratch",
      title: "child",
      cwd: HOME,
      parentSessionId: "p",
      kind: "subagent",
      status: "running",
    });
    expect(resolveSessionProject(store.db, "p").projectId).toBe(PROJECT);
    expect(getSession(store.db, "p:a1")?.projectId).toBe(PROJECT);

    const store2 = setUp();
    scratchSession(store2, "q", writeTranscript([environmentLine(HOME, [WORKTREE])]));
    createSession(store2.db, {
      id: "q:a1",
      projectId: "scratch",
      title: "child",
      cwd: HOME,
      parentSessionId: "q",
      kind: "subagent",
      status: "running",
    });
    expect(resolveSessionProject(store2.db, "q:a1").projectId).toBe(PROJECT);
    expect(getSession(store2.db, "q")?.projectId).toBe(PROJECT);
  });

  test("falls back to scratch with a warning only when nothing resolves", () => {
    const store = setUp();
    scratchSession(store, "s3", writeTranscript([environmentLine(HOME, ["/nowhere"])]));
    const res = resolveSessionProject(store.db, "s3", { paths: [HOME] });
    expect(res.projectId).toBe("scratch");
    expect(res.warning).toContain("scratch");
    expect(res.warning).toContain(HOME);
  });

  test("never re-homes a session already in a real project", () => {
    const store = setUp();
    upsertProject(store.db, { id: "other", name: "Other", branch: "main", repos: [] });
    createSession(store.db, { id: "s4", projectId: "other", title: "s4", cwd: WORKTREE, status: "running" });
    expect(resolveSessionProject(store.db, "s4", { paths: [WORKTREE] })).toEqual({
      projectId: "other",
      moved: false,
    });
  });
});

describe("routes", () => {
  function app(store: Store) {
    return createServer(store, () => {}, null, undefined, undefined, "");
  }

  test("search_knowledge resolves the project from the additional directory; warns when it can't", async () => {
    const store = setUp();
    scratchSession(store, "r1", writeTranscript([environmentLine(HOME, [WORKTREE])]));
    scratchSession(store, "r2", writeTranscript([environmentLine(HOME, [])]));
    const server = app(store);

    const search = (session_id: string) =>
      server.request("/api/knowledge/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id, cwd: HOME, query: "anything", scoped: true }),
      });

    const resolved = (await (await search("r1")).json()) as { project: string; projectWarning?: string };
    expect(resolved.project).toBe(PROJECT);
    expect(resolved.projectWarning).toBeUndefined();

    const fallback = (await (await search("r2")).json()) as { project: string; projectWarning?: string };
    expect(fallback.project).toBe("scratch");
    expect(fallback.projectWarning).toContain("scratch");
  });

  test("a hook whose cwd is in the worktree moves a scratch session", async () => {
    const store = setUp();
    scratchSession(store, "h1");
    const res = await app(store).request("/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "h1",
        cwd: WORKTREE,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    });
    expect(res.status).toBe(200);
    expect(getSession(store.db, "h1")?.projectId).toBe(PROJECT);
  });
});
