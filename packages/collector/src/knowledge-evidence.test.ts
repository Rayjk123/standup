import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, unlink, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, setSetting, upsertProject } from "@standup/store";
import {
  DEFAULT_BASE_CONFIDENCE,
  DISPUTED_CONFIDENCE,
  EVIDENCE_CONFIDENCE_CAPS,
  KnowledgeStore,
  type KnowledgeDoc,
} from "@standup/knowledge";
import {
  RepoEvidenceContext,
  computeDocEvidence,
  deriveNamedPaths,
  deriveNamedSymbols,
  isAboutRepo,
  isModelReverifyEnabled,
  isOnDefaultBranch,
  isRepoRoot,
  rebaselineSha,
  resolveDefaultRefs,
  resolveDocAnchor,
  reverifyModelProjectSettingKey,
  reverifyProjectSettingKey,
  runGitLines,
  type GitLineRunner,
  type GitStatusRunner,
} from "./knowledge-staleness.js";
import {
  MAX_REVERIFY_ATTEMPTS,
  demoteStale,
  freshnessGate,
  readProjectFreshness,
  recordModelPassVerdicts,
  recordReverifyAttempt,
  replaceProjectFreshness,
} from "./knowledge-freshness.js";
import { reverifiableProjects, runEvidencePass, verifyAcceptedDoc, type EvidencePassDeps } from "./knowledge-reverify.js";
import { buildPinnedRepo } from "./kbeval/env.js";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * The deterministic evidence pass and the freshness gate against real temp git
 * repos: every commit is dated explicitly so date-anchored lookups are
 * reproducible.
 */

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

let clock = Date.parse("2026-09-01T00:00:00Z");

function git(repo: string, args: string[]): string {
  const iso = new Date(clock).toISOString();
  const out = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  return out.stdout.toString().trim();
}

async function commitFile(repo: string, path: string, contents: string | null, message: string): Promise<string> {
  clock += 3_600_000;
  const abs = join(repo, path);
  if (contents === null) await unlink(abs);
  else {
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function tempRepo(): Promise<string> {
  const dir = await tempDir("standup-evidence-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  await commitFile(dir, "README.md", "repo\n", "initial");
  return dir;
}

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: overrides.slug ?? "id",
    projectId: "p",
    slug: "s",
    title: "T",
    body: "",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    filePath: "/x",
    ...overrides,
  };
}

const ctxFor = (repo: string, docs: KnowledgeDoc[], opts: { git?: GitStatusRunner; lines?: GitLineRunner } = {}) =>
  RepoEvidenceContext.forDocs(repo, docs, opts);

async function evidence(repo: string, d: KnowledgeDoc, peers?: Map<string, KnowledgeDoc>) {
  return computeDocEvidence(await ctxFor(repo, [d]), d, peers);
}

describe("deriveNamedSymbols / deriveNamedPaths", () => {
  test("keeps code-shaped backticked names and calls, skips plain words", () => {
    const body = "Uses `knnSearch(db, q, k)`, `VEC_TABLE`, `retrieveProductKnowledge` and `claude` and `scope`.";
    expect(deriveNamedSymbols(body).sort()).toEqual(["VEC_TABLE", "knnSearch", "retrieveProductKnowledge"]);
  });

  test("skips names and paths on lines that describe them as removed or unmerged", () => {
    const body = [
      "`oldHelper()` was removed in favor of `newHelper()`.",
      "A `parseWikilinks` function exists only on an unmerged branch.",
      "The router lives in src/router.ts.",
      "src/legacy.ts was deleted.",
    ].join("\n");
    expect(deriveNamedSymbols(body)).toEqual([]);
    expect(deriveNamedPaths(body)).toEqual(["src/router.ts"]);
  });
});

describe("computeDocEvidence", () => {
  test("a named path and symbol that existed at the anchor and are gone at HEAD are findings", async () => {
    const repo = await tempRepo();
    const anchor = await commitFile(repo, "src/router.ts", "export function routeRequest() {}\n", "add router");
    await commitFile(repo, "src/router.ts", null, "remove router");
    const d = doc({ body: "Requests go through `routeRequest()` in src/router.ts.", generatedFromSha: anchor });
    const found = await evidence(repo, d);
    expect(found.map((e) => e.kind).sort()).toEqual(["missing-path", "missing-symbol"]);
    expect(found.find((e) => e.kind === "missing-path")?.detail).toBe("src/router.ts");
  });

  test("a name that was never in the tree at the anchor is not evidence", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "src/real.ts", "export const realThing = 1;\n", "add real");
    const d = doc({
      body: "Uses `AbortError` from the runtime and src/other-codebase/thing.ts, plus `realThing` in src/real.ts.",
      lastVerifiedAt: new Date(clock + 60_000).toISOString(),
    });
    expect(await evidence(repo, d)).toEqual([]);
  });

  test("a date-anchored doc (no sha) is held to the commit at its last-verified date", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "src/cfg.ts", "export const loadConfig = 1;\n", "add cfg");
    const verifiedAt = new Date(clock + 60_000).toISOString();
    await commitFile(repo, "src/cfg.ts", null, "drop cfg");
    const d = doc({ body: "Config is read by src/cfg.ts.", lastVerifiedAt: verifiedAt });
    expect((await resolveDocAnchor(repo, d))?.from).toBe("date");
    expect((await evidence(repo, d)).map((e) => e.kind)).toEqual(["missing-path"]);
  });

  test("a doc that predates the repo's history has no anchor and no findings", async () => {
    const repo = await tempRepo();
    const d = doc({ body: "See src/x.ts.", lastVerifiedAt: "2020-01-01T00:00:00Z" });
    expect(await resolveDocAnchor(repo, d)).toBeNull();
    expect(await evidence(repo, d)).toEqual([]);
  });

  test("file drift is reported for priority but caps nothing", async () => {
    const repo = await tempRepo();
    const anchor = await commitFile(repo, "src/hot.ts", "v0\n", "add hot");
    for (let i = 1; i <= 5; i++) await commitFile(repo, "src/hot.ts", `v${i}\n`, `edit ${i}`);
    const d = doc({ body: "The hot path is src/hot.ts.", generatedFromSha: anchor });
    expect((await evidence(repo, d)).map((e) => e.kind)).toEqual(["file-drift"]);
    expect(EVIDENCE_CONFIDENCE_CAPS["file-drift"]).toBeUndefined();
  });

  test("a recorded contradiction is judged on content dates, not file times", async () => {
    const repo = await tempRepo();
    // The peer's FILE is newer (a re-mirror touched it), but its content is older.
    const olderContent = doc({ slug: "mirror", generatedAt: "2026-08-01T00:00:00Z", updatedAt: new Date("2026-10-01T00:00:00Z") });
    const newerContent = doc({ slug: "newer", lastVerifiedAt: "2026-09-20T00:00:00Z" });
    const subject = doc({
      slug: "subject",
      lastVerifiedAt: "2026-09-01T00:00:00Z",
      verdict: "contradicted",
      disputes: [
        { claim: "Contradicts newer", finding: "", evidence: "" },
        { claim: "Contradicts mirror", finding: "", evidence: "" },
      ],
    });
    const peers = new Map([olderContent, newerContent, subject].map((d) => [`p/${d.slug}`, d]));
    expect(await evidence(repo, subject, peers)).toEqual([{ kind: "contradicted-by-newer", detail: "newer" }]);
  });

  test("a repo that is not a git checkout yields no findings rather than an error", async () => {
    const dir = await tempDir("standup-evidence-plain-");
    const d = doc({ body: "See src/x.ts and `someSymbol`.", generatedFromSha: "a".repeat(40) });
    expect(await evidence(dir, d)).toEqual([]);
  });

  test("symbols are grepped once per commit for the whole pass, not once per doc", async () => {
    const repo = await tempRepo();
    const anchor = await commitFile(repo, "src/a.ts", "export const alphaThing = 1; export const betaThing = 2;\n", "add");
    const docs = Array.from({ length: 6 }, (_, i) =>
      doc({ slug: `d${i}`, body: `Uses \`alphaThing\` and \`betaThing\` and \`gamma_${i}\`.`, generatedFromSha: anchor })
    );
    const calls: string[] = [];
    const lines: GitLineRunner = (r, a, on) => {
      calls.push(a[0]);
      return runGitLines(r, a, on);
    };
    const ctx = await ctxFor(repo, docs, { lines });
    for (const d of docs) await computeDocEvidence(ctx, d);
    // One scan of the checkout for every doc's symbols, and one grep at the
    // shared anchor commit for the names missing at HEAD.
    expect(calls.filter((c) => c === "ls-files")).toHaveLength(1);
    expect(calls.filter((c) => c === "grep")).toHaveLength(1);
  });
});

describe("unmerged — any default branch, squash and rebase merges", () => {
  async function withRemote(): Promise<{ repo: string; origin: string }> {
    const repo = await tempRepo();
    const origin = await tempDir("standup-evidence-origin-");
    Bun.spawnSync(["git", "init", "-q", "--bare", origin]);
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["push", "-q", "origin", "main"]);
    git(repo, ["remote", "set-head", "origin", "main"]);
    git(repo, ["fetch", "-q", "origin"]);
    return { repo, origin };
  }

  test("a sha on local main is merged even when origin/main is behind it", async () => {
    const { repo } = await withRemote();
    const local = await commitFile(repo, "src/new.ts", "x\n", "local only");
    const refs = await resolveDefaultRefs(repo);
    expect(refs).toEqual(expect.arrayContaining(["refs/heads/main", "refs/remotes/origin/main"]));
    expect(await isOnDefaultBranch(repo, local, refs)).toBe(true);
    expect(await evidence(repo, doc({ generatedFromSha: local }))).toEqual([]);
  });

  test("a side branch never merged is unmerged; squash- and rebase-merged branches are not", async () => {
    const repo = await tempRepo();
    git(repo, ["checkout", "-q", "-b", "never"]);
    const never = await commitFile(repo, "src/never.ts", "n\n", "never merged");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["checkout", "-q", "-b", "squashed"]);
    await commitFile(repo, "src/sq.ts", "one\n", "sq 1");
    const squashedTip = await commitFile(repo, "src/sq.ts", "one\ntwo\n", "sq 2");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "-q", "--squash", "squashed"]);
    clock += 3_600_000;
    git(repo, ["commit", "-q", "-m", "squash merge"]);
    git(repo, ["checkout", "-q", "-b", "picked"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    const pickedTip = await commitFile(repo, "src/pick.ts", "p\n", "picked");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["cherry-pick", pickedTip]);
    const refs = await resolveDefaultRefs(repo);
    expect(await isOnDefaultBranch(repo, never, refs)).toBe(false);
    expect(await isOnDefaultBranch(repo, squashedTip, refs)).toBe(true);
    expect(await isOnDefaultBranch(repo, pickedTip, refs)).toBe(true);
    expect((await evidence(repo, doc({ generatedFromSha: never }))).map((e) => e.kind)).toEqual(["unmerged"]);
  });

  test("a commit in the middle of a squash-merged branch counts as merged once the branch is gone", async () => {
    const repo = await tempRepo();
    git(repo, ["checkout", "-q", "-b", "feature"]);
    const c1 = await commitFile(repo, "src/f.ts", "export const one = 1;\n", "feature step one");
    const c2 = await commitFile(repo, "src/f.ts", "export const one = 1;\nexport const two = 2;\n", "feature step two");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "-q", "--squash", "feature"]);
    clock += 3_600_000;
    git(repo, ["commit", "-q", "-m", "Feature (#12)"]);
    git(repo, ["branch", "-q", "-D", "feature"]);
    const refs = await resolveDefaultRefs(repo);
    expect(await isOnDefaultBranch(repo, c2, refs)).toBe(true);
    expect(await isOnDefaultBranch(repo, c1, refs)).toBe(true);
  });

  test("a symbol that exists only on an unmerged branch is an unmerged claim for a doc with no sha", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "src/graph.ts", "export const buildEdges = 1;\n", "graph");
    git(repo, ["checkout", "-q", "-b", "wikilinks"]);
    await commitFile(repo, "src/wikilinks.ts", "export function parseWikilinks() {}\n", "wikilinks");
    git(repo, ["checkout", "-q", "main"]);
    const d = doc({ body: "`parseWikilinks(body)` turns links into edges; see `buildEdges`.", lastVerifiedAt: new Date(clock).toISOString() });
    expect(await evidence(repo, d)).toEqual([{ kind: "unmerged", detail: "parseWikilinks only on wikilinks" }]);
  });

  test("a doc whose sha is merged is never an unmerged claim, whatever a side branch holds", async () => {
    const repo = await tempRepo();
    const merged = await commitFile(repo, "src/graph.ts", "export const buildEdges = 1;\n", "graph");
    git(repo, ["checkout", "-q", "-b", "wikilinks"]);
    await commitFile(repo, "src/wikilinks.ts", "export function parseWikilinks() {}\n", "wikilinks");
    git(repo, ["checkout", "-q", "main"]);
    const d = doc({ body: "`parseWikilinks(body)` turns links into edges.", generatedFromSha: merged });
    expect(await evidence(repo, d)).toEqual([]);
  });

  test("a symbol found on a branch only in docs, JSON, eval corpora or fixtures is not an unmerged claim", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "src/graph.ts", "export const buildEdges = 1;\n", "graph");
    git(repo, ["checkout", "-q", "-b", "corpus"]);
    await commitFile(repo, "notes/plan.md", "Uses `ExpiredToken`.\n", "plan");
    await commitFile(repo, "data/history.json", '{"q": "parseWikilinks"}\n', "history");
    await commitFile(repo, "packages/k/eval/corpus/a.ts", "const AWS_PROFILE = 1;\n", "corpus");
    await commitFile(repo, "packages/k/eval-x/fixture-repo/src/b.ts", "export const fixtureOnly = 1;\n", "fixture");
    git(repo, ["checkout", "-q", "main"]);
    const d = doc({
      body: "`ExpiredToken`, `parseWikilinks`, `AWS_PROFILE` and `fixtureOnly` all matter; see `buildEdges`.",
      lastVerifiedAt: new Date(clock).toISOString(),
    });
    expect(await evidence(repo, d)).toEqual([]);
  });

  test("a branch squash-merged on the default branch is not searched even while it still exists", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "src/graph.ts", "export const buildEdges = 1;\n", "graph");
    git(repo, ["checkout", "-q", "-b", "wikilinks"]);
    await commitFile(repo, "src/wikilinks.ts", "export function parseWikilinks() {}\n", "wikilinks");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "-q", "--squash", "wikilinks"]);
    clock += 3_600_000;
    git(repo, ["commit", "-q", "-m", "Wikilinks (#7)"]);
    await commitFile(repo, "src/wikilinks.ts", null, "drop wikilinks");
    const d = doc({ body: "`parseWikilinks(body)` turns links into edges; see `buildEdges`.", lastVerifiedAt: new Date(clock).toISOString() });
    expect(await evidence(repo, d)).toEqual([]);
  });

  test("default refs put the branch HEAD is on first, then main over master, local over remote", async () => {
    const repo = await tempRepo();
    git(repo, ["branch", "master"]);
    expect((await resolveDefaultRefs(repo))[0]).toBe("refs/heads/main");
    git(repo, ["checkout", "-q", "master"]);
    expect((await resolveDefaultRefs(repo))[0]).toBe("refs/heads/master");
  });

  test("a clean re-verify on a feature branch re-baselines to a default-branch commit, so it is never flagged", async () => {
    const repo = await tempRepo();
    const base = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-q", "-b", "feature"]);
    const head = await commitFile(repo, "src/f.ts", "f\n", "feature work");
    const refs = await resolveDefaultRefs(repo);
    const to = await rebaselineSha(repo, head, refs);
    expect(to).toBe(base);
    expect(await evidence(repo, doc({ generatedFromSha: to }))).toEqual([]);
  });
});

describe("isRepoRoot / pinned eval repos", () => {
  test("a directory inside another checkout is not a repo root, and the evidence pass skips it", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "fixture/src/a.ts", "export const fixtureThing = 1;\n", "fixture");
    const inner = join(repo, "fixture");
    expect(await isRepoRoot(repo)).toBe(true);
    expect(await isRepoRoot(inner)).toBe(false);
    const result = await runEvidencePass(memoryDeps({}).deps, "p", [doc({ body: "src/a.ts" })], inner);
    expect(result.skipped).toBe("not-a-repo-root");
    expect(result.checked).toBe(0);
  });

  test("a pinned repo has the same sha on every build, whatever checkout its source sits in", async () => {
    const source = await tempDir("standup-pinned-src-");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "a.ts"), "export const a = 1;\n");
    const a = buildPinnedRepo(source, join(await tempDir("standup-pinned-a-"), "repo"));
    const b = buildPinnedRepo(source, join(await tempDir("standup-pinned-b-"), "repo"));
    const sha = (dir: string) => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
    expect(sha(a)).toBe(sha(b));
    expect(await isRepoRoot(a)).toBe(true);
  });
});

function memoryDeps(files: Record<string, Record<string, unknown>>) {
  const recorded: Array<{ projectId: string; records: unknown[] }> = [];
  const deps: EvidencePassDeps = {
    readFrontmatter: async (_p, slug) => files[slug] ?? null,
    record: (projectId, records) => {
      recorded.push({ projectId, records });
    },
  };
  return { deps, recorded };
}

describe("runEvidencePass + freshness gate — findings are derived, never folded into the doc", () => {
  test("a cap holds while the finding holds and is gone once the file comes back", async () => {
    const repo = await tempRepo();
    const anchor = await commitFile(repo, "src/gone.ts", "export const goneThing = 1;\n", "add");
    await commitFile(repo, "src/gone.ts", null, "remove");
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [repo] });
    const k = new KnowledgeStore(store.db);
    const d = doc({ slug: "owner-doc", body: "Lives in src/gone.ts.", generatedFromSha: anchor, originClass: "owner", sourceKind: "code" });
    k.upsertDoc(d);
    const deps: EvidencePassDeps = {
      readFrontmatter: async () => ({}),
      record: (projectId, records, at) => replaceProjectFreshness(store.db, projectId, records, at),
    };

    const first = await runEvidencePass(deps, "p", [d], repo);
    expect(first.capped).toEqual([
      { slug: "owner-doc", cap: EVIDENCE_CONFIDENCE_CAPS["missing-path"]!, evidence: [{ kind: "missing-path", detail: "src/gone.ts" }] },
    ]);
    const hit = { projectId: "p", slug: "owner-doc" };
    expect(freshnessGate(store.db).inputs(hit).confidence).toBe(EVIDENCE_CONFIDENCE_CAPS["missing-path"]);
    // The doc itself asserts nothing new: no confidence was written anywhere.
    expect(k.getDoc("p", "owner-doc")?.confidence).toBeUndefined();

    await commitFile(repo, "src/gone.ts", "export const goneThing = 1;\n", "restore");
    const second = await runEvidencePass(deps, "p", [d], repo);
    expect(second.capped).toEqual([]);
    expect(readProjectFreshness(store.db, "p").get("owner-doc")?.cap).toBeUndefined();
    expect(freshnessGate(store.db).inputs(hit).confidence).toBe(DEFAULT_BASE_CONFIDENCE);
    store.close();
  });

  test("a doc mirrored from a repo file stands as of that file's last commit", async () => {
    const repo = await tempRepo();
    await commitFile(repo, "plan/STATUS.md", "# Status\n", "status");
    const committedAt = new Date(clock).toISOString();
    const mem = memoryDeps({ STATUS: { ingested_from: join(repo, "plan/STATUS.md") } });
    const result = await runEvidencePass(mem.deps, "p", [doc({ slug: "STATUS" })], repo);
    expect(result.anchored).toEqual(["STATUS"]);
    expect(mem.recorded[0].records).toEqual([
      { slug: "STATUS", anchorAt: committedAt, cap: undefined, findings: [], aboutRepo: false },
    ]);
  });

  test("personal and activity docs are not checked", async () => {
    const repo = await tempRepo();
    const mem = memoryDeps({});
    const result = await runEvidencePass(
      mem.deps,
      "p",
      [
        doc({ slug: "mine", scope: "user", ownerUser: "u", body: "src/a.ts" }),
        doc({ slug: "native-mem-memory-diary", sourceKind: "native-memory", body: "src/a.ts" }),
      ],
      repo
    );
    expect(result.checked).toBe(0);
  });
});

describe("freshness gate — decay gates only where a re-verification will lift the doc back", () => {
  async function seedOld(modelPass: boolean) {
    const repo = await tempRepo();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [repo], dailyReviewActive: modelPass });
    const k = new KnowledgeStore(store.db);
    const old = new Date("2025-01-01T00:00:00Z");
    k.upsertDoc(doc({ slug: "native-mem-memory-diary", sourceKind: "native-memory", updatedAt: old, originClass: "owner" }));
    k.upsertDoc(doc({ slug: "mine", scope: "user", ownerUser: "u", updatedAt: old, originClass: "owner" }));
    k.upsertDoc(doc({ slug: "about", body: "Lives in src/a.ts.", updatedAt: old, originClass: "owner" }));
    k.upsertDoc(doc({ slug: "elsewhere", body: "A process note.", updatedAt: old, originClass: "owner" }));
    replaceProjectFreshness(
      store.db,
      "p",
      [
        { slug: "about", findings: [], aboutRepo: true },
        { slug: "elsewhere", findings: [], aboutRepo: false },
      ],
      new Date().toISOString()
    );
    return store;
  }

  test("model pass on and the doc about the repo: a decayed doc is gated out, not marked stale", async () => {
    const store = await seedOld(true);
    const gate = freshnessGate(store.db);
    expect(gate.isRecoverable({ projectId: "p", slug: "about" })).toBe(true);
    expect(gate.eligible({ projectId: "p", slug: "about" })).toBe(false);
    expect(gate.staleSince({ projectId: "p", slug: "about" })).toBeUndefined();
    // A doc the model pass would skip has no recovery path even with the pass on.
    expect(gate.eligible({ projectId: "p", slug: "elsewhere" })).toBe(true);
    expect(gate.staleSince({ projectId: "p", slug: "elsewhere" })).toBeDefined();
    store.close();
  });

  test("model pass off: no decayed doc is gated out; each is marked stale since the day it crossed the floor", async () => {
    const store = await seedOld(false);
    const gate = freshnessGate(store.db);
    for (const slug of ["about", "elsewhere"]) {
      expect(gate.eligible({ projectId: "p", slug })).toBe(true);
      expect(gate.staleSince({ projectId: "p", slug })).toMatch(/^2025-/);
    }
    store.close();
  });

  test("a doc whose fact-checks keep ending without a verdict stops being gated, until its body changes", async () => {
    const store = await seedOld(true);
    const hit = { projectId: "p", slug: "about" };
    const body = "Lives in src/a.ts.";
    for (let i = 0; i < MAX_REVERIFY_ATTEMPTS - 1; i++) recordReverifyAttempt(store.db, "p", "about", body, "unverified", "t");
    expect(freshnessGate(store.db).isRecoverable(hit)).toBe(true);
    recordReverifyAttempt(store.db, "p", "about", body, "error", "t");
    const gate = freshnessGate(store.db);
    expect(gate.isRecoverable(hit)).toBe(false);
    expect(gate.eligible(hit)).toBe(true);
    expect(gate.staleSince(hit)).toBeDefined();
    // Attempts are counted against the body: an edited doc is owed fresh checks.
    recordReverifyAttempt(store.db, "p", "about", "Lives in src/a.ts and src/b.ts.", "unverified", "t");
    expect(freshnessGate(store.db).isRecoverable(hit)).toBe(true);
    // A verdict resets the count.
    for (let i = 0; i < MAX_REVERIFY_ATTEMPTS; i++) recordReverifyAttempt(store.db, "p", "about", body, "error", "t");
    recordReverifyAttempt(store.db, "p", "about", body, "clean", "t");
    expect(freshnessGate(store.db).isRecoverable(hit)).toBe(true);
    store.close();
  });

  test("a model pass that reached no verdict at all demotes decayed docs instead of gating them", async () => {
    const store = await seedOld(true);
    const hit = { projectId: "p", slug: "about" };
    recordModelPassVerdicts(store.db, "p", false);
    const gate = freshnessGate(store.db);
    expect(gate.isRecoverable(hit)).toBe(false);
    expect(gate.eligible(hit)).toBe(true);
    expect(gate.staleSince(hit)).toBeDefined();
    recordModelPassVerdicts(store.db, "p", true);
    expect(freshnessGate(store.db).eligible(hit)).toBe(false);
    store.close();
  });

  test("a project re-verification no longer runs for keeps no findings", async () => {
    const repo = await tempRepo();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "on", name: "On", branch: "main", repos: [repo] });
    upsertProject(store.db, { id: "off", name: "Off", branch: "main", repos: [repo] });
    upsertProject(store.db, { id: "gone", name: "Gone", branch: "main", repos: [join(repo, "missing")] });
    setSetting(store.db, reverifyProjectSettingKey("off"), "off");
    for (const id of ["on", "off", "gone"]) {
      replaceProjectFreshness(store.db, id, [{ slug: "x", cap: 0.5, findings: [{ kind: "missing-path", detail: "a" }] }], "t");
    }
    expect(reverifiableProjects(store.db).map((p) => p.id)).toEqual(["on"]);
    expect(readProjectFreshness(store.db, "on").size).toBe(1);
    expect(readProjectFreshness(store.db, "off").size).toBe(0);
    expect(readProjectFreshness(store.db, "gone").size).toBe(0);
    store.close();
  });

  test("personal and activity docs are never gated nor marked by decay", async () => {
    const store = await seedOld(true);
    const gate = freshnessGate(store.db);
    for (const hit of [
      { projectId: "p", slug: "native-mem-memory-diary", sourceKind: "native-memory" },
      { projectId: "p", slug: "mine", scope: "user" },
    ]) {
      expect(gate.eligible(hit)).toBe(true);
      expect(gate.staleSince(hit)).toBeUndefined();
    }
    store.close();
  });

  test("a pass that cannot read the repo clears the project's old findings", async () => {
    const repo = await tempRepo();
    const inner = join(repo, "sub");
    await mkdir(inner, { recursive: true });
    const store = createStore(":memory:");
    replaceProjectFreshness(store.db, "p", [{ slug: "x", cap: 0.5, findings: [{ kind: "missing-path", detail: "a" }] }], "t");
    await runEvidencePass(
      { readFrontmatter: async () => ({}), record: (pid, recs, at) => replaceProjectFreshness(store.db, pid, recs, at) },
      "p",
      [doc({ slug: "x" })],
      inner
    );
    expect(readProjectFreshness(store.db, "p").size).toBe(0);
    store.close();
  });

  test("demotion moves a stale doc behind fresher docs of its own project only", () => {
    const items = [
      { projectId: "a", slug: "stale-a", stale: true },
      { projectId: "b", slug: "fresh-b", stale: false },
      { projectId: "a", slug: "fresh-a", stale: false },
      { projectId: "c", slug: "stale-c", stale: true },
      { projectId: "b", slug: "fresh-b2", stale: false },
    ];
    const order = demoteStale(items, (i) => (i.stale ? "2026-01-01" : undefined)).map((i) => i.slug);
    expect(order).toEqual(["fresh-b", "fresh-a", "stale-a", "stale-c", "fresh-b2"]);
  });
});

describe("content clock", () => {
  test("a new row's clock starts at the doc's generation date, else its file time", () => {
    const store = createStore(":memory:");
    const k = new KnowledgeStore(store.db);
    k.upsertDoc(doc({ slug: "g", body: "drafted", generatedAt: "2026-07-01T00:00:00Z", updatedAt: new Date("2026-09-01T00:00:00Z") }));
    k.upsertDoc(doc({ slug: "u", body: "hand-written", updatedAt: new Date("2026-09-01T00:00:00Z") }));
    expect(k.getDoc("p", "g")?.contentFirstSeen).toBe("2026-07-01T00:00:00.000Z");
    expect(k.getDoc("p", "u")?.contentFirstSeen).toBe("2026-09-01T00:00:00.000Z");
    store.close();
  });

  test("a rewrite that keeps the body keeps the clock; a changed body restarts it at that sync's file time", () => {
    const store = createStore(":memory:");
    const k = new KnowledgeStore(store.db);
    const first = new Date("2026-08-01T00:00:00Z");
    k.upsertDoc(doc({ slug: "c", body: "same body", updatedAt: first }));
    k.upsertDoc(doc({ slug: "c", body: "same body", title: "Renamed", updatedAt: new Date("2026-09-09T01:34:00Z") }));
    expect(k.getDoc("p", "c")?.contentFirstSeen).toBe(first.toISOString());
    const edited = new Date("2026-09-20T00:00:00Z");
    k.upsertDoc(doc({ slug: "c", body: "a new body", updatedAt: edited }));
    expect(k.getDoc("p", "c")?.contentFirstSeen).toBe(edited.toISOString());
    store.close();
  });

  test("an undated contradicted doc is compared on its content clock", async () => {
    const repo = await tempRepo();
    const peer = doc({ slug: "peer", contentFirstSeen: "2026-09-20T00:00:00Z" });
    const subject = doc({
      slug: "subject",
      contentFirstSeen: "2026-09-01T00:00:00Z",
      verdict: "contradicted",
      disputes: [{ claim: "Contradicts peer", finding: "", evidence: "" }],
    });
    const peers = new Map([peer, subject].map((d) => [`p/${d.slug}`, d]));
    expect(await evidence(repo, subject, peers)).toEqual([{ kind: "contradicted-by-newer", detail: "peer" }]);
  });
});

describe("owner edit re-asserts the doc", () => {
  test("a body edit restarts the decay clock and lifts a low asserted base; a title-only edit does not", async () => {
    const repo = await tempRepo();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [repo] });
    const knowledgeDir = await tempDir("standup-edit-");
    await mkdir(join(knowledgeDir, "p"), { recursive: true });
    const file = join(knowledgeDir, "p", "status.md");
    await writeFile(file, `---\ntitle: Status\nconfidence: 0.5\nlast_verified_at: "2026-01-01T00:00:00.000Z"\n---\n\nPhase 1 DONE.\n`);
    const sync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, sync, undefined, knowledgeDir);
    const put = (title: string, body: string) =>
      app.request("/api/projects/p/knowledge/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });

    expect((await put("Status (renamed)", "Phase 1 DONE.")).status).toBe(200);
    expect(await readFile(file, "utf-8")).toContain("2026-01-01T00:00:00.000Z");

    const before = Date.now();
    expect((await put("Status", "Phase 1 DONE. Phase 2 DONE.")).status).toBe(200);
    const raw = await readFile(file, "utf-8");
    expect(raw).toContain(`confidence: ${DEFAULT_BASE_CONFIDENCE}`);
    const stamped = /last_verified_at: ['"]?([^'"\n]+)/.exec(raw)?.[1] ?? "";
    expect(Date.parse(stamped)).toBeGreaterThanOrEqual(before - 1000);
    expect(raw).not.toContain("half_life_days");
    store.close();
  });
});

describe("an edit leaves an unverified agent doc pending", () => {
  test("a body edit of an agent doc awaiting its fact-check neither lifts its base nor stamps it verified", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    const knowledgeDir = await tempDir("standup-edit-pending-");
    await mkdir(join(knowledgeDir, "p"), { recursive: true });
    const file = join(knowledgeDir, "p", "proposal.md");
    await writeFile(file, `---\ntitle: Proposal\norigin_class: agent\nconfidence: 0.6\n---\n\nThe retry limit is 3.\n`);
    const sync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, sync, undefined, knowledgeDir);
    const res = await app.request("/api/projects/p/knowledge/proposal", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Proposal", body: "The retry limit is three." }),
    });
    expect(res.status).toBe(200);
    const raw = await readFile(file, "utf-8");
    expect(raw).toContain("confidence: 0.6");
    expect(raw).not.toContain("last_verified_at");
    store.close();
  });
});

describe("model pass — opt-in, and only for docs about this repo", () => {
  test("off by default; on by setting or the daily-review opt-in; a project off value wins", () => {
    const store = createStore(":memory:");
    expect(isModelReverifyEnabled(store.db, { id: "a" })).toBe(false);
    expect(isModelReverifyEnabled(store.db, { id: "a", dailyReviewActive: true })).toBe(true);
    setSetting(store.db, reverifyModelProjectSettingKey("b"), "true");
    expect(isModelReverifyEnabled(store.db, { id: "b" })).toBe(true);
    setSetting(store.db, "knowledge.reverify_model", "on");
    expect(isModelReverifyEnabled(store.db, { id: "c" })).toBe(true);
    setSetting(store.db, reverifyModelProjectSettingKey("c"), "off");
    expect(isModelReverifyEnabled(store.db, { id: "c" })).toBe(false);
    store.close();
  });

  test("a doc about another system or checkout is not fact-checked against this repo", () => {
    const tree = new Set(["src/a.ts", "src/b.ts"]);
    expect(isAboutRepo({ body: "Handlers live in src/a.ts and src/b.ts." }, tree)).toBe(true);
    expect(isAboutRepo({ body: "See src/gateway/server.ts, src/agent/turn.ts and src/a.ts." }, tree)).toBe(false);
    expect(isAboutRepo({ body: "Source checkout: `/Users/me/code/other-service`, file src/a.ts." }, tree)).toBe(false);
    expect(isAboutRepo({ body: "A process doc that names no files." }, tree)).toBe(false);
    expect(isAboutRepo({ body: "No files.", generatedFromSha: "abc" }, tree)).toBe(true);
  });

  test("a dispute that only says a path is not found reads as unverified, never disputed", async () => {
    const absent = await verifyAcceptedDoc("s", "b", "/repo", async (_s, _b, _r, opts) => {
      expect(opts?.absenceIsNotAMismatch).toBe(true);
      return {
        verdict: "disputed",
        disputes: [{ claim: "the handler is in src/x.ts", finding: "src/x.ts does not exist in the repo", evidence: "ls" }],
      };
    });
    expect(absent).toEqual({ verdict: "unverified", disputes: [] });
    const real = await verifyAcceptedDoc("s", "b", "/repo", async () => ({
      verdict: "disputed",
      disputes: [
        { claim: "retries 3 times", finding: "MAX_RETRIES is 5", evidence: "rg MAX_RETRIES" },
        { claim: "in src/y.ts", finding: "no such file", evidence: "ls" },
      ],
    }));
    expect(real.verdict).toBe("disputed");
    expect(real.disputes.map((d) => d.claim)).toEqual(["retries 3 times"]);
    expect(DISPUTED_CONFIDENCE).toBeLessThan(DEFAULT_BASE_CONFIDENCE);
  });
});
