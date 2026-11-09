import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { verifyDraft, type VerifyOptions } from "./draft-verify.js";
import { isPathLike, quoteIsDistinctive, quoteNearLine } from "./knowledge-dispute-evidence.js";
import { gitFetch, privateClonePath, refreshMainline, runGit, type GitRun, type MainlineFetch } from "./knowledge-mainline.js";
import { setActiveOrgProfile } from "./org-profile/load.js";
import { exampleCorpProfile } from "./org-profile/fixtures/example-corp.js";

/** Runs git in `cwd`, failing the test on a non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** sandbox_core.py with `MAX_CASES = <n>` on line 47 when `n` is given. */
function sandboxCore(n?: number): string {
  const lines = Array.from({ length: 46 }, (_, i) => `# line ${i + 1}`);
  if (n !== undefined) lines.push(`MAX_CASES = ${n}`);
  lines.push("def run():", "    return MAX_CASES" + (n === undefined ? "_UNSET" : ""));
  return `${lines.join("\n")}\n`;
}

let root: string;
/** A clone whose origin/main predates the commit that added MAX_CASES, with an unpushed local commit. */
let stale: string;
let remoteHead: string;
let noRemote: string;

beforeAll(() => {
  // Real path: git reports the clone's paths resolved, and TMPDIR may sit behind a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "draft-verify-")));
  const remote = join(root, "remote.git");
  const author = join(root, "author");
  stale = join(root, "stale");
  noRemote = join(root, "no-remote");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(root, "clone", "--quiet", remote, author);
  writeFileSync(join(author, "sandbox_core.py"), sandboxCore());
  git(author, "add", ".");
  git(author, "commit", "--quiet", "-m", "init");
  git(author, "push", "--quiet", "origin", "HEAD:main");
  git(root, "clone", "--quiet", remote, stale);
  writeFileSync(join(stale, "local_only.py"), "UNMERGED = 1\n");
  git(stale, "add", ".");
  git(stale, "commit", "--quiet", "-m", "unmerged work");
  writeFileSync(join(author, "sandbox_core.py"), sandboxCore(10));
  git(author, "commit", "--quiet", "-am", "add MAX_CASES");
  git(author, "push", "--quiet", "origin", "HEAD:main");
  remoteHead = git(author, "rev-parse", "HEAD");
  git(root, "init", "--quiet", noRemote);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Options with a private fetch cache and clone root, and a stub model answering `reply(dirs)`. */
function options(reply: (dirs: string[]) => object, extra: VerifyOptions = {}): VerifyOptions {
  return {
    runModel: async (_prompt, dirs) => JSON.stringify(reply(dirs)),
    ...extra,
    mainline: { cache: new Map(), cloneRoot: join(root, "clones"), ...extra.mainline },
  };
}

/** Every path under `dir` with its mtime and content, for detecting any write. */
function manifest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const stat = statSync(path);
    out[relative(dir, path)] = entry.isFile() ? `${stat.mtimeMs}:${readFileSync(path).toString("base64")}` : `${stat.mtimeMs}`;
  }
  out["."] = `${statSync(dir).mtimeMs}`;
  return out;
}

const BODY = "The sandbox caps runs with MAX_CASES = 5 in sandbox_core.py.";

describe("verifyDraft reads the freshly fetched mainline", () => {
  test("a symbol on the remote's mainline but not the stale local ref is found, and unmerged local work is not visible", async () => {
    expect(git(stale, "rev-parse", "origin/main")).not.toBe(remoteHead);
    let seen: { maxCases: boolean; localOnly: boolean } | null = null;
    const result = await verifyDraft(
      "s",
      BODY,
      stale,
      options((dirs) => {
        const core = readFileSync(join(dirs[0]!, "sandbox_core.py"), "utf8");
        seen = { maxCases: core.includes("MAX_CASES = 10"), localOnly: existsSync(join(dirs[0]!, "local_only.py")) };
        // What a checker reading the stale ref would claim.
        return seen.maxCases
          ? { disputes: [] }
          : {
              disputes: [
                {
                  kind: "absent",
                  claim: "MAX_CASES = 5",
                  finding: "MAX_CASES does not exist",
                  evidence: "rg MAX_CASES",
                  symbol: "MAX_CASES =",
                  searched: [join(dirs[0]!, "sandbox_core.py")],
                },
              ],
            };
      })
    );
    expect(seen!).toEqual({ maxCases: true, localOnly: false });
    expect(result.verdict).toBe("clean");
    expect(result.refs).toEqual([{ repo: stale, ref: "origin/main", sha: remoteHead }]);
    // The fetch went into the private clone, not the checkout.
    expect(git(stale, "rev-parse", "origin/main")).not.toBe(remoteHead);
    expect(git(stale, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("a local main strictly ahead of origin (merged locally, never pushed) is the tree read", async () => {
    // Shaped like the owner's install: work merged into local main, origin far behind.
    const ahead = join(root, "ahead");
    git(root, "clone", "--quiet", join(root, "remote.git"), ahead);
    writeFileSync(join(ahead, "runtime.ts"), "export class PersonaRuntime { publish() {} }\n");
    git(ahead, "add", ".");
    git(ahead, "commit", "--quiet", "-m", "merge persona runtime locally");
    const localHead = git(ahead, "rev-parse", "HEAD");
    expect(git(ahead, "rev-parse", "origin/main")).toBe(remoteHead);
    let sawRuntime = false;
    const result = await verifyDraft(
      "s",
      "`PersonaRuntime.publish` lives in runtime.ts.",
      ahead,
      options((dirs) => {
        sawRuntime = existsSync(join(dirs[0]!, "runtime.ts"));
        return sawRuntime
          ? { disputes: [] }
          : {
              disputes: [
                { kind: "absent", claim: "runtime.ts", finding: "runtime.ts does not exist", evidence: "ls", symbol: "PersonaRuntime", searched: [dirs[0]!] },
              ],
            };
      })
    );
    expect(sawRuntime).toBe(true);
    expect(result.verdict).toBe("clean");
    expect(result.refs).toEqual([{ repo: ahead, ref: "main", sha: localHead }]);
    // The source is still only read: its origin/main has not moved.
    expect(git(ahead, "rev-parse", "origin/main")).toBe(remoteHead);

    // A further local merge within the fetch cache's lifetime is read at once.
    const cache = new Map();
    const cloneRoot = join(root, "ahead-clones");
    const first = await refreshMainline(ahead, { cache, cloneRoot });
    expect(first.ok && first.ref.sha).toBe(localHead);
    writeFileSync(join(ahead, "drain.ts"), "export function drain() {}\n");
    git(ahead, "add", ".");
    git(ahead, "commit", "--quiet", "-m", "merge drain locally");
    const second = await refreshMainline(ahead, { cache, cloneRoot });
    expect(second.ok && second.ref.sha).toBe(git(ahead, "rev-parse", "HEAD"));
  });

  test("a code-review repo's local mainline ahead of origin is work in review, so origin is read", async () => {
    const reviewed = join(root, "reviewed");
    git(root, "clone", "--quiet", join(root, "remote.git"), reviewed);
    // On the example.corp profile's code host without reaching any host: ls-remote on it fails locally.
    git(reviewed, "remote", "set-url", "origin", join(root, "missing", "code.example.corp", "StandupFixture"));
    writeFileSync(join(reviewed, "in_review.py"), "IN_REVIEW = 1\n");
    git(reviewed, "add", ".");
    git(reviewed, "commit", "--quiet", "-m", "committed locally before its review");
    // The review host is unreachable here: fetch from the fixture remote instead.
    const fetch: MainlineFetch = async (gitDir, branch) => {
      const res = await runGit(["--git-dir", gitDir, "fetch", "--quiet", join(root, "remote.git"), `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      return res.exitCode === 0 ? null : res.stderr;
    };
    let sawInReview = true;
    setActiveOrgProfile(exampleCorpProfile());
    try {
      const result = await verifyDraft(
        "s",
        BODY,
        reviewed,
        options((dirs) => ((sawInReview = existsSync(join(dirs[0]!, "in_review.py"))), { disputes: [] }), {
          mainline: { fetch, cloneRoot: join(root, "reviewed-clones") },
        })
      );
      expect(sawInReview).toBe(false);
      expect(result.refs).toEqual([{ repo: reviewed, ref: "origin/main", sha: remoteHead }]);
    } finally {
      setActiveOrgProfile();
    }
  });

  test("the source repository's git directory is left exactly as it was", async () => {
    const before = manifest(join(stale, ".git"));
    const cloneRoot = join(root, "untouched-clones");
    for (let i = 0; i < 2; i++) {
      const result = await verifyDraft("s", BODY, stale, options(() => ({ disputes: [] }), { mainline: { cloneRoot } }));
      expect(result.verdict).toBe("clean");
    }
    expect(manifest(join(stale, ".git"))).toEqual(before);
  });

  test("the private clone is made on first use and fetched into incrementally after", async () => {
    const cloneRoot = join(root, "reuse-clones");
    const clone = privateClonePath(join(stale, ".git"), cloneRoot);
    let dirsSeen: string[] = [];
    const reply = (dirs: string[]) => ((dirsSeen = dirs), { disputes: [] });
    const first = await verifyDraft("s", BODY, stale, options(reply, { mainline: { cloneRoot } }));
    expect(first.verdict).toBe("clean");
    expect(dirsSeen).toEqual([clone]);
    expect(readFileSync(join(clone, ".git", "objects", "info", "alternates"), "utf8").trim()).toBe(join(stale, ".git", "objects"));
    expect(git(clone, "remote", "get-url", "origin")).toBe(join(root, "remote.git"));
    expect(git(clone, "rev-parse", "HEAD")).toBe(remoteHead);
    const marker = join(clone, ".git", "reuse-marker");
    writeFileSync(marker, "");
    const second = await verifyDraft("s", BODY, stale, options(reply, { mainline: { cloneRoot } }));
    expect(second.verdict).toBe("clean");
    expect(existsSync(marker)).toBe(true);
  });

  test("a clone whose borrowed objects are gone is made again", async () => {
    const cloneRoot = join(root, "broken-clones");
    const clone = privateClonePath(join(stale, ".git"), cloneRoot);
    expect((await verifyDraft("s", BODY, stale, options(() => ({ disputes: [] }), { mainline: { cloneRoot } }))).verdict).toBe("clean");
    const marker = join(clone, ".git", "broken-marker");
    writeFileSync(marker, "");
    writeFileSync(join(clone, ".git", "objects", "info", "alternates"), "/nonexistent/objects\n");
    writeFileSync(join(clone, ".git", "refs", "remotes", "origin", "main"), "0".repeat(40) + "\n");
    rmSync(join(clone, ".git", "index"), { force: true });
    let seen = false;
    const again = await verifyDraft(
      "s",
      BODY,
      stale,
      options((dirs) => ((seen = readFileSync(join(dirs[0]!, "sandbox_core.py"), "utf8").includes("MAX_CASES = 10")), { disputes: [] }), {
        mainline: { cloneRoot },
      })
    );
    expect(again.verdict).toBe("clean");
    expect(seen).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(clone, "rev-parse", "HEAD")).toBe(remoteHead);
  });

  test("a failed fetch, or no remote, is unverifiable rather than a verdict from stale refs", async () => {
    let modelRan = false;
    const failing: MainlineFetch = async () => "fatal: unable to access remote";
    const result = await verifyDraft(
      "s",
      BODY,
      stale,
      options(() => ((modelRan = true), { disputes: [] }), { mainline: { cache: new Map(), fetch: failing } })
    );
    expect(result.verdict).toBe("unverifiable");
    expect(result.disputes).toHaveLength(1);
    expect(result.disputes[0]!.claim).toContain("could not refresh mainline");
    expect(result.disputes[0]!.origin).toBe("repo");
    const bare = await verifyDraft("s", BODY, noRemote, options(() => ((modelRan = true), { disputes: [] })));
    expect(bare.verdict).toBe("unverifiable");
    expect(bare.disputes[0]!.claim).toContain("no origin remote");
    expect(modelRan).toBe(false);
  });

  test("one fetch per repository serves a burst of checks", async () => {
    let fetches = 0;
    const real = gitFetch(runGit);
    const counting: MainlineFetch = async (gitDir, branch) => {
      fetches++;
      return real(gitDir, branch);
    };
    const cache = new Map();
    const cloneRoot = join(root, "burst-clones");
    const burst = await Promise.all([0, 1, 2].map(() => refreshMainline(stale, { cache, cloneRoot, fetch: counting })));
    for (const r of burst) expect(r.ok).toBe(true);
    expect(fetches).toBe(1);
    const later = await refreshMainline(stale, { cache, cloneRoot, fetch: counting, now: () => Date.now() + 10 * 60_000 });
    expect(later.ok).toBe(true);
    expect(fetches).toBe(2);
  });
});

describe("verifyDraft keeps a dispute only when its evidence holds at the verified commit", () => {
  const cite = (dirs: string[], line: number, quote: string) => ({
    disputes: [
      {
        kind: "contradicted",
        claim: "MAX_CASES = 5",
        finding: "MAX_CASES is 10",
        evidence: "rg MAX_CASES",
        citations: [{ file: join(dirs[0]!, "sandbox_core.py"), line, quote }],
      },
    ],
  });

  test("a quote that is not at the cited line is dropped and counted, leaving the doc unverified, never clean", async () => {
    const result = await verifyDraft("s", BODY, stale, options((dirs) => cite(dirs, 47, "MAX_CASES = 99")));
    expect(result.verdict).toBe("unverified");
    expect(result.dropped?.count).toBe(1);
    expect(result.dropped?.reasons[0]).toContain("sandbox_core.py:47");
    expect(result.disputes).toEqual([expect.objectContaining({ claim: result.dropped!.reasons[0], origin: "repo" })]);
    // The right text far from the cited line is dropped too.
    const far = await verifyDraft("s", BODY, stale, options((dirs) => cite(dirs, 20, "MAX_CASES = 10")));
    expect(far.dropped?.count).toBe(1);
  });

  test("a located quote that holds the claimed value is refuted, not a dispute", async () => {
    const agreeing = (dirs: string[]) => ({
      disputes: [
        {
          kind: "contradicted",
          claim: "MAX_CASES = 10",
          finding: "MAX_CASES differs",
          evidence: "rg MAX_CASES",
          citations: [{ file: join(dirs[0]!, "sandbox_core.py"), line: 45, quote: "MAX_CASES = 10" }],
        },
      ],
    });
    const result = await verifyDraft("s", BODY, stale, options(agreeing));
    expect(result.verdict).toBe("unverified");
    expect(result.dropped?.count).toBe(1);
    expect(result.dropped?.reasons[0]).toContain("refuted");
  });

  test("an absence claim for a symbol present at the ref is dropped", async () => {
    const result = await verifyDraft(
      "s",
      BODY,
      stale,
      options((dirs) => ({
        disputes: [
          {
            kind: "absent",
            claim: "MAX_CASES = 5",
            finding: "MAX_CASES does not exist in the sandbox",
            evidence: "rg MAX_CASES",
            symbol: "MAX_CASES",
            searched: [join(dirs[0]!, "sandbox_core.py")],
          },
          { kind: "absent", claim: "x", finding: "y is missing", evidence: "rg y", symbol: "NOWHERE_SYMBOL" },
        ],
      }))
    );
    expect(result.verdict).toBe("unverified");
    expect(result.dropped?.count).toBe(2);
    expect(result.dropped?.reasons[0]).toContain(`"MAX_CASES" is present at origin/main@${remoteHead.slice(0, 7)}`);
    expect(result.dropped?.reasons[1]).toContain("no file searched");
  });

  test("a genuine quoted dispute is kept, with its paths pointing at the checkout", async () => {
    const result = await verifyDraft("s", BODY, stale, options((dirs) => cite(dirs, 45, "MAX_CASES = 10")));
    expect(result.verdict).toBe("disputed");
    expect(result.dropped).toBeUndefined();
    expect(result.disputes).toHaveLength(1);
    expect(result.disputes[0]!.citations).toEqual([{ file: join(stale, "sandbox_core.py"), line: 45, quote: "MAX_CASES = 10" }]);
    const absent = await verifyDraft(
      "s",
      "NOWHERE_SYMBOL configures it.",
      stale,
      options((dirs) => ({
        disputes: [
          {
            kind: "absent",
            claim: "NOWHERE_SYMBOL configures it",
            finding: "NOWHERE_SYMBOL is not defined",
            evidence: "rg NOWHERE_SYMBOL",
            symbol: "NOWHERE_SYMBOL",
            searched: [dirs[0]!],
          },
        ],
      }))
    );
    expect(absent.verdict).toBe("disputed");
    expect(absent.disputes[0]!.searched).toEqual([stale]);
  });

  const absentFile = (symbol: string) => ({
    kind: "absent",
    claim: `${symbol} holds the sandbox`,
    finding: `${symbol} does not exist`,
    evidence: `ls ${symbol}`,
    symbol,
    searched: ["/"],
  });

  test("an absence claim about a file that exists at the ref is dropped, by name, relative path or absolute path", async () => {
    for (const symbol of ["sandbox_core.py", "./sandbox_core.py"]) {
      const result = await verifyDraft("s", BODY, stale, options(() => ({ disputes: [absentFile(symbol)] })));
      expect(result.verdict).toBe("unverified");
      expect(result.dropped?.reasons[0]).toContain(`the file "${symbol}" exists at origin/main@${remoteHead.slice(0, 7)}`);
    }
    const absolute = await verifyDraft(
      "s",
      BODY,
      stale,
      options((dirs) => ({ disputes: [absentFile(join(dirs[0]!, "sandbox_core.py"))] }))
    );
    expect(absolute.verdict).toBe("unverified");
    expect(absolute.dropped?.reasons[0]).toContain(`the file "${join(stale, "sandbox_core.py")}" exists`);
    const missing = await verifyDraft("s", BODY, stale, options(() => ({ disputes: [absentFile("src/missing_mod.py")] })));
    expect(missing.verdict).toBe("disputed");
  });

  test("an absence that cannot be confirmed because the search failed or timed out is dropped", async () => {
    const failing =
      (command: string, exitCode: number): GitRun =>
      async (args, timeoutMs) =>
        args.includes(command) ? { exitCode, stdout: "", stderr: "fatal: failed" } : runGit(args, timeoutMs);
    for (const [command, exitCode, symbol] of [
      ["grep", 128, "NOWHERE_SYMBOL"],
      ["grep", 143, "NOWHERE_SYMBOL"],
      ["ls-tree", 128, "src/missing_mod.py"],
    ] as const) {
      const result = await verifyDraft(
        "s",
        BODY,
        stale,
        options(() => ({ disputes: [absentFile(symbol)] }), { mainline: { git: failing(command, exitCode) } })
      );
      expect(result.verdict).toBe("unverified");
      expect(result.dropped?.count).toBe(1);
      expect(result.dropped?.reasons[0]).toContain("evidence check failed");
    }
  });

  test("a contradiction needs a distinctive quote; only an explicit absence skips the quote", async () => {
    const short = await verifyDraft("s", BODY, stale, options((dirs) => cite(dirs, 47, "10")));
    expect(short.verdict).toBe("unverified");
    expect(short.dropped?.reasons[0]).toContain("too short to locate");
    const unkinded = await verifyDraft(
      "s",
      BODY,
      stale,
      options(() => ({ disputes: [{ claim: "x", finding: "NOWHERE_SYMBOL is missing", evidence: "rg", symbol: "NOWHERE_SYMBOL", searched: ["/"] }] }))
    );
    expect(unkinded.verdict).toBe("unverified");
    expect(unkinded.dropped?.reasons[0]).toContain("cites no quoted line");
  });

  test("a further repository whose mainline cannot be refreshed leaves a dispute-free check unverifiable, not clean", async () => {
    const result = await verifyDraft("s", BODY, stale, options(() => ({ disputes: [] }), { additionalRepos: [noRemote] }));
    expect(result.verdict).toBe("unverifiable");
    expect(result.disputes).toEqual([
      expect.objectContaining({ claim: expect.stringContaining(`could not refresh mainline of ${noRemote}`), origin: "repo" }),
    ]);
    const disputed = await verifyDraft("s", BODY, stale, options((dirs) => cite(dirs, 47, "MAX_CASES = 10"), { additionalRepos: [noRemote] }));
    expect(disputed.verdict).toBe("disputed");
  });

  test("a clone left dirty by an earlier check is reset and cleaned before the next, even at the same commit", async () => {
    const cache = new Map();
    const cloneRoot = join(root, "dirty-clones");
    const clone = privateClonePath(join(stale, ".git"), cloneRoot);
    expect((await verifyDraft("s", BODY, stale, options(() => ({ disputes: [] }), { mainline: { cache, cloneRoot } }))).verdict).toBe(
      "clean"
    );
    writeFileSync(join(clone, "sandbox_core.py"), "MAX_CASES = 5\n");
    writeFileSync(join(clone, "stray.py"), "STRAY = 1\n");
    let seen: { core: string; stray: boolean } | null = null;
    await verifyDraft(
      "s",
      BODY,
      stale,
      options(
        (dirs) => ((seen = { core: readFileSync(join(dirs[0]!, "sandbox_core.py"), "utf8"), stray: existsSync(join(dirs[0]!, "stray.py")) }), { disputes: [] }),
        { mainline: { cache, cloneRoot } }
      )
    );
    expect(seen!.core).toBe(sandboxCore(10));
    expect(seen!.stray).toBe(false);
  });
});

describe("the default branch is asked of the remote", () => {
  test("a source whose origin/HEAD is stale is checked at the branch the remote now names", async () => {
    const base = join(root, "moved-head");
    const remote = join(base, "remote.git");
    const author = join(base, "author");
    const source = join(base, "source");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    git(root, "clone", "--quiet", remote, author);
    writeFileSync(join(author, "a.txt"), "on main\n");
    git(author, "add", ".");
    git(author, "commit", "--quiet", "-m", "main");
    git(author, "push", "--quiet", "origin", "HEAD:main");
    git(root, "clone", "--quiet", remote, source);
    writeFileSync(join(author, "a.txt"), "on trunk\n");
    git(author, "commit", "--quiet", "-am", "trunk");
    git(author, "push", "--quiet", "origin", "HEAD:trunk");
    const trunk = git(author, "rev-parse", "HEAD");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
    expect(git(source, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");

    const refreshed = await refreshMainline(source, { cache: new Map(), cloneRoot: join(base, "clones") });
    expect(refreshed.ok && { ref: refreshed.ref.ref, sha: refreshed.ref.sha }).toEqual({ ref: "origin/trunk", sha: trunk });
    // The source's own refs are left as they were.
    expect(git(source, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
  });
});

describe("quoteNearLine", () => {
  const text = ["a", "b", "c", "d", "e = 1", "f", "g", "h", "i"].join("\n");
  test("matches at or within three lines, ignoring whitespace and a line-number gutter", () => {
    expect(quoteNearLine(text, 5, "e = 1")).toBe(true);
    expect(quoteNearLine(text, 2, "e  =  1")).toBe(true);
    expect(quoteNearLine(text, 8, "     5→e = 1")).toBe(true);
    expect(quoteNearLine(text, 9, "e = 1")).toBe(false);
    expect(quoteNearLine(text, 5, "e = 2")).toBe(false);
    expect(quoteNearLine(text, 5, "")).toBe(false);
    expect(quoteNearLine(text, 0, "e = 1")).toBe(false);
  });
});

describe("quoteIsDistinctive and isPathLike", () => {
  test("a quote needs two tokens or twelve non-whitespace characters", () => {
    expect(quoteIsDistinctive("e = 1")).toBe(true);
    expect(quoteIsDistinctive("MAX_CASES_LIMIT")).toBe(true);
    expect(quoteIsDistinctive("}")).toBe(false);
    expect(quoteIsDistinctive("   12→return")).toBe(false);
    expect(quoteIsDistinctive("")).toBe(false);
  });

  test("a symbol with a slash or a file extension and no whitespace names a path", () => {
    expect(isPathLike("src/x")).toBe(true);
    expect(isPathLike("config.yaml")).toBe(true);
    expect(isPathLike("MAX_CASES")).toBe(false);
    expect(isPathLike("MAX_CASES = 5")).toBe(false);
  });
});
