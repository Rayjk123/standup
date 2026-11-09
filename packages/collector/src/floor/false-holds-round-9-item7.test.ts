import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * An isolated test run: `env -i` with HOME, the XDG dirs, the temp dirs and
 * Standup's DB, knowledge and internal dirs all under one /tmp root (a
 * literal one, or `$R` from `mktemp -d -p /tmp`), then `bun test` in the
 * worker's own worktree. Written with each value in double quotes
 * (`HOME="$R/home"`), the way a careful script spells it, it is the same
 * isolation as the unquoted spelling: the quotes only keep each value one
 * word. Without the isolation, setting HOME or the XDG config and data dirs
 * stays held wherever the call names a denylist target (here a comment
 * naming the live data dir, as workers' commands often do).
 *
 * The worktree reads through to this checkout; the rest of the machine is
 * virtual.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");
const ELSEWHERE = join("/", "fake", "elsewhere");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:7777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  scratchDir: SCRATCH,
  scratchRoot: join(HOME, ".cache", "standup-scratch"),
};

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
};

/** The worker's env as the hook sees it: in a tmux pane, with its temp dirs in the launch's scratch dir. */
const WORKER_ENV: Record<string, string> = {
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: "/usr/bin:/bin",
};

/** A literal root an earlier run left behind, whose temp dir holds a fixture link leading out of it. */
const USED = join("/", "tmp", "r9-used");
const USED_DIRS = ["home", "xdg/config", "xdg/data", "xdg/cache", "xdg/state", "tmp/docs-routes-x", "data", "knowledge", "internal"].map((d) => join(USED, d));
/** A root under /tmp that is itself a link out of /tmp. */
const LINKED = join("/", "tmp", "r9-link");
const LINKS: Record<string, string> = {
  [join(USED, "tmp", "docs-routes-x", "link.md")]: join(ELSEWHERE, "notes.md"),
  [LINKED]: join(ELSEWHERE, "iso"),
};

/** The real path a virtual worktree or install path reads through to, or null for the rest of the virtual machine. */
function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", SCRATCH, ...USED_DIRS]);
  for (const f of [...Object.keys(VIRTUAL), ...Object.keys(LINKS), SCRATCH]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (p: string) => p in VIRTUAL || bare(p) in LINKS || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p, max) => (p in VIRTUAL ? { ok: true, text: VIRTUAL[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" }),
    exists,
    isDirectory,
    executable: (p) => (p in VIRTUAL ? false : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat(Object.keys(LINKS), [...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    lstat: (p) => (bare(p) in LINKS ? { symlink: true, file: false, nlink: 1 } : exists(p) ? { symlink: false, file: !isDirectory(p), nlink: 1 } : null),
    realpath: (p) => (bare(p) in LINKS ? LINKS[bare(p)]! : exists(p) ? bare(p) : null),
    homeDir: () => HOME,
    env: (name) => WORKER_ENV[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** Classifies `command` with the hook's own TMPDIR set to the worker's, from which the floor reads a bare `mktemp -d`'s dir. */
function bash(command: string, cwd = ROOT): FloorVerdict {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = SCRATCH;
  try {
    return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

/** The env an isolated test run hands `bun test`, every path under `r`, each value double-quoted unless `bare`. */
function iso(r: string, over: Record<string, string> = {}, bare = false): string {
  const env: Record<string, string> = {
    PATH: "/fake/home/.bun/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: `${r}/home`,
    XDG_CACHE_HOME: `${r}/xdg/cache`,
    XDG_CONFIG_HOME: `${r}/xdg/config`,
    XDG_DATA_HOME: `${r}/xdg/data`,
    XDG_STATE_HOME: `${r}/xdg/state`,
    TMPDIR: `${r}/tmp`,
    TMP: `${r}/tmp`,
    TEMP: `${r}/tmp`,
    DB_PATH: `${r}/data/standup.db`,
    STANDUP_SQLITE_PATH: `${r}/data/standup.db`,
    KNOWLEDGE_DIR: `${r}/knowledge`,
    STANDUP_INTERNAL_ROOT: `${r}/internal`,
    ...over,
  };
  return Object.entries(env).map(([k, v]) => (bare || /^'.*'$/.test(v) ? `${k}=${v}` : `${k}="${v}"`)).join(" ");
}

/** A no-op handed a denylist command's words: with it in the call, what the floor can't read is held, not allowed. */
const NOTE = ": never runs tmux kill-server\n";
const MKTEMP = "R=$(mktemp -d -p /tmp floor-r9-XXXXXX)";
const MKDIRS = 'mkdir -p "$R/home" "$R/xdg/cache" "$R/xdg/config" "$R/xdg/data" "$R/xdg/state" "$R/tmp" "$R/data" "$R/knowledge" "$R/internal"';
const TARGET = "packages/shared/src/";
const LIT = join("/", "tmp", "floor-r9-lit");

function verdict(command: string, cwd?: string): { command: string; action: string; reason: string } {
  const v = bash(command, cwd);
  return { command, action: v.action, reason: v.action === "hold" ? v.reason : "" };
}

const allowed = (command: string, cwd?: string) => expect(verdict(command, cwd)).toMatchObject({ command, action: "allow" });
const heldForConfig = (command: string, name = "HOME", cwd?: string) => {
  const v = verdict(command, cwd);
  expect(v).toMatchObject({ command, action: "hold" });
  expect(v.reason).toContain(`sets ${name}, so tools read their configuration from`);
};

describe("an isolated test run with double-quoted values is isolated", () => {
  const runs = [
    `${NOTE}env -i ${iso(LIT)} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; ${MKDIRS}; env -i ${iso("$R")} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("${R}")} bun test ${TARGET}`,
    `${NOTE}R=$(mktemp -d -p /tmp x-XXXXXX); env -i ${iso("$R")} bun test packages/collector/src/floor/false-holds-round-8-item1.test.ts`,
    `${NOTE}${MKTEMP}; ${MKDIRS}; cd ${ROOT} && env -i ${iso("$R")} bun test ${TARGET}`,
    `${NOTE}cd ${ROOT} && env -i ${iso(LIT)} bun test ${TARGET}`,
    `${NOTE}set -u\n${MKTEMP}\n${MKDIRS}\ncd "${ROOT}" || exit 1\nenv -i \\\n  ${iso("$R")} \\\n  bun test ${TARGET}\ncode=$?\necho "root: $R exit: $code"\nexit $code`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R")} bun test ${TARGET} > $R/out.txt 2>&1; grep "(fail)" $R/out.txt`,
    `${NOTE}${MKTEMP}; env -i "HOME=$R/home" ${iso("$R", {}, true).replace(/HOME=\S+ /, "")} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i HOME="$R"/home ${iso("$R", {}, true).replace(/HOME=\S+ /, "")} bun test ${TARGET}`,
  ];
  test.each(runs)("allows %p", (command) => allowed(command));

  // The same runs spelled without quotes were already isolated: the quoted spelling now matches them.
  test.each([`${NOTE}env -i ${iso(LIT, {}, true)} bun test ${TARGET}`, `${NOTE}${MKTEMP}; env -i ${iso("$R", {}, true)} bun test ${TARGET}`])("allows %p", (command) => allowed(command));

  // Without a denylist-naming text, what the floor can't read is allowed either way.
  test.each([`env -i ${iso(LIT)} bun test ${TARGET}`, `${MKTEMP}; env -i ${iso("$R")} bun test ${TARGET}`])("allows %p", (command) => allowed(command));
});

describe("a root the command names in a plain assignment", () => {
  const short = (r: string, q = "") =>
    `PATH=/usr/bin:/bin HOME=${q}${r}/home${q} XDG_CONFIG_HOME=${q}${r}/cfg${q} XDG_DATA_HOME=${q}${r}/data${q} XDG_CACHE_HOME=${q}${r}/cache${q} XDG_STATE_HOME=${q}${r}/state${q} DB_PATH=${q}${r}/db/standup.db${q} STANDUP_SQLITE_PATH=${q}${r}/db/standup.db${q} KNOWLEDGE_DIR=${q}${r}/kb${q} STANDUP_INTERNAL_ROOT=${q}${r}/internal${q} TMPDIR=${q}${r}/tmp${q}`;
  const files = "packages/shared/src/topology.test.ts packages/shared/src/";
  test.each([
    `${NOTE}R=/tmp/r9-iso; mkdir -p $R/home; env -i ${short("$R")} bun test ${files}`,
    `${NOTE}R=/tmp/r9-iso; mkdir -p "$R/home"; env -i ${short("$R", '"')} bun test ${files}`,
    `${NOTE}R=/tmp/r9-iso\nenv -i ${short("${R}", '"')} bun test ${files}`,
    `${NOTE}R="/tmp/r9-iso"; env -i ${short("$R", '"')} bun test ${files}`,
  ])("allows %p", (command) => allowed(command));

  // The worker's own TMPDIR is the launch's scratch dir: a root below it is credited as one below /tmp is.
  test.each([
    `${NOTE}R=${SCRATCH}/iso; env -i ${short("$R")} bun test ${files}`,
    `${NOTE}R=${SCRATCH}/iso; env -i ${short("$R", '"')} bun test ${files}`,
    `${NOTE}env -i ${short(`${SCRATCH}/iso`, '"')} bun test ${files}`,
  ])("allows %p, rooted in the worker's own scratch dir", (command) => allowed(command));

  test.each([
    [`${NOTE}R=/tmp/r9-iso; env -i ${short("$R", '"').replace('HOME="$R/home"', `HOME="${HOME}/.config"`)} bun test ${files}`, "HOME"],
    [`${NOTE}R=/tmp/r9-iso; env -i ${short("$R", '"').replace('XDG_CONFIG_HOME="$R/cfg"', `XDG_CONFIG_HOME="${HOME}/.config"`)} bun test ${files}`, "XDG_CONFIG_HOME"],
    [`${NOTE}R=/tmp/r9-iso; env -i ${short("$R", '"').replace('XDG_DATA_HOME="$R/data"', `XDG_DATA_HOME="${HOME}/.local/share"`)} bun test ${files}`, "XDG_DATA_HOME"],
    [`${NOTE}R=${join(DATA, "worktrees", "iso")}; env -i ${short("$R", '"')} bun test ${files}`, "HOME"],
    [`${NOTE}R=${HOME}; env -i ${short("$R", '"')} bun test ${files}`, "XDG_CONFIG_HOME"],
  ])("holds %p, aimed at a real home or config dir or Standup's data dir", (command, name) => heldForConfig(command, name));

  // Rooted in the live data dir itself, the run is held for the live paths it is handed.
  test("holds a root in Standup's data dir", () => {
    const command = `${NOTE}R=${DATA}; env -i ${short("$R", '"')} bun test ${files}`;
    expect(verdict(command)).toMatchObject({ command, action: "hold" });
    expect(verdict(command).reason).toContain("in Standup's live data dir");
  });
});

describe("zsh reads some `$T` forms differently inside double quotes", () => {
  test.each([
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$R[1,8]/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$R:h/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$R:h/home" }, true)} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$=R/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$~R/home" })} bun test ${TARGET}`,
  ])("holds %p", (command) => heldForConfig(command));

  // A `:` that starts no modifier (a PATH list) is plain text.
  test("allows a PATH list after `$T`", () => allowed(`${NOTE}${MKTEMP}; B=/usr/bin; env -i ${iso("$R", { PATH: "$B:/bin" })} bun test ${TARGET}`));
});

describe("an isolated scratch collector started with double-quoted values", () => {
  const FLAGS = SCRATCH_COLLECTOR_ENV.map(([k, v]) => `${k}=${v}`).join(" ");
  const env = (q: string) =>
    [
      `PATH=${q}/fake/home/.bun/bin:/usr/bin:/bin${q}`,
      ...["HOME=home", "XDG_CONFIG_HOME=xdg/config", "XDG_DATA_HOME=xdg/data", "XDG_CACHE_HOME=xdg/cache", "XDG_STATE_HOME=xdg/state", "TMPDIR=tmp", "TMUX_TMPDIR=tmux", "DB_PATH=db", "KNOWLEDGE_DIR=kb", "STANDUP_INTERNAL_ROOT=internal", "STANDUP_PROJECT_DOCS_DIR=docs", "ICONS_DIR=icons", "STANDUP_WRITE_TOKEN_FILE=token", "STANDUP_PROJECTS_PATH=projects.json", "STANDUP_WORKTREE_ROOT=wt"].map((kv) => {
        const [k, v] = kv.split("=");
        return `${k}=${q}$X/${v}${q}`;
      }),
      "COLLECTOR_PORT=29777 WS_PORT=29778",
      FLAGS,
    ].join(" ");
  const start = (q: string) => `X=$(mktemp -d -p /tmp floor-iso-XXXXXX); mkdir -p "$X/home" "$X/tmux"; env -i ${env(q)} bun packages/collector/src/index.ts > $TMPDIR/c.log 2>&1 &`;
  test("the quoted start decides as the unquoted one, and is allowed", () => {
    expect(verdict(start('"'))).toMatchObject({ action: verdict(start("")).action });
    expect(verdict(start('"')).action).toBe("allow");
  });
});

describe("a quoted run that is not isolated stays held", () => {
  test.each([
    [`${NOTE}env -i ${iso("/tmp/x", { HOME: "/fake/other" })} bun test ${TARGET}`, "HOME"],
    [`${NOTE}env -i ${iso("/tmp/x", { HOME: join("/", "fake", "home", ".ssh-ish") })} bun test ${TARGET}`, "HOME"],
    [`${NOTE}env -i ${iso("/tmp/x", { HOME: "/home/someoneelse" })} bun test ${TARGET}`, "HOME"],
    [`${NOTE}env -i ${iso("/tmp/x", { HOME: "~other" })} bun test ${TARGET}`, "HOME"],
    [`${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "/fake/other" })} bun test ${TARGET}`, "HOME"],
  ])("holds %p, whose HOME is outside the /tmp root", (command, name) => heldForConfig(command, name));

  // The real home itself moves no config, but the /tmp XDG dirs beside it are no isolation.
  test("holds HOME at the real home with the XDG dirs under /tmp", () => heldForConfig(`${NOTE}env -i ${iso("/tmp/x", { HOME })} bun test ${TARGET}`, "XDG_CONFIG_HOME"));

  test.each([
    `${NOTE}env -i ${iso("/tmp/x", { XDG_CONFIG_HOME: join(HOME, ".config") })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { XDG_CONFIG_HOME: "/fake/other/config" })} bun test ${TARGET}`,
  ])("holds %p, whose XDG_CONFIG_HOME is outside the /tmp root", (command) => heldForConfig(command, "XDG_CONFIG_HOME"));

  test.each([
    `${NOTE}env -i ${iso(LINKED)} bun test ${TARGET}`,
    `${NOTE}env -i ${iso(USED)} bun test ${TARGET}`,
    `${NOTE}R=${USED}; env -i ${iso("$R")} bun test ${TARGET}`,
  ])("holds %p, whose root is or holds a link the floor can't vouch for", (command) => heldForConfig(command));

  // Single quotes and backslashes make `$R` literal text; a substitution or a variable the command never wrote out is no written value.
  test.each([
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "'$R/home'" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "\\$R/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$(mktemp -d -p /tmp)/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "$X/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; env -i ${iso("$R", { HOME: "${R:-/tmp/y}/home" })} bun test ${TARGET}`,
    `${NOTE}${MKTEMP}; IFS=:; env -i ${iso("$R")} bun test ${TARGET}`,
  ])("holds %p, whose HOME is no value the command writes out", (command) => heldForConfig(command));
});

describe("quoting changes nothing the unquoted spelling decides", () => {
  // Isolation is not limited to `bun test` (isolationRoot): the quoted spelling of another program run decides as the unquoted one does.
  const pairs = [
    [`${NOTE}env -i ${iso(LIT)} bun run build`, `${NOTE}env -i ${iso(LIT, {}, true)} bun run build`],
    [`${NOTE}${MKTEMP}; env -i ${iso("$R")} bun test ${TARGET}`, `${NOTE}${MKTEMP}; env -i ${iso("$R", {}, true)} bun test ${TARGET}`],
  ] as const;
  test.each(pairs)("%p decides as %p", (quoted, bare) => expect(bash(quoted).action).toBe(bash(bare).action));

  // From a cwd outside the worktree, the run decides as its unquoted spelling does.
  test("a run from outside the worktree decides as its unquoted spelling", () => {
    const cwd = join(ELSEWHERE, "checkout");
    const quoted = verdict(`${NOTE}cd ${cwd} && env -i ${iso(LIT)} bun test ${TARGET}`, cwd);
    const bare = verdict(`${NOTE}cd ${cwd} && env -i ${iso(LIT, {}, true)} bun test ${TARGET}`, cwd);
    expect(quoted.action).toBe(bare.action);
  });
});
