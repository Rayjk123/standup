import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A test file that sets up a throwaway repository and points its remote
 * somewhere, the way a test of push or code-review logic does, runs that step in the
 * directory the test chose when it runs. The same step aimed at the
 * directory the runner starts in, or at a repository the text names, changes
 * where the worktree pushes and still holds. The machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const REPO = join("/", "fake", "repo");
const INSTALL = join("/", "fake", "install");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "a3a3a3a3-0000-4000-8000-0000000000a3",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const PACKAGE_JSON = JSON.stringify({
  name: "standup",
  workspaces: ["packages/*"],
  scripts: { test: "bun test", typecheck: "tsc --noEmit", point: "git config remote.origin.url https://example.com/x.git", repoint: "git remote set-url origin https://example.com/x.git" },
});

const HEADER = 'import { execSync, spawnSync } from "child_process";\nimport { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "fs";\nimport { tmpdir } from "os";\nimport { join, resolve } from "path";\nimport { test } from "bun:test";\nimport { $ } from "bun";\nimport { execa } from "execa";\n';
const ORIGIN = "https://example.com/x.git";
const TEMP = 'const d = mkdtempSync(join(tmpdir(), "x-"));\n';

/** The shape of a pipeline test: a fresh repo under the temp dir whose remote the test sets and unsets. */
const TEMP_REPO_TEST = [
  HEADER,
  "function plainGitRepo(origin: string): string {",
  '  const dir = mkdtempSync(join(tmpdir(), "standup-plain-"));',
  '  Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir, stdout: "pipe", stderr: "pipe" });',
  '  Bun.spawnSync(["git", "config", "remote.origin.url", origin], { cwd: dir, stdout: "pipe", stderr: "pipe" });',
  "  return dir;",
  "}",
  'test("no remote, no review", () => {',
  '  const repo = plainGitRepo("https://github.com/example/app.git");',
  '  Bun.spawnSync(["git", "config", "--unset", "remote.origin.url"], { cwd: repo });',
  "});",
  'test("a remote added after the clone", () => {',
  '  const dir = mkdtempSync(join(tmpdir(), "standup-base-"));',
  '  const remote = mkdtempSync(join(tmpdir(), "standup-origin-"));',
  "  execSync(`git remote add origin ${remote}`, { cwd: dir });",
  '  spawnSync("git", ["remote", "set-url", "origin", remote], { cwd: dir });',
  "});",
].join("\n");

const DIRS = new Set<string>(["/", "/tmp", ROOT, REPO]);

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const all: Record<string, string> = {
    [join(ROOT, ".git")]: `gitdir: ${REPO}/.git/worktrees/feat-1\n`,
    [join(ROOT, "package.json")]: PACKAGE_JSON,
    [join(REPO, ".git", "HEAD")]: "ref: refs/heads/main\n",
    ...files,
  };
  const dirs = new Set(DIRS);
  for (const f of Object.keys(all)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in all ? { ok: true, text: all[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in all || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(all), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in all || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, files: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(files));
}

/** The verdict for each way a worker runs the suite, given one test file. */
function runs(text: string): FloorVerdict[] {
  const files = { [join(ROOT, "src", "closeout.test.ts")]: text };
  return ["bun test", "bun test src/closeout.test.ts", "bun test src"].map((command) => bash(command, files));
}

function category(v: FloorVerdict): string | null {
  return v.action === "hold" ? String(v.category) : null;
}

describe("a remote a test sets in a directory it chooses at run time", () => {
  test("running the suite that holds it is allowed", () => {
    for (const v of runs(TEMP_REPO_TEST)) expect(v).toEqual({ action: "allow" });
  });

  test("the held command from the report runs", () => {
    const files = { [join(ROOT, "src", "pipeline", "pipeline-closeout.test.ts")]: TEMP_REPO_TEST };
    const command = `cd ${ROOT}; bun run typecheck 2>&1 | grep -E "error" | head -20; bun test src/pipeline/pipeline-closeout.test.ts 2>&1 | grep -E "pass|fail" | tail -5`;
    expect(bash(command, files)).toEqual({ action: "allow" });
  });

  const cases: Array<[string, string]> = [
    ["a cwd shorthand bound to a temp dir", `const cwd = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("git remote add origin ${ORIGIN}", { cwd });`],
    ["a subdirectory of a temp dir", `${TEMP}execSync("git remote add origin ${ORIGIN}", { cwd: join(d, "clone") });`],
    ["a path resolved under the temp dir", `const dd = resolve(tmpdir(), "x");\nexecSync("git remote add origin ${ORIGIN}", { cwd: dd });`],
    ["a name assigned in beforeEach", `let dir: string;\nbeforeEach(() => {\n  dir = mkdtempSync(join(tmpdir(), "x-"));\n});\nexecSync("git remote add origin ${ORIGIN}", { cwd: dir });`],
    ["await mkdtemp from fs/promises", `import { mkdtemp } from "fs/promises";\nconst root = await mkdtemp(join(tmpdir(), "r-"));\nspawnSync("git", ["remote", "add", "origin", "${ORIGIN}"], { cwd: root });`],
    ["a template prefix under tmpdir()", "const d = mkdtempSync(`${tmpdir()}/x-`);\nexecSync(`git remote add origin " + ORIGIN + "`, { cwd: d });"],
    ["the real path of a temp dir, cast", `const d = realpathSync(mkdtempSync(join(tmpdir(), "x-"))) as string;\nexecSync("git remote add origin ${ORIGIN}", { cwd: d });`],
    ["a fixture object's dir", `const repo = { dir: mkdtempSync(join(tmpdir(), "x-")) };\nexecSync("git remote add origin ${ORIGIN}", { cwd: repo.dir });`],
    ["a helper that returns { dir }", `function fixture() {\n  const dir = mkdtempSync(join(tmpdir(), "x-"));\n  return { dir };\n}\nconst f = fixture();\nconst { dir: root } = fixture();\nexecSync("git remote add origin ${ORIGIN}", { cwd: f.dir });\nexecSync("git remote set-url origin ${ORIGIN}", { cwd: root });`],
    ["a hermetic env", `${TEMP}execSync("git remote add origin ${ORIGIN}", { cwd: d, env: { ...process.env, HOME: d, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });`],
    ["HOME set for the whole file", `${TEMP}process.env.HOME = d;\nexecSync("git remote add origin ${ORIGIN}", { cwd: d });`],
    ["git -C a temp dir", `${TEMP}execSync(\`git -C \${d} remote add origin ${ORIGIN}\`);`],
    ["git -C the same temp dir in every step", `${TEMP}execSync(\`git -C \${d} init -q && git -C \${d} remote add origin ${ORIGIN}\`);`],
    ["a unique-name part in the temp prefix", "const d = mkdtempSync(join(tmpdir(), `x-${Date.now()}-`));\nconst e = join(tmpdir(), `y-${process.pid}`);\nexecSync(`git remote add origin " + ORIGIN + "`, { cwd: d });\nexecSync(`git remote set-url origin " + ORIGIN + "`, { cwd: e });"],
    ["Bun.spawnSync with cmd", `${TEMP}Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", "${ORIGIN}"], cwd: d });`],
    ["a file with no semicolons that uses Array.from", `${TEMP.replace(";", "")}execSync("git remote add origin ${ORIGIN}", { cwd: d })\nconst xs = Array.from([1])`],
    ["a name bound through another name to a temp dir", `${TEMP}const dd = d;\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: dd });`],
    ["a local helper that makes a temp dir", `function fresh() {\n  const dir = mkdtempSync(join(tmpdir(), "x-"));\n  return dir;\n}\nconst r = fresh();\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: r });`],
    ["an env option that sets the author", `${TEMP}execSync("git remote add origin ${ORIGIN}", { cwd: d, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });`],
    ["encoding and stdio options", `${TEMP}execSync("git remote add origin ${ORIGIN}", { cwd: d, encoding: "utf8", stdio: "pipe" });`],
    ["a Bun shell .cwd()", `${TEMP}await $\`git remote add origin ${ORIGIN}\`.cwd(d);`],
    ["a Bun shell .quiet().cwd()", `${TEMP}await $\`git remote set-url origin ${ORIGIN}\`.quiet().cwd(d);`],
    ["execa", `${TEMP}await execa("git", ["remote", "add", "origin", "${ORIGIN}"], { cwd: d });`],
    ["git remote -v, no cwd", 'execSync("git remote -v");'],
    ["git remote update, no cwd", 'execSync("git remote update");'],
    ["git remote prune, no cwd", 'execSync("git remote prune origin");'],
    ["init and remote add in one text",`${TEMP}execSync("git init -q && git remote add origin ${ORIGIN}", { cwd: d });`],
  ];
  for (const [name, body] of cases) {
    test(name, () => {
      const text = `${HEADER}test("x", async () => {\n${body}\n});\n`;
      for (const v of runs(text)) expect({ name, verdict: v }).toEqual({ name, verdict: { action: "allow" } });
    });
  }
});

describe("a test that changes where the worktree pushes still holds", () => {
  const cases: Array<[string, string]> = [
    ["no cwd: the directory the runner starts in", 'execSync("git config remote.origin.url https://example.com/x.git");'],
    ["no cwd, argv form", 'spawnSync("git", ["remote", "set-url", "origin", "https://example.com/x.git"]);'],
    ["no cwd, unset", 'Bun.spawnSync(["git", "config", "--unset", "remote.origin.pushurl"]);'],
    ["the runner's own cwd", 'execSync("git config remote.origin.url https://example.com/x.git", { cwd: process.cwd() });'],
    ["a literal cwd", 'execSync("git config remote.origin.url https://example.com/x.git", { cwd: "." });'],
    ["the test file's own dir", 'execSync("git config remote.origin.url https://example.com/x.git", { cwd: import.meta.dir });'],
    ["a name bound to the runner's cwd", 'const here = process.cwd();\nexecSync("git config remote.origin.url https://example.com/x.git", { cwd: here });'],
    ["a name rebound to the runner's cwd", 'let d = mkdtempSync(join(tmpdir(), "x-"));\nd = process.cwd();\nexecSync("git remote set-url origin https://example.com/x.git", { cwd: d });'],
    ["a name bound to __dirname", 'const d = __dirname;\nspawnSync("git", ["config", "remote.origin.url", "https://example.com/x.git"], { cwd: d });'],
    ["a cd to a real repo first", `const d = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("cd ${REPO} && git config remote.origin.url https://example.com/x.git", { cwd: d });`],
    ["git -C a real repo", `const d = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("git -C ${REPO} remote set-url origin https://example.com/x.git", { cwd: d });`],
    ["--git-dir a real repo", `const d = mkdtempSync(join(tmpdir(), "x-"));\nBun.spawnSync(["git", "--git-dir", "${REPO}/.git", "config", "remote.origin.url", "https://example.com/x.git"], { cwd: d });`],
    ["GIT_DIR in the shell text", `const d = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("GIT_DIR=${REPO}/.git git config remote.origin.url https://example.com/x.git", { cwd: d });`],
    ["an env option, which can name GIT_DIR", 'const d = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("git config remote.origin.url https://example.com/x.git", { cwd: d, env: gitEnv });'],
    ["an env option that names GIT_DIR", `const d = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d, env: { ...process.env, GIT_DIR: "${REPO}/.git" } });`],
    ["npm --prefix a real repo", `${TEMP}execSync("npm --prefix ${REPO} exec -- git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["yarn --cwd a real repo", `${TEMP}execSync("yarn --cwd ${REPO} exec git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["bun --cwd a real repo", `${TEMP}execSync("bun --cwd ${REPO} x git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["sh -c around it", `${TEMP}execSync("sh -c 'git config remote.origin.url ${ORIGIN}'", { cwd: d });`],
    ["piped through xargs", `${TEMP}execSync("echo ${ORIGIN} | xargs git config remote.origin.url", { cwd: d });`],
    ["git config -f a real repo's config", `${TEMP}execSync("git config -f ${REPO}/.git/config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["git config --file= a real repo's config", `${TEMP}execSync("git config --file=${REPO}/.git/config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["git config --global insteadOf", `${TEMP}execSync("git config --global url.https://evil.example/.insteadOf https://github.com/", { cwd: d });`],
    ["git config --global pushInsteadOf", `${TEMP}execSync("git config --global url.https://evil.example/.pushInsteadOf git@github.com:", { cwd: d });`],
    ["git config --system insteadOf", `${TEMP}execSync("git config --system url.https://evil.example/.insteadOf https://github.com/", { cwd: d });`],
    ["git config -f the global config", `${TEMP}execSync("git config -f ${HOME}/.gitconfig url.https://evil.example/.insteadOf https://github.com/", { cwd: d });`],
    ["a cwd nested inside another option", `${TEMP}execSync("git config remote.origin.url ${ORIGIN}", { stdio: "pipe", input: JSON.stringify({ cwd: d }) });`],
    ["a cwd inside a nested call", `${TEMP}execSync("git config remote.origin.url ${ORIGIN}", opts(mk({ cwd: d })));`],
    ["a name bound through another name to the runner's cwd", `const top = process.cwd();\nconst dd = top;\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: dd });`],
    ["a helper the file doesn't define", `execSync("git config remote.origin.url ${ORIGIN}", { cwd: repoRoot() });`],
    ["a local helper that returns the runner's cwd", `function here() { return process.cwd(); }\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: here() });`],
    ["an options object later given an env", `${TEMP}const o = { cwd: d };\no.env = gitEnv;\nexecSync("git config remote.origin.url ${ORIGIN}", o);`],
    ["a Bun shell .cwd() with an .env()", `${TEMP}await $\`git config remote.origin.url ${ORIGIN}\`.cwd(d).env(gitEnv);`],
    ["git remote set-url, no cwd", `execSync("git remote set-url origin ${ORIGIN}");`],
    ["git remote add upstream, no cwd", `execSync("git remote add upstream ${ORIGIN}");`],
    ["a parameter, called with the runner's cwd", `function setup(dir: string) { execSync("git config remote.origin.url ${ORIGIN}", { cwd: dir }); }\nsetup(process.cwd());`],
    ["an arrow parameter", `[process.cwd()].forEach((dir) => execSync("git config remote.origin.url ${ORIGIN}", { cwd: dir }));`],
    ["a parameter shadowing a temp dir", `${TEMP}function setup(d: string) { execSync("git config remote.origin.url ${ORIGIN}", { cwd: d }); }\nsetup(process.cwd());`],
    ["a loop variable", `for (const dir of [process.cwd()]) execSync("git config remote.origin.url ${ORIGIN}", { cwd: dir });`],
    ["an undeclared name", `execSync("git config remote.origin.url ${ORIGIN}", { cwd: PROJECT_ROOT });`],
    ["a member of an undeclared fixture", `execSync("git remote set-url origin ${ORIGIN}", { cwd: repo.path });`],
    ["a class field", `class R { root = process.cwd(); run() { execSync("git config remote.origin.url ${ORIGIN}", { cwd: this.root }); } }`],
    ["a local helper that returns its argument", `function id(x: string) { return x; }\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: id(process.cwd()) });`],
    ["a compound assignment", `let d = mkdtempSync(join(tmpdir(), "x-"));\nd += "/../..";\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a destructuring assignment", `let d = mkdtempSync(join(tmpdir(), "x-"));\n[d] = [process.cwd()];\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a temp dir made in the worktree", `const d = mkdtempSync(join(process.cwd(), "x-"));\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a temp dir with a relative prefix", `const d = mkdtempSync("fx-");\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a temp dir climbing out", `const d = mkdtempSync(join(tmpdir(), "../fake/repo/x-"));\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["TMPDIR pointed at the worktree", `process.env.TMPDIR = process.cwd();\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: tmpdir() });`],
    ["a symlink into the temp dir", `${TEMP}const l = join(d, "l");\nsymlinkSync(process.cwd(), l);\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: l });`],
    ["a gitfile naming a real repo", `${TEMP}writeFileSync(join(d, ".git"), "gitdir: ${REPO}/.git");\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a worktree of the real repo", `${TEMP}execSync("git worktree add " + d);\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["git init --separate-git-dir a real repo", `${TEMP}execSync("git init --separate-git-dir ${REPO}/.git && git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["git config --glob", `${TEMP}execSync("git config --glob url.https://evil.example/.insteadOf https://github.com/", { cwd: d });`],
    ["git config -f stuck to its value", `${TEMP}execSync("git config -f${REPO}/.git/config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["git config --fil", `${TEMP}execSync("git config --fil ${REPO}/.git/config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["flags spread into the argv", `${TEMP}const flags = ["-C", "${REPO}"];\nspawnSync("git", [...flags, "config", "remote.origin.url", "${ORIGIN}"], { cwd: d });`],
    ["flags concatenated into the text", `${TEMP}const flags = " -C ${REPO}";\nexecSync("git" + flags + " config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["an options object bound to a name", `${TEMP}const o = { cwd: d };\nexecSync("git config remote.origin.url ${ORIGIN}", o);`],
    ["an options object changed through an alias", `${TEMP}const o = { cwd: d };\nconst p = o;\np.cwd = process.cwd();\nexecSync("git config remote.origin.url ${ORIGIN}", o);`],
    ["GIT_DIR set through an alias of process.env", `${TEMP}const e = process.env;\ne.GIT_DIR = "${REPO}/.git";\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["GIT_DIR set through Reflect", `${TEMP}Reflect.set(process.env, "GIT_DIR", "${REPO}/.git");\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["GIT_DIR set with a literal key", `${TEMP}process.env["GIT_DIR"] = "${REPO}/.git";\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a shell option with BASH_ENV", `${TEMP}execSync("git config remote.origin.url ${ORIGIN}", { cwd: d, shell: "/bin/bash", env: { ...process.env, BASH_ENV: "/tmp/rc" } });`],
    ["git -c in the text", `${TEMP}execSync("git -c include.path=${REPO}/.git/config config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["git -C a name bound to the runner's cwd", `const top = process.cwd();\nexecSync(\`git -C \${top} remote set-url origin ${ORIGIN}\`);`],
    ["git -C a temp dir, then a step without it", `${TEMP}execSync(\`git -C \${d} init -q && git remote add origin ${ORIGIN}\`);`],
    ["git -C a temp dir, then a step after ;", `${TEMP}execSync(\`git -C \${d} remote add upstream ${ORIGIN}; git remote set-url origin ${ORIGIN}\`);`],
    ["git -C a temp dir, then a step on the next line", `${TEMP}execSync(\`git -C \${d} init -q\ngit config remote.origin.url ${ORIGIN}\`);`],
    ["git -C a temp dir with the runner's cwd as cwd", `${TEMP}execSync(\`git -C \${d} init -q && git config remote.origin.url ${ORIGIN}\`, { cwd: process.cwd() });`],
    ["os mocked by mock.module", `import { mock } from "bun:test";\nmock.module("os", () => ({ tmpdir: () => process.cwd() }));\n${TEMP}execSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["node:os mocked, tmpdir() as cwd", `mock.module("node:os", () => ({ tmpdir: () => process.cwd() }));\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: tmpdir() });`],
    ["os mocked by jest.mock", `jest.mock("os", () => ({ tmpdir: () => process.cwd() }));\n${TEMP}execSync("git config remote.origin.url ${ORIGIN}", { cwd: d });`],
    ["a spy on os.tmpdir", `import * as os from "os";\nspyOn(os, "tmpdir").mockReturnValue(process.cwd());\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: os.tmpdir() });`],
    ["os.tmpdir assigned", `import os from "os";\nos.tmpdir = () => process.cwd();\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: os.tmpdir() });`],
    ["require(\"os\").tmpdir assigned", `require("os").tmpdir = () => process.cwd();\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: tmpdir() });`],
    ["a fixture changed by a helper it is passed to", `const repo = { dir: mkdtempSync(join(tmpdir(), "x-")) };\nfunction reset(r: { dir: string }) { r.dir = process.cwd(); }\nreset(repo);\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: repo.dir });`],
    ["a fixture changed through an array", `const repo = { dir: mkdtempSync(join(tmpdir(), "x-")) };\nconst all = [repo];\nall[0].dir = process.cwd();\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: repo.dir });`],
    ["a fixture with a getter", `const repo = { get dir() { return process.cwd(); } };\nexecSync("git config remote.origin.url ${ORIGIN}", { cwd: repo.dir });`],
  ];
  for (const [name, body] of cases) {
    test(name, () => {
      const text = `${HEADER}test("x", () => {\n${body}\n});\n`;
      for (const v of runs(text)) expect({ name, category: category(v) }).toEqual({ name, category: "outward" });
    });
  }
});

describe("the same step typed or run any other way still holds", () => {
  test("typed in the command", () => {
    for (const command of [
      "git config remote.origin.url https://example.com/x.git",
      "git config --unset remote.origin.url",
      "git remote set-url origin https://example.com/x.git",
      `git -C ${REPO} config remote.origin.url https://example.com/x.git`,
      `cd ${REPO} && git config remote.origin.url https://example.com/x.git`,
      `cd /tmp && git -C ${ROOT} remote set-url origin https://example.com/x.git`,
    ]) {
      expect({ command, category: category(bash(command)) }).toEqual({ command, category: "outward" });
    }
  });

  test("inline code and package scripts", () => {
    for (const command of [
      `bun -e 'require("child_process").execSync("git config remote.origin.url https://example.com/x.git", { cwd: dir })'`,
      `node -e 'require("child_process").execSync("git config remote.origin.url https://example.com/x.git")'`,
      "bun run point",
      "npm run repoint",
    ]) {
      expect({ command, category: category(bash(command)) }).toEqual({ command, category: "outward" });
    }
  });

  test("a large suite of fixture repos is read in bounded time", () => {
    const one = (k: number) => `test("t${k}", () => {\n  dir = mkdtempSync(join(tmpdir(), "x-${k}-"));\n  const r${k} = mkdtempSync(join(tmpdir(), "y-"));\n  execSync("git remote add origin ${ORIGIN}", { cwd: dir });\n  spawnSync("git", ["remote", "set-url", "origin", "${ORIGIN}"], { cwd: r${k} });\n});\n`;
    const text = `${HEADER}let dir: string;\n${Array.from({ length: 1500 }, (_, k) => one(k)).join("")}`;
    const started = performance.now();
    const v = bash("bun test src/big.test.ts", { [join(ROOT, "src", "big.test.ts")]: text });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(v.action === "allow" || category(v) === "outward").toBe(true);
  });

  test("a run whose environment moves git", () => {
    const placed = `${HEADER}test("x", () => {\n${TEMP}execSync("git config remote.origin.url ${ORIGIN}", { cwd: d });\n});\n`;
    const files = { [join(ROOT, "src", "a.test.ts")]: placed };
    expect(bash("bun test", files)).toEqual({ action: "allow" });
    for (const command of [`GIT_DIR=${REPO}/.git bun test`, `env GIT_DIR=${REPO}/.git bun test`, `export TMPDIR=${ROOT}; bun test`, "bun test --env-file ci.env"]) {
      expect({ command, category: category(bash(command, files)) }).toEqual({ command, category: "outward" });
    }
    const sibling = { ...files, [join(ROOT, "src", "b.test.ts")]: `${HEADER}process.env.GIT_DIR = "${REPO}/.git";\n` };
    expect(category(bash("bun test", sibling))).toBe("outward");
    const dotenv = { ...files, [join(ROOT, ".env")]: `GIT_DIR=${REPO}/.git\n` };
    expect(category(bash("bun test", dotenv))).toBe("outward");
    for (const command of ["bun --env-file ci.env test", "bun --preload ./setup.ts test", "bun test --config ci.toml", "bun test --preload ./setup.ts", "NODE_OPTIONS='--require ./x.js' bun test"]) {
      expect({ command, category: category(bash(command, files)) }).toEqual({ command, category: "outward" });
    }
  });

  test("a run whose test files import a module", () => {
    const importing = (spec: string) => `import "${spec}";\n${HEADER}test("x", () => {\n${TEMP}execSync("git config remote.origin.url ${ORIGIN}", { cwd: d });\n});\n`;
    const clean = { [join(ROOT, "src", "a.test.ts")]: importing("./setup"), [join(ROOT, "src", "setup.ts")]: 'import { helper } from "./lib/helper.js";\nexport const x = helper;\n', [join(ROOT, "src", "lib", "helper.ts")]: "export const helper = 1;\n" };
    expect(bash("bun test", clean)).toEqual({ action: "allow" });
    const moved = { ...clean, [join(ROOT, "src", "lib", "helper.ts")]: `process.env.GIT_DIR = "${REPO}/.git";\nexport const helper = 1;\n` };
    expect(category(bash("bun test", moved))).toBe("outward");
    const tmp = { ...clean, [join(ROOT, "src", "setup.ts")]: "process.env.TMPDIR = process.cwd();\n" };
    expect(category(bash("bun test", tmp))).toBe("outward");
    const missing = { [join(ROOT, "src", "a.test.ts")]: importing("./not-there") };
    expect(category(bash("bun test", missing))).toBe("outward");
  });

  test("a large file of inline fixture data is read in bounded time", () => {
    const data = `const rows = [\n${Array.from({ length: 12000 }, (_, k) => `  { id: ${k}, name: "row-${k}", tags: ["a", "b"], nested: { ok: true } },`).join("\n")}\n];\n`;
    const text = `${HEADER}${data}test("x", () => {\n${TEMP}execSync("git remote add origin ${ORIGIN}", { cwd: d });\n});\n`;
    const started = performance.now();
    const v = bash("bun test src/big.test.ts", { [join(ROOT, "src", "big.test.ts")]: text });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(v).toEqual({ action: "allow" });
  });

  test("a script file that sets the remote in a directory of its choosing", () => {
    const files = { [join(ROOT, "scripts", "point.ts")]: `${HEADER}const d = mkdtempSync(join(tmpdir(), "x-"));\nexecSync("git config remote.origin.url https://example.com/x.git", { cwd: d });\n` };
    expect(category(bash("bun scripts/point.ts", files))).toBe("outward");
  });
});
