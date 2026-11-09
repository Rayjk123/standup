import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectCodeSearchBackend,
  homeSecretStores,
  literalAlternation,
  protectedPaths,
  refusedReason,
  resolveRipgrepPath,
  searchableTempDir,
  searchCode,
  toPosixEre,
} from "./code-search.js";
import { walkAndMatch, type CodeSearchMatch } from "./code-search-walk.js";
import { DEFAULT_ORG_PROFILE } from "./org-profile/default.js";
import { exampleCorpProfile } from "./org-profile/fixtures/example-corp.js";

/**
 * ripgrep is absent on some hosts the collector runs on, so every assertion
 * here is about what the search does WITHOUT it: which backend takes over, that
 * the fallbacks agree with each other, and that none of them can be talked into
 * reading outside the root they were given.
 *
 * STANDUP_RG_PATH is the seam. Pointing it at a path that does not exist is how
 * a test says "this host has no ripgrep" regardless of what is installed, which
 * is also what makes these tests produce the same result on a developer laptop
 * (where `rg` is on PATH) and in the environment this was written in (where it
 * is not).
 */

const dirs: string[] = [];
const envBefore = process.env.STANDUP_RG_PATH;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(searchableTempDir(), prefix));
  dirs.push(dir);
  return dir;
}

function gitInit(dir: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["add", "-A"],
    ["commit", "-q", "-m", "seed"],
  ]) {
    Bun.spawnSync(["git", ...args], { cwd: dir });
  }
}

function noRipgrep(): void {
  process.env.STANDUP_RG_PATH = join(tmpdir(), "definitely-not-ripgrep-zqxjk");
}

afterEach(() => {
  if (envBefore === undefined) delete process.env.STANDUP_RG_PATH;
  else process.env.STANDUP_RG_PATH = envBefore;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("protectedPaths", () => {
  const HOME = "/home/alice";

  test("the home credential stores are refused under every profile", () => {
    for (const profile of [DEFAULT_ORG_PROFILE, exampleCorpProfile()]) {
      const { refused } = protectedPaths({ HOME }, profile);
      expect(refused).toEqual(expect.arrayContaining([join(HOME, ".aws"), join(HOME, ".ssh"), join(HOME, ".config", "gh")]));
    }
  });

  test("the org profile's SSO dirs and cookie files are refused; the default profile names none", () => {
    expect(protectedPaths({ HOME }, exampleCorpProfile()).refused).toEqual(
      expect.arrayContaining([join(HOME, ".corp-sso"), join(HOME, ".corp-sso", "cookie")])
    );
    expect(protectedPaths({ HOME }, DEFAULT_ORG_PROFILE).refused).not.toContain(join(HOME, ".corp-sso"));
  });
});

describe("homeSecretStores", () => {
  const HOME = "/home/alice";
  const cases: [string, string, boolean][] = [
    ["an SSO tool's cookie below a home dot dir", ".some-sso/cookie", true],
    ["a browser cookie database", ".mozilla/firefox/abc.default/cookies.sqlite", true],
    ["a saved cookie jar", ".cache/tool/session-cookie.json", true],
    ["an SSO tool's credentials file below a home dot dir", ".sso-tool/credentials", true],
    ["a token cache below a home dot dir", ".cache/huggingface/token", true],
    ["a cookie-named file outside any home dot entry", "work/app/cookies.json", false],
    ["a credentials-named file outside any home dot entry", "work/app/credentials", false],
    ["a source file about cookies", ".config/app/cookie.ts", false],
    ["a model vocabulary of tokens", ".cache/huggingface/hub/m/added_tokens.json", false],
    ["a cookie-named file in a provisioned worktree", ".local/share/standup/worktrees/p/x/cookies.json", false],
    ["a credentials-named file in a provisioned worktree", ".local/share/standup/worktrees/p/x/credentials", false],
    ["a path outside the home dir", "../bob/.sso/cookie", false],
  ];
  test.each(cases)("%s", (_title, rel, expected) => {
    expect(homeSecretStores({ HOME })(join(HOME, rel))).toBe(expected);
  });

  test("refusedReason names a cookie store or credential cache under the default profile", () => {
    expect(refusedReason(join(HOME, ".some-sso", "cookie"), { HOME })).toContain("cookie store");
    expect(refusedReason(join(HOME, ".sso-tool", "credentials"), { HOME })).toContain("credential or token cache");
    expect(refusedReason(join(HOME, ".cache", "huggingface", "token"), { HOME })).toContain("credential or token cache");
    expect(refusedReason(join(HOME, ".some-sso", "config.json"), { HOME })).toBeNull();
  });
});

describe("searchableTempDir", () => {
  test("is the temp dir when code search searches there, else /tmp", () => {
    const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    // A home outside /home, /Users and /root is known only as the current HOME.
    const home = realpathSync(mkdtempSync(join("/tmp", "cs-temp-home-")));
    dirs.push(home);
    const plain = join(home, "tmp");
    const dotted = join(home, ".cache", "standup-scratch", "l1");
    for (const d of [plain, dotted]) mkdirSync(d, { recursive: true });
    process.env.HOME = home;
    try {
      const cases: Array<[string, string]> = [
        [plain, plain],
        [dotted, realpathSync("/tmp")],
      ];
      for (const [tmp, expected] of cases) {
        process.env.TMPDIR = tmp;
        expect({ tmp, dir: searchableTempDir() }).toEqual({ tmp, dir: expected });
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("backend selection", () => {
  test("STANDUP_RG_PATH pointing at a missing file means no ripgrep", () => {
    noRipgrep();
    expect(resolveRipgrepPath()).toBeNull();
  });

  test("a git work tree falls back to git grep, a plain directory to the walker", () => {
    noRipgrep();
    const repo = tempDir("cs-backend-repo-");
    writeFileSync(join(repo, "a.ts"), "const needle = 1;\n");
    gitInit(repo);
    expect(detectCodeSearchBackend(repo)).toMatchObject({ backend: "git-grep", status: "degraded" });

    const plain = tempDir("cs-backend-plain-");
    expect(detectCodeSearchBackend(plain)).toMatchObject({ backend: "js", status: "degraded" });
  });

  test("an executable named by STANDUP_RG_PATH is used, and reports status ok", async () => {
    const dir = tempDir("cs-fake-rg-");
    const fake = join(dir, "rg");
    writeFileSync(fake, '#!/bin/sh\necho "./fake.ts:7:from the fake rg"\n');
    chmodSync(fake, 0o755);
    process.env.STANDUP_RG_PATH = fake;

    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result).toMatchObject({ backend: "rg", status: "ok" });
    expect(result.matches).toEqual([{ file: "./fake.ts", line: 7, text: "from the fake rg" }]);
  });

  test("a search root that does not exist is unavailable, not a throw", async () => {
    noRipgrep();
    const result = await searchCode({ pattern: "needle", cwd: join(tmpdir(), "cs-absent-zqxjk") });
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("does not exist");
  });
});

describe("git grep and the walker agree", () => {
  // Same tree twice: one a git work tree (git grep), one not (walker). Every
  // assertion below is made against both results, so a fallback that quietly
  // disagrees with the other is a failure rather than a surprise in production.
  function seed(dir: string): void {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "alpha.ts"), "export const needle = 1;\nconst other = 2;\nneedle();\n");
    writeFileSync(join(dir, "src", "beta.ts"), "// NEEDLE in a comment\n");
    writeFileSync(join(dir, "skip.eval.ts"), "needle in an eval fixture\n");
  }

  async function both(options: Parameters<typeof searchCode>[0] extends infer O ? Omit<O & object, "cwd"> : never) {
    noRipgrep();
    const repo = tempDir("cs-parity-repo-");
    seed(repo);
    gitInit(repo);
    const plain = tempDir("cs-parity-plain-");
    seed(plain);
    const viaGit = await searchCode({ ...options, cwd: repo });
    const viaWalker = await searchCode({ ...options, cwd: plain });
    expect(viaGit.backend).toBe("git-grep");
    expect(viaWalker.backend).toBe("js");
    return { viaGit, viaWalker };
  }

  test("both find the same lines and report rg-shaped paths", async () => {
    const { viaGit, viaWalker } = await both({ pattern: "needle" });
    const expected = [
      { file: "./src/alpha.ts", line: 1, text: "export const needle = 1;" },
      { file: "./src/alpha.ts", line: 3, text: "needle();" },
      { file: "./skip.eval.ts", line: 1, text: "needle in an eval fixture" },
    ];
    for (const result of [viaGit, viaWalker]) {
      expect([...result.matches].sort((a, b) => (a.file < b.file ? -1 : 1))).toEqual(
        [...expected].sort((a, b) => (a.file < b.file ? -1 : 1))
      );
      expect(result.status).toBe("degraded");
    }
  });

  test("both honor case-insensitivity, an exclude glob and the per-file cap", async () => {
    const { viaGit, viaWalker } = await both({
      pattern: "needle",
      caseInsensitive: true,
      excludes: ["*.eval.ts"],
      maxCount: 1,
    });
    for (const result of [viaGit, viaWalker]) {
      const files = result.matches.map((m) => m.file);
      expect(files).toContain("./src/alpha.ts");
      expect(files).toContain("./src/beta.ts");
      expect(files.some((f) => f.includes("eval"))).toBe(false);
      expect(files.filter((f) => f === "./src/alpha.ts")).toHaveLength(1);
    }
  });

  test("both treat an alternation of escaped literals identically", async () => {
    const { viaGit, viaWalker } = await both({ pattern: literalAlternation(["needle", "other"]) });
    for (const result of [viaGit, viaWalker]) {
      expect(result.matches.filter((m) => m.file === "./src/alpha.ts")).toHaveLength(3);
    }
  });
});

describe("the search root is a boundary", () => {
  test("a `..` path, an absolute path outside, and a symlink out all find nothing", async () => {
    noRipgrep();
    const root = tempDir("cs-escape-");
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    const token = "zqxjkescapecanary";
    writeFileSync(join(outside, "secret.md"), `a secret containing ${token}\n`);
    // Present inside too, so an empty result can't be mistaken for the pattern
    // never matching anything.
    writeFileSync(join(repo, "real.ts"), `// source containing ${token}\n`);
    symlinkSync(outside, join(repo, "link"));

    const up = await searchCode({ pattern: token, cwd: repo, path: "../outside" });
    expect(up.status).toBe("unavailable");
    expect(up.matches).toEqual([]);

    const absolute = await searchCode({ pattern: token, cwd: repo, path: outside });
    expect(absolute.status).toBe("unavailable");
    expect(absolute.matches).toEqual([]);

    const whole = await searchCode({ pattern: token, cwd: repo });
    expect(whole.matches.map((m) => m.file)).toEqual(["./real.ts"]);
  });

  test("a subdirectory path searches only that subdirectory", async () => {
    noRipgrep();
    const root = tempDir("cs-subdir-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "in.ts"), "needle\n");
    writeFileSync(join(root, "out.ts"), "needle\n");

    const result = await searchCode({ pattern: "needle", cwd: root, path: "src" });
    expect(result.matches.map((m) => m.file)).toEqual(["src/in.ts"]);
  });
});

describe("budget and timeout", () => {
  test("a spent budget truncates and drops the file the cut landed in", async () => {
    noRipgrep();
    const dir = tempDir("cs-budget-");
    writeFileSync(join(dir, "a.ts"), "needle\nneedle\n");
    writeFileSync(join(dir, "b.ts"), "needle\nneedle\n");

    const result = await searchCode({ pattern: "needle", cwd: dir, maxMatches: 3 });
    expect(result.truncated).toBe(true);
    // a.ts is complete; b.ts was cut through, so it is omitted rather than
    // ranked on a partial view.
    expect(result.matches.map((m) => m.file)).toEqual(["./a.ts", "./a.ts"]);
  });

  test("an exhausted time budget returns what it had, marked truncated", async () => {
    noRipgrep();
    const dir = tempDir("cs-timeout-");
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.ts`), "needle\n");

    const result = await searchCode({ pattern: "needle", cwd: dir, timeoutMs: 0 });
    expect(result.truncated).toBe(true);
    expect(result.error).toContain("timed out");
  });

  test("the walker skips node_modules, build output and .gitignore'd paths", async () => {
    noRipgrep();
    const dir = tempDir("cs-ignore-");
    writeFileSync(join(dir, ".gitignore"), "generated\n");
    for (const sub of ["node_modules", "build", "generated"]) {
      mkdirSync(join(dir, sub));
      writeFileSync(join(dir, sub, "x.ts"), "needle\n");
    }
    writeFileSync(join(dir, "kept.ts"), "needle\n");

    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result.matches.map((m) => m.file)).toEqual(["./kept.ts"]);
  });

  test("the walker skips binary files", async () => {
    noRipgrep();
    const dir = tempDir("cs-binary-");
    writeFileSync(join(dir, "blob.ts"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x0a]));
    writeFileSync(join(dir, "text.ts"), "needle\n");

    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result.matches.map((m) => m.file)).toEqual(["./text.ts"]);
  });
});

describe("literalAlternation", () => {
  test("escapes metacharacters so one pattern means the same to every engine", () => {
    expect(literalAlternation(["a.b", "c+d"])).toBe("a\\.b|c\\+d");
  });

  test("a term carrying a metacharacter matches literally", async () => {
    noRipgrep();
    const dir = tempDir("cs-literal-");
    writeFileSync(join(dir, "a.ts"), "search_code()\nsearchXcode()\n");

    const result = await searchCode({ pattern: literalAlternation(["search_code("]), cwd: dir });
    expect(result.matches.map((m) => m.line)).toEqual([1]);
  });
});

function fakeRipgrep(script: string): string {
  const dir = tempDir("cs-fake-rg-");
  const fake = join(dir, "rg");
  writeFileSync(fake, `#!/bin/sh\n${script}\n`);
  chmodSync(fake, 0o755);
  process.env.STANDUP_RG_PATH = fake;
  return dir;
}

describe("a pathological pattern never blocks the event loop", () => {
  test("catastrophic backtracking is cut off at the deadline while timers keep firing", async () => {
    noRipgrep();
    const dir = tempDir("cs-redos-");
    // Each line makes `(?:a+)+$` backtrack exponentially before failing.
    const line = `${"a".repeat(32)}!`;
    writeFileSync(join(dir, "slow.txt"), `${Array.from({ length: 40 }, () => line).join("\n")}\n`);

    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    const result = await searchCode({ pattern: "(?:a+)+$", cwd: dir, timeoutMs: 200 });
    const elapsed = performance.now() - started;
    clearInterval(timer);

    expect(result.backend).toBe("js");
    expect(elapsed).toBeLessThan(400);
    // The interval fired throughout: the regex ran off the event loop.
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect(result.truncated).toBe(true);
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("timed out");
  });

  test("a work tree hands a pattern git grep rejects to the bounded walker", async () => {
    noRipgrep();
    const repo = tempDir("cs-redos-git-");
    writeFileSync(join(repo, "slow.txt"), `${"a".repeat(32)}!\n`);
    gitInit(repo);

    const started = performance.now();
    const result = await searchCode({ pattern: "(?:a+)+$", cwd: repo, timeoutMs: 200 });
    expect(performance.now() - started).toBeLessThan(400);
    expect(result.backend).toBe("js");
    expect(result.fallbackReason).toContain("git grep cannot express this pattern");
    expect(result.error).toContain("timed out");
  });

  test("the walker checks its deadline between lines of one file", () => {
    const dir = tempDir("cs-line-deadline-");
    // Five cheap matching lines, then many lines that each backtrack for a while.
    const lines = [
      ...Array.from({ length: 5 }, () => "a".repeat(20)),
      ...Array.from({ length: 2000 }, () => `${"a".repeat(18)}!`),
    ];
    writeFileSync(join(dir, "one.txt"), `${lines.join("\n")}\n`);

    const found: CodeSearchMatch[] = [];
    const started = performance.now();
    const outcome = walkAndMatch(
      {
        root: dir,
        target: dir,
        pattern: "^(?:a|a)+$",
        flags: "",
        maxMatches: 100,
        excludes: [],
        includes: [],
        maxBytes: 1_000_000,
        deadlineAt: performance.timeOrigin + performance.now() + 50,
        refused: [],
      },
      (batch) => found.push(...batch)
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(outcome.timedOut).toBe(true);
    // What matched before the deadline is still reported.
    expect(found.map((m) => m.line)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("include globs and path rules match ripgrep's", () => {
  function seedGlobs(dir: string): void {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src", "a.ts"), "needle\n");
    writeFileSync(join(dir, "docs", "b.ts"), "needle\n");
    writeFileSync(join(dir, "x.md"), "needle\n");
  }

  test("git grep honors a basename include instead of ORing it with the whole tree", async () => {
    noRipgrep();
    const repo = tempDir("cs-include-git-");
    seedGlobs(repo);
    gitInit(repo);
    const result = await searchCode({ pattern: "needle", cwd: repo, includes: ["*.ts"] });
    expect(result.backend).toBe("git-grep");
    expect(result.matches.map((m) => m.file).sort()).toEqual(["./docs/b.ts", "./src/a.ts"]);
  });

  test("a path-shaped include, and an include under a subdirectory path, stay inside it", async () => {
    noRipgrep();
    const repo = tempDir("cs-include-path-");
    seedGlobs(repo);
    gitInit(repo);
    const plain = tempDir("cs-include-path-plain-");
    seedGlobs(plain);
    for (const cwd of [repo, plain]) {
      const anchored = await searchCode({ pattern: "needle", cwd, includes: ["src/*.ts"] });
      expect(anchored.matches.map((m) => m.file)).toEqual(["./src/a.ts"]);
      const under = await searchCode({ pattern: "needle", cwd, path: "docs", includes: ["*.ts"] });
      expect(under.matches.map((m) => m.file)).toEqual(["docs/b.ts"]);
      // A path include naming a sibling of the searched path finds nothing.
      const sibling = await searchCode({ pattern: "needle", cwd, path: "docs", includes: ["src/*.ts"] });
      expect(sibling.matches).toEqual([]);
    }
  });

  test("a glob that climbs out of the root, or is absolute, is refused", async () => {
    noRipgrep();
    const root = tempDir("cs-glob-escape-");
    mkdirSync(join(root, "pkg", "a"), { recursive: true });
    mkdirSync(join(root, "pkg", "b"), { recursive: true });
    writeFileSync(join(root, "pkg", "b", "secret.ts"), "needle\n");
    writeFileSync(join(root, "pkg", "a", "in.ts"), "needle\n");
    gitInit(root);
    const cwd = join(root, "pkg", "a");
    for (const globs of [{ includes: ["../b/**"] }, { includes: ["/etc/*"] }, { excludes: ["../x"] }]) {
      const result = await searchCode({ pattern: "needle", cwd, ...globs });
      expect(result.status).toBe("unavailable");
      expect(result.error).toContain("glob escapes the search root");
      expect(result.matches).toEqual([]);
    }
  });

  test("hidden entries are skipped by both fallbacks, tracked or not", async () => {
    noRipgrep();
    const seedHidden = (dir: string): void => {
      mkdirSync(join(dir, ".github"));
      writeFileSync(join(dir, ".github", "ci.yml"), "needle\n");
      writeFileSync(join(dir, ".env"), "needle\n");
      writeFileSync(join(dir, "seen.ts"), "needle\n");
    };
    const repo = tempDir("cs-hidden-git-");
    seedHidden(repo);
    gitInit(repo);
    const plain = tempDir("cs-hidden-plain-");
    seedHidden(plain);
    for (const cwd of [repo, plain]) {
      const result = await searchCode({ pattern: "needle", cwd });
      expect(result.matches.map((m) => m.file)).toEqual(["./seen.ts"]);
    }
    // Naming a hidden directory explicitly searches it, as rg does.
    const explicit = await searchCode({ pattern: "needle", cwd: repo, path: ".github" });
    expect(explicit.matches.map((m) => m.file)).toEqual([".github/ci.yml"]);
  });

  test("a file ending in a newline has no phantom empty last line", async () => {
    noRipgrep();
    const repo = tempDir("cs-eol-git-");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    gitInit(repo);
    const plain = tempDir("cs-eol-plain-");
    writeFileSync(join(plain, "a.txt"), "one\ntwo\n");
    for (const cwd of [repo, plain]) {
      expect((await searchCode({ pattern: "^$", cwd })).matches).toEqual([]);
    }
  });

  test("inside a work tree the walker searches tracked build output and honors nested ignores", async () => {
    noRipgrep();
    const repo = tempDir("cs-walker-git-");
    mkdirSync(join(repo, "build"));
    mkdirSync(join(repo, "pkg", "gen"), { recursive: true });
    writeFileSync(join(repo, "build", "tracked.ts"), "needle\n");
    writeFileSync(join(repo, "pkg", ".gitignore"), "gen\n");
    writeFileSync(join(repo, "pkg", "kept.ts"), "needle\n");
    gitInit(repo);
    writeFileSync(join(repo, "pkg", "gen", "ignored.ts"), "needle\n");
    // `(?:` is rejected by `grep -E`, so the walker answers from the work tree's file list.
    const result = await searchCode({ pattern: "(?:needle)", cwd: repo });
    expect(result.backend).toBe("js");
    expect(result.matches.map((m) => m.file).sort()).toEqual(["./build/tracked.ts", "./pkg/kept.ts"]);

    // Outside a work tree, a nested .gitignore is honored too.
    const plain = tempDir("cs-walker-plain-");
    mkdirSync(join(plain, "pkg", "gen"), { recursive: true });
    writeFileSync(join(plain, "pkg", ".gitignore"), "gen\n");
    writeFileSync(join(plain, "pkg", "gen", "ignored.ts"), "needle\n");
    writeFileSync(join(plain, "pkg", "kept.ts"), "needle\n");
    const walked = await searchCode({ pattern: "needle", cwd: plain });
    expect(walked.matches.map((m) => m.file)).toEqual(["./pkg/kept.ts"]);
  });
});

describe("ripgrep failures and output handling", () => {
  test("matches printed before a file error (exit 2) are kept and the error reported", async () => {
    const dir = fakeRipgrep('echo "./ok.ts:1:needle"\necho "rg: ./locked: Permission denied" >&2\nexit 2');
    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result).toMatchObject({ backend: "rg", status: "ok" });
    expect(result.matches).toEqual([{ file: "./ok.ts", line: 1, text: "needle" }]);
    expect(result.error).toContain("Permission denied");
  });

  test("a pattern ripgrep rejects falls back with that reason, not 'not installed'", async () => {
    const dir = fakeRipgrep('echo "regex parse error" >&2\nexit 2');
    writeFileSync(join(dir, "a.ts"), "needle\n");
    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result.backend).toBe("js");
    expect(result.fallbackReason).toContain("ripgrep could not run this search: regex parse error");
    expect(result.matches.map((m) => m.file)).toEqual(["./a.ts"]);
  });

  test("a host without ripgrep says so as the fallback reason", async () => {
    noRipgrep();
    const dir = tempDir("cs-no-rg-");
    writeFileSync(join(dir, "a.ts"), "needle\n");
    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result.fallbackReason).toBe("ripgrep is not installed on this host");
  });

  test("ripgrep output outside the root, hidden or credential-shaped is dropped", async () => {
    const dir = fakeRipgrep(
      [
        'echo "./kept.ts:1:needle"',
        'echo "./.aws/credentials:1:needle"',
        'echo "./sub/credentials:2:needle"',
        'echo "./../escape.ts:3:needle"',
      ].join("\n")
    );
    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result.matches.map((m) => m.file)).toEqual(["./kept.ts"]);
  });

  test("output beyond the budget stops the process instead of being buffered", async () => {
    // Prints more lines than the budget, then would hang for 5s.
    const dir = fakeRipgrep('for i in 1 2 3 4 5 6 7 8; do echo "./f$i.ts:1:needle"; done\nsleep 5');
    const started = performance.now();
    const result = await searchCode({ pattern: "needle", cwd: dir, maxMatches: 3 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeLessThanOrEqual(3);
  });
});

describe("the walker's failures and limits", () => {
  const RealWorker = globalThis.Worker;
  afterEach(() => {
    globalThis.Worker = RealWorker;
  });

  test("a walker that cannot start is unavailable, not degraded", async () => {
    noRipgrep();
    const dir = tempDir("cs-dead-walker-");
    writeFileSync(join(dir, "a.ts"), "needle\n");
    globalThis.Worker = class {
      constructor() {
        throw new Error("workers disabled");
      }
    } as unknown as typeof Worker;
    const result = await searchCode({ pattern: "needle", cwd: dir });
    expect(result.backend).toBe("js");
    expect(result.status).toBe("unavailable");
    expect(result.error).toContain("search worker could not start");
  });

  test("no more than four walker Workers run at once; the rest wait within their deadline", async () => {
    noRipgrep();
    const dir = tempDir("cs-walker-cap-");
    writeFileSync(join(dir, "slow.txt"), `${Array.from({ length: 40 }, () => `${"a".repeat(32)}!`).join("\n")}\n`);
    let live = 0;
    let peak = 0;
    globalThis.Worker = class extends RealWorker {
      constructor(url: string | URL) {
        super(url);
        live++;
        peak = Math.max(peak, live);
      }
      terminate(): void {
        live--;
        super.terminate();
      }
    } as typeof Worker;

    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => searchCode({ pattern: "(?:a+)+$", cwd: dir, timeoutMs: 250 }))
    );
    expect(performance.now() - started).toBeLessThan(800);
    expect(peak).toBeLessThanOrEqual(4);
    for (const result of results) {
      expect(result.status).toBe("unavailable");
      expect(result.truncated).toBe(true);
    }
  });

  test("bracket globs are character classes, as git and ripgrep read them", async () => {
    noRipgrep();
    const seedBrackets = (dir: string): void => {
      for (const name of ["a.ts", "b.ts", "c.ts", "[a].ts"]) writeFileSync(join(dir, name), "needle\n");
    };
    const repo = tempDir("cs-bracket-git-");
    seedBrackets(repo);
    gitInit(repo);
    const plain = tempDir("cs-bracket-plain-");
    seedBrackets(plain);
    for (const cwd of [repo, plain]) {
      const included = await searchCode({ pattern: "needle", cwd, includes: ["[ab].ts"] });
      expect(included.matches.map((m) => m.file).sort()).toEqual(["./a.ts", "./b.ts"]);
      const negated = await searchCode({ pattern: "needle", cwd, includes: ["[!ab].ts"] });
      expect(negated.matches.map((m) => m.file).sort()).toEqual(["./c.ts"]);
    }
  });
});

describe("Perl-style escapes mean the same on git grep as on the walker", () => {
  const lines = ["id 42", "tab\there", "under_score", "no-digits!", "word boundary", "x"];

  async function parity(pattern: string): Promise<number[]> {
    noRipgrep();
    const repo = tempDir("cs-escape-git-");
    writeFileSync(join(repo, "a.txt"), `${lines.join("\n")}\n`);
    gitInit(repo);
    const plain = tempDir("cs-escape-plain-");
    writeFileSync(join(plain, "a.txt"), `${lines.join("\n")}\n`);
    const viaGit = await searchCode({ pattern, cwd: repo });
    const viaWalker = await searchCode({ pattern, cwd: plain });
    expect(viaWalker.backend).toBe("js");
    expect(viaGit.backend).toBe("git-grep");
    expect(viaGit.matches.map((m) => m.line)).toEqual(viaWalker.matches.map((m) => m.line));
    return viaWalker.matches.map((m) => m.line);
  }

  for (const [pattern, expected] of [
    ["\\d+", [1]],
    ["^\\D+$", [2, 3, 4, 5, 6]],
    ["\\s", [1, 2, 5]],
    ["^\\S+$", [3, 4, 6]],
    ["^\\w+$", [3, 6]],
    ["\\W", [1, 2, 4, 5]],
    ["[\\d]", [1]],
    ["^[\\w-]+!$", [4]],
    ["\\bboundary\\b", [5]],
  ] as const) {
    test(`${pattern}`, async () => {
      expect(await parity(pattern)).toEqual([...expected]);
    });
  }

  test("the shorthands translate to POSIX classes; constructs ERE lacks route to the walker", () => {
    expect(toPosixEre("\\d+\\.\\w")).toBe("[0-9]+\\.[[:alnum:]_]");
    expect(toPosixEre("[\\d\\s]")).toBe("[0-9[:space:]]");
    expect(toPosixEre(literalAlternation(["a.b", "search_code("]))).toBe("a\\.b|search_code\\(");
    for (const pattern of ["\\t", "\\x41", "\\p{L}", "(\\w)\\1", "(?:a)", "(?i)a", "[\\D]", "[[:alpha:]]", "[]a]", "a\\"]) {
      expect(toPosixEre(pattern)).toBeNull();
    }
  });
});
