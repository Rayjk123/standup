import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `bun test <dir>/` treats its argument as a substring filter over every test
 * file Bun finds below the directory it starts in, so the floor reads only the
 * found files whose path holds that filter verbatim: the isolated test run
 * every worker uses (`env -i` with every path var under one fresh mktemp root,
 * output in the scratch dir) classifies well inside the budget against this
 * repository, whatever sibling directories share the filter's prefix. A filter
 * the runner might read some other way (`./x`, `x/../y`, a word right after an
 * option, a value the floor can't know) still has every found file read.
 */

const ROOT_SETUP = "R=$(mktemp -d -p /tmp floor-x-XXXXXX) && mkdir -p $R/home $R/xdg/config $R/xdg/data $R/xdg/cache $R/xdg/state $R/tmp $R/data $R/knowledge $R/internal";
const ISOLATION: Record<string, string> = {
  HOME: "$R/home",
  XDG_CONFIG_HOME: "$R/xdg/config",
  XDG_DATA_HOME: "$R/xdg/data",
  XDG_CACHE_HOME: "$R/xdg/cache",
  XDG_STATE_HOME: "$R/xdg/state",
  TMPDIR: "$R/tmp",
  TMP: "$R/tmp",
  TEMP: "$R/tmp",
  DB_PATH: "$R/data/standup.db",
  STANDUP_SQLITE_PATH: "$R/data/standup.sqlite",
  KNOWLEDGE_DIR: "$R/knowledge",
  STANDUP_INTERNAL_ROOT: "$R/internal",
};

function isolatedEnv(overrides: Record<string, string | null> = {}): string {
  const vars = Object.entries({ ...ISOLATION, ...overrides }).filter((e): e is [string, string] => e[1] !== null);
  return `env -i PATH=/home/alice/.bun/bin:/usr/local/bin:/usr/bin:/bin ${vars.map(([k, v]) => `${k}=${v}`).join(" ")}`;
}

function isolated(dir: string, run: string, overrides: Record<string, string | null> = {}, tail = ""): string {
  return `cd ${dir} && ${ROOT_SETUP} && ${isolatedEnv(overrides)} ${run} > $TMPDIR/x.log 2>&1${tail}`;
}

describe("the isolated test run, against this repository with the real probes", () => {
  const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
  const FLOOR = join("packages", "collector", "src", "floor");
  const HOME = join("/", "fake", "home");
  const DATA = join(HOME, ".local", "share", "standup");
  const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");
  const config: FloorConfig = {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: "11111111-2222-3333-4444-555555555555",
    root: REPO,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: DATA,
    floorPaths: [join(DATA, "floor")],
    installDir: join(DATA, "install"),
    protectedPaths: [join(DATA, "secrets")],
    tmpDirs: ["/tmp", SCRATCH],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
  const disk = defaultProbes();
  /** Sibling scratch copies of the floor (`floor-*`, `persona-*` beside them) left out of every listing when `hideCopies`. */
  const real = (hideCopies: boolean): Partial<FloorProbes> => ({
    gitBranch: () => "standup/feat-1",
    homeDir: () => HOME,
    env: (name) => (name === "TMPDIR" ? SCRATCH : undefined),
    ...(hideCopies ? { listDir: (p: string) => disk.listDir(p)?.filter((n) => !/^(?:floor|persona)-/.test(n)) ?? null } : {}),
  });
  const bash = (command: string, hideCopies = false): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: REPO }, config, real(hideCopies));

  /** The test file whose string fixtures name a launcher module, held on its own (see the report on importedModules). */
  const importOnly = () => bash(`bun test ${FLOOR}/import-only.test.ts`);

  for (const [label, command, hideCopies] of [
    ["the floor dir", isolated(REPO, `bun test ${FLOOR}/`), false],
    ["the floor dir, sibling copies hidden", isolated(REPO, `bun test ${FLOOR}/`), true],
    ["the floor dir from the package", isolated(join(REPO, "packages", "collector"), "bun test src/floor/"), false],
    ["the floor dir, not isolated", `bun test ${FLOOR}/`, false],
  ] as const) {
    test(`${label} classifies in time, reading only the files the filter selects`, () => {
      const started = Date.now();
      const verdict = bash(command, hideCopies);
      const elapsed = Date.now() - started;
      console.log(`[timing] ${elapsed}ms ${label}`);
      expect(verdict).not.toMatchObject({ reason: expect.stringContaining("too large or complex") });
      // The one file of the dir held on its own is the whole of what holds the run.
      expect(verdict).toEqual(importOnly());
      expect(elapsed).toBeLessThan(6000);
    }, 60_000);
  }

  for (const run of [
    `bun test ${FLOOR}/classify.test.ts`,
    `bun test ${FLOOR}/classify.test.ts ${FLOOR}/gate.test.ts ${FLOOR}/shell.test.ts`,
    `bun test ${FLOOR}/loose-by-default.test.ts ${FLOOR}/real-repo.test.ts`,
    "bunx tsc --noEmit -p packages/collector",
    "bun run typecheck",
  ]) {
    test(`allowed: ${run}`, () => {
      const started = Date.now();
      const command = isolated(REPO, run);
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
      expect(Date.now() - started).toBeLessThan(6000);
    }, 60_000);
  }
});

describe("bun test reads the found files a path filter selects", () => {
  const HOME = join("/", "fake", "home");
  const DATA = join(HOME, ".local", "share", "standup");
  const ROOT = join(DATA, "worktrees", "standup", "feat-1");
  const INSTALL = join("/", "fake", "install");
  const COMMON = join("/", "fake", "repo", ".git");
  const SCRATCH = join(HOME, ".cache", "standup-scratch");
  const OWN_SCRATCH = join(SCRATCH, "launch-1");
  const config: FloorConfig = {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: "launch-1",
    root: ROOT,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    worktreeRoots: [join(DATA, "worktrees")],
    waitSeconds: 60,
    standupDataDir: DATA,
    floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
    installDir: INSTALL,
    protectedPaths: [join(DATA, "secrets"), SCRATCH],
    tmpDirs: ["/tmp", OWN_SCRATCH],
    scratchRoot: SCRATCH,
    scratchDir: OWN_SCRATCH,
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };

  const OK = 'import { expect, test } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n';
  const PUSH = 'import { test } from "bun:test";\nimport { execSync } from "child_process";\ntest("x", () => { execSync("git push origin HEAD"); });\n';
  const DATA_WRITE = `import { test } from "bun:test";\nimport { writeFileSync } from "fs";\ntest("x", () => writeFileSync("${join(DATA, "standup.db")}", ""));\n`;
  const FLOOR_WRITE = `import { test } from "bun:test";\nimport { writeFileSync } from "fs";\ntest("x", () => writeFileSync("${join(INSTALL, "packages", "collector", "src", "floor", "classify.ts")}", ""));\n`;
  const HOME_DB = 'import { test } from "bun:test";\nimport { homedir } from "os";\nimport { join } from "path";\nimport { Database } from "bun:sqlite";\ntest("x", () => { new Database(join(homedir(), ".local", "share", "standup", "standup.db")); });\n';

  const FILES: Record<string, string> = {
    [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
    [join(ROOT, "package.json")]: JSON.stringify({ name: "x", scripts: {} }),
    [join(ROOT, "floor", "ok.test.ts")]: OK,
    [join(ROOT, "floor", "more.test.ts")]: OK,
    [join(ROOT, "floor-copy", "push.test.ts")]: PUSH,
    [join(ROOT, "lib", "ok.test.ts")]: OK,
    [join(ROOT, "deep", "lib", "push.test.ts")]: PUSH,
    [join(ROOT, "w", "data.test.ts")]: DATA_WRITE,
    [join(ROOT, "tamper", "floor.test.ts")]: FLOOR_WRITE,
    [join(ROOT, "ok", "ok.test.ts")]: OK,
    [join(ROOT, "book", "push.test.ts")]: PUSH,
    [join(ROOT, "h", "home.test.ts")]: HOME_DB,
    [join(ROOT, "sub", "bunfig.toml")]: '[test]\npreload = ["./pre.ts"]\n',
    [join(ROOT, "sub", "pre.ts")]: `import { writeFileSync } from "fs";\nwriteFileSync("${join(DATA, "standup.db")}", "");\n`,
    [join(ROOT, "sub", "floor", "ok.test.ts")]: OK,
    [join(INSTALL, "package.json")]: JSON.stringify({ name: "x", scripts: {} }),
    [join(INSTALL, "floor", "ok.test.ts")]: OK,
    [join(DATA, "standup.db")]: "",
  };

  /** The fake tree, plus `extra` files and `links` (a symlink's path to the path it points to). */
  function probes(extra: Record<string, string> = {}, links: Record<string, string> = {}): Partial<FloorProbes> {
    const files: Record<string, string> = { ...FILES, ...extra };
    const dirs = new Set<string>(["/", "/tmp", ROOT]);
    for (const f of [...Object.keys(files), ...Object.keys(links)]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
    dirs.delete(join(ROOT, ".git"));
    /** `p` with any symlink it goes through replaced by what the link points to. */
    const real = (p: string): string => {
      for (const [link, to] of Object.entries(links)) if (p === link || p.startsWith(`${link}/`)) return real(to + p.slice(link.length));
      return p;
    };
    const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
    parseShellSnapshot("", defs);
    return {
      gitBranch: () => "standup/feat-1",
      gitAlias: () => null,
      gitHooksDir: () => null,
      gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
      readFile: (p) => (real(p) in files ? { ok: true, text: files[real(p)]! } : { ok: false, reason: "missing" }),
      exists: (p) => real(p) in files || dirs.has(real(p)),
      isDirectory: (p) => dirs.has(real(p)),
      executable: (p) => (real(p) in files ? false : null),
      lstat: (p) => (p in links ? { symlink: true, file: false, nlink: 1 } : p in files ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
      listDir: (p) => {
        const at = real(p);
        if (!dirs.has(at)) return null;
        return [...new Set([...Object.keys(files), ...dirs, ...Object.keys(links)].filter((f) => f.startsWith(`${at === "/" ? "" : at}/`)).map((f) => f.slice(at.length + 1).split("/")[0]!))];
      },
      realpath: (p) => (real(p) in files || dirs.has(real(p)) ? real(p) : null),
      homeDir: () => HOME,
      shellDefinitions: () => defs,
      env: (name) => (name === "TMPDIR" ? OWN_SCRATCH : undefined),
      awsAccount: () => null,
      now: () => Date.now(),
      gitTree: () => null,
      gitAncestor: () => null,
      gitBlob: () => ({ ok: false, reason: "missing" }),
    };
  }

  const bash = (command: string, cwd = ROOT): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());

  test.each([
    "bun test floor/",
    "bun test floor/ok.test.ts floor/",
    "bun test floor/ -t name",
    "bun test --bail=1 floor/",
    "bun test -tname floor/",
    "bun test -utname floor/",
    "bun test lib/ok",
    isolated(ROOT, "bun test floor/"),
    isolated(ROOT, "bun test h/"),
  ])("allowed: %s", (command) => {
    expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
  });

  /** A file outside `floor/` the run reads: its push, or a write to the data dir or the floor. */
  const OUTSIDE = /git push|w\/data\.test\.ts|tamper\/floor\.test\.ts/;

  test.each([
    // The filter without its slash also matches the copy beside the dir.
    ["bun test floor", "", OUTSIDE],
    // A path elsewhere that holds the filter is found too.
    ["bun test lib/", "outward", /git push/],
    // A filter Bun might normalize before matching selects nothing on its own.
    ["bun test ./floor/", "", OUTSIDE],
    ["bun test floor/../floor/", "", OUTSIDE],
    [`bun test ${ROOT}/floor/`, "", OUTSIDE],
    // A word right after an option may be that option's value, not a filter.
    ["bun test --rerun-each 2 floor/", "", OUTSIDE],
    ["bun test -x floor/", "", OUTSIDE],
    // A preload attached to its option still loads, whatever the filter selects.
    ["bun test -rsub/pre.ts floor/", "floor-tamper", /standup\.db/],
    ["bun test -ursub/pre.ts floor/", "floor-tamper", /standup\.db/],
    ["bun test -ur sub/pre.ts floor/", "floor-tamper", /standup\.db/],
    ["bun test floor/ w/", "floor-tamper", /standup\.db/],
    ["bun test tamper/", "floor-tamper", /src\/floor\/classify\.ts/],
    // A filter is a substring of the path, not a whole dir name: `ok/` also selects `book/…`.
    ["bun test ok/", "outward", /git push/],
    [isolated(ROOT, "bun test w/"), "floor-tamper", /standup\.db/],
    [isolated(ROOT, "bun test floor/", {}, " && git push origin HEAD"), "outward", /git push/],
  ] as const)("held: %s", (command, category, reason) => {
    const verdict = bash(command);
    expect({ command, verdict }).toMatchObject({ command, verdict: { action: "hold", ...(category ? { category } : {}) } });
    expect(verdict.action === "hold" ? verdict.reason : "").toMatch(reason);
  });

  test("a filter selects no looser a verdict than naming the files it selects", () => {
    for (const [filtered, named] of [
      ["bun test h/", "bun test h/home.test.ts"],
      ["bun test w/", "bun test w/data.test.ts"],
      ["bun test lib/", "bun test lib/ok.test.ts deep/lib/push.test.ts"],
    ]) {
      expect({ filtered, verdict: bash(filtered!) }).toEqual({ filtered, verdict: bash(named!) });
      expect({ filtered, verdict: bash(isolated(ROOT, filtered!)) }).toEqual({ filtered, verdict: bash(isolated(ROOT, named!)) });
    }
  });

  test("a filter reads every file found when the tree holds a symlink, since Bun matches the path through it", () => {
    const EVIL = 'import { test } from "bun:test";\ntest("x", () => { Bun.spawnSync(["git", "push", "origin", "HEAD:main"]); });\n';
    const S = join(ROOT, "sym");
    const extra = { [join(S, "a", "evil.test.ts")]: EVIL, [join(S, "b", "ok.test.ts")]: OK };
    const run = (command: string, links: Record<string, string>) =>
      classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(extra, links));
    // `zz` -> `a`: Bun runs `zz/evil.test.ts` for the filter `zz`.
    const dirLink = { [join(S, "zz")]: join(S, "a") };
    // `zz.test.ts` -> `a/evil.test.ts`: the file found twice, once by each path.
    const fileLink = { [join(S, "zz.test.ts")]: join(S, "a", "evil.test.ts") };
    for (const [command, links] of [
      ["cd sym && bun test a", dirLink],
      ["cd sym && bun test zz", dirLink],
      ["cd sym && bun test zz/", dirLink],
      [isolated(S, "bun test zz"), dirLink],
      ["cd sym && bun test zz", fileLink],
      [isolated(S, "bun test zz"), fileLink],
    ] as const) {
      const verdict = run(command, links);
      expect({ command, verdict }).toMatchObject({ command, verdict: { action: "hold", category: "outward" } });
      expect(verdict.action === "hold" ? verdict.reason : "").toMatch(/git push/);
    }
    // Without a link the filter still narrows to what it names.
    expect(run(isolated(S, "bun test b/"), {})).toEqual({ action: "allow" });
  });

  test("a filter whose value the floor can't know reads every file found", () => {
    expect(bash("bun test $X")).toMatchObject({ action: "hold" });
  });

  test("the bunfig's preloads load whatever the filter selects", () => {
    expect(bash("cd sub && bun test floor/")).toMatchObject({ action: "hold" });
    expect(bash(isolated(join(ROOT, "sub"), "bun test floor/"))).toMatchObject({ action: "hold" });
  });

  test("the run from the install dir holds", () => {
    expect(bash(isolated(INSTALL, "bun test floor/"))).toMatchObject({ action: "hold" });
  });
});
