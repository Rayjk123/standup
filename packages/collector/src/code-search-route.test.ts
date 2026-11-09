import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLaunch, createSession, createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";
import { searchableTempDir } from "./code-search.js";

/**
 * /api/ripgrep (the `ripgrep` MCP tool) searches only inside an allow-list: registered project repos, active launch worktrees of
 * registered projects, and STANDUP_CODE_SEARCH_ROOTS, or below one of them. Any
 * other directory a request names is refused with a message, never searched;
 * inside an allowed root the deny-list (home, dot-dirs, credential stores,
 * system dirs) still applies. HOME is a temp dir throughout. All in-process via
 * app.request.
 */

const token = "zqxjkroutecanary";
let root: string;
let repo: string;
let sessionDir: string;
let stranger: string;
let store: Store;
let app: ReturnType<typeof createServer>;
const saved = {
  HOME: process.env.HOME,
  STANDUP_RG_PATH: process.env.STANDUP_RG_PATH,
  STANDUP_CODE_SEARCH_ROOTS: process.env.STANDUP_CODE_SEARCH_ROOTS,
};

beforeEach(() => {
  root = mkdtempSync(join(searchableTempDir(), "cs-route-"));
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME);
  repo = join(root, "repo");
  sessionDir = join(root, "session");
  stranger = join(root, "stranger");
  for (const dir of [repo, join(repo, "src"), sessionDir, stranger]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), `export const ${token} = 1;\n`);
  writeFileSync(join(sessionDir, "b.ts"), `// ${token}\n`);
  writeFileSync(join(stranger, "c.ts"), `// ${token}\n`);
  process.env.STANDUP_RG_PATH = join(tmpdir(), "definitely-not-ripgrep-zqxjk");
  delete process.env.STANDUP_CODE_SEARCH_ROOTS;

  store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "proj", branch: "main", repos: [repo] });
  createSession(store.db, { id: "sess", projectId: "proj", title: "s", cwd: sessionDir, status: "running" });
  app = createServer(store, () => {}, null);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function post(path: string, body: Record<string, unknown>, actor = "alice") {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", [DEFAULT_IDENTITY_HEADER]: actor },
    body: JSON.stringify(body),
  });
}

describe("/api/ripgrep", () => {
  test("a registered repo, or a directory below it, is searched", async () => {
    for (const cwd of [repo, join(repo, "src")]) {
      const res = await post("/api/ripgrep", { cwd, pattern: token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: Array<{ file: string }> };
      expect(body.matches).toHaveLength(1);
    }
  });

  test("a session's cwd outside every registered root is refused, even for its creator", async () => {
    // The session row could have come from an unauthenticated /hook post.
    for (const body of [{ session_id: "sess", cwd: sessionDir }, { cwd: sessionDir }]) {
      const res = await post("/api/ripgrep", { ...body, pattern: token });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("registered project repos");
    }
  });

  test("a session inside a registered repo is searched with or without its session id", async () => {
    const inRepo = join(repo, "src");
    createSession(store.db, { id: "repo-sess", projectId: "proj", title: "r", cwd: inRepo, status: "running" });
    for (const body of [{ session_id: "repo-sess", cwd: inRepo }, { cwd: inRepo }]) {
      expect((await post("/api/ripgrep", { ...body, pattern: token }, "codex-user")).status).toBe(200);
    }
  });

  test("any other directory is refused with a clear message", async () => {
    for (const cwd of [stranger, root, "/", "/etc"]) {
      const res = await post("/api/ripgrep", { cwd, pattern: token });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { status: string; error: string; matches: unknown[] };
      expect(body.status).toBe("unavailable");
      expect(body.error).toContain("limited to registered project repos");
      expect(body.matches).toEqual([]);
    }
  });

  test("STANDUP_CODE_SEARCH_ROOTS allows an extra root", async () => {
    process.env.STANDUP_CODE_SEARCH_ROOTS = stranger;
    const res = await post("/api/ripgrep", { cwd: stranger, pattern: token });
    expect(res.status).toBe(200);
  });

  test("inside an allowed root, the deny-list still applies", async () => {
    // A registered repo whose tree holds a credential file and a .env.
    writeFileSync(join(repo, "credentials"), `${token}\n`);
    writeFileSync(join(repo, ".env"), `${token}\n`);
    const whole = await post("/api/ripgrep", { cwd: repo, pattern: token });
    expect(((await whole.json()) as { matches: Array<{ file: string }> }).matches.map((m) => m.file)).toEqual([
      "./src/a.ts",
    ]);
    const explicit = await post("/api/ripgrep", { cwd: repo, path: ".env", pattern: token });
    const body = (await explicit.json()) as { status: string; matches: unknown[] };
    expect(body.status).toBe("unavailable");
    expect(body.matches).toEqual([]);
  });
});

describe("launched worktrees", () => {
  function launchAt(id: string, worktree: string, projectId: string): void {
    mkdirSync(join(worktree, "pkg"), { recursive: true });
    writeFileSync(join(worktree, "pkg", "w.ts"), `// ${token}\n`);
    createLaunch(store.db, { id, projectId, task: "t", worktreePath: worktree, branch: `standup/${id}`, status: "running" });
  }

  test("a cwd inside an active launch's worktree for a registered project is searched, with no session id", async () => {
    // A Codex session can't name its session id.
    const worktree = join(root, "worktrees", "launch-1");
    launchAt("L-1", worktree, "proj");
    const res = await post("/api/ripgrep", { cwd: join(worktree, "pkg"), pattern: token }, "codex-user");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matches: unknown[] }).matches).toHaveLength(1);
  });

  test("a cleaned launch's worktree allows nothing", async () => {
    const cleaned = join(root, "worktrees", "cleaned");
    launchAt("L-3", cleaned, "proj");
    store.db.run("UPDATE launches SET status = 'cleaned' WHERE id = 'L-3'");
    expect((await post("/api/ripgrep", { cwd: cleaned, pattern: token })).status).toBe(400);
  });
});

describe("project registration", () => {
  test("the filesystem root, the home directory or an ancestor of it is refused as a repo", async () => {
    const home = process.env.HOME!;
    // A4: a home dot-directory is refused as a repo too.
    for (const repoPath of ["/", home, "~", join(home, ".."), "~/.config", join(home, ".claude")]) {
      const created = await post("/api/projects", { id: "wide", repos: [repoPath] });
      expect(created.status).toBe(400);
      expect(((await created.json()) as { error: string }).error).toContain("is not allowed");
      const patched = await app.request("/api/projects/proj", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repos: [repoPath] }),
      });
      expect(patched.status).toBe(400);
    }
    // A repo under the home directory is fine for the owner, who alone sets a
    // new project's repos.
    const secrets = generateOwnerSecrets();
    const owned = createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
      ownerSecrets: secrets,
    });
    const asOwner = (body: Record<string, unknown>) =>
      owned.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken },
        body: JSON.stringify(body),
      });
    const nested = join(home, "src", "repo");
    mkdirSync(nested, { recursive: true });
    expect((await asOwner({ id: "nested", repos: [nested] })).status).toBe(201);
    // So is a Standup-provisioned worktree under the data directory.
    const provisioned = join(home, ".local", "share", "standup", "worktrees", "proj", "w");
    mkdirSync(provisioned, { recursive: true });
    expect((await asOwner({ id: "provisioned", repos: [provisioned] })).status).toBe(201);
  });
});
