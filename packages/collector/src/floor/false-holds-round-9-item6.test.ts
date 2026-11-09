import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `playwright install` with PLAYWRIGHT_BROWSERS_PATH below the worker's
 * TMPDIR (its launch's scratch dir) writes only there, however the shell
 * spells the variable: `$TMPDIR/pw`, `"$TMPDIR/pw"`, `${TMPDIR}/pw`, set
 * inline, exported or handed to `env`, started by `npx`, `bunx` or `npm
 * exec`. Without the variable, or with one naming the default browsers dir,
 * a dir the floor can't place, a path that climbs out of the scratch dir, or
 * a TMPDIR the command points elsewhere, it writes the browsers the
 * screenshot helper launches and stays held; `--with-deps` (or a word the
 * floor can't read) also installs system packages, as `install-deps` does,
 * and stays held too.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const MS = join(HOME, ".cache", "ms-playwright");

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

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(MS, "chromium-1187", "chrome-linux", "chrome")]: "bin\n",
};

function probes(env: Record<string, string> = {}): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, OWN_SCRATCH, join(ROOT, "node_modules", ".bin")]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    homeDir: () => env.HOME ?? HOME,
    env: (name) => env[name] ?? (name === "HOME" ? HOME : name === "TMPDIR" ? OWN_SCRATCH : undefined),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/**
 * The hook shares the worker's environment, where the launcher set TMPDIR to
 * the launch's scratch dir; `tmpdir` undefined is the collector's own
 * environment, which has none.
 */
function bash(command: string, env: Record<string, string> = {}, tmpdir: string | undefined = env.TMPDIR ?? OWN_SCRATCH): FloorVerdict {
  const p = probes(env);
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, { ...p, env: (name) => (name === "TMPDIR" ? tmpdir : p.env!(name)) });
}

function expectAllowed(command: string, env: Record<string, string> = {}, tmpdir: string | undefined = env.TMPDIR ?? OWN_SCRATCH): void {
  expect({ command, verdict: bash(command, env, tmpdir) }).toEqual({ command, verdict: { action: "allow" } });
}

function expectHeld(command: string, category: string, env: Record<string, string> = {}): void {
  const v = bash(command, env);
  expect({ command, v: v.action === "hold" ? { action: v.action, category: v.category } : v }).toMatchObject({ command, v: { action: "hold", category } });
}

describe("playwright install into a dir below the worker's TMPDIR", () => {
  test.each([
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium",
    'PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/pw" npx playwright install chromium',
    "PLAYWRIGHT_BROWSERS_PATH=${TMPDIR}/pw npx playwright install chromium",
    'PLAYWRIGHT_BROWSERS_PATH="${TMPDIR}/pw" npx playwright install chromium',
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw bunx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx -y playwright install chromium",
    "export PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw && npx playwright install",
    'export PLAYWRIGHT_BROWSERS_PATH="${TMPDIR}/pw" && npx playwright install chromium',
    "export PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw; bunx playwright install chromium",
    "env PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install",
    'env PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/pw" npx playwright install chromium',
    "env PLAYWRIGHT_BROWSERS_PATH=${TMPDIR}/pw bunx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium > $TMPDIR/pw.log 2>&1",
    "cd $TMPDIR && PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium",
    "mkdir -p $TMPDIR/pw && PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium",
    "export PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw\nnpx playwright install chromium",
    "PW=$TMPDIR/pw; PLAYWRIGHT_BROWSERS_PATH=$PW npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx --yes playwright@latest install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw bun x playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw pnpm dlx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npm exec playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npm exec -- playwright install chromium",
    "env PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npm exec --yes -- playwright@1.55 install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx -- playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium 2>&1 | tail -5",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium && ls $TMPDIR/pw",
    `TMPDIR=${HOME}/.cache env PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/ms-playwright npx playwright install chromium`,
  ])("allows %p", (command) => {
    expectAllowed(command);
  });

  test.each([
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 600 npx playwright install chromium",
    "export PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw && timeout 600 npx playwright install chromium",
    "env PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 10m bunx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 1.5h npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout -s KILL 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout -sTERM -k 10 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout --signal=INT --kill-after=30s 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout --signal 9 --kill-after 5 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout --preserve-status --foreground -v 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout --verbose -- 600 npx playwright install chromium 2>&1 | tail -5",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 600 npm exec -- playwright install chromium",
  ])("allows under timeout %p", (command) => {
    expectAllowed(command);
  });

  test("classified again in the collector, whose environment has no TMPDIR", () => {
    expectAllowed("PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium", {}, undefined);
    expectAllowed('env PLAYWRIGHT_BROWSERS_PATH="${TMPDIR}/pw" npx playwright install chromium', {}, undefined);
  });
});

describe("playwright install that may write the helper's browsers stays held", () => {
  test.each([
    "npx playwright install chromium",
    "bunx playwright install",
    "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=${HOME}/.cache/ms-playwright npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$UNKNOWN/pw npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=${UNKNOWN}/pw npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/../../ms-playwright npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/../launch-2/pw npx playwright install chromium",
    "env PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/../../ms-playwright npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium",
    `TMPDIR=${HOME}/.cache; PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/ms-playwright npx playwright install chromium`,
    `export TMPDIR=${HOME}/.cache && PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/ms-playwright npx playwright install chromium`,
    "TMPDIR=$(cat /tmp/where); PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install --with-deps chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install chromium --with-deps",
    "PLAYWRIGHT_BROWSERS_PATH=/tmp/pw npm exec -- playwright install --with-deps",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install $FLAGS chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npm --prefix /tmp/p exec playwright install chromium",
    "npm exec playwright install chromium",
    "timeout 600 npx playwright install chromium",
    `PLAYWRIGHT_BROWSERS_PATH=${MS} timeout 600 npx playwright install chromium`,
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 600 npx playwright install --with-deps chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 600 npx playwright install-deps",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout $T npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout -s $SIG 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout -k $K 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout $OPTS 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout --frobnicate 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout -s=KILL 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout --signal= 600 npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout forever npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 600 sudo npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw timeout 600 env -i npx playwright install chromium",
    "timeout 600 env PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install chromium",
    `PLAYWRIGHT_BROWSERS_PATH=${MS} npm exec -- playwright install chromium`,
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw npx playwright install-deps chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw sudo npx playwright install chromium",
  ])("%p", (command) => {
    expectHeld(command, "floor-tamper");
  });

  test("a TMPDIR in the worker's environment naming the helper's cache", () => {
    expectHeld("PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/ms-playwright npx playwright install chromium", "floor-tamper", { TMPDIR: join(HOME, ".cache") });
  });
});

/*
 * GNU getopt_long takes a unique prefix of a long option as that option, so
 * `timeout --kill 1 10 rm …` runs `rm` with `--kill-after 1`, not `10`. A
 * wrapper's long options are read spelt out in full; one that is none of its
 * own, nor the prefix of exactly one, leaves where its command starts unread.
 */
describe("a GNU wrapper's long option given as a prefix", () => {
  test.each([
    "timeout --kill 1 10 rm -rf ~/.ssh",
    "timeout --sig KILL 10 rm -rf ~/.ssh",
    "timeout --k=1 10 rm -rf ~/.ssh",
    "timeout --kill-after 1 10 rm -rf ~/.ssh",
    "timeout -k 1 --sig KILL 10 rm -rf ~/.ssh",
    "nice --adj 5 rm -rf ~/.ssh",
    "nice --adj=5 rm -rf ~/.ssh",
    "env --unse FOO rm -rf ~/.ssh",
    "env --chd /tmp rm -rf ~/.ssh",
    "stdbuf --out 0 rm -rf ~/.ssh",
    "stdbuf --output L rm -rf ~/.ssh",
    "ionice --classd 7 rm -rf ~/.ssh",
    "sudo --us root rm -rf ~/.ssh",
  ])("the command it runs is read: %p", (command) => {
    expectHeld(command, "floor-tamper");
  });

  test.each([
    "timeout --frob 10 rm -rf /tmp/x",
    "timeout --ver 10 rm -rf /tmp/x",
    "nice --x 5 rm -rf /tmp/x",
    "env --i FOO=1 rm -rf /tmp/x",
    "stdbuf --x 0 rm -rf /tmp/x",
    "sudo --pre rm -rf /tmp/x",
    "nohup --frob rm -rf /tmp/x",
    "ionice --cl 3 rm -rf /tmp/x",
  ])("one that is none of its own, or the start of more than one, is held: %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test.each([
    "timeout --kill 1 10 ls /tmp",
    "timeout --sig KILL 10 ls /tmp",
    "timeout --pres 10 ls /tmp",
    "nice --adj 5 ls /tmp",
    "env --unse FOO ls /tmp",
    "stdbuf --out 0 ls /tmp",
    "env --ignore-env PATH=/usr/bin ls /tmp",
    "stdbuf --e 0 ls /tmp",
    "timeout --s TERM 10 ls /tmp",
  ])("allows %p", (command) => {
    expectAllowed(command);
  });
});
