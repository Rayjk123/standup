import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type GitTree, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A second round of safe worker commands the floor held at owner level, and
 * the real outward steps of the same shape that must still hold. The machine
 * is virtual, and its paths are built piece by piece so this file carries no
 * literal Standup path of its own.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const LAUNCH = "a3a3a3a3-0000-4000-8000-0000000000a3";
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(DATA, "review-scratch", LAUNCH);
const OTHER_SCRATCH = join(DATA, "review-scratch", "a4a4a4a4-0000-4000-8000-0000000000a4");

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://127.0.0.1:17777",
  launchId: LAUNCH,
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const PACKAGE_JSON = JSON.stringify({ name: "standup", workspaces: ["packages/*"], scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "eslint ." } });

/** A test file that only names outward steps in its expectations, the way the floor's own tests do. */
const DATA_TEST = [
  'import { test, expect } from "bun:test";',
  'test("a push is held", () => {',
  '  expect(classify(\'execSync("git push origin HEAD")\')).toBe("outward");',
  "});",
].join("\n");

/** A test file that really runs an outward step when the suite runs. */
const PUSHING_TEST = ['import { execSync } from "child_process";', 'import { test } from "bun:test";', 'test("publishes", () => {', '  execSync("git push origin HEAD");', "});"].join("\n");

const FIXTURE_SCREENSHOT = [
  'import { chromium } from "playwright";',
  "const base = process.env.BASE ?? \"http://127.0.0.1:5301\";",
  "const page = await (await (await chromium.launch()).newContext()).newPage();",
  'await page.route("/api/asks/pending", (route) => route.fulfill({ json: [] }));',
  'await page.route(`${base}/api/plans`, (route) => route.fulfill({ json: [] }));',
  'await page.routeWebSocket("/ws", (ws) => ws.close());',
  'export const title = "Add the Review tab for human sign-off on delivery pipelines";',
  "await page.goto(`${base}/review`);",
  'await page.screenshot({ path: "/tmp/review.png" });',
].join("\n");

const BASE_FILES: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "src", "app.ts")]: "export const app = 1;\n",
  [join(ROOT, "src", "data.test.ts")]: DATA_TEST,
  [join(ROOT, "scripts", "shot.ts")]: FIXTURE_SCREENSHOT,
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
  [join(SCRATCH, "keep.png")]: "png",
  [join(OTHER_SCRATCH, "keep.png")]: "png",
  ["/tmp/shots/a.png"]: "png",
  [join("/", "fake", "repo", ".git", "HEAD")]: "ref: refs/heads/main\n",
};

/** HEAD, its local `main`, and a commit a local branch holds: they differ only in src/app.ts. */
const BLOBS: Record<string, string> = {
  "o-pkg": PACKAGE_JSON,
  "o-app-head": "export const app = 1;\n",
  "o-app-main": "export const app = 2;\n",
  "o-test": DATA_TEST,
};
const HEAD_ENTRIES: Record<string, string> = { "package.json": "o-pkg", "src/app.ts": "o-app-head", "src/data.test.ts": "o-test" };
const MAIN_ENTRIES: Record<string, string> = { ...HEAD_ENTRIES, "src/app.ts": "o-app-main" };

function tree(entries: Record<string, string>, commit: string, modes: Record<string, string> = {}): GitTree {
  return { commit, entries: new Map(Object.entries(entries).map(([path, oid]) => [path, { mode: modes[path] ?? "100644", oid }])) };
}

const SHA = "c".repeat(40);

interface World {
  files?: Record<string, string>;
  blobs?: Record<string, string>;
  revs?: Record<string, GitTree>;
  /** Commits already contained in another, as `<commit> in <commit>`; a rebase onto one of these fast-forwards. */
  contains?: string[];
}

/**
 * The floor's own environment, without git's variables. A git variable set where the tests run
 * (a hermetic runner sets GIT_CONFIG_NOSYSTEM) makes the floor leave a checkout's tree unread.
 */
function floorEnv(name: string): string | undefined {
  return name.startsWith("GIT_") ? undefined : process.env[name];
}

function probes(world: World = {}): Partial<FloorProbes> {
  const files = { ...BASE_FILES, ...(world.files ?? {}) };
  const blobs = { ...BLOBS, ...(world.blobs ?? {}) };
  const revs: Record<string, GitTree> = world.revs ?? {
    HEAD: tree(HEAD_ENTRIES, "a".repeat(40)),
    main: tree(MAIN_ENTRIES, "b".repeat(40)),
    [SHA]: tree(MAIN_ENTRIES, SHA),
    "standup/feat-1": tree(HEAD_ENTRIES, "a".repeat(40)),
  };
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map([["grep", ["grep --color=auto"]]]), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    env: floorEnv,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: (dir, rev) => (dir === ROOT ? (revs[rev] ?? null) : null),
    gitAncestor: (dir, commit, of) => (dir === ROOT ? (world.contains ?? [`${"a".repeat(40)} in ${"b".repeat(40)}`, `${"a".repeat(40)} in ${SHA}`]).includes(`${commit} in ${of}`) : null),
    gitBlob: (_dir, oid) => (oid in blobs ? { ok: true, text: blobs[oid]! } : { ok: false, reason: "missing" }),
  };
}

function bash(command: string, world?: World, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(world));
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category: string, ownerOnly?: boolean): void {
  expect(v.action).toBe("hold");
  if (v.action === "hold") {
    expect({ category: v.category, ownerOnly: v.ownerOnly, reason: v.reason }).toMatchObject(ownerOnly === undefined ? { category } : { category, ownerOnly });
  }
}

describe("1. what a test run or a package script would execute is read", () => {
  test("a test file that runs an outward step is held, named or found by the runner", () => {
    const files = { [join(ROOT, "src", "push.test.ts")]: PUSHING_TEST };
    expectHeld(bash("bun test src/push.test.ts", { files }), "outward");
    expectHeld(bash("bun test src", { files }), "outward");
    expectHeld(bash("bun test", { files }), "outward");
    expectHeld(bash("npm test", { files }), "outward");
  });

  test("every shape of a real outward step in a test file is held", () => {
    const cases: Array<[string, string]> = [
      ['import { execSync } from "child_process";\ntest("x", () => execSync("git push origin HEAD"));\n', "outward"],
      ['import { spawnSync } from "child_process";\ntest("x", () => spawnSync("git", ["push", "origin", "HEAD"]));\n', "outward"],
      ['test("x", async () => { await Bun.$`git push origin HEAD`; });\n', "outward"],
      ['test("x", () => Bun.spawnSync(["corp-review", "--draft", "--issue", "X-1"]));\n', "review"],
      ['import { execSync } from "child_process";\ntest("x", () => execSync("curl -X POST http://127.0.0.1:17777/api/asks/a1/resolve -d \'{}\'"));\n', "collector-api"],
      ['import { execSync } from "child_process";\ntest("x", () => execSync("aws lambda update-function-code --function-name f"));\n', "aws"],
      ['import { execSync } from "child_process";\ntest("x", () => execSync(decodeURIComponent("git%20push%20origin%20HEAD")));\n', "outward"],
      ['import { execSync } from "child_process";\ntest("x", () => execSync(new RegExp("git push origin HEAD").source));\n', "outward"],
      ['import { spawnSync } from "child_process";\ntest("x", () => spawnSync("sh", ["-c", new RegExp("git push origin HEAD").source]));\n', "outward"],
      ['import { execSync } from "child_process";\ntest("x", () => execSync(new RegExp(String.raw`git push origin HEAD`).source));\n', "outward"],
      ['import { execSync } from "child_process";\nconst s = "git push origin HEAD";\ntest("x", () => execSync(s));\n', "outward"],
      ['import { execSync } from "child_process";\nconst s = new RegExp("git push origin HEAD").source;\ntest("x", () => execSync(s));\n', "outward"],
      ['import { execSync } from "child_process";\nconst re = new RegExp("git push origin HEAD");\ntest("x", () => execSync(re.source));\n', "outward"],
      ['import { execSync } from "child_process";\nconst re = new RegExp("git push origin HEAD");\ntest("x", () => execSync(String(re).slice(1, -1)));\n', "outward"],
      ['import { exec } from "child_process";\nimport { promisify } from "util";\nconst run = promisify(exec);\ntest("x", async () => { await run("git push origin HEAD"); });\n', "outward"],
      ['const { execSync: run } = require("child_process");\ntest("x", () => run("git push origin HEAD"));\n', "outward"],
      ['import { execa } from "execa";\ntest("x", () => execa("git", ["push", "origin", "HEAD"]));\n', "outward"],
      ['test("x", () => new Deno.Command("git", { args: ["push", "origin", "HEAD"] }));\n', "outward"],
      ['const cp = require("child_process");\ntest("x", () => cp["exec" + "Sync"]("git push origin HEAD"));\n', "unclassified"],
      ['import { $ } from "execa";\ntest("x", async () => { await $({ shell: true })("git push origin HEAD"); });\n', "unclassified"],
    ];
    for (const [text, category] of cases) {
      const files = { [join(ROOT, "src", "probe.test.ts")]: text };
      for (const command of ["bun test", "bun test src/probe.test.ts"]) {
        const v = bash(command, { files });
        expect({ text, action: v.action, category: v.action === "hold" ? String(v.category) : null }).toEqual({ text, action: "hold" as const, category });
      }
    }
  });

  test("a module every test preloads is read too, from the config or the command line", () => {
    const guard = { [join(ROOT, "guard.ts")]: 'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n' };
    expectHeld(bash("bun test", { files: { ...guard, [join(ROOT, "bunfig.toml")]: '[test]\npreload = [\n  "./guard.ts",\n]\n' } }), "outward");
    expectHeld(bash("bun test --preload ./guard.ts", { files: guard }), "outward");
    expectHeld(bash("bun test --preload=./guard.ts src/data.test.ts", { files: guard }), "outward");
  });

  test("an argument that is not a file is a filter over every test the runner finds", () => {
    const files = { [join(ROOT, "src", "push.test.ts")]: PUSHING_TEST, [join(ROOT, "other", "src", "push.test.ts")]: PUSHING_TEST };
    expectHeld(bash("bun test push", { files }), "outward");
    expectHeld(bash("bun test -t 'publishes' push", { files }), "outward");
    // A directory name is a filter too: `bun test src` runs other/src's tests as well.
    expectHeld(bash("bun test src", { files: { [join(ROOT, "other", "src", "push.test.ts")]: PUSHING_TEST } }), "outward");
  });

  test("a helper module a test imports is read, however the specifier spells it", () => {
    // A function an imported module defines that the test calls runs its push as the test does (import-only.test.ts).
    const helper = 'import { execSync } from "child_process";\nexport const ship = () => execSync("git push origin HEAD");\n';
    for (const [spec, path, category] of [
      ["./helper.js", join(ROOT, "src", "helper.ts"), "outward"],
      ["./helper", join(ROOT, "src", "helper.ts"), "outward"],
      // JSX is read whole, in full.
      ["../lib/helper.js", join(ROOT, "lib", "helper.tsx"), "outward"],
    ] as const) {
      const files = { [join(ROOT, "src", "uses.test.ts")]: `import { ship } from "${spec}";\ntest("x", () => ship());\n`, [path]: helper };
      const v = bash("bun test", { files });
      expectHeld(v, category);
      expect(v.action === "hold" && v.reason).toContain("git push");
    }
    // Run when the helper loads, it counts in full.
    const files = { [join(ROOT, "src", "uses.test.ts")]: 'import "./helper.js";\ntest("x", () => {});\n', [join(ROOT, "src", "helper.ts")]: 'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n' };
    expectHeld(bash("bun test", { files }), "outward");
  });

  test("names and directories each runner picks up, and only those", () => {
    const files = { [join(ROOT, "src", "fixture-test.ts")]: PUSHING_TEST, [join(ROOT, "test", "helper.ts")]: PUSHING_TEST };
    // `bun test` runs neither: it takes only `.test`/`_test`/`.spec`/`_spec` names.
    expectAllowed(bash("bun test", { files }));
    expectHeld(bash("node --test", { files }), "outward");
  });

  test("an argument the floor can't resolve selects from every test below, which are all read", () => {
    const files = { [join(ROOT, "src", "push.test.ts")]: PUSHING_TEST };
    expectHeld(bash("bun test $(cat list.txt)", { files }), "outward");
    expectAllowed(bash("bun test $(cat list.txt)"));
  });

  test("tests in a tree the floor can't read hold", () => {
    expectHeld(bash("git pull && bun test"), "unclassified");
  });

  test("a test file the floor can't read holds rather than counting as empty", () => {
    const big = `${"// padding\n".repeat(40_000)}import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n`;
    expectHeld(bash("bun test", { files: { [join(ROOT, "src", "big.test.ts")]: big } }), "outward");
    const unreadable = { [join(ROOT, "src", "odd.test.ts")]: "\u0000 import { execSync } from 'child_process';\nexecSync('git push origin HEAD');\n" };
    expectHeld(bash("bun test", { files: unreadable }), "outward");
  });

  test("a test file that only names outward steps in its expectations runs", () => {
    expectAllowed(bash("bun test src/data.test.ts"));
    expectAllowed(bash("bun test"));
    expectAllowed(bash("bun test -t 'git push is held'"));
    expectAllowed(bash("bun run typecheck"));
  });
});

describe("2. a local revision a checkout or rebase lands on is read from git objects", () => {
  test("typecheck after creating a branch at a local commit, or rebasing onto a local branch, runs", () => {
    expectAllowed(bash(`git checkout -b probe ${SHA} && bun run typecheck`));
    expectAllowed(bash("git rebase main && bun run typecheck"));
    expectAllowed(bash("git switch -c probe main && bun run typecheck"));
  });

  test("an outward step in either tree still holds", () => {
    const pushes = JSON.stringify({ name: "standup", scripts: { typecheck: "git push origin HEAD" } });
    const revs = {
      HEAD: tree(HEAD_ENTRIES, "a".repeat(40)),
      main: tree({ ...MAIN_ENTRIES, "package.json": "o-push" }, "b".repeat(40)),
      [SHA]: tree({ ...MAIN_ENTRIES, "package.json": "o-push" }, SHA),
      "standup/feat-1": tree(HEAD_ENTRIES, "a".repeat(40)),
    };
    const world = { blobs: { "o-push": pushes }, revs };
    expectHeld(bash(`git checkout -b probe ${SHA} && bun run typecheck`, world), "outward");
    expectHeld(bash("git rebase main && bun run typecheck", world), "outward");
  });

  test("a revision no local branch holds is unread, and its local checkout runs", () => {
    expectAllowed(bash("git checkout -b probe origin/feature && bun run typecheck"));
    expectAllowed(bash("git rebase origin/main && bun run typecheck"));
  });

  test("a rebase that replays commits leaves a tree that is neither side's, which is unread and runs", () => {
    // The branch's commits are not in the upstream, so the rebase is no fast-forward:
    // package.json could keep the branch's script while the script file comes from main.
    expectAllowed(bash("git rebase main && bun run typecheck", { contains: [] }));
    expectAllowed(bash("git rebase main && bun test", { contains: [] }));
  });
});

describe("3. a help flag never uploads", () => {
  test("the org's review CLI asked for help or its version runs", () => {
    expectAllowed(bash("corp-review -h"));
    expectAllowed(bash("corp-review --help"));
    expectAllowed(bash("corp-review --version"));
  });

  test("a real upload still holds", () => {
    expectHeld(bash("corp-review --revise R-1 --description /tmp/shots/a.md"), "review");
    expectHeld(bash("corp-review --help --draft"), "review");
    expectHeld(bash("corp-review -- -h"), "review");
    expectHeld(bash("corp-review --draft --issue X-1"), "review");
  });
});

describe("4. route mocks and UI copy in a fixture harness are not calls", () => {
  test("a screenshot harness whose /api routes are all mocked runs", () => {
    expectAllowed(bash("bun scripts/shot.ts"));
  });

  test("stage ids in a data table are not the tools they are named after", () => {
    const files = {
      [join(ROOT, "packages", "shared", "src", "pipeline.ts")]: [
        'export type StageId = "coding" | "validation" | "deploy" | "screenshot" | "corp-review";',
        'export const STAGE_IDS: StageId[] = ["coding", "validation", "deploy", "screenshot", "corp-review"];',
        'export const DEFAULT_PIPELINE = { stages: [{ id: "deploy", kind: "deploy" }, { id: "corp-review", kind: "corp-review", edges: [{ to: "corp-review" }] }] };',
      ].join("\n"),
    };
    expectAllowed(bash(`bun -e 'import { DEFAULT_PIPELINE } from "./packages/shared/src/pipeline.ts"; console.log(DEFAULT_PIPELINE.stages.length);'`, { files }));
    expectAllowed(bash("bun packages/shared/src/pipeline.ts", { files }));
  });

  test("a regex literal's exec is a match, not a command", () => {
    const files = {
      [join(ROOT, "packages", "shared", "src", "pipeline.ts")]: [
        'export const STAGE_IDS = ["coding", "deploy", "corp-review"];',
        'export const waivedBy = (reason: string) => /^waived by ([^:]+): ([\\s\\S]*)$/i.exec(reason)?.[1];',
      ].join("\n"),
    };
    expectAllowed(bash("bun packages/shared/src/pipeline.ts", { files }));
  });

  test("a list of tool-named words in a file that runs nothing is a table, not argv", () => {
    const files = {
      [join(ROOT, "packages", "shared", "src", "review.ts")]: [
        'export type LinkKind = "corp-review" | "deploy" | "stack" | "other";',
        'export const LINK_KINDS: readonly LinkKind[] = ["corp-review", "deploy", "stack", "other"];',
      ].join("\n"),
    };
    expectAllowed(bash("bun packages/shared/src/review.ts", { files }));
  });

  test("an argv list in a file that can run it is still read", () => {
    const files = {
      [join(ROOT, "scripts", "ship.ts")]: ['import { spawnSync } from "child_process";', 'spawnSync("git", ["push", "origin", "HEAD"]);'].join("\n"),
    };
    expectHeld(bash("bun scripts/ship.ts", { files }), "outward");
  });

  test("a data table in a file that can also run commands is still read", () => {
    const files = {
      [join(ROOT, "scripts", "stages.ts")]: ['import { execSync } from "child_process";', 'const STAGES = ["deploy", "corp-review"];', "execSync(STAGES[1]!);"].join("\n"),
    };
    expectHeld(bash("bun scripts/stages.ts", { files }), "outward");
  });

  test("a test that pushes into its own fixture repo under a temp dir runs; any other push holds", () => {
    const fixture = 'import { execSync } from "child_process";\ntest("x", () => { execSync("git init --bare /tmp/fx.git"); execSync("git push /tmp/fx.git HEAD"); });\n';
    expectAllowed(bash("bun test", { files: { [join(ROOT, "src", "fx.test.ts")]: fixture } }));
    expectAllowed(bash("git push /tmp/fx.git HEAD"));
    for (const command of ["git push origin HEAD", "git push", `git push ${join(HOME, "repo.git")} HEAD`, "git push https://example.com/r.git HEAD", "git push --repo=origin"]) {
      expectHeld(bash(command), "outward");
    }
  });

  test("a test file that binds Standup's own port still holds", () => {
    const serves = 'import { serve } from "bun";\ntest("x", () => serve({ port: 17777, fetch: () => new Response("x") }));\n';
    expectHeld(bash("bun test", { files: { [join(ROOT, "src", "serve.test.ts")]: serves } }), "floor-tamper");
  });

  test("a real call to the collector still holds", () => {
    const files = { [join(ROOT, "scripts", "real.ts")]: 'await fetch("http://127.0.0.1:17777/api/asks/a1/resolve", { method: "POST", body: "{}" });\n' };
    expectHeld(bash("bun scripts/real.ts", { files }), "collector-api");
  });
});

describe("5. the launch's own review scratch dir is its own ground", () => {
  test("staging review media into it runs", () => {
    expectAllowed(bash(`cp /tmp/shots/*.png ${SCRATCH}/`));
    expectAllowed(bash(`cp /tmp/shots/a.png ${SCRATCH}/a.png`));
    expectAllowed(bash(`mkdir -p ${SCRATCH} && cp /tmp/shots/a.png ${SCRATCH}`));
  });

  test("another launch's scratch dir and the rest of the data dir still hold", () => {
    for (const dest of [join(OTHER_SCRATCH, "a.png"), join(DATA, "review-media", "a.png"), join(DATA, "secrets", "a.png"), join(DATA, "standup.db")]) {
      const v = bash(`cp /tmp/shots/a.png ${dest}`);
      expect(v.action).toBe("hold");
      if (v.action === "hold") expect({ dest, ownerOnly: v.ownerOnly }).toEqual({ dest, ownerOnly: true });
    }
    expectHeld(bash(`rm -rf ${SCRATCH}`), "standup-ops");
  });
});

describe("6. an aliased program downstream of xargs parses", () => {
  test("the shell parses whatever the alias expansion puts back together", () => {
    expectAllowed(bash("find . -name '*.ts' | xargs grep -l 'a|b' 2>/dev/null; git status --short | grep -v '^M \\|^A '"));
    expectAllowed(bash("find . -type f | xargs grep -n 'pipeline_advance' 2>/dev/null"));
  });

  test("an outward step downstream of xargs still holds", () => {
    expectHeld(bash("echo HEAD | xargs git push origin"), "outward");
  });
});

describe("7. an arithmetic assignment runs no program", () => {
  const SCAN = join(ROOT, "scan.sh");
  const SCAN_TEXT = ["#!/bin/bash", "declare -A n_scanned", "for ki in a b; do", "  n_scanned[ki]=$((n_scanned[ki] + 1))", "done", 'echo "${n_scanned[@]}"'].join("\n");
  const PUSH_SCAN = join(ROOT, "push-scan.sh");
  const PUSH_SCAN_TEXT = ["#!/bin/bash", "for ki in a b; do", "  n_scanned[$(git push origin HEAD)]=$((n_scanned[ki] + 1))", "done"].join("\n");

  test("element and scalar arithmetic assignments run", () => {
    expectAllowed(bash("n_scanned[ki]=$((n_scanned[ki] + 1))"));
    expectAllowed(bash("total=$((total + 1))"));
    expectAllowed(bash("for ki in a b; do n_scanned[ki]=$((n_scanned[ki] + 1)); done; echo ${n_scanned[@]}"));
    expectAllowed(bash('counts["$key"]+=$((1)); m[i[j]]=2; a[$i]=x'));
  });

  test("a script made of them runs", () => {
    expectAllowed(bash(`bash ${SCAN}`, { files: { [SCAN]: SCAN_TEXT } }));
  });

  test("a command substitution in the subscript or the expression is still classified", () => {
    expectHeld(bash("n[$(git push origin HEAD)]=1"), "outward");
    expectHeld(bash("n[i]=$(($(git push origin HEAD) + 1))"), "outward");
    expectHeld(bash("n[`git push origin HEAD`]+=1"), "outward");
    expectHeld(bash("total=$(( $(git push origin HEAD) + 1 ))"), "outward");
    expectHeld(bash(`bash ${PUSH_SCAN}`, { files: { [PUSH_SCAN]: PUSH_SCAN_TEXT } }), "outward");
  });

  test("a shell without arrays runs the word as a program", () => {
    const LURE = join(ROOT, "ax=", "r");
    const world: World = { files: { [LURE]: "git push origin HEAD\n" } };
    expectHeld(bash("dash -c 'a[x]=/r'", world), "outward");
    expectHeld(bash("sh -c 'a[x]=/r'", world), "outward");
    expectHeld(bash("busybox sh -c 'a[x]=/r'", world), "outward");
    const DASH_SCRIPT = join(ROOT, "d.sh");
    expectHeld(bash(`./d.sh`, { files: { [LURE]: "git push origin HEAD\n", [DASH_SCRIPT]: "#!/bin/dash\na[x]=/r\n" } }), "outward");
    expectAllowed(bash("bash -c 'a[x]=/r'", world));
    expectAllowed(bash(`./scan.sh`, { files: { [SCAN]: SCAN_TEXT } }));
  });

  test("under /bin/sh, an element assignment of pure arithmetic still runs nothing", () => {
    const SH_SCAN = join(ROOT, "sh-scan.sh");
    const PLAIN_SCAN = join(ROOT, "plain-scan");
    const lines = ["for ki in a b; do", "  n_scanned[ki]=$((n_scanned[ki] + 1))", "done"];
    expectAllowed(bash(`sh ${SCAN}`, { files: { [SCAN]: SCAN_TEXT } }));
    expectAllowed(bash("sh -c 'n_scanned[ki]=$((n_scanned[ki] + 1))'"));
    expectAllowed(bash("dash -c 'n[1]=2; total+=$((total + 1))'"));
    expectAllowed(bash("./sh-scan.sh", { files: { [SH_SCAN]: ["#!/bin/sh", ...lines].join("\n") } }));
    expectAllowed(bash("env ./plain-scan", { files: { [PLAIN_SCAN]: lines.join("\n") } }));
    // A PATH the worker changed may hold a program by that name: which one
    // dash runs can't be read, so it holds.
    const BIN = join(ROOT, "bin");
    const lures: World = { files: { [join(BIN, "a[0]=1")]: "git push origin HEAD\n", [join(BIN, "a+=1")]: "git push origin HEAD\n", [join(ROOT, "a[0]=1")]: "git push origin HEAD\n" } };
    const DOT = join(ROOT, "a0=1");
    const globLures: World = { files: { [DOT]: "git push origin HEAD\n", [join("/tmp", "bin", "a1=1")]: "git push origin HEAD\n" } };
    expectHeld(bash(`PATH=/tmp/bin:$PATH sh -c 'a[[:digit:]]=1'`, globLures), "unclassified");
    for (const command of [`PATH=.:$PATH sh -c 'a[$((1))]=1'`, `PATH=.:$PATH sh -c 'a[\\x]=1'`]) {
      expect({ command, action: bash(command, globLures).action }).toEqual({ command, action: "hold" });
    }
    // Written by the same command.
    for (const command of [
      `printf 'git push origin HEAD\\n' > a0=1; chmod +x a0=1; PATH=.:$PATH sh -c 'a[0]=1'`,
      `printf 'git push origin HEAD\\n' > zz; chmod +x zz; PATH=.:$PATH zz`,
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    for (const command of [
      `PATH=${BIN}:$PATH sh -c 'a[0]=1'`,
      `export PATH=${BIN}:$PATH; sh -c 'a+=1'`,
      `PATH=.:$PATH sh -c 'a[0]=1'`,
      `PATH=:$PATH sh -c 'a[0]=1'`,
      `PATH=${BIN}:$PATH git -c alias.z='!a[0]=1' z`,
    ]) {
      // Which program dash looks up on a PATH the worker changed can't be read: held.
      expect({ command, action: bash(command, lures).action }).toEqual({ command, action: "hold" });
    }
    // The guards stay: a path, a substitution, or a variable that changes what runs.
    expectHeld(bash("sh -c 'n[$(git push origin HEAD)]=$((1))'"), "outward");
    expectHeld(bash("sh -c 'n[k]=$(( $(git push origin HEAD) + 1 ))'"), "outward");
    expectHeld(bash("sh -c 'PATH[0]=$((1)); ls'"), "unclassified");
    expectHeld(bash("sh -c 'LD_PRELOAD[0]=/tmp/e.so git status'"), "unclassified");
  });

  test("text /bin/sh runs is read both as dash and as bash would", () => {
    const LURE = join(ROOT, "ax=", "r");
    const APPEND_LURE = join(ROOT, "a+=", "r");
    const world: World = { files: { [LURE]: "echo ok\n", [APPEND_LURE]: "git push origin HEAD\n" } };
    // bash as sh runs the array literal's substitution.
    expectHeld(bash("sh -c 'a[x]=/r y=($(git push origin HEAD))'", world), "outward");
    // dash has no `+=`: the word is a path it runs.
    expectHeld(bash("dash -c 'a+=/r'", world), "outward");
    // Runners that hand text to /bin/sh.
    expectHeld(bash(`git -c alias.z='!a+=/r' z`, world), "outward");
    // A script with no shebang, started by a program rather than a shell.
    const NO_SHEBANG = join(ROOT, "n.sh");
    expectHeld(bash("env ./n.sh", { files: { ...world.files, [NO_SHEBANG]: "a+=/r\n" } }), "outward");
  });

  test("an element of a variable that changes what runs is an unknown value", () => {
    expectHeld(bash("PATH[0]=/tmp/bin; ls"), "unclassified");
  });
});

describe("8. wrappers and builtins that set what a program sees are read as they parse", () => {
  test("xargs reads -I's value as the replacement and --replace as taking none", () => {
    expectHeld(bash("echo origin | xargs -I --replace git push --replace HEAD"), "outward");
    expectHeld(bash("echo origin | xargs --replace git push {} HEAD"), "outward");
    expectHeld(bash("echo origin | xargs -I -I git push -I HEAD"), "outward");
    expectHeld(bash("echo origin | xargs -0 -d , -I {} git push {} HEAD"), "outward");
    expectAllowed(bash("echo a.ts | xargs -I {} grep -n x {}"));
    expectAllowed(bash("echo a.ts | xargs --replace grep -n x {}"));
  });

  test("xargs finds the replacement inside a group of short options", () => {
    expectHeld(bash("echo push | xargs -rI {} git {} origin HEAD"), "outward");
    expectHeld(bash("echo push | xargs -xrI{} git {} origin HEAD"), "outward");
    expectHeld(bash("echo push | xargs -ri git {} origin HEAD"), "outward");
    expectAllowed(bash("echo a.ts | xargs -rI{} grep -n x {}"));
    expectAllowed(bash("find . -name '*.ts' -print0 | xargs -0 -n1 -P4 grep -l x"));
  });

  test("printf -v and read assign a value the floor doesn't compute", () => {
    // A preload hook set that way is unread, and runs.
    expectAllowed(bash("printf -v LD_PRELOAD /tmp/e.so; export LD_PRELOAD; git status"));
    expectAllowed(bash("printf -vLD_PRELOAD /tmp/e.so; export LD_PRELOAD; git status"));
    // A PATH set that way changes which program a name runs.
    expectHeld(bash("printf -v 'PATH[0]' /tmp/bin; ls"), "unclassified");
    expectHeld(bash("read -r PATH < /tmp/p; ls"), "unclassified");
    expectHeld(bash("read 'PATH[0]' < /tmp/p; ls"), "unclassified");
    expectHeld(bash("declare PATH[0]=/tmp/bin; ls"), "unclassified");
    expectHeld(bash("printf -v 'a[$(git push origin HEAD)]' x"), "unclassified");
    expectAllowed(bash("printf -v line '%s-%s' a b; echo \"$line\""));
    expectAllowed(bash("printf -vline '%s' a; echo \"$line\""));
    expectAllowed(bash("while IFS=, read -r a b; do echo \"$a\"; done < /tmp/x.csv"));
    expectAllowed(bash("read -r -p 'Name: ' name; echo \"$name\""));
  });

  test("+=, namerefs, array values, mapfile callbacks and arithmetic subscripts are read as bash runs them", () => {
    expectHeld(bash('a="git push origin HEAD"; a+=" "; $a'), "outward");
    expectHeld(bash('a="git pu"; a+="sh origin HEAD"; $a'), "outward");
    // A nameref is unread, and runs.
    expectAllowed(bash("declare -n p=PATH; p=/tmp/bin; ls"));
    expectAllowed(bash("f() { local -n q=LD_PRELOAD; q=/tmp/e.so; git status; }; f"));
    expectAllowed(bash("declare $(printf -- -n) p=PATH; p=/tmp/bin; ls"));
    expectHeld(bash("declare -a PATH='(/tmp/bin)'; ls"), "unclassified");
    expectHeld(bash("mapfile -C 'git push origin HEAD' -c 1 arr < /tmp/x"), "outward");
    expectHeld(bash("readarray -C'git push origin HEAD' arr < /tmp/x"), "outward");
    for (const command of [
      "let 'a[$(git push origin HEAD)]=1'",
      "unset 'a[$(git push origin HEAD)]'",
      "test -v 'a[$(git push origin HEAD)]'",
      "[ -v 'a[`git push origin HEAD`]' ]",
      "[[ -v 'a[$(git push origin HEAD)]' ]]",
      "x='a[$(git push origin HEAD)]'; echo $((x))",
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    for (const command of [
      "x='a[b[1]+$(git push origin HEAD)]'; echo $((x))",
      "x='a[$[1]+$(git push origin HEAD)]'; echo $((x))",
      "y='$(git push origin HEAD)'; x='a[${y@P}]'; echo $((x))",
      "let 'a[b[1]+$(git push origin HEAD)]=1'",
      "[[ -v 'a[b[0]+$(git push origin HEAD)]' ]]",
      "declare -i n; n+='a[b[1]+$(git push origin HEAD)]'",
      "y='a['; y+='$(git push origin HEAD)]'; echo $((y))",
      "for y in 'a[$(git push origin HEAD)]'; do echo $((y)); done",
      "read -r y <<< 'a[$(git push origin HEAD)]'; echo $((y))",
      "printf -v y '%s' 'a[$(git push origin HEAD)]'; (( y ))",
      "let \"$(cat /tmp/x)\"",
      "[[ -v $(cat /tmp/x) ]]",
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    expectHeld(bash("mapfile -tC 'git push origin HEAD' -c 1 arr < /tmp/x"), "outward");
    expectHeld(bash("mapfile -tC'git push origin HEAD' arr < /tmp/x"), "outward");
    for (const command of [
      "printf -v y 'a\\x5b$(git push origin HEAD)]'; echo $((y))",
      "printf -v y 'a%s$(git push origin HEAD)]' '['; echo $((y))",
      `PATH=.:$PATH sh -c 'a[!]=]1'`,
      "cd /usr/bin && sh -c 'g[!]=] pr merge 1'",
    ]) {
      expect({ command, action: bash(command, { files: { [join(ROOT, "ax1")]: "git push origin HEAD\n" } }).action }).toEqual({ command, action: "hold" });
    }
    // Text that isn't a subscript, and assignment values with option-like words.
    expectAllowed(bash("x='[${HOME}]'; PS4='+[${BASH_SOURCE}:${LINENO}] '; msg=\"[ci] bump \\${VERSION}\"; q='.[] | select(.n == \"${x}\")'; echo ok"));
    expectAllowed(bash("declare -r opts=\"-maxdepth 1 -print\"; declare msg='use -n to dry run'; printf -v pad '%s' 7; echo $opts"));
    expectAllowed(bash("mapfile -t -d '' -u 3 arr 3< /tmp/x; let i++; x+=1; PATH+=:/usr/local/bin; ls"));
    expectAllowed(bash('s="a"; s+="b"; echo "$s"'));
    expectAllowed(bash("export -n FOO; let 'n = n + 1'; unset n; [[ -v n ]]; mapfile -t lines < /tmp/x"));
  });

  test("loop variables and descriptor variables go through the same check", () => {
    expectAllowed(bash("for LD_PRELOAD in /tmp/e.so; do export LD_PRELOAD; git status; done"));
    expectHeld(bash("for PATH in $(cat /tmp/p); do ls; done"), "unclassified");
    expectAllowed(bash("select LD_PRELOAD in /tmp/e.so; do git status; break; done"));
    expectHeld(bash("exec {PATH}>/dev/null; ls"), "unclassified");
    expectAllowed(bash("for f in a b; do echo $f; done"));
    expectAllowed(bash("exec {fd}>/tmp/log; echo hi"));
  });

  test("OpenSSL config and module paths are unread like a native preload, and run", () => {
    expectAllowed(bash("OPENSSL_CONF=/tmp/evil.cnf git status"));
    expectAllowed(bash("export OPENSSL_MODULES=/tmp/m; curl -s http://127.0.0.1:1/"));
  });

  test("bwrap's mounts and options are read at their real arity", () => {
    expectHeld(bash("bwrap --bind / / git push origin HEAD"), "outward");
    expectHeld(bash("bwrap --ro-bind /usr /usr --dev /dev --unshare-net git push origin HEAD"), "outward");
    // Mounts and options that change what the program sees are unread, and run.
    expectAllowed(bash("bwrap --bind /tmp/evil /usr/lib ls"));
    expectAllowed(bash("bwrap --symlink /tmp/evil /usr/bin/ls ls"));
    expectAllowed(bash("bwrap --setenv LD_PRELOAD /tmp/e.so ls"));
    expectAllowed(bash("bwrap --dev-bind / / --overlay-src /tmp/evil --ro-overlay /usr/bin ls"));
    expectAllowed(bash("bwrap --dev-bind / / --overlay-src /tmp/evil --tmp-overlay /usr/bin ls"));
    expectAllowed(bash("bwrap --dev-bind / / --ro-bind-fd 3 /usr/bin/ls ls 3</tmp/evil"));
    expectAllowed(bash("bwrap --dev-bind / / --args 3 ls 3</tmp/a"));
    expectAllowed(bash("bwrap --made-up-option x ls"));
    expectAllowed(bash("bwrap --ro-bind / / --unshare-net ls -la"));
    // unshare and nsenter take short options, read by the generic wrapper.
    const EVIL = join(ROOT, "evil.sh");
    const evil: World = { files: { [EVIL]: "#!/bin/sh\ngit push origin HEAD\n" } };
    for (const command of ["unshare -r ./evil.sh", "unshare -U -- ./evil.sh", "unshare -r bash evil.sh", "nsenter -t 1 -m ./evil.sh", "unshare --map-user 0 ./evil.sh", "unshare --propagation private ./evil.sh", "unshare -R / ./evil.sh", "unshare -w /tmp ./evil.sh", "unshare --setgroups deny ./evil.sh"]) {
      expect({ command, category: (bash(command, evil) as { category?: string }).category }).toEqual({ command, category: "outward" });
    }
    expectAllowed(bash("unshare --user --map-root-user ls"));
    expectAllowed(bash("nsenter --target 1 --mount ls"));
    expectAllowed(bash("bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-all --die-with-parent ls -la"));
  });
});
