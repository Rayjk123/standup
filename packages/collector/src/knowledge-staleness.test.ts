import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { writeKnowledgeFile } from "@standup/knowledge";
import {
  computeStaleness,
  hasProvenance,
  isStale,
  primaryRepoPath,
  STALENESS_THRESHOLD_COMMITS,
} from "./knowledge-staleness.js";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * Staleness for generated knowledge docs (phase-7 Step 6). Exercised as a
 * plain module first — no HTTP, no database — and then once through the
 * route that actually serves the Knowledge tab, since a green unit test for
 * the git plumbing proves nothing about whether the route wires it up.
 */

async function tempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-staleness-repo-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "test\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

function commit(repo: string, file: string, contents: string): void {
  Bun.spawnSync(["bash", "-c", `echo '${contents}' > '${file}'`], { cwd: repo });
  Bun.spawnSync(["git", "add", "."], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-q", "-m", `update ${file}`], { cwd: repo });
}

function headSha(repo: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("hasProvenance", () => {
  test("undefined and null are not provenance", () => {
    expect(hasProvenance(undefined)).toBe(false);
    expect(hasProvenance(null)).toBe(false);
  });

  // The empty-string-is-not-NULL gotcha (runbook.md) already broke
  // title-setting once. Step 6 keys "is this generated" off this exact
  // distinction, so an empty string must never read as present — treating
  // it as a sha would flag every doc a bug like that touches as stale.
  test("an empty string is not provenance, even though it is not null", () => {
    expect(hasProvenance("")).toBe(false);
    expect(hasProvenance("   ")).toBe(false);
  });

  test("a real sha is provenance", () => {
    expect(hasProvenance("abc123")).toBe(true);
  });
});

describe("isStale", () => {
  test("threshold boundary: one below is not stale, exactly at it is", () => {
    expect(isStale(STALENESS_THRESHOLD_COMMITS - 1)).toBe(false);
    expect(isStale(STALENESS_THRESHOLD_COMMITS)).toBe(true);
    expect(isStale(STALENESS_THRESHOLD_COMMITS + 1)).toBe(true);
  });

  test("zero commits since generation is not stale", () => {
    expect(isStale(0)).toBe(false);
  });
});

describe("primaryRepoPath", () => {
  test("expands a leading ~ using the real home directory", () => {
    const path = primaryRepoPath({ repos: ["~/code/standup"] });
    expect(path).not.toBeNull();
    expect(path).not.toMatch(/^~/);
    expect(path).toMatch(/code\/standup$/);
  });

  test("no repos configured -> null", () => {
    expect(primaryRepoPath({ repos: [] })).toBeNull();
  });
});

describe("computeStaleness", () => {
  test("counts commits and files changed since the given sha", async () => {
    const repo = await tempGitRepo();
    cleanupDirs.push(repo);
    const sha = headSha(repo);

    commit(repo, "a.txt", "one");
    commit(repo, "b.txt", "two");
    commit(repo, "a.txt", "one changed");

    const result = await computeStaleness(repo, sha);
    expect(result.reachable).toBe(true);
    expect(result.commitsSince).toBe(3);
    // a.txt and b.txt — git diff --name-only reports each touched path once,
    // not once per commit that touched it.
    expect(result.filesChanged).toBe(2);
    expect(result.stale).toBe(false); // 3 << 50
  });

  test("a sha with zero commits since it (HEAD itself) is reachable and not stale", async () => {
    const repo = await tempGitRepo();
    cleanupDirs.push(repo);
    const sha = headSha(repo);

    const result = await computeStaleness(repo, sha);
    expect(result.reachable).toBe(true);
    expect(result.commitsSince).toBe(0);
    expect(result.filesChanged).toBe(0);
    expect(result.stale).toBe(false);
  });

  // The degradation this whole module exists for: a plausible-looking sha
  // that isn't in this clone — branch deleted, history rewritten, repos[0]
  // moved — must never throw or 500 the Knowledge tab.
  test("an unreachable sha degrades instead of throwing", async () => {
    const repo = await tempGitRepo();
    cleanupDirs.push(repo);
    const fakeSha = "a".repeat(40); // well-formed, just not in this repo

    const result = await computeStaleness(repo, fakeSha);
    expect(result.reachable).toBe(false);
    expect(result.commitsSince).toBeNull();
    expect(result.filesChanged).toBeNull();
    expect(result.stale).toBe(false);
  });

  test("a repo path that doesn't exist at all degrades the same way", async () => {
    const result = await computeStaleness("/no/such/path/on/this/machine", "deadbeef");
    expect(result.reachable).toBe(false);
    expect(result.commitsSince).toBeNull();
  });
});

describe("GET /api/projects/:id/knowledge — staleness wiring", () => {
  function projectId(): string {
    return `staleness-route-test-${randomUUID().slice(0, 8)}`;
  }

  async function tempKnowledgeDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "standup-staleness-knowledge-"));
  }

  function setUpStore(id: string, repos: string[]): Store {
    const store = createStore(":memory:");
    upsertProject(store.db, { id, name: "Staleness Route Test", branch: "main", repos });
    return store;
  }

  test("a human-authored doc (no sha) always gets staleness: null", async () => {
    const id = projectId();
    const store = setUpStore(id, []);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "conventions",
      title: "Conventions",
      body: "written by a person",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge`);
    const docs = (await res.json()) as Array<{ slug: string; staleness: unknown }>;

    const doc = docs.find((d) => d.slug === "conventions");
    expect(doc?.staleness).toBeNull();

    store.close();
  });

  test("a generated doc gets a real commit count against its project's repo", async () => {
    const id = projectId();
    const repo = await tempGitRepo();
    cleanupDirs.push(repo);
    const sha = headSha(repo);
    commit(repo, "x.txt", "change");
    commit(repo, "y.txt", "change");

    const store = setUpStore(id, [repo]);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "generated text",
      generatedFromSha: sha,
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge`);
    const docs = (await res.json()) as Array<{
      slug: string;
      staleness: { reachable: boolean; commitsSince: number; stale: boolean } | null;
    }>;

    const doc = docs.find((d) => d.slug === "gotchas");
    expect(doc?.staleness?.reachable).toBe(true);
    expect(doc?.staleness?.commitsSince).toBe(2);
    expect(doc?.staleness?.stale).toBe(false);

    store.close();
  });

  test("a generated doc with no repo configured degrades to unreachable, not a crash", async () => {
    const id = projectId();
    const store = setUpStore(id, []); // no repos
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "generated text",
      generatedFromSha: "a".repeat(40),
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge`);
    expect(res.status).toBe(200);
    const docs = (await res.json()) as Array<{ slug: string; staleness: { reachable: boolean } | null }>;

    const doc = docs.find((d) => d.slug === "gotchas");
    expect(doc?.staleness?.reachable).toBe(false);

    store.close();
  });
});
