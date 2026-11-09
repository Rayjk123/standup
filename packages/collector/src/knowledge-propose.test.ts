import { expect, test, describe, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, readdir, symlink } from "fs/promises";
import { realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, createSession, createLaunch, upsertProject, touchUser } from "@standup/store";
import type { Store } from "@standup/store";
import { searchKnowledge, writeKnowledgeFile, KnowledgeLoader, KnowledgeStore } from "@standup/knowledge";
import { DEFAULT_IDENTITY_HEADER, GLOBAL_PROJECT_ID } from "@standup/shared";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";
import type { DraftVerification } from "./draft-verify.js";
import { UNNAMED_UNMERGED_WARNING } from "./knowledge-repo-claims.js";

/**
 * propose_knowledge's collector-side gate resolves the doc's project and
 * provenance from the calling launch OR, when there is no running launch, the
 * calling session. The only hard requirement is a resolvable session to
 * attribute the doc to. These exercise POST /api/knowledge/propose directly (not
 * through the MCP tool, which packages/mcp does not hot-reload — see runbook.md)
 * to confirm any running launch (ordinary or bootstrap) can contribute, that a
 * monitored session with no launch can too (falling back to its own project),
 * that an explicit target project routes the doc cross-project, that an unknown
 * target 404s, and that a caller with no resolvable session is rejected.
 *
 * These cases pin the DRAFT path (request_human_review: true), where the
 * proposal stays a draft a human must accept — never searchable until then — so
 * the provenance/routing/gate assertions read the `.drafts/` file. The
 * auto-accept default (no flag → publish immediately, searchable) has its own
 * describe block at the bottom.
 */

/**
 * The server under test, with the write-path quality checks stubbed: the
 * post-publish fact-check answers `verdict` (default: an error, which leaves a
 * doc unverified) and the contradiction judge finds nothing — no `claude` spawn.
 */
const verifyCalls: Array<{ slug: string; repoPath: string; additionalRepos?: string[] }> = [];
let verifyVerdict: DraftVerification = { verdict: "error", disputes: [] };
function serverWith(
  store: Store,
  broadcast: Parameters<typeof createServer>[1],
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string,
  identityConfig?: Parameters<typeof createServer>[11]
) {
  return createServer(
    store,
    broadcast,
    null,
    knowledgeSync,
    undefined,
    knowledgeDir,
    "",
    {},
    undefined,
    undefined,
    undefined,
    identityConfig,
    {},
    {
      verify: async (slug, _body, repoPath, additionalRepos) => {
        verifyCalls.push(additionalRepos?.length ? { slug, repoPath, additionalRepos } : { slug, repoPath });
        return verifyVerdict;
      },
      judge: async () => ({ contradicts: false, reason: "" }),
    }
  );
}

const PROJECT_ID = `propose-test-${randomUUID().slice(0, 8)}`;

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-knowledge-propose-"));
}

/** A real git repo with one commit, so `git rev-parse HEAD` in the handler
 * has something to resolve — findLaunchByCwd matches on worktree_path, so
 * this same directory is used as both the launch's worktree and the
 * request's cwd. */
async function tempGitWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-bootstrap-worktree-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "test\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

function setUpStore(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, {
    id: PROJECT_ID,
    name: "Propose Test",
    branch: "main",
    repos: [],
  });
  return store;
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("POST /api/knowledge/propose", () => {
  test("accepts a monitored session (session row, no launch) and writes a draft to its own project", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    // A real git worktree, but with NO launch tracking it — the monitored /
    // adopted / re-homed case. The handler must fall back to the session.
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "monitored-learned",
        title: "Monitored Learned",
        body: "A monitored session with no launch contributes this draft.",
        request_human_review: true,
      }),
    });

    expect(res.status).toBe(200);

    // It lands as an agent draft in the session's own project, attributed to the
    // session — no launch id, since there was no launch to stamp.
    const draftPath = join(knowledgeDir, PROJECT_ID, ".drafts", "monitored-learned.md");
    const raw = await readFile(draftPath, "utf-8");
    expect(raw).toContain("contributes this draft");
    expect(raw).toMatch(/origin_class: ?["']?agent/);
    expect(raw).toMatch(new RegExp(`source_session_id: ?["']?${sessionId}`));
    // The sha is stamped from the session's own cwd (a real worktree here).
    expect(raw).toMatch(/generated_from_sha:/);

    const results = await searchKnowledge(store.db, PROJECT_ID, "monitored learned", null);
    expect(results.find((r) => r.slug === "monitored-learned")).toBeUndefined();

    store.close();
  });

  test("rejects a caller with no resolvable session at all", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    // No session row is created and cwd matches nothing — resolveCallingSession
    // returns null, the one remaining hard rejection.
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: randomUUID(),
        cwd: "/tmp/not-a-session",
        slug: "sneaky",
        title: "Sneaky",
        body: "Should never land.",
      }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/no active session/i);

    // Nothing should have been written to disk at all.
    await expect(readdir(join(knowledgeDir, PROJECT_ID, ".drafts"))).rejects.toThrow();

    store.close();
  });

  test("accepts a session inside a running ordinary (non-bootstrap) launch and writes an agent draft", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    const launch = createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "ordinary work",
      worktreePath: worktree,
      branch: "standup/ordinary",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "learned-thing",
        title: "Learned Thing",
        body: "An ordinary launch, steered to contribute back, proposes this draft.",
        request_human_review: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(launch.kind).toBe("worktree"); // sanity: fixture is what it claims

    // It lands as a draft (for human review), stamped with the launch and the
    // 'agent' trust class — never as an accepted, searchable doc.
    const draftPath = join(knowledgeDir, PROJECT_ID, ".drafts", "learned-thing.md");
    const raw = await readFile(draftPath, "utf-8");
    expect(raw).toContain("proposes this draft");
    expect(raw).toMatch(/generated_by_launch_id: ?["']?/);
    expect(raw).toMatch(/origin_class: ?["']?agent/);
    // An agent proposal that names no kind is stamped 'unclassified', at the
    // unverified starting confidence with no verification stamp (nothing has
    // checked it yet), and the default half-life — so the fields carry through
    // the accept rename onto the doc.
    expect(raw).toMatch(/source_kind: ?["']?unclassified/);
    expect(raw).toMatch(/confidence: ?0\.6/);
    expect(raw).toMatch(/half_life_days: ?90/);
    expect(raw).not.toMatch(/last_verified_at/);

    const results = await searchKnowledge(store.db, PROJECT_ID, "learned thing", null);
    expect(results.find((r) => r.slug === "learned-thing")).toBeUndefined();

    store.close();
  });

  test("matches a launch stored under a symlinked path against a realpath cwd (no silent 403)", async () => {
    // The launch's worktree_path is recorded from the configured worktree root
    // (which may be a symlink, e.g. ~/work -> /Volumes/work),
    // while the session reports its cwd as the OS-resolved realpath. A literal
    // compare would treat those as different trees and 403 the contribute-back
    // call; findLaunchByCwd canonicalizes both sides, so the same directory
    // reached through a symlink still matches.
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    const realWorktree = realpathSync(await tempGitWorktree());
    cleanupDirs.push(realWorktree);
    const linkDir = await mkdtemp(join(tmpdir(), "standup-symlink-"));
    cleanupDirs.push(linkDir);
    const symlinkedWorktree = join(linkDir, "worktree");
    await symlink(realWorktree, symlinkedWorktree);

    // Launch is stored under the SYMLINK path; the session's cwd is the REALPATH
    // — textually different, same directory.
    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "ordinary work on a symlinked mount",
      worktreePath: symlinkedWorktree,
      branch: "standup/symlinked",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: realWorktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: realWorktree,
        slug: "symlink-thing",
        title: "Symlink Thing",
        body: "A launch reached through a symlinked worktree root still contributes back.",
        request_human_review: true,
      }),
    });

    expect(res.status).toBe(200);
    const draftPath = join(knowledgeDir, PROJECT_ID, ".drafts", "symlink-thing.md");
    const raw = await readFile(draftPath, "utf-8");
    expect(raw).toContain("contributes back");
    expect(raw).toMatch(/origin_class: ?["']?agent/);

    store.close();
  });

  test("accepts a session inside a running bootstrap launch and writes a draft", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "bootstrap",
      projectId: PROJECT_ID,
      task: "bootstrap knowledge",
      worktreePath: worktree,
      branch: "standup/bootstrap",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const app = serverWith(
      store,
      (msg) => {
        broadcasts.push(msg as { type: string; payload: Record<string, unknown> });
      },
      knowledgeSync,
      knowledgeDir
    );

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "toolchain",
        title: "Toolchain",
        body: "Run `bun test` to run the whole suite.",
        tags: ["setup"],
        request_human_review: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; slug: string; nearest: unknown[] };
    expect(json).toEqual({ ok: true, slug: "toolchain", nearest: [] });

    // The file landed in .drafts/, not as an accepted doc.
    const draftPath = join(knowledgeDir, PROJECT_ID, ".drafts", "toolchain.md");
    const raw = await readFile(draftPath, "utf-8");
    expect(raw).toContain("Run `bun test`");
    expect(raw).toMatch(/generated_from_sha:/);
    expect(raw).toMatch(/generated_by_launch_id: ?["']?/);

    // The collector stamped a real sha from the worktree, not something the
    // (nonexistent, in this test) agent supplied.
    const headSha = (
      await new Response(
        Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: worktree, stdout: "pipe" }).stdout
      ).text()
    ).trim();
    expect(raw).toContain(headSha);

    // The row is indexed as a pending draft.
    expect(broadcasts.some((m) => m.type === "knowledge:draft")).toBe(true);

    // A proposal is a substantive knowledge-graph change, so it also lands on the
    // proposing session as a self-reported checkpoint — the one pipe both the web
    // feed and Slack's feedLine read — where it surfaces in the curated feed
    // (persisted, not a live-only nudge) rather than only bumping the Knowledge tab.
    const proposeCheckpoint = broadcasts.find(
      (m) =>
        m.type === "checkpoint:new" &&
        (m.payload as { source?: string }).source === "self-reported" &&
        String((m.payload as { summary?: string }).summary).includes("📚 Proposed knowledge")
    );
    expect(proposeCheckpoint).toBeDefined();
    expect((proposeCheckpoint!.payload as { sessionId: string }).sessionId).toBe(sessionId);
    expect((proposeCheckpoint!.payload as { summary: string }).summary).toContain("Toolchain");

    // Never reachable through search_knowledge — knowledge_drafts has no FTS
    // table and searchKnowledge never queries it (see store.ts's
    // ensureTables comment), but assert it rather than trust the absence of
    // a code path, per phase-7.md's instruction to test this, not reason
    // about it.
    const results = await searchKnowledge(store.db, PROJECT_ID, "toolchain bun test", null);
    expect(results.find((r) => r.slug === "toolchain")).toBeUndefined();

    store.close();
  });

  test("flags a proposal whose slug already names an accepted doc as a regenerate (replaces_slug), from ground truth not the index", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "regenerate an existing doc",
      worktreePath: worktree,
      branch: "standup/regen",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    // A human-authored accepted doc is on disk (ground truth) but never synced
    // into the SQLite index — the staleness the guard must survive (a post-boot
    // or externally-created doc). If the handler consulted the index instead of
    // ground truth it would miss this and drop replaces_slug, letting accept
    // later clobber the human's doc.
    await writeKnowledgeFile(knowledgeDir, PROJECT_ID, {
      slug: "architecture",
      title: "Architecture",
      body: "The human-authored accepted doc that must not be silently overwritten.",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "architecture",
        title: "Architecture",
        body: "A regenerated take on the architecture doc.",
        request_human_review: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; slug: string; nearest: unknown[] };
    expect(json).toEqual({ ok: true, slug: "architecture", nearest: [] });

    // The draft carries replaces_slug, the data-loss gate that makes accept
    // merge rather than silently overwrite the accepted doc.
    const draftPath = join(knowledgeDir, PROJECT_ID, ".drafts", "architecture.md");
    const raw = await readFile(draftPath, "utf-8");
    expect(raw).toContain("regenerated take");
    expect(raw).toMatch(/replaces_slug: ?["']?architecture/);

    // The accepted doc on disk is untouched — a proposal only ever writes a draft.
    const accepted = await readFile(join(knowledgeDir, PROJECT_ID, "architecture.md"), "utf-8");
    expect(accepted).toContain("must not be silently overwritten");

    store.close();
  });

  test("leaves replaces_slug unset for a first-time proposal (no accepted doc on disk)", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "first-time proposal",
      worktreePath: worktree,
      branch: "standup/first",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "brand-new",
        title: "Brand New",
        body: "No accepted doc with this slug exists yet.",
        request_human_review: true,
      }),
    });

    expect(res.status).toBe(200);
    const raw = await readFile(join(knowledgeDir, PROJECT_ID, ".drafts", "brand-new.md"), "utf-8");
    expect(raw).not.toMatch(/replaces_slug/);

    store.close();
  });

  test("honors an explicit source_kind (product/spec) so a proposer can land a product doc, and rejects a bogus one back to unclassified", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "land a spec the agent read",
      worktreePath: worktree,
      branch: "standup/spec",
      status: "running",
    });
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    // A valid product/spec value is stamped — this is the production path that
    // lets product-knowledge injection (roadmap r8) reach a non-empty corpus.
    const ok = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "checkout-spec",
        title: "Checkout spec",
        body: "Guest checkout must be supported.",
        source_kind: "spec",
        request_human_review: true,
      }),
    });
    expect(ok.status).toBe(200);
    const specRaw = await readFile(
      join(knowledgeDir, PROJECT_ID, ".drafts", "checkout-spec.md"),
      "utf-8"
    );
    expect(specRaw).toMatch(/source_kind: ?["']?spec/);

    // A bogus value never lands in the corpus — it falls back to the code default.
    const bogus = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "bogus-kind",
        title: "Bogus kind",
        body: "The source_kind here is not a real kind.",
        source_kind: "marketing",
        request_human_review: true,
      }),
    });
    expect(bogus.status).toBe(200);
    const bogusRaw = await readFile(
      join(knowledgeDir, PROJECT_ID, ".drafts", "bogus-kind.md"),
      "utf-8"
    );
    expect(bogusRaw).toMatch(/source_kind: ?["']?unclassified/);

    store.close();
  });

  test("a finished (status != running) launch no longer counts, but the session rescues the proposal", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "bootstrap",
      projectId: PROJECT_ID,
      task: "bootstrap knowledge",
      worktreePath: worktree,
      branch: "standup/bootstrap",
      status: "cleaned",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "late",
        title: "Late",
        body: "Lands via the session after the launch was cleaned up.",
        request_human_review: true,
      }),
    });

    // findLaunchByCwd excludes status = 'cleaned' outright, so there is no
    // running launch — but the tracked session now carries the proposal, so
    // instead of a 403 the draft lands, attributed to the session with no launch id.
    expect(res.status).toBe(200);
    const raw = await readFile(join(knowledgeDir, PROJECT_ID, ".drafts", "late.md"), "utf-8");
    expect(raw).toContain("after the launch was cleaned up");
    expect(raw).not.toMatch(/generated_by_launch_id: ?["']?\S/);

    store.close();
  });

  test("routes a draft to an explicit cross-project target, and 404s an unknown one", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    // A second registered project B — the caller's session is in PROJECT_ID (A).
    const PROJECT_B = `propose-target-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, {
      id: PROJECT_B,
      name: "Target Project B",
      branch: "main",
      repos: [],
    });

    const launch = createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "contribute knowledge about another project",
      worktreePath: worktree,
      branch: "standup/cross",
      status: "running",
    });
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    // Target B explicitly: the draft must land in B's drafts, not A's, while
    // provenance still attributes the caller's launch/session.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        project: PROJECT_B,
        slug: "cross-doc",
        title: "Cross Doc",
        body: "Knowledge about project B, contributed from a session in project A.",
        request_human_review: true,
      }),
    });
    expect(res.status).toBe(200);

    const bDraft = await readFile(join(knowledgeDir, PROJECT_B, ".drafts", "cross-doc.md"), "utf-8");
    expect(bDraft).toContain("Knowledge about project B");
    expect(bDraft).toMatch(new RegExp(`generated_by_launch_id: ?["']?${launch.id}`));
    // It did NOT land in the caller's own project A.
    await expect(readFile(join(knowledgeDir, PROJECT_ID, ".drafts", "cross-doc.md"), "utf-8")).rejects.toThrow();

    // An unknown target project is a 404.
    const unknown = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        project: "no-such-project",
        slug: "orphan",
        title: "Orphan",
        body: "Targets a project that does not exist.",
      }),
    });
    expect(unknown.status).toBe(404);

    // An empty-string project is treated as omitted (not as a present-but-blank
    // id): it must NOT slip past the unknown-project 404 into an orphan draft at
    // the knowledge root, and must default to the caller's own project A.
    const emptyProject = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        project: "   ",
        slug: "empty-project-doc",
        title: "Empty Project Doc",
        body: "A blank project param must default to the caller's project, not orphan.",
        request_human_review: true,
      }),
    });
    expect(emptyProject.status).toBe(200);
    // Landed in the caller's own project A, attributed to the caller's launch.
    const aDraft = await readFile(
      join(knowledgeDir, PROJECT_ID, ".drafts", "empty-project-doc.md"),
      "utf-8"
    );
    expect(aDraft).toContain("must default to the caller's project");
    // NOT orphaned at the knowledge root under an empty project id.
    await expect(
      readFile(join(knowledgeDir, ".drafts", "empty-project-doc.md"), "utf-8")
    ).rejects.toThrow();

    store.close();
  });
});

/**
 * Provenance/scope on propose (Item 5). A proposal with no explicit scope takes
 * the project's default (its knowledge_scope override, else the account setting,
 * else 'project'); an explicit scope overrides it; scope='user' stamps the owner
 * from the SERVER-RESOLVED identity, never a client field; an invalid scope is
 * rejected. These read the DRAFT frontmatter (request_human_review: true), where
 * scope/owner are stamped and carried through accept.
 */
describe("POST /api/knowledge/propose — scope + owner", () => {
  async function proposeDraft(
    knowledgeScope: "global" | "project" | undefined,
    proposeBody: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; draft: string; store: Store; knowledgeDir: string }> {
    const store = setUpStore();
    if (knowledgeScope) {
      upsertProject(store.db, {
        id: PROJECT_ID,
        name: "Propose Test",
        branch: "main",
        repos: [],
        knowledgeScope,
      });
    }
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const slug = (proposeBody.slug as string) ?? "scoped-doc";
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug,
        title: "Scoped Doc",
        body: "A doc whose scope is under test.",
        request_human_review: true,
        ...proposeBody,
      }),
    });

    let draft = "";
    try {
      draft = await readFile(join(knowledgeDir, PROJECT_ID, ".drafts", `${slug}.md`), "utf-8");
    } catch {
      /* a rejected propose writes nothing */
    }
    return { status: res.status, draft, store, knowledgeDir };
  }

  test("no explicit scope takes the project's knowledge_scope default", async () => {
    const { status, draft, store } = await proposeDraft("global", { slug: "defaults-global" });
    expect(status).toBe(200);
    expect(draft).toMatch(/scope: ?["']?global/);
    store.close();
  });

  test("no explicit scope on a plain project falls back to 'project'", async () => {
    const { status, draft, store } = await proposeDraft(undefined, { slug: "defaults-project" });
    expect(status).toBe(200);
    expect(draft).toMatch(/scope: ?["']?project/);
    store.close();
  });

  test("an explicit scope overrides the project default", async () => {
    // Project default is 'global', but the proposal explicitly asks for 'project'.
    const { status, draft, store } = await proposeDraft("global", {
      slug: "explicit-project",
      scope: "project",
    });
    expect(status).toBe(200);
    expect(draft).toMatch(/scope: ?["']?project/);
    store.close();
  });

  test("a proposal asking for scope='user' is refused and nothing is written", async () => {
    const { status, draft, store } = await proposeDraft(
      undefined,
      { slug: "my-note", scope: "user", owner_user: "mallory" },
      { [DEFAULT_IDENTITY_HEADER]: "alice" }
    );
    expect(status).toBe(400);
    expect(draft).toBe("");
    store.close();
  });

  test("an invalid scope is rejected and nothing is written", async () => {
    const { status, draft, store } = await proposeDraft(undefined, {
      slug: "bad-scope",
      scope: "everyone",
    });
    expect(status).toBe(400);
    expect(draft).toBe("");
    store.close();
  });
});

/**
 * The auto-accept default (the behavior change): with no request_human_review
 * flag, a proposal is published immediately as an accepted, searchable doc — the
 * same end state as a human accepting a draft — reusing the shared publishDraft
 * accept path. request_human_review: true opts back into the legacy draft-for-
 * review behavior.
 */
describe("POST /api/knowledge/propose — auto-accept default (publish on propose)", () => {
  test("publishes immediately by default: an accepted, searchable doc (not a draft), with agent provenance", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });
    // The launch resolves to this session so the accepted feed change is
    // attributed to it (publishDraft reads launch.sessionId).
    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "contribute knowledge",
      worktreePath: worktree,
      branch: "standup/auto",
      status: "running",
      sessionId,
    });

    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const app = serverWith(
      store,
      (msg) => broadcasts.push(msg as { type: string; payload: Record<string, unknown> }),
      knowledgeSync,
      knowledgeDir
    );

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "auto-published",
        title: "Auto Published",
        body: "This proposal is auto-accepted and becomes searchable immediately.",
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      slug: string;
      published?: boolean;
      mode?: string;
      verification?: string;
      nearest?: unknown[];
    };
    expect(json).toEqual({
      ok: true,
      slug: "auto-published",
      published: true,
      mode: "accept",
      verification: "pending",
      nearest: [],
    });

    // It landed as an ACCEPTED doc, not a draft.
    const accepted = await readFile(
      join(knowledgeDir, PROJECT_ID, "auto-published.md"),
      "utf-8"
    );
    expect(accepted).toContain("auto-accepted and becomes searchable");
    // Provenance carried through the accept: agent-authored, unclassified (no
    // kind was proposed), unverified confidence with the default half-life.
    expect(accepted).toMatch(/origin_class: ?["']?agent/);
    expect(accepted).toMatch(/source_kind: ?["']?unclassified/);
    expect(accepted).toMatch(/confidence: ?0\.6/);
    expect(accepted).toMatch(/half_life_days: ?90/);
    // No draft left behind.
    await expect(
      readFile(join(knowledgeDir, PROJECT_ID, ".drafts", "auto-published.md"), "utf-8")
    ).rejects.toThrow();

    // It IS reachable through search now (the point of publishing).
    const results = await searchKnowledge(store.db, PROJECT_ID, "auto-accepted searchable", null);
    expect(results.find((r) => r.slug === "auto-published")).toBeDefined();

    // Surfaced on the feed: an `accepted` knowledge:change attributed to the
    // authoring session, plus a "📚 Published knowledge" checkpoint on the caller.
    const change = broadcasts.find(
      (m) => m.type === "knowledge:change" && (m.payload as { kind?: string }).kind === "accepted"
    );
    expect(change).toBeDefined();
    expect((change!.payload as { sessionId?: string }).sessionId).toBe(sessionId);
    const published = broadcasts.find(
      (m) =>
        m.type === "checkpoint:new" &&
        String((m.payload as { summary?: string }).summary).includes("📚 Published knowledge")
    );
    expect(published).toBeDefined();
    expect((published!.payload as { summary: string }).summary).toContain("Auto Published");

    store.close();
  });

  test("request_human_review: true keeps it a draft, out of search (the escape hatch)", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "propose for review",
      worktreePath: worktree,
      branch: "standup/review",
      status: "running",
    });
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "held-for-review",
        title: "Held For Review",
        body: "This one asked for a human to vet it first.",
        request_human_review: true,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; slug: string; published?: boolean; nearest?: unknown[] };
    // The draft path returns the plain shape (no published flag).
    expect(json).toEqual({ ok: true, slug: "held-for-review", nearest: [] });

    // It's a DRAFT, not an accepted doc, and never searchable until a human accepts.
    const draft = await readFile(
      join(knowledgeDir, PROJECT_ID, ".drafts", "held-for-review.md"),
      "utf-8"
    );
    expect(draft).toContain("asked for a human to vet it");
    await expect(
      readFile(join(knowledgeDir, PROJECT_ID, "held-for-review.md"), "utf-8")
    ).rejects.toThrow();
    const results = await searchKnowledge(store.db, PROJECT_ID, "human vet first", null);
    expect(results.find((r) => r.slug === "held-for-review")).toBeUndefined();

    store.close();
  });

  test("a default proposal whose slug already names an accepted doc publishes as a replace", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "regenerate and auto-publish",
      worktreePath: worktree,
      branch: "standup/replace",
      status: "running",
    });
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    // An accepted doc already exists at this slug (ground truth on disk).
    await writeKnowledgeFile(knowledgeDir, PROJECT_ID, {
      slug: "runbook",
      title: "Runbook",
      body: "the older accepted version",
      // This session's own agent doc: a same-slug proposal updates it (an owner
      // doc, or another session's, is refused).
      originClass: "agent",
      sourceSessionId: sessionId,
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "runbook",
        title: "Runbook",
        body: "the regenerated version that supersedes it",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { published?: boolean; mode?: string };
    expect(json.published).toBe(true);
    expect(json.mode).toBe("replace");

    // The accepted doc now carries the regenerated body, and no draft remains.
    const doc = await readFile(join(knowledgeDir, PROJECT_ID, "runbook.md"), "utf-8");
    expect(doc).toContain("regenerated version that supersedes it");
    await expect(
      readFile(join(knowledgeDir, PROJECT_ID, ".drafts", "runbook.md"), "utf-8")
    ).rejects.toThrow();

    store.close();
  });
});

/**
 * The audience gate on the create/propose path — the sibling of the PUT edit
 * route's mayChangeAudience gate. scope/owner_user decide a doc's RETRIEVAL
 * AUDIENCE (a 'global' doc injects into every project's agents, a 'user' doc into
 * its owner's window alone). Standup runs for a single trusted team behind an
 * authenticating tunnel, which AUTHENTICATES the caller — the identity header is
 * tunnel-guaranteed, not forgeable — so an
 * authenticated teammate authors and scopes their own knowledge (including
 * scope='user' owned by themselves and corpus-wide scope='global') with NO
 * operator token; scope/owner is a soft team routing boundary, not a hard wall.
 * The out-of-band write token is only a fallback when there is NO authenticated
 * identity (a raw non-tunnel bind); cross-user re-aiming is blocked by the
 * trustworthy acting===owner hygiene check (a caller editing another user's doc
 * preserves its owner/scope), not by the token.
 */
describe("POST /api/knowledge/propose — audience authoring in multiplayer (authenticated identity suffices)", () => {
  // The gate reads STANDUP_WRITE_TOKEN / STANDUP_BIND_HOST live per request; a
  // stray token/bind from the ambient env would confuse the no-token cases, so pin
  // them off and restore after.
  let savedToken: string | undefined;
  let savedBind: string | undefined;
  beforeEach(() => {
    savedToken = process.env.STANDUP_WRITE_TOKEN;
    savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
    else process.env.STANDUP_WRITE_TOKEN = savedToken;
    if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
    else process.env.STANDUP_BIND_HOST = savedBind;
  });

  // Two distinct tunnel identities → multiplayer, the deployment this feature
  // targets; the authenticating tunnel authenticates each teammate, so an authenticated
  // caller may author + scope their own knowledge with no token.
  async function seedMultiplayer(): Promise<{
    store: Store;
    knowledgeDir: string;
    worktree: string;
    sessionId: string;
    app: ReturnType<typeof createServer>;
  }> {
    const store = setUpStore();
    // The reserved GLOBAL corpus exists as a targetable project (auto-ensured on
    // boot in production), so the `project: "global"` home-guard cases can target
    // it — mirroring the real deployment where getProject('global') always resolves.
    upsertProject(store.db, {
      id: GLOBAL_PROJECT_ID,
      name: "Global",
      branch: "main",
      repos: [],
      reserved: true,
    });
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    return { store, knowledgeDir, worktree, sessionId, app };
  }

  test("an authenticated caller proposing a NEW scope='user' doc is refused (no token)", async () => {
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    // alice owns this tracked session and her tunnel identity is authenticated,
    // but a scope='user' doc is in the personal layer, which only Persona writes.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "alice" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "alice-user-note",
        title: "Alice Note",
        body: "alice's personal note",
        scope: "user",
        owner_user: "mallory",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("personal layer");

    // Nothing was written: no accepted doc and no draft.
    expect(await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID)).toHaveLength(0);
    expect(await new KnowledgeLoader(knowledgeDir).loadDrafts(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("an authenticated caller auto-publishing a NEW scope='global' doc lands it global (no token)", async () => {
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    // An explicit scope='global' on a brand-new doc is a desired corpus-wide
    // contribution; an authenticated teammate makes it directly.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "team-global",
        title: "Team Global",
        body: "corpus-wide payload",
        scope: "global",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true });

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.body).toContain("corpus-wide payload");
    expect(loaded.scope).toBe("global");
    expect(loaded.ownerUser).toBeUndefined();

    store.close();
  });

  test("an authenticated caller MAY HOME a NEW doc in the GLOBAL corpus via project:\"global\" (no token)", async () => {
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    // A doc homed under project_id='global' reaches EVERY project (scopeAudienceSql's
    // reserved-corpus disjunct) — a desired team-wide contribution an authenticated
    // teammate makes directly.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "team-home-global",
        title: "Team Home Global",
        body: "corpus-wide payload via home",
        project: "global",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true });

    // It landed in the reserved GLOBAL corpus, not the caller's own project.
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(GLOBAL_PROJECT_ID);
    expect(loaded.slug).toBe("team-home-global");
    expect(loaded.body).toContain("corpus-wide payload via home");
    expect(loaded.projectId).toBe(GLOBAL_PROJECT_ID);
    expect(await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("homing a doc in the GLOBAL corpus via project:\"global\" also works with a token present", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    // The token isn't required — the authenticated identity already authorizes the
    // global home — and presenting it changes nothing.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "op-home-global",
        title: "Op Home Global",
        body: "intentionally corpus-wide via home",
        project: "global",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true });

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(GLOBAL_PROJECT_ID);
    expect(loaded.slug).toBe("op-home-global");
    expect(loaded.body).toContain("intentionally corpus-wide via home");
    expect(loaded.projectId).toBe(GLOBAL_PROJECT_ID);
    expect(await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("a replace by a DIFFERENT teammate of an existing scope='user' doc is refused", async () => {
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    // An accepted scope='user' doc owned by alice already exists on disk.
    await writeKnowledgeFile(knowledgeDir, PROJECT_ID, {
      slug: "alice-note",
      title: "Alice Note",
      body: "alice's original private note",
      scope: "user",
      ownerUser: "alice",
      sourceKind: "code",
      originClass: "agent",
    });

    // bob proposes a replace, requesting a WIDEN to global. alice's doc is in the
    // personal layer, so the proposal is refused before anything is written.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "alice-note",
        title: "Alice Note",
        body: "bob's replacement body",
        scope: "global",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("personal layer");

    // alice's doc is as it was: body, scope and owner.
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.slug).toBe("alice-note");
    expect(loaded.body).toBe("alice's original private note");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");
    expect(await new KnowledgeLoader(knowledgeDir).loadDrafts(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("a NEW scope='user' doc is refused with a token present too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    // A write token does not open the personal layer.
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "alice",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "op-user",
        title: "Op User",
        body: "an intentionally personal note",
        scope: "user",
        owner_user: "mallory",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("personal layer");

    // Nothing was written: no accepted doc and no draft.
    expect(await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID)).toHaveLength(0);
    expect(await new KnowledgeLoader(knowledgeDir).loadDrafts(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("a NEW scope='global' doc lands global with a token present too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const { store, knowledgeDir, worktree, sessionId, app } = await seedMultiplayer();

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "op-global",
        title: "Op Global",
        body: "intentionally corpus-wide",
        scope: "global",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true });

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.scope).toBe("global");

    store.close();
  });

  test("a loopback authenticated caller auto-publishes a global doc even with a network-exposed bind", async () => {
    // The bind is network-exposed (STANDUP_BIND_HOST=0.0.0.0), but the in-process
    // caller's source is loopback, so its identity is authenticated and the audience
    // write applies. Audience trust is the tunnel identity, not the bind host; the
    // genuine no-identity fallback is exercised in knowledge-edit-scope's unit tests.
    process.env.STANDUP_BIND_HOST = "0.0.0.0";
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "alice" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "lan-global",
        title: "LAN Global",
        body: "authenticated corpus-wide payload",
        scope: "global",
      }),
    });
    expect(res.status).toBe(200);

    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.body).toContain("authenticated corpus-wide payload");
    expect(loaded.scope).toBe("global");

    store.close();
  });
});

/**
 * The propose create/replace path and the PUT edit path resolve scope/owner
 * through ONE shared choke point (resolveAuthoredAudience), so both agree on the
 * audience of a replace. These pin the behavior that only the centralized helper
 * gives the propose path: a replace with no explicit scope PRESERVES an existing
 * owned 'user' doc's audience (a regenerate is not an audience change); the OWNER
 * may explicitly widen their own doc; and a DIFFERENT teammate can neither reassign
 * nor widen it (data hygiene) — the same rules the PUT route enforces. An owned
 * 'user' doc is in the personal layer, which only Persona writes, so a proposal
 * that would replace one is refused outright, whoever proposes it.
 */
describe("POST /api/knowledge/propose — shared audience helper on replace", () => {
  let savedToken: string | undefined;
  let savedBind: string | undefined;
  beforeEach(() => {
    savedToken = process.env.STANDUP_WRITE_TOKEN;
    savedBind = process.env.STANDUP_BIND_HOST;
    delete process.env.STANDUP_WRITE_TOKEN;
    delete process.env.STANDUP_BIND_HOST;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.STANDUP_WRITE_TOKEN;
    else process.env.STANDUP_WRITE_TOKEN = savedToken;
    if (savedBind === undefined) delete process.env.STANDUP_BIND_HOST;
    else process.env.STANDUP_BIND_HOST = savedBind;
  });

  test("a replace with no explicit scope of an owned 'user' doc is refused", async () => {
    // Single-user loopback (no tunnel users) → the local operator is authorized to
    // change audiences, yet a regenerate of alice's personal doc is refused: the
    // personal layer is written only by Persona.
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    await writeKnowledgeFile(knowledgeDir, PROJECT_ID, {
      slug: "alice-note",
      title: "Alice Note",
      body: "alice's original private note",
      scope: "user",
      ownerUser: "alice",
      sourceKind: "code",
      originClass: "agent",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "alice-note",
        title: "Alice Note",
        body: "alice's regenerated private note",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("personal layer");

    // alice's doc is as it was: body, scope and owner.
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.slug).toBe("alice-note");
    expect(loaded.body).toBe("alice's original private note");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");
    expect(await new KnowledgeLoader(knowledgeDir).loadDrafts(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("the OWNER's own replace of their 'user' doc is refused too (no token)", async () => {
    const store = setUpStore();
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    await writeKnowledgeFile(knowledgeDir, PROJECT_ID, {
      slug: "alice-note",
      title: "Alice Note",
      body: "alice's original private note",
      scope: "user",
      ownerUser: "alice",
      sourceKind: "code",
      originClass: "agent",
    });

    // alice IS the owner and her tunnel identity is authenticated, yet a replace of
    // her personal doc through propose is refused: only Persona writes there.
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "alice" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "alice-note",
        title: "Alice Note",
        body: "promoted to the whole corpus",
        scope: "global",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("personal layer");

    // alice's doc is as it was: body, scope and owner.
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.slug).toBe("alice-note");
    expect(loaded.body).toBe("alice's original private note");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");
    expect(await new KnowledgeLoader(knowledgeDir).loadDrafts(PROJECT_ID)).toHaveLength(0);

    store.close();
  });

  test("a DIFFERENT teammate's replace of an owned 'user' doc is refused with a write token too", async () => {
    process.env.STANDUP_WRITE_TOKEN = "s3cret";
    const store = setUpStore();
    touchUser(store.db, "alice", { viaTunnel: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    await writeKnowledgeFile(knowledgeDir, PROJECT_ID, {
      slug: "alice-note",
      title: "Alice Note",
      body: "alice's original private note",
      scope: "user",
      ownerUser: "alice",
      sourceKind: "code",
      originClass: "agent",
    });

    // bob presents a matching operator token but is NOT the owner; the token does
    // not open the personal layer, so the replace is refused.
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEFAULT_IDENTITY_HEADER]: "bob",
        "x-standup-write-token": "s3cret",
      },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "alice-note",
        title: "Alice Note",
        body: "bob's replacement body",
        scope: "global",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("personal layer");

    // alice's doc is as it was: body, scope and owner.
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.slug).toBe("alice-note");
    expect(loaded.body).toBe("alice's original private note");
    expect(loaded.scope).toBe("user");
    expect(loaded.ownerUser).toBe("alice");
    expect(await new KnowledgeLoader(knowledgeDir).loadDrafts(PROJECT_ID)).toHaveLength(0);

    store.close();
  });
});

/**
 * Dead path-pointer warnings (non-fatal). A doc that embeds a filesystem path
 * pointing at a fallback ("canonical full doc in-repo: …", or an absolute macOS
 * path) is only useful if the path resolves — a foreign-machine /Volumes//Users
 * path never does, and a repo-relative path that isn't present under the worktree
 * is dead too. Propose does not BLOCK on these; it returns a `warnings` array so
 * the agent learns the pointer it stored is unusable. Detection is conservative:
 * a repo-relative pointer that DOES resolve, and prose that merely contains a
 * slash, produce no warning.
 */
describe("POST /api/knowledge/propose — dead path-pointer warnings", () => {
  async function proposeWithBody(
    body: string,
    seedFile?: { relPath: string; contents: string }
  ): Promise<{ warnings?: string[]; store: Store }> {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    if (seedFile) {
      await Bun.write(join(worktree, seedFile.relPath), seedFile.contents);
    }

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: `pointer-doc-${randomUUID().slice(0, 8)}`,
        title: "Pointer Doc",
        body,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { warnings?: string[] };
    return { warnings: json.warnings, store };
  }

  test("a body with a /Volumes/... foreign-machine pointer yields a warning", async () => {
    const { warnings, store } = await proposeWithBody(
      "Background context. Canonical full doc in-repo: /Volumes/work/notes/design.md — read it for detail."
    );
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("/Volumes/work/notes/design.md"))).toBe(true);
    store.close();
  });

  test("a repo-relative pointer that resolves under the worktree yields no warning", async () => {
    const { warnings, store } = await proposeWithBody(
      "See docs/architecture.md for the full write-up.",
      { relPath: "docs/architecture.md", contents: "# Architecture\n" }
    );
    expect(warnings).toBeUndefined();
    store.close();
  });

  test("a repo-relative pointer that does NOT resolve under the worktree yields a warning", async () => {
    const { warnings, store } = await proposeWithBody(
      "The details live in src/ghost/module.ts, which no longer exists."
    );
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("src/ghost/module.ts"))).toBe(true);
    store.close();
  });

  test.each([
    "packages/web/src/App.tsx",
    "packages/web/src/Widget.jsx",
    "packages/web/package.json",
    "docs/guides/intro.mdx",
  ])("a resolving pointer to %s is matched whole and yields no warning", async (relPath) => {
    const { warnings, store } = await proposeWithBody(
      `The entry point is ${relPath}, which wires the rest together.`,
      { relPath, contents: "content\n" }
    );
    expect(warnings).toBeUndefined();
    store.close();
  });

  test("a missing .tsx pointer is warned about under its full name, not a truncated .ts", async () => {
    const { warnings, store } = await proposeWithBody(
      "The details live in src/ghost/App.tsx, which no longer exists."
    );
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("src/ghost/App.tsx"))).toBe(true);
    expect(warnings!.some((w) => w.includes("App.ts'"))).toBe(false);
    store.close();
  });

  test("prose that merely contains slashes is not flagged", async () => {
    const { warnings, store } = await proposeWithBody(
      "Prefer search_knowledge/get_knowledge_doc, and handle the and/or case in the retry path."
    );
    expect(warnings).toBeUndefined();
    store.close();
  });

  test("a not-yet-merged claim that names no branch is asked to name it", async () => {
    const { warnings, store } = await proposeWithBody(
      "The retry queue drains failed Slack posts every minute. The retry queue change is not yet merged."
    );
    expect(warnings).toContain(UNNAMED_UNMERGED_WARNING);
    store.close();
  });

  test("a not-yet-merged claim that names its branch is not warned about", async () => {
    const { warnings, store } = await proposeWithBody(
      "The retry queue drains failed Slack posts every minute. The retry queue change is on branch `feat/retry-queue`, not yet merged."
    );
    expect(warnings ?? []).not.toContain(UNNAMED_UNMERGED_WARNING);
    store.close();
  });
});

/**
 * Status-note guard: a title that reads as a status note (a review id, merge or
 * deploy state, a validation claim, a dated parenthetical) is refused with a
 * fix-it message; a body carrying two or more such markers is accepted with a
 * warning.
 */
describe("POST /api/knowledge/propose — status-note guard", () => {
  async function propose(title: string, body: string): Promise<{ status: number; json: { error?: string; warnings?: string[] }; store: Store }> {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: PROJECT_ID, title: "", cwd: worktree, status: "running" });

    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: worktree, slug: `status-doc-${randomUUID().slice(0, 8)}`, title, body }),
    });
    return { status: res.status, json: (await res.json()) as { error?: string; warnings?: string[] }, store };
  }

  test("a title with a review id is refused with a fix-it message", async () => {
    const { status, json, store } = await propose("Retry fix in review REV-1234567", "The retry loop backs off exponentially.");
    expect(status).toBe(400);
    expect(json.error).toContain("title reads as a status note");
    expect(json.error).toContain('"REV-1234567"');
    store.close();
  });

  test("a title with a dated parenthetical is refused", async () => {
    const { status, store } = await propose("Cache invalidation (proposed 2026-10-06)", "Invalidate on write.");
    expect(status).toBe(400);
    store.close();
  });

  test("an ordinary title is accepted without a status warning", async () => {
    const { status, json, store } = await propose("Deploy order: CMK before IAM", "Create the CMK before the IAM role that references it.");
    expect(status).toBe(200);
    expect(json.warnings).toBeUndefined();
    store.close();
  });

  test("a body with two status markers is refused with a fix-it message", async () => {
    const { status, json, store } = await propose(
      "Retry backoff in the sync client",
      "The client backs off exponentially. DEPLOYED to beta; all tests pass at 3f9a2c1."
    );
    expect(status).toBe(400);
    expect(json.error).toContain("reads as a status report");
    expect(json.error).toContain('"DEPLOYED"');
    store.close();
  });

  test("a body with one status marker is accepted with a warning", async () => {
    const { status, json, store } = await propose(
      "Retry backoff in the sync client",
      "The client backs off exponentially; the change landed in REV-1234567."
    );
    expect(status).toBe(200);
    expect(json.warnings?.some((w) => w.includes("a status marker"))).toBe(true);
    store.close();
  });
});

describe("POST /api/knowledge/propose — scratch-homed global and secret redaction", () => {
  async function seedSession(projectId: string) {
    const store = setUpStore();
    upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId, title: "", cwd: worktree, status: "running" });
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const propose = (body: Record<string, unknown>) =>
      app.request("/api/knowledge/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, cwd: worktree, ...body }),
      });
    return { store, knowledgeDir, propose };
  }

  test("a scope=global proposal homed in scratch is refused with a pointer to `project`", async () => {
    const { store, knowledgeDir, propose } = await seedSession("scratch");
    const res = await propose({ slug: "unanchored", title: "Unanchored", body: "a broad claim", scope: "global" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("`project`");
    expect(await new KnowledgeLoader(knowledgeDir).loadProject("scratch")).toHaveLength(0);
    store.close();
  });

  test("the same session may land scope=global once it names a target project", async () => {
    const { store, knowledgeDir, propose } = await seedSession("scratch");
    const res = await propose({
      slug: "anchored",
      title: "Anchored",
      body: "a broad claim",
      scope: "global",
      project: PROJECT_ID,
    });
    expect(res.status).toBe(200);
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.scope).toBe("global");
    store.close();
  });

  test("secrets, account ids and ARNs' accounts are redacted before publishing a project doc, and counted", async () => {
    const { store, knowledgeDir, propose } = await seedSession(PROJECT_ID);
    const res = await propose({
      slug: "creds",
      title: "Account 123456789012 setup",
      body: "Use arn:aws:iam::123456789012:role/Admin with Server=db;User Id=app;Password=hunter2very; sortKey: createdAt",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true, redactions: 3 });
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.title).toBe("Account [REDACTED] setup");
    expect(loaded.body).toContain("arn:aws:iam::[REDACTED]:role/Admin");
    expect(loaded.body).not.toContain("123456789012");
    expect(loaded.body).not.toContain("hunter2very");
    // Credential-shaped team data stays: the heuristic tier is for global and personal docs.
    expect(loaded.body).toContain("sortKey: createdAt");
    expect(loaded.sourceKind).toBe("unclassified");
    store.close();
  });

  /** One of alice's personal memories, indexed so it joins the personal fingerprint. */
  const MEMORY = "Alice is out every second Friday for a standing medical appointment.";
  function seedMemory(store: Store) {
    new KnowledgeStore(store.db).upsertDoc({
      id: randomUUID(),
      projectId: PROJECT_ID,
      slug: "persona-schedule",
      title: "Schedule",
      body: MEMORY,
      scope: "user",
      ownerUser: "alice",
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: "/x/persona-schedule.md",
      originClass: "agent",
    });
  }

  test("a shared proposal loses the lines that restate a personal memory, and the count is reported", async () => {
    const { store, knowledgeDir, propose } = await seedSession(PROJECT_ID);
    seedMemory(store);
    const res = await propose({
      slug: "release-cadence",
      title: "Release cadence",
      body: ["Releases go out on Thursdays after the integ run.", `* ${MEMORY}`, "Hotfixes skip the queue."].join("\n"),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true, withheld: 1 });
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.body).not.toContain("medical appointment");
    expect(loaded.body).toContain("Releases go out on Thursdays");
    expect(loaded.body).toContain("Hotfixes skip the queue.");
    store.close();
  });

  test("a proposal with nothing left once personal lines are withheld is refused", async () => {
    const { store, knowledgeDir, propose } = await seedSession(PROJECT_ID);
    seedMemory(store);
    const res = await propose({ slug: "schedule-copy", title: "Schedule", body: MEMORY });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ withheld: 1 });
    expect(await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID)).toHaveLength(0);
    store.close();
  });

  test("a proposal with no personal lines reports nothing withheld", async () => {
    const { store, propose } = await seedSession(PROJECT_ID);
    seedMemory(store);
    const res = await propose({ slug: "plain", title: "Plain", body: "Releases go out on Thursdays after the integ run." });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("withheld");
    store.close();
  });

  test("a scope=global proposal also loses its account ids", async () => {
    const { store, knowledgeDir, propose } = await seedSession(PROJECT_ID);
    const res = await propose({
      slug: "creds",
      title: "Account 123456789012 setup",
      body: "Use arn:aws:iam::123456789012:role/Admin with password: hunter2very",
      scope: "global",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, published: true, redactions: 3 });
    const [loaded] = await new KnowledgeLoader(knowledgeDir).loadProject(PROJECT_ID);
    expect(loaded.scope).toBe("global");
    expect(loaded.title).not.toContain("123456789012");
    expect(loaded.body).not.toContain("123456789012");
    expect(loaded.body).not.toContain("hunter2very");
    store.close();
  });
});

describe("POST /api/knowledge/propose — the fact-check runs against the doc's own project", () => {
  /** A session in PROJECT_ID (A), working in its own launch worktree, plus a
   *  second project with the given repos. */
  async function seedCrossProject(targetRepos: string[]) {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);
    const target = `propose-fc-target-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, { id: target, name: "Fact-check Target", branch: "main", repos: targetRepos });
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: PROJECT_ID, title: "", cwd: worktree, status: "running" });
    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "write docs",
      worktreePath: worktree,
      branch: "standup/fc",
      status: "running",
      sessionId,
    });
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const propose = (fields: Record<string, unknown>) =>
      app.request("/api/knowledge/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, cwd: worktree, ...fields }),
      });
    return { store, knowledgeDir, worktree, target, propose };
  }

  beforeEach(() => {
    verifyCalls.length = 0;
    verifyVerdict = { verdict: "error", disputes: [] };
  });

  test("a proposal from project A targeting project B is checked against B's repo, not the proposer's", async () => {
    const repoB = await tempGitWorktree();
    cleanupDirs.push(repoB);
    const { store, worktree, target, propose } = await seedCrossProject([repoB]);
    const slug = `cross-${randomUUID().slice(0, 6)}`;

    const res = await propose({ slug, title: "Target surface", body: "The target project's API surface.", project: target });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ published: true, verification: "pending" });

    const calls = verifyCalls.filter((c) => c.slug === slug);
    expect(calls).toEqual([{ slug, repoPath: repoB }]);
    expect(calls.some((c) => c.repoPath === worktree)).toBe(false);
    store.close();
  });

  test("a proposal targeting a project with no repos is recorded unverifiable and never checked", async () => {
    const { store, target, propose } = await seedCrossProject([]);
    const slug = `norepo-${randomUUID().slice(0, 6)}`;
    // Were it checked, the proposer's repo would dispute it.
    verifyVerdict = { verdict: "disputed", disputes: [{ claim: "x", finding: "not here", evidence: "ls" }] };

    const res = await propose({ slug, title: "Unreachable surface", body: "A surface in a repo-less project.", project: target });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ published: true });

    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([]);
    const doc = new KnowledgeStore(store.db).getDoc(target, slug);
    expect(doc?.verdict).toBe("unverifiable");
    expect(doc?.disputes).toEqual([
      expect.objectContaining({ claim: `unverifiable: no repo for project ${target}`, origin: "repo" }),
    ]);
    // Still pending: unverified confidence, never stamped.
    expect(doc?.lastVerifiedAt).toBeUndefined();
    store.close();
  });

  test("a draft (request_human_review) targeting a project with no repos is recorded unverifiable too", async () => {
    const { store, target, propose } = await seedCrossProject([]);
    const slug = `norepo-draft-${randomUUID().slice(0, 6)}`;

    const res = await propose({
      slug,
      title: "Unreachable draft",
      body: "A draft about a repo-less project.",
      project: target,
      request_human_review: true,
    });
    expect(res.status).toBe(200);

    const draft = new KnowledgeStore(store.db).getDraft(target, slug);
    expect(draft?.verdict).toBe("unverifiable");
    expect(draft?.disputes).toEqual([
      expect.objectContaining({ claim: `unverifiable: no repo for project ${target}`, origin: "repo" }),
    ]);
    store.close();
  });

  test("a same-project proposal is still checked against the proposer's own checkout", async () => {
    const { store, worktree, propose } = await seedCrossProject([]);
    const slug = `own-${randomUUID().slice(0, 6)}`;

    const res = await propose({ slug, title: "Own fact", body: "A fact about the proposer's own project." });
    expect(res.status).toBe(200);

    // PROJECT_ID registers no repos; its launch worktree is still the checkout.
    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([{ slug, repoPath: worktree }]);
    store.close();
  });

  test("a same-project proposal from a checkout of another project's launch is checked against the doc's project repo", async () => {
    const repoB = await tempGitWorktree();
    cleanupDirs.push(repoB);
    const { store, target, propose } = await seedCrossProject([repoB]);
    // The session is attributed to the target project, but its checkout is the
    // worktree of a finished PROJECT_ID launch: the doc is checked against the
    // target's repo, never that checkout.
    const otherCheckout = await tempGitWorktree();
    cleanupDirs.push(otherCheckout);
    createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "earlier work",
      worktreePath: otherCheckout,
      branch: "standup/earlier",
      status: "cleaned",
    });
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: target, title: "", cwd: otherCheckout, status: "running" });
    const slug = `misattributed-${randomUUID().slice(0, 6)}`;
    const res = await propose({
      session_id: sessionId,
      cwd: otherCheckout,
      slug,
      title: "Target fact",
      body: "A fact about the target.",
    });
    expect(res.status).toBe(200);
    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([{ slug, repoPath: repoB }]);
    store.close();
  });
});

describe("POST /api/knowledge/propose — a global doc is checked against the projects it is about", () => {
  /** A tunnel-authenticated session in PROJECT_ID, the reserved global corpus,
   *  and a registered project `named` with one repo. `launch` makes the
   *  session's checkout a launch worktree of PROJECT_ID; otherwise it is the
   *  worktree of a finished launch of another project, which never serves
   *  PROJECT_ID. */
  async function seedGlobal(launch: boolean) {
    const store = setUpStore();
    upsertProject(store.db, { id: GLOBAL_PROJECT_ID, name: "Global", branch: "main", repos: [], reserved: true });
    touchUser(store.db, "bob", { viaTunnel: true });
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    const namedRepo = await tempGitWorktree();
    cleanupDirs.push(worktree, namedRepo);
    const named = `named-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, { id: named, name: "Named", branch: "main", repos: [namedRepo] });
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: PROJECT_ID, title: "", cwd: worktree, status: "running" });
    if (launch) {
      createLaunch(store.db, {
        id: randomUUID(),
        kind: "worktree",
        projectId: PROJECT_ID,
        task: "write docs",
        worktreePath: worktree,
        branch: "standup/global",
        status: "running",
        sessionId,
      });
    } else {
      const elsewhere = `elsewhere-${randomUUID().slice(0, 8)}`;
      upsertProject(store.db, { id: elsewhere, name: "Elsewhere", branch: "main", repos: [] });
      createLaunch(store.db, {
        id: randomUUID(),
        kind: "worktree",
        projectId: elsewhere,
        task: "earlier work",
        worktreePath: worktree,
        branch: "standup/elsewhere",
        status: "cleaned",
      });
    }
    const app = serverWith(store, () => {}, knowledgeSync, knowledgeDir);
    const propose = (fields: Record<string, unknown>) =>
      app.request("/api/knowledge/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "bob" },
        body: JSON.stringify({ session_id: sessionId, cwd: worktree, project: GLOBAL_PROJECT_ID, ...fields }),
      });
    return { store, worktree, named, namedRepo, propose };
  }

  beforeEach(() => {
    verifyCalls.length = 0;
    verifyVerdict = { verdict: "error", disputes: [] };
  });

  test("a global doc is checked against its source project's checkout", async () => {
    const { store, worktree, propose } = await seedGlobal(true);
    const slug = `global-src-${randomUUID().slice(0, 6)}`;
    const res = await propose({ slug, title: "Team convention", body: "Releases go out on Thursdays." });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ published: true });
    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([{ slug, repoPath: worktree }]);
    store.close();
  });

  test("a global doc whose body names a registered project is checked against that project's repo too", async () => {
    const { store, worktree, named, namedRepo, propose } = await seedGlobal(true);
    const slug = `global-named-${randomUUID().slice(0, 6)}`;
    const res = await propose({ slug, title: "Shared gotcha", body: `Both this project and \`${named}\` pin the same SDK.` });
    expect(res.status).toBe(200);
    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([
      { slug, repoPath: worktree, additionalRepos: [namedRepo] },
    ]);
    store.close();
  });

  test("a global draft with no source checkout is checked against the project its body names", async () => {
    const { store, named, namedRepo, propose } = await seedGlobal(false);
    const slug = `global-only-named-${randomUUID().slice(0, 6)}`;
    const res = await propose({
      slug,
      title: "Named only",
      body: `The \`${named}\` service retries three times.`,
      request_human_review: true,
    });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && !verifyCalls.some((c) => c.slug === slug); i++) await Bun.sleep(10);
    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([{ slug, repoPath: namedRepo }]);
    store.close();
  });

  /** A model dispute citing a file in `repo`. */
  const disputeIn = (repo: string): DraftVerification => ({
    verdict: "disputed",
    disputes: [
      { claim: "retries three times", finding: "retries twice", evidence: "rg retry", citations: [{ file: join(repo, "retry.ts"), line: 1, quote: "RETRIES = 2" }] },
    ],
  });

  test("a published global doc checked only against a project it names is not disputed by that repo", async () => {
    const { store, named, namedRepo, propose } = await seedGlobal(false);
    const slug = `global-pub-named-${randomUUID().slice(0, 6)}`;
    verifyVerdict = disputeIn(namedRepo);
    const res = await propose({ slug, title: "Named retries", body: `The \`${named}\` service retries three times.` });
    expect(res.status).toBe(200);
    const kstore = new KnowledgeStore(store.db);
    for (let i = 0; i < 100 && !kstore.getDoc(GLOBAL_PROJECT_ID, slug)?.verdict; i++) await Bun.sleep(10);
    const doc = kstore.getDoc(GLOBAL_PROJECT_ID, slug);
    expect(doc?.verdict).toBe("unverifiable");
    expect(doc?.disputes?.[0]?.claim).toContain("only names");
    store.close();
  });

  test("a global draft's findings against a project it only names make it unverifiable, not disputed", async () => {
    const { store, named, namedRepo, propose } = await seedGlobal(false);
    const slug = `global-draft-named-${randomUUID().slice(0, 6)}`;
    verifyVerdict = disputeIn(namedRepo);
    const res = await propose({
      slug,
      title: "Named retries draft",
      body: `The \`${named}\` service retries three times.`,
      request_human_review: true,
    });
    expect(res.status).toBe(200);
    const kstore = new KnowledgeStore(store.db);
    for (let i = 0; i < 100 && !kstore.getDraft(GLOBAL_PROJECT_ID, slug)?.verdict; i++) await Bun.sleep(10);
    const draft = kstore.getDraft(GLOBAL_PROJECT_ID, slug);
    expect(draft?.verdict).toBe("unverifiable");
    expect(draft?.disputes?.map((d) => d.origin)).toEqual(["repo", "repo"]);
    store.close();
  });

  test("a global doc with no resolvable repo is recorded unverifiable, and stays searchable", async () => {
    const { store, propose } = await seedGlobal(false);
    const slug = `global-none-${randomUUID().slice(0, 6)}`;
    // Were it checked against the proposer's checkout, this would dispute it.
    verifyVerdict = { verdict: "disputed", disputes: [{ claim: "x", finding: "not here", evidence: "ls" }] };
    const res = await propose({ slug, title: "Unanchored note", body: "Prefer small reviews over large ones." });
    expect(res.status).toBe(200);
    expect(verifyCalls.filter((c) => c.slug === slug)).toEqual([]);
    const doc = new KnowledgeStore(store.db).getDoc(GLOBAL_PROJECT_ID, slug);
    expect(doc?.verdict).toBe("unverifiable");
    expect(doc?.disputes).toEqual([
      expect.objectContaining({ claim: expect.stringContaining("unverifiable: no repo resolvable"), origin: "repo" }),
    ]);
    const hits = await searchKnowledge(store.db, GLOBAL_PROJECT_ID, "small reviews", null, {
      limit: 5,
      audience: { projectId: PROJECT_ID },
    });
    expect(hits.map((h) => h.slug)).toContain(slug);
    store.close();
  });
});
