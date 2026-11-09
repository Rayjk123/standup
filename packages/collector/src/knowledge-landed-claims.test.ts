import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, upsertProject } from "@standup/store";
import { DEFAULT_BASE_CONFIDENCE, EVIDENCE_CONFIDENCE_CAPS, KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import {
  UNNAMED_UNMERGED_WARNING,
  bodyHash,
  checkBranchClaimsLanded,
  ensureLandedClaimsTable,
  expireLandedBranchClaims,
  extractBranchMergeClaims,
  isConfirmedLanding,
  LANDING_RULES,
  landedClaimDeps,
  landedClaimFor,
  landedClaimMarker,
  readLandedClaims,
  rewriteLandedClaims,
  unnamedUnmergedWarning,
  type BranchLanding,
} from "./knowledge-repo-claims.js";
import { RepoEvidenceContext } from "./knowledge-staleness.js";
import { freshnessGate, readProjectFreshness, replaceProjectFreshness } from "./knowledge-freshness.js";
import { runEvidencePass, type EvidencePassDeps } from "./knowledge-reverify.js";

/**
 * "On branch X, not yet merged" claims against real temp git repos: work that
 * landed as a rebased copy (new shas, same patches) counts as landed whether
 * or not the branch still exists; a branch with commits that have no copy on
 * main stays unmerged; and a claim nothing in git can settle is left alone.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

let clock = Date.parse("2026-09-01T00:00:00Z");

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  commit: (path: string, text: string, message: string) => string;
}

function repo(): Repo {
  const dir = tempDir("standup-landed-claims-");
  const git = (...args: string[]) => {
    const iso = new Date(clock).toISOString();
    const res = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    return res.stdout.toString().trim();
  };
  const commit = (path: string, text: string, message: string) => {
    clock += 3_600_000;
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  commit("README.md", "repo\n", "base");
  return { dir, git, commit };
}

/**
 * main ← base, then `feature/x` adds src/x.ts (`parseThing`) in two commits;
 * main moves on, and both commits are cherry-picked onto it — the rebased
 * copy a landed branch leaves behind.
 */
function rebasedLanding(): { r: Repo; base: string; tip: string } {
  const r = repo();
  const base = r.git("rev-parse", "HEAD");
  r.git("checkout", "-q", "-b", "feature/x");
  const first = r.commit("src/x.ts", "export function parseThing() {\n  return 1;\n}\n", "Add parseThing");
  const tip = r.commit("src/x.ts", "export function parseThing() {\n  return 2;\n}\n", "Tune parseThing");
  r.git("checkout", "-q", "main");
  r.commit("docs/notes.md", "notes\n", "Unrelated main work");
  clock += 3_600_000;
  r.git("cherry-pick", first, tip);
  return { r, base, tip };
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

async function landing(dir: string, d: KnowledgeDoc): Promise<BranchLanding> {
  return checkBranchClaimsLanded(await RepoEvidenceContext.forDocs(dir, [d]), d);
}

describe("extractBranchMergeClaims", () => {
  const cases: Array<{ body: string; branch?: string | null }> = [
    { body: "The fix is on branch `standup/roadmap-2-allow-once-second-check-4056b0`, not yet merged.", branch: "standup/roadmap-2-allow-once-second-check-4056b0" },
    { body: "Lives on branch standup/pipeline-closeout-252b1e (not merged yet).", branch: "standup/pipeline-closeout-252b1e" },
    { body: "The `feature/wikilinks` branch is not merged.", branch: "feature/wikilinks" },
    { body: "Work sits in the worktree branch `fix-thing`; pending merge.", branch: "fix-thing" },
    { body: "Implemented in branch `feature/y`, not yet merged.", branch: "feature/y" },
    { body: "It is on unmerged branch `feature/z`.", branch: "feature/z" },
    { body: "This change is not yet merged.", branch: null },
    { body: "Pending merge to main.", branch: null },
    { body: "The parser hasn’t been merged yet.", branch: null },
    { body: "Awaiting merge after review.", branch: null },
    // Not claims:
    { body: "A doc distilled on an unmerged branch is provisional." },
    { body: "If the branch is not yet merged, the check fails." },
    { body: "`isMerged()` returns false when the work is not merged." },
    { body: "The commit abc1234f is not yet merged." },
    { body: 'The guard warns on "not yet merged" text.' },
    { body: "The revert is not yet merged." },
    { body: "Merged into main on 2026-09-01." },
    { body: "Not merged into the web package yet." },
    { body: "```\n# not yet merged\n```" },
  ];
  for (const c of cases) {
    test(`${c.body.replace(/\n/g, " ")} → ${c.branch === undefined ? "no claim" : (c.branch ?? "unnamed")}`, () => {
      const claims = extractBranchMergeClaims(c.body);
      if (c.branch === undefined) expect(claims).toEqual([]);
      else expect(claims.map((x) => x.branch)).toEqual([c.branch]);
    });
  }

  test("one claim per sentence, each with its own sentence", () => {
    const body = "Feature A is on branch `a/one`, not yet merged.\nFeature B is on branch `b/two` (not merged yet).";
    expect(extractBranchMergeClaims(body).map((c) => [c.branch, c.sentence])).toEqual([
      ["a/one", "Feature A is on branch `a/one`, not yet merged."],
      ["b/two", "Feature B is on branch `b/two` (not merged yet)."],
    ]);
  });
});

describe("unnamedUnmergedWarning", () => {
  test("warns on a not-yet-merged claim that names no branch", () => {
    expect(unnamedUnmergedWarning("The router change is not yet merged.")).toBe(UNNAMED_UNMERGED_WARNING);
    expect(UNNAMED_UNMERGED_WARNING).toBe(
      'Name the branch: write "on branch <name>, not yet merged" so Standup can expire the claim when it lands.'
    );
  });
  test("is quiet when the branch is named, or there is no claim", () => {
    expect(unnamedUnmergedWarning("The router change is on branch `feature/router`, not yet merged.")).toBeNull();
    expect(unnamedUnmergedWarning("The router lives in src/router.ts.")).toBeNull();
    expect(unnamedUnmergedWarning("A doc on an unmerged branch is provisional.")).toBeNull();
  });
});

describe("rewriteLandedClaims", () => {
  const rewrite = (body: string) => rewriteLandedClaims(body, extractBranchMergeClaims(body), "main");
  const cases: Array<[string, string]> = [
    ["The fix is on branch `x/y-1`, not yet merged.", "The fix is on `main`."],
    ["Lives on branch x/y-1 (not merged yet).", "Lives on `main`."],
    ["Implemented in branch `feature/y`, not yet merged.", "Implemented on `main`."],
    ["It is on unmerged branch `x/y-1`.", "It is on `main`."],
    ["Intro.\n- Not merged yet: the parser.", "Intro.\n- The parser."],
    // A sentence that is only the caveat goes, whole.
    ["Pending merge.\n\nThe parser reads x.", "The parser reads x."],
    ["Not yet merged into main.", ""],
    ["On branch `x/y-1`, not yet merged.\n\nThe parser reads x.", "The parser reads x."],
    ["Intro. On branch `x/y-1`, not yet merged. The parser reads x.", "Intro. The parser reads x."],
    // The rest of a sentence that says more is kept.
    [
      "On branch `standup/floor-interpreter-stdin-gaps-6d117d` (not yet merged), `packages/collector/src/floor/classify.ts` `localMerge`.",
      "`packages/collector/src/floor/classify.ts` `localMerge`.",
    ],
  ];
  for (const [before, after] of cases) {
    test(before.replace(/\n/g, " "), () => {
      expect(rewrite(before)).toBe(after);
    });
  }

  test("a caveat with a contradicting 'on mainline, still…' follow-up drops both, never garbling the sentence", () => {
    const body = [
      "This describes the design on branch `standup/hook-route-auth-c054e7`, which is not yet merged. On mainline, `/hook` is still unauthenticated.",
      "",
      "**Design** (the header comment of `packages/collector/src/hook-auth.ts` is the full spec)",
      "",
      "- **Per-launch hook token.** A floor-guarded launch gets its own hook token.",
    ].join("\n");
    const out = rewrite(body)!;
    expect(out).toBe(
      [
        "**Design** (the header comment of `packages/collector/src/hook-auth.ts` is the full spec)",
        "",
        "- **Per-launch hook token.** A floor-guarded launch gets its own hook token.",
      ].join("\n")
    );
    expect(out).not.toMatch(/which is,|landed on|still unauthenticated|not yet merged|standup\/hook-route-auth/);
  });

  test("a follow-up on the next line of the same paragraph goes too; one in another paragraph stays", () => {
    const body = "The design is on branch `a/b-1`, not yet merged.\nUntil it lands, main still retries.\n\nOn main, retries are still capped at 3.";
    expect(rewrite(body)).toBe("The design is on `main`.\n\nOn main, retries are still capped at 3.");
  });

  test("a caveat that cannot be cleanly separated writes no draft (null)", () => {
    // Two not-merged phrases in one sentence: taking one out leaves the other.
    const body = "The parser is on branch `a/b-1`, not yet merged, and the lexer has not been merged either.";
    expect(extractBranchMergeClaims(body)).toHaveLength(1);
    expect(rewrite(body)).toBeNull();
  });

  // A caveat that is part of the sentence's grammar is never cut into a fragment.
  const unseparable = [
    "`runHook` is on branch `x/y-1` and not yet merged.",
    "Note: the retry loop is on branch `x/y-1` and hasn't been merged.",
    "It was written on branch `x/y-1` and is pending merge.",
    "The `x/y-1` branch is not yet merged; it adds `runHook` to src/a.ts.",
    "Work on branch `x/y-1` is not yet merged, so main still uses the old parser.",
    "Branch `x/y-1` hasn't been merged yet, but it fixes the race in src/a.ts.",
    "The parser on branch `x/y-1`, not yet merged, handles BOM.",
    "The new parser, not yet merged, handles BOM.",
  ];
  for (const body of unseparable) {
    test(`null, not a fragment: ${body}`, () => {
      expect(extractBranchMergeClaims(body)).toHaveLength(1);
      expect(rewrite(body)).toBeNull();
    });
  }

  test("lasting facts about main after a caveat are kept; only 'still' contrasts go", () => {
    expect(rewrite("The fix is on branch `x/y-1`, not yet merged. In `main`, `drainQueue` runs until the queue is empty.")).toBe(
      "The fix is on `main`. In `main`, `drainQueue` runs until the queue is empty."
    );
    expect(rewrite("The fix is on branch `x/y-1`, not yet merged. Main does not retry on 409 responses.")).toBe(
      "The fix is on `main`. Main does not retry on 409 responses."
    );
  });

  test("a path left leading the sentence keeps its case; a lead-in label alone is dropped", () => {
    expect(rewrite("On branch `x/y-1` (not yet merged), src/a.ts reads the token.")).toBe("src/a.ts reads the token.");
    expect(rewrite("Status: on branch `x/y-1`, not yet merged.\n\nBody.")).toBe("Body.");
  });

  test("a quoted copy of the caveat inside a code block is left alone; the prose one is rewritten", () => {
    const body = "```\nOn branch `x/y-1`, not yet merged.\n```\nOn branch `x/y-1`, not yet merged.\n\nBody.";
    expect(rewrite(body)).toBe("```\nOn branch `x/y-1`, not yet merged.\n```\n\nBody.");
  });
});

describe("checkBranchClaimsLanded — by content, not ancestry", () => {
  test("a branch whose commits were rebased onto main is landed while it still exists", async () => {
    const { r } = rebasedLanding();
    const d = doc({ body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged." });
    const result = await landing(r.dir, d);
    expect(result.state).toBe("landed");
    expect(result).toMatchObject({ mainline: "main", via: "rebased-copy" });
  });

  test("after the rebased branch is deleted, the doc's sha patches and named files on main make it landed", async () => {
    const { r, tip } = rebasedLanding();
    r.git("branch", "-D", "feature/x");
    const d = doc({ body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.", generatedFromSha: tip });
    const result = await landing(r.dir, d);
    expect(result).toMatchObject({ state: "landed", mainline: "main", via: "rebased-copy" });
  });

  test("a doc written on main before the branch's commits is landed once the names it introduced are on main", async () => {
    const { r, base } = rebasedLanding();
    r.git("branch", "-D", "feature/x");
    const d = doc({ body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.", generatedFromSha: base });
    const result = await landing(r.dir, d);
    expect(result).toMatchObject({ state: "landed", via: "content" });
    if (result.state === "landed") expect(result.how).toContain("src/x.ts");
  });

  test("a branch with commits that have no copy on main is unmerged", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feature/y");
    const tip = r.commit("src/y.ts", "export function buildY() {}\n", "Add buildY");
    r.git("checkout", "-q", "main");
    const d = doc({ body: "`buildY` in src/y.ts is on branch `feature/y`, not yet merged.", generatedFromSha: tip });
    expect((await landing(r.dir, d)).state).toBe("unmerged");
  });

  test("a named branch that is gone, with the doc's files absent from main, is unknown", async () => {
    const r = repo();
    const d = doc({ body: "Adds src/gone.ts on branch `feature/gone`, not yet merged." });
    expect((await landing(r.dir, d)).state).toBe("unknown");
  });

  test("a gone branch whose work is not on main by patch is unknown, never landed", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feature/w");
    const tip = r.commit("src/w.ts", "export function wThing() {}\n", "Add wThing");
    r.git("checkout", "-q", "main");
    r.git("branch", "-D", "feature/w");
    const d = doc({ body: "`wThing` in src/w.ts is on branch `feature/w`, not yet merged.", generatedFromSha: tip });
    expect((await landing(r.dir, d)).state).toBe("unknown");
  });

  test("a doc naming nothing, with no sha and its branch gone, is unknown", async () => {
    const r = repo();
    const d = doc({ body: "The router rework is on branch `feature/router`, not yet merged." });
    expect((await landing(r.dir, d)).state).toBe("unknown");
  });
});

/** A doc shaped like floor-merge-result-overlay: its branch merged, then main dropped the design it describes. */
const DROPPED_BODY =
  "On branch `standup/floor-gaps-6d117d` (not yet merged), src/classify.ts `localMerge`.\n\nThe merge base comes from the `gitMergeBase` probe.";

/** main ← merge of `standup/floor-gaps-6d117d` (adds `localMerge`/`gitMergeBase`), then a main commit dropping both. */
function droppedDesign(): Repo {
  const r = repo();
  r.commit("src/classify.ts", "export function classify() {}\n", "classify");
  r.git("checkout", "-q", "-b", "standup/floor-gaps-6d117d");
  r.commit(
    "src/classify.ts",
    "export function classify() {}\nexport function localMerge() {}\nexport function gitMergeBase() {}\n",
    "floor: read merge results"
  );
  r.git("checkout", "-q", "main");
  r.commit("docs/notes.md", "notes\n", "Unrelated main work");
  clock += 3_600_000;
  r.git("merge", "-q", "--no-ff", "-m", "Merge floor gaps", "standup/floor-gaps-6d117d");
  r.commit("src/classify.ts", "export function classify() {}\n", "floor: drop merge-result reading");
  return r;
}

describe("checkBranchClaimsLanded — the doc's names must be on main, not only the branch's ancestry", () => {
  test("a branch merged into main whose design main later dropped is dropped, not landed", async () => {
    const r = droppedDesign();
    const result = await landing(r.dir, doc({ body: DROPPED_BODY }));
    expect(result.state).toBe("dropped");
    expect(result.how).toContain("was merged into main");
    expect(result.how).toContain("localMerge");
    expect(result.how).toContain("gitMergeBase");
  });

  test("a dropped design writes no draft, and a landed record from the ancestry-only rules is forgotten", async () => {
    const r = droppedDesign();
    const store = createStore(":memory:");
    const d = doc({ slug: "floor-merge-result-overlay", body: DROPPED_BODY });
    ensureLandedClaimsTable(store.db);
    store.db.run(
      `INSERT INTO knowledge_landed_claims (project_id, slug, body_hash, branch, mainline, how, landed_at, draft_written, via)
       VALUES ('p', 'floor-merge-result-overlay', ?, 'standup/floor-gaps-6d117d', 'main', 'merged', '2026-09-01T00:00:00.000Z', 1, 'merge')`,
      [bodyHash(d.body)]
    );
    // Found under the older rules: not shown as landed.
    expect(landedClaimFor(store.db, d)).toBeUndefined();
    const knowledgeDir = tempDir("standup-landed-knowledge-");
    const result = await expireLandedBranchClaims({ db: store.db, knowledgeDir, projects: [{ projectId: "p", repoPath: r.dir, docs: [d] }] });
    expect(result).toMatchObject({ checked: 1, landed: 0, dropped: 1, drafts: 0 });
    expect(readLandedClaims(store.db, "p").has("floor-merge-result-overlay")).toBe(false);
    expect(existsSync(join(knowledgeDir, "p", ".drafts", "floor-merge-result-overlay.md"))).toBe(false);
    store.close();
  });

  test("a branch squash-merged with edits (no patch-identical commit) is landed while it still exists", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feature/s");
    r.commit("src/s.ts", "export function squashThing() {\n  return 1;\n}\n", "Add squashThing");
    r.commit("src/t.ts", "export function tailThing() {}\n", "Add tailThing");
    r.git("checkout", "-q", "main");
    r.commit("docs/notes.md", "notes\n", "Unrelated main work");
    clock += 3_600_000;
    r.git("merge", "-q", "--squash", "feature/s");
    r.commit("CHANGELOG.md", "squashThing\n", "Land feature/s (squashed, with a changelog)");
    const d = doc({ body: "`squashThing` in src/s.ts is on branch `feature/s`, not yet merged." });
    const result = await landing(r.dir, d);
    expect(result).toMatchObject({ state: "landed", mainline: "main", via: "reapplied" });
    // Line containment ignores deletions and order: a review draft, never the LANDED marker.
    expect(isConfirmedLanding({ via: "reapplied", rules: LANDING_RULES })).toBe(false);
    expect(isConfirmedLanding({ via: "squash", rules: LANDING_RULES })).toBe(true);
  });

  test("an unrelated branch whose slug also contains 'packet' is not a sibling", async () => {
    const r = repo();
    r.commit("src/a.ts", "export function sharedThing() {}\n", "shared");
    const base = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "-b", "standup/review-packet-requires-review-link-e420fa");
    r.commit("src/review-link.ts", "export function requireReviewLink() {}\n", "require a code review link");
    r.git("checkout", "-q", "-b", "standup/review-packet-video-recordings-32024a", base);
    r.commit("src/video.ts", "export function recordVideo() {}\n", "record videos");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "-m", "Merge videos", "standup/review-packet-video-recordings-32024a");
    // A relaunch reusing the slug is unrelated work too.
    r.git("checkout", "-q", "-b", "standup/review-packet-requires-review-link-def456", base);
    r.commit("src/other.ts", "export function otherThing() {}\n", "other");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "-m", "Merge other", "standup/review-packet-requires-review-link-def456");
    const d = doc({ body: "`sharedThing` in src/a.ts is on branch `standup/review-packet-requires-review-link-e420fa`, not yet merged." });
    expect((await landing(r.dir, d)).state).toBe("unmerged");
  });

  test("a symbol the merged branch replaced, named in an 'on mainline … still' contrast, does not make it dropped", async () => {
    const r = repo();
    r.commit("src/h.ts", "export function legacyHook() {}\n", "legacy");
    r.git("checkout", "-q", "-b", "feature/auth");
    r.commit("src/h.ts", "export function authedHook() {}\n", "replace legacyHook");
    r.git("checkout", "-q", "main");
    r.commit("docs/notes.md", "notes\n", "Unrelated main work");
    clock += 3_600_000;
    r.git("merge", "-q", "--no-ff", "-m", "Merge auth", "feature/auth");
    const d = doc({
      body: "`authedHook` in src/h.ts is on branch `feature/auth`, not yet merged.\nOn mainline, `legacyHook` still serves the route.",
    });
    expect(await landing(r.dir, d)).toMatchObject({ state: "landed", via: "merge" });
  });

  test("a branch whose only landed commit is a cherry-picked helper stays unmerged", async () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feature/part");
    const helper = r.commit("src/p.ts", "export function partHelper() {}\n", "helper");
    r.commit("src/design.ts", "export function realDesign() {\n  return 1;\n}\n", "the design");
    r.git("checkout", "-q", "main");
    r.commit("docs/notes.md", "notes\n", "Unrelated main work");
    clock += 3_600_000;
    r.git("cherry-pick", helper);
    const d = doc({ body: "`partHelper` in src/p.ts is on branch `feature/part`, not yet merged." });
    expect((await landing(r.dir, d)).state).toBe("unmerged");
  });

  test("a branch whose work landed through its -continue- sibling is landed", async () => {
    const r = repo();
    const base = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "-b", "standup/foo-abc123");
    r.commit("src/f.ts", "export function fooThing() {\n  return 'draft';\n}\n", "foo: first try");
    r.git("checkout", "-q", "-b", "standup/foo-continue-def456", base);
    const redo = r.commit("src/f.ts", "export function fooThing() {\n  return 'final';\n}\n", "foo: redo");
    r.git("checkout", "-q", "main");
    r.commit("docs/notes.md", "notes\n", "Unrelated main work");
    clock += 3_600_000;
    r.git("cherry-pick", redo);
    const d = doc({ body: "`fooThing` in src/f.ts is on branch `standup/foo-abc123`, not yet merged." });
    const result = await landing(r.dir, d);
    expect(result).toMatchObject({ state: "landed", mainline: "main", via: "rebased-copy" });
    expect(result.how).toContain("standup/foo-continue-def456");
  });

  test("a branch rewritten and landed under an unrelated name is landed by content (unconfirmed)", async () => {
    const r = repo();
    const base = r.git("rev-parse", "HEAD");
    r.git("checkout", "-q", "-b", "feature/first");
    r.commit("src/g.ts", "export function gThing() {\n  return 'draft';\n}\n", "g: first try");
    r.git("checkout", "-q", "main");
    expect(r.git("rev-parse", "HEAD")).toBe(base);
    r.commit("src/g.ts", "export function gThing() {\n  return 'final';\n}\n", "g: land a rewrite");
    const result = await landing(r.dir, doc({ body: "`gThing` in src/g.ts is on branch `feature/first`, not yet merged." }));
    expect(result).toMatchObject({ state: "landed", via: "content" });
  });
});

describe("evidence pass and maintenance", () => {
  test("a landed claim drops the doc's unmerged finding and cap, and a review draft rewrites the sentence", async () => {
    const { r } = rebasedLanding();
    // The checkout sits behind main, so `parseThing` is missing at HEAD and
    // found only on the still-present `feature/x` tip: an unmerged finding.
    r.git("checkout", "-q", "--detach", "HEAD~3");
    const body = "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.";
    const d = doc({ slug: "parser", body, originClass: "owner", sourceKind: "code" });
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [r.dir] });
    new KnowledgeStore(store.db).upsertDoc(d);
    const drafts: Array<{ projectId: string; slug: string; body: string; replacesSlug?: string }> = [];
    const base: EvidencePassDeps = {
      readFrontmatter: async () => ({}),
      record: (projectId, records, at) => replaceProjectFreshness(store.db, projectId, records, at),
    };

    const without = await runEvidencePass(base, "p", [d], r.dir);
    expect(without.findings.parser?.map((f) => f.kind)).toEqual(["unmerged"]);
    expect(freshnessGate(store.db).inputs({ projectId: "p", slug: "parser" }).confidence).toBe(EVIDENCE_CONFIDENCE_CAPS.unmerged);

    const deps: EvidencePassDeps = {
      ...base,
      landedClaims: {
        read: (projectId) => readLandedClaims(store.db, projectId),
        record: landedClaimDeps(store.db, "/nonexistent").record,
        writeDraft: async (projectId, draft) => {
          drafts.push({ projectId, slug: draft.slug, body: draft.body, replacesSlug: draft.replacesSlug });
          return true;
        },
      },
    };
    const first = await runEvidencePass(deps, "p", [d], r.dir);
    expect(first.findings.parser).toBeUndefined();
    expect(first.capped).toEqual([]);
    expect(first.landed).toEqual([{ slug: "parser", how: expect.stringContaining("feature/x"), draftWritten: true }]);
    expect(readProjectFreshness(store.db, "p").get("parser")?.cap).toBeUndefined();
    expect(freshnessGate(store.db).inputs({ projectId: "p", slug: "parser" }).confidence).toBe(DEFAULT_BASE_CONFIDENCE);
    expect(drafts).toEqual([
      {
        projectId: "p",
        slug: "parser",
        replacesSlug: "parser",
        body: "`parseThing` in src/x.ts is on `main`.",
      },
    ]);

    // Search and injection read the record for the doc's current body.
    const rec = landedClaimFor(store.db, d);
    expect(rec).toMatchObject({ branch: "feature/x", mainline: "main" });
    const marker = landedClaimMarker(rec!);
    expect(marker).toContain("LANDED");
    expect(marker).not.toMatch(/not (?:yet )?merged|unmerged/i);
    expect(landedClaimFor(store.db, { ...d, body: `${body}\nEdited.` })).toBeUndefined();

    // Idempotent: the same body is not checked or drafted again.
    const second = await runEvidencePass(deps, "p", [d], r.dir);
    expect(second.landed).toEqual([{ slug: "parser", how: expect.any(String), draftWritten: false }]);
    expect(second.findings.parser).toBeUndefined();
    expect(drafts.length).toBe(1);
    store.close();
  });

  test("expireLandedBranchClaims records landings, writes drafts, clears stored findings, and is idempotent", async () => {
    const { r, tip } = rebasedLanding();
    r.git("branch", "-D", "feature/x");
    r.git("checkout", "-q", "-b", "feature/y");
    const yTip = r.commit("src/y.ts", "export function buildY() {}\n", "Add buildY");
    r.git("checkout", "-q", "main");
    const knowledgeDir = tempDir("standup-landed-knowledge-");
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [r.dir] });
    const k = new KnowledgeStore(store.db);
    const landedDoc = doc({
      slug: "parser",
      title: "Parser",
      body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.",
      generatedFromSha: tip,
      sourceKind: "code",
      tags: ["parser"],
    });
    const openDoc = doc({ slug: "builder", body: "`buildY` in src/y.ts is on branch `feature/y`, not yet merged.", generatedFromSha: yTip });
    const unknownDoc = doc({ slug: "router", body: "The router rework is on branch `feature/router`, not yet merged." });
    const plainDoc = doc({ slug: "plain", body: "The router lives in src/router.ts." });
    for (const d of [landedDoc, openDoc, unknownDoc, plainDoc]) k.upsertDoc(d);
    replaceProjectFreshness(
      store.db,
      "p",
      [{ slug: "parser", cap: EVIDENCE_CONFIDENCE_CAPS.unmerged, findings: [{ kind: "unmerged", detail: "stale" }] }],
      "2026-09-01T00:00:00.000Z"
    );
    expect(freshnessGate(store.db).inputs({ projectId: "p", slug: "parser" }).confidence).toBe(EVIDENCE_CONFIDENCE_CAPS.unmerged);
    const synced: string[] = [];
    const deps = { db: store.db, knowledgeDir, syncDrafts: async (projectId: string) => void synced.push(projectId) };

    const first = await expireLandedBranchClaims(deps);
    expect(first).toEqual({ checked: 3, landed: 1, alreadyLanded: 0, unmerged: 1, dropped: 0, unknown: 1, drafts: 1, findingsCleared: 1 });
    expect(synced).toEqual(["p"]);
    const draftPath = join(knowledgeDir, "p", ".drafts", "parser.md");
    expect(existsSync(draftPath)).toBe(true);
    const draft = readFileSync(draftPath, "utf-8");
    expect(draft).toContain("`parseThing` in src/x.ts is on `main`.");
    expect(draft).not.toContain("not yet merged");
    expect(draft).toContain("replaces_slug: parser");
    // A record left with nothing to say is not stored at all.
    expect(readProjectFreshness(store.db, "p").get("parser")).toBeUndefined();
    expect(freshnessGate(store.db).inputs({ projectId: "p", slug: "parser" }).confidence).toBe(DEFAULT_BASE_CONFIDENCE);
    expect(readLandedClaims(store.db, "p").get("parser")).toMatchObject({ branch: "feature/x", mainline: "main" });

    const second = await expireLandedBranchClaims(deps);
    expect(second).toEqual({ checked: 3, landed: 0, alreadyLanded: 1, unmerged: 1, dropped: 0, unknown: 1, drafts: 0, findingsCleared: 0 });
    expect(synced).toEqual(["p"]);
    store.close();
  });

  test("a landing found by the branch shows the marker; one inferred from content only writes the draft", async () => {
    const { r, base, tip } = rebasedLanding();
    r.git("branch", "-D", "feature/x");
    const knowledgeDir = tempDir("standup-landed-knowledge-");
    const store = createStore(":memory:");
    const body = "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.";
    const byBranch = doc({ slug: "by-branch", body, generatedFromSha: tip });
    const byContent = doc({ slug: "by-content", body, generatedFromSha: base });
    replaceProjectFreshness(
      store.db,
      "p",
      [
        { slug: "by-branch", cap: EVIDENCE_CONFIDENCE_CAPS.unmerged, findings: [{ kind: "unmerged", detail: "stale" }] },
        { slug: "by-content", cap: EVIDENCE_CONFIDENCE_CAPS.unmerged, findings: [{ kind: "unmerged", detail: "stale" }] },
      ],
      "2026-09-01T00:00:00.000Z"
    );
    const result = await expireLandedBranchClaims({
      db: store.db,
      knowledgeDir,
      projects: [{ projectId: "p", repoPath: r.dir, docs: [byBranch, byContent] }],
    });
    expect(result).toMatchObject({ landed: 2, drafts: 2, findingsCleared: 1 });

    const records = readLandedClaims(store.db, "p");
    expect(records.get("by-branch")?.via).toBe("rebased-copy");
    expect(records.get("by-content")?.via).toBe("content");
    expect(isConfirmedLanding(records.get("by-branch")!)).toBe(true);
    expect(isConfirmedLanding(records.get("by-content")!)).toBe(false);

    // Search and injection mark only the branch-based landing.
    expect(landedClaimFor(store.db, byBranch)).toMatchObject({ branch: "feature/x", mainline: "main" });
    expect(landedClaimFor(store.db, byContent)).toBeUndefined();
    // The inferred one keeps its unmerged finding; its review draft is pending.
    expect(readProjectFreshness(store.db, "p").get("by-branch")).toBeUndefined();
    expect(readProjectFreshness(store.db, "p").get("by-content")?.findings.map((f) => f.kind)).toEqual(["unmerged"]);
    const draft = readFileSync(join(knowledgeDir, "p", ".drafts", "by-content.md"), "utf-8");
    expect(draft).toContain("`parseThing` in src/x.ts is on `main`.");
    expect(draft).not.toContain("not yet merged");

    // Idempotent for both.
    const again = await expireLandedBranchClaims({
      db: store.db,
      knowledgeDir,
      projects: [{ projectId: "p", repoPath: r.dir, docs: [byBranch, byContent] }],
    });
    expect(again).toMatchObject({ landed: 0, alreadyLanded: 2, drafts: 0 });
    expect(landedClaimFor(store.db, byContent)).toBeUndefined();
    store.close();
  });

  test("a record stored without how the work landed is not shown, and the next check fills it in", async () => {
    const { r, tip } = rebasedLanding();
    r.git("branch", "-D", "feature/x");
    const store = createStore(":memory:");
    const d = doc({ slug: "parser", body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.", generatedFromSha: tip });
    ensureLandedClaimsTable(store.db);
    store.db.run(
      `INSERT INTO knowledge_landed_claims (project_id, slug, body_hash, branch, mainline, how, landed_at, draft_written)
       VALUES ('p', 'parser', ?, 'feature/x', 'main', 'legacy', '2026-09-01T00:00:00.000Z', 1)`,
      [bodyHash(d.body)]
    );
    expect(landedClaimFor(store.db, d)).toBeUndefined();
    const result = await expireLandedBranchClaims({
      db: store.db,
      knowledgeDir: tempDir("standup-landed-knowledge-"),
      projects: [{ projectId: "p", repoPath: r.dir, docs: [d] }],
    });
    expect(result).toMatchObject({ landed: 1, alreadyLanded: 0 });
    expect(landedClaimFor(store.db, d)?.via).toBe("rebased-copy");
    store.close();
  });

  test("a table created before `via` existed gains the column on read", () => {
    const store = createStore(":memory:");
    store.db.run(
      `CREATE TABLE knowledge_landed_claims (project_id TEXT NOT NULL, slug TEXT NOT NULL, body_hash TEXT NOT NULL,
         branch TEXT, mainline TEXT NOT NULL, how TEXT NOT NULL, landed_at TEXT NOT NULL,
         draft_written INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, slug))`
    );
    store.db.run(
      "INSERT INTO knowledge_landed_claims VALUES ('p', 's', 'h', NULL, 'main', 'old', '2026-09-01T00:00:00.000Z', 0)"
    );
    const rec = readLandedClaims(store.db, "p").get("s");
    expect(rec).toMatchObject({ slug: "s", mainline: "main" });
    expect(rec?.via).toBeUndefined();
    store.close();
  });

  test("a draft already pending for the slug is never overwritten", async () => {
    const { r, tip } = rebasedLanding();
    const knowledgeDir = tempDir("standup-landed-knowledge-");
    mkdirSync(join(knowledgeDir, "p", ".drafts"), { recursive: true });
    writeFileSync(join(knowledgeDir, "p", ".drafts", "parser.md"), "---\ntitle: Mine\n---\nA human's draft.\n");
    const store = createStore(":memory:");
    const d = doc({ slug: "parser", body: "`parseThing` in src/x.ts is on branch `feature/x`, not yet merged.", generatedFromSha: tip });
    const result = await expireLandedBranchClaims({
      db: store.db,
      knowledgeDir,
      projects: [{ projectId: "p", repoPath: r.dir, docs: [d] }],
    });
    expect(result).toMatchObject({ landed: 1, drafts: 0 });
    expect(readFileSync(join(knowledgeDir, "p", ".drafts", "parser.md"), "utf-8")).toContain("A human's draft.");
    store.close();
  });
});
