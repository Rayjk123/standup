import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A test or type-check run given its scratch env through `env`. Written out,
 * `env HOME=/tmp/… … bun test …` runs as the prefix form `HOME=/tmp/… … bun
 * test …` does and is judged the same way (isolatedCheckRun): allowed when
 * every scratch path is a literal under /tmp. So is `env $V0 $V1 … bun test
 * …` where each variable holds one `NAME=value` word written out in the
 * command, with no blank, glob or computed part, on every path. A scratch env
 * the floor can't pin down (a HOME elsewhere, a variable missing, options it
 * doesn't read, one variable holding all the words, which zsh hands env as
 * one word) is unread and allowed unless the command names something the
 * floor guards: the live data dir or DB, an outward step, a Bun config written
 * into the run's home. Words whose value the floor can't tell at all (`env
 * $V0` with V0 unknown, a changed IFS) still hold, as they may be the program.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
/** A temp path that is a symlink to the real home. */
const LINKED = join("/", "tmp", "linked-home");
/** A temp path that is a symlink to a dir that doesn't exist yet. */
const DANGLING = join("/", "tmp", "dangling");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
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

const PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test", typecheck: "tsc --noEmit" } });
const SAFE_TEST = 'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\n';

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "x.test.ts")]: SAFE_TEST,
  [join(ROOT, "packages", "collector", "src", "floor", "x.test.ts")]: SAFE_TEST,
  [join(DATA, "standup.db")]: "",
  [join(HOME, ".aws", "credentials")]: "[default]\n",
  // A temp home already holding git's configuration.
  [join("/", "tmp", "dirty", ".gitconfig")]: "[core]\n\thooksPath = /tmp/evil\n",
  // Temp homes and config dirs already holding Bun's global configuration.
  [join("/", "tmp", "bunhome", ".bunfig.toml")]: 'preload = ["/tmp/evil.ts"]\n',
  [join("/", "tmp", "bunxdg", "config", ".bunfig.toml")]: 'preload = ["/tmp/evil.ts"]\n',
  // Temp homes already holding Claude Code's settings.
  [join("/", "tmp", "claudehome", ".claude", "settings.json")]: '{"hooks":{}}\n',
  [join("/", "tmp", "claudejson", ".claude.json")]: "{}\n",
  // Scratch dirs other than HOME already holding something, and a DB file already there.
  [join("/", "tmp", "planted", "data", "standup", "standup.db")]: "",
  [join("/", "tmp", "planted", "state", "x")]: "",
  [join("/", "tmp", "planted", "cache", "x")]: "",
  [join("/", "tmp", "planted", "k", "doc.md")]: "# planted\n",
  [join("/", "tmp", "planted", "i", "x")]: "",
  [join("/", "tmp", "planted", "d", "x.md")]: "",
  [join("/", "tmp", "planted", "x.db")]: "",
  // A scratch tree a worker reuses, with what earlier runs left in it: no config any tool loads.
  [join("/", "tmp", "standup-webdocs-XvMJCE", "data", "standup", "standup.db")]: "",
  [join("/", "tmp", "standup-webdocs-XvMJCE", "state", "standup", "x.log")]: "",
  [join("/", "tmp", "standup-webdocs-XvMJCE", "cache", "bun", "x")]: "",
  [join("/", "tmp", "standup-webdocs-XvMJCE", "db", "x.db")]: "",
  [join("/", "tmp", "standup-webdocs-XvMJCE", "k", "doc.md")]: "# kept\n",
  [join("/", "tmp", "standup-webdocs-XvMJCE", "i", "x")]: "",
  [join("/", "tmp", "standup-webdocs-XvMJCE", "config", "standup", "x.json")]: "{}\n",
  [join("/", "tmp", "standup-webdocs-XvMJCE", ".local", "share", "x")]: "",
  // Worktree dirs holding an env file Bun loads, and one holding none.
  [join(ROOT, "envdir", ".env")]: "STANDUP_WORKTREE_ROOT=/fake/home/.local/share/standup/worktrees\n",
  [join(ROOT, "envtest", ".env.test")]: "KNOWLEDGE_DIR=/fake/home/.local/share/standup/knowledge\n",
  [join(ROOT, "envlocal", ".env.local")]: "DB_PATH=/fake/home/.local/share/standup/standup.db\n",
  [join(ROOT, "plain", "x.test.ts")]: SAFE_TEST,
};
/** An empty temp dir already there. */
const EMPTY = join("/", "tmp", "r6-empty");
/** A temp home whose `.bunfig.toml` is a link to a file that doesn't exist yet. */
const LINKED_BUNFIG = join("/", "tmp", "lnkcfg", ".bunfig.toml");

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, join("/", "tmp", "lnkcfg"), EMPTY]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const links: Record<string, string> = { [LINKED]: HOME, [DANGLING]: join(HOME, "nowhere"), [LINKED_BUNFIG]: join("/", "tmp", "later.toml") };
  const real = (p: string): string => {
    for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
    return p;
  };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (real(p) in FILES ? { ok: true, text: FILES[real(p)]! } : { ok: false, reason: "missing" }),
    exists: (p) => real(p) in FILES || dirs.has(real(p)),
    isDirectory: (p) => dirs.has(real(p)),
    listDir: (p) => {
      const d = real(p);
      return dirs.has(d) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${d === "/" ? "" : d}/`)).map((f) => f.slice(d.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (real(p) in FILES || dirs.has(real(p)) ? real(p) : null),
    lstat: (p) => (p in links ? { symlink: true, file: false, nlink: 1 } : p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    // The worker's TMPDIR is under the /tmp these fixtures lay out, whatever the test runner's is.
    env: (name) => (name === "TMPDIR" ? "/tmp" : process.env[name]),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function expectAllowed(command: string): void {
  expect({ command, v: bash(command) }).toEqual({ command, v: { action: "allow" } });
}

function expectHeld(command: string): void {
  expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
}

/** Every scratch path a check run sets (CHECK_RUN_ENV), plus the project docs dir, under /tmp/r6. */
const VARS: Record<string, string> = {
  HOME: "/tmp/r6",
  XDG_CONFIG_HOME: "/tmp/r6/.config",
  XDG_DATA_HOME: "/tmp/r6/.local/share",
  XDG_STATE_HOME: "/tmp/r6/.local/state",
  XDG_CACHE_HOME: "/tmp/r6/.cache",
  DB_PATH: "/tmp/r6/standup.db",
  STANDUP_SQLITE_PATH: "/tmp/r6/standup.db",
  KNOWLEDGE_DIR: "/tmp/r6/k",
  STANDUP_INTERNAL_ROOT: "/tmp/r6/i",
  STANDUP_PROJECT_DOCS_DIR: "/tmp/r6/d",
};
/** The assignments, joined by `sep`, with `over` replacing or (null) dropping some. */
const env = (over: Record<string, string | null> = {}, sep = " ") =>
  Object.entries({ ...VARS, ...over })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(sep);
const E = env();
const RUN = "bun test packages/collector/src/floor/x.test.ts";

describe("10. the prefix and `env` forms, written out", () => {
  test("the prefix form is allowed", () => {
    expectAllowed(`${E} ${RUN}`);
  });

  test("`env --` then assignments", () => {
    // `env` takes `NAME=value` words after `--` as assignments too: a HOME, config or preload hook moved
    // elsewhere is unread and allowed, and the program after them is still judged.
    for (const command of [
      "env -- HOME=/tmp/dirty git status",
      "env -- HOME=/tmp/x bun test x.test.ts",
      "env -i -- HOME=/tmp/dirty git status",
      "env -- LD_PRELOAD=/tmp/evil.so ls",
      "env -- A=1 GIT_CONFIG_GLOBAL=/tmp/evil.cfg git status",
      `env -- ${E} ${RUN}`,
      "env -- A=1 ls",
    ]) expectAllowed(command);
    for (const command of ["env -- HOME=/tmp/x git push origin HEAD", "env -i -- A=1 git push origin HEAD"]) expectHeld(command);
  });

  test("the prefix form with HOME a link that leads nowhere yet is unread and allowed", () => {
    expectAllowed(`${env({ HOME: DANGLING })} ${RUN}`);
    expectHeld(`${env({ HOME: DANGLING })} ${RUN} && git push origin main`);
  });

  test("`env` with the same assignments written out is allowed", () => {
    for (const command of [`env ${E} ${RUN}`, `env ${E} bun test x.test.ts`, `env ${E} bunx tsc --noEmit`, `env ${E} NODE_ENV=test ${RUN}`]) expectAllowed(command);
  });

  test("an `env -S` string earns no isolation, as it runs with the env `env` was handed, which the shell around it doesn't show", () => {
    // Without the credit it is a check run like any other, which runs; one pointing a variable at the live DB holds, as the prefix form does.
    expectAllowed(`env -S '${E} ${RUN}'`);
    expectHeld(`env -S '${env({ DB_PATH: join(DATA, "standup.db") })} ${RUN}'`);
  });

  test("`env` with a prefix assignment of its own holds only when that names the live data dir outside worktrees/", () => {
    for (const command of [`X=1 env ${E} ${RUN}`, `STANDUP_WORKTREE_ROOT=${join(DATA, "worktrees")} env ${E} ${RUN}`]) expectAllowed(command);
    expectHeld(`STANDUP_PROJECTS_PATH=${join(DATA, "projects")} env ${E} ${RUN}`);
  });

  test("the prefix form holds a variable at the live data dir", () => {
    for (const command of [
      `${env({ KNOWLEDGE_DIR: join(DATA, "knowledge") })} ${RUN}`,
      `${env({ DB_PATH: join(DATA, "standup.db") })} ${RUN}`,
      `${E} STANDUP_DATA_DIR=${DATA} ${RUN}`,
    ]) expectHeld(command);
  });

  test("the prefix form with a variable missing, unresolved, at the home, or other options and programs is unread and allowed", () => {
    for (const command of [
      ...Object.keys(VARS)
        .filter((k) => k !== "STANDUP_PROJECT_DOCS_DIR")
        .map((k) => `${env({ [k]: null })} ${RUN}`),
      `${env({ HOME: HOME })} ${RUN}`,
      `${env({ XDG_CONFIG_HOME: join(HOME, ".config") })} ${RUN}`,
      `${env({ HOME: "$X/home" })} ${RUN}`,
      `${env({ HOME: "$(mktemp -d)" })} ${RUN}`,
      `${env({ HOME: "/tmp" })} ${RUN}`,
      `${env({ HOME: "/tmp/../fake/home" })} ${RUN}`,
      `echo '[alias] x = !sh' > /tmp/r6/.gitconfig && ${E} ${RUN}`,
      `${E} bun test --preload ./x.ts x.test.ts`,
      `${E} bun test -r./x.ts x.test.ts`,
      `${E} bun test -c./b.toml x.test.ts`,
      `${E} bun test -ur./x.ts x.test.ts`,
      `${E} bun test --preload=./x.ts x.test.ts`,
      `${E} bun run typecheck`,
      `${E} bun test /tmp/x.test.ts`,
      `${E} bun test ../../x.test.ts`,
      `${E} bunx tsc --noEmit -p /tmp/tsconfig.json`,
    ]) expectAllowed(command);
  });

  test("`env` holds what the prefix form holds, and a value it can't split into words", () => {
    for (const command of [
      `env ${env({ DB_PATH: join(DATA, "standup.db") })} ${RUN}`,
      `env ${E} STANDUP_DATA_DIR=${DATA} ${RUN}`,
      `env ${env({ HOME: "$X" })} ${RUN}`,
    ]) expectHeld(command);
  });

  test("`env` allows, unread, what the prefix form allows", () => {
    for (const command of [
      ...Object.keys(VARS)
        .filter((k) => k !== "STANDUP_PROJECT_DOCS_DIR")
        .map((k) => `env ${env({ [k]: null })} ${RUN}`),
      `env ${env({ HOME: "/tmp/../fake/home" })} ${RUN}`,
      `env ${env({ HOME: "/tmp/../home/u" })} ${RUN}`,
      `env ${env({ HOME: "/tmp" })} ${RUN}`,
      `env ${env({ HOME: HOME })} ${RUN}`,
      `env ${env({ HOME: "/home/u" })} ${RUN}`,
      `env ${env({ HOME: LINKED })} ${RUN}`,
      `env ${env({ HOME: DANGLING })} ${RUN}`,
      `env ${env({ HOME: "/tmp/dirty" })} ${RUN}`,
      `env ${env({ HOME: "$(mktemp -d)" })} ${RUN}`,
      `env ${E} bun run test`,
      `env ${E} bun run typecheck`,
      `env ${E} bun test --preload ./x.ts x.test.ts`,
      `env ${E} sh -c 'bun test x.test.ts'`,
      `env ${E} git status`,
      `env -i ${E} ${RUN}`,
      `env -u PATH ${E} ${RUN}`,
      `env -C /tmp ${E} ${RUN}`,
      `env '${E}' ${RUN}`,
      `env ${env({ HOME: "/tmp/r6*" })} ${RUN}`,
      `env ${env({ HOME: "/tmp/r{6,7}" })} ${RUN}`,
      `env ${E} bun test $F`,
      `env ${E} HOME=/tmp/dirty ${RUN}`,
      `env ${E} env HOME=/fake/home/sub ${RUN}`,
      `echo '[alias] x = !sh' > /tmp/r6/.gitconfig && env ${E} ${RUN}`,
    ]) expectAllowed(command);
  });
});

/**
 * The assignments, one shell variable each (`V0="HOME=/tmp/r6"; V1=…`), with
 * `over` replacing or (null) dropping some: `defs` assigns them, quoted with
 * `q` and joined by `sep`, and `refs` is the `$V0 $V1 …` that hands them to env.
 */
const split = (over: Record<string, string | null> = {}, q = '"', sep = "; ") => {
  const entries = Object.entries({ ...VARS, ...over }).filter(([, v]) => v !== null);
  return {
    defs: entries.map(([k, v], i) => `V${i}=${q}${k}=${v}${q}`).join(sep),
    refs: entries.map((_, i) => `$V${i}`).join(" "),
  };
};
/** `defs; env refs RUN`, with `over` as in split. */
const spliced = (over: Record<string, string | null> = {}, run = RUN) => {
  const { defs, refs } = split(over);
  return `${defs}; env ${refs} ${run}`;
};
const { defs: DEFS, refs: REFS } = split();

describe("10. `env $V0 $V1 …`, one assignment per variable", () => {
  const safe = [
    spliced(),
    `${split({}, "'").defs}; env ${REFS} ${RUN}`,
    `${split({}, "").defs}; env ${REFS} ${RUN}`,
    `${split({}, '"', "\n").defs}\nenv ${REFS} ${RUN}`,
    `${DEFS}; env ${REFS.replace(/\$(V\d+)/g, "${$1}")} ${RUN}`,
    `${DEFS}; env ${REFS} ${RUN} > /tmp/r6.log 2>&1; tail -5 /tmp/r6.log`,
    `${DEFS} && env ${REFS} ${RUN}`,
    `${DEFS}; cd ${ROOT} && env ${REFS} ${RUN}`,
    `${DEFS}; env -- ${REFS} ${RUN}`,
    `${DEFS}; env ${REFS} NODE_ENV=test ${RUN}`,
    `${split({ HOME: null }).defs}; env HOME=/tmp/r6 ${split({ HOME: null }).refs} ${RUN}`,
    `if [ -n "$X" ]; then ${DEFS}; else ${DEFS}; fi; env ${REFS} ${RUN}`,
    `${DEFS}; (V0=$X); env ${REFS} ${RUN}`,
    // A top-level `P && V0=…` is read both ways, each a run with every value known.
    `${DEFS}; [ -n "$X" ] && V0=HOME=/fake/home/sub; env ${REFS} ${RUN}`,
    // Unset, `$E` is no words: the run gets no env of its own and moves nothing.
    `E=HOME=/tmp/dirty; unset E; env $E ${RUN}`,
  ];
  test.each(safe)("allows %p", (command) => {
    expectAllowed(command);
  });

  const risky = [
    // A value unknown, or not the same on every path.
    `env ${REFS} ${RUN}`,
    `${DEFS}; V0=$X; env ${REFS} ${RUN}`,
    `${DEFS}; V0="$X"; env ${REFS} ${RUN}`,
    `${DEFS}; V0="$(cat /tmp/e)"; env ${REFS} ${RUN}`,
    `${DEFS}; read -r V0 < /tmp/e; env ${REFS} ${RUN}`,
    `${split({ HOME: null }).defs}; if [ -n "$X" ]; then V9=HOME=/tmp/r6; fi; env ${REFS} ${RUN}`,
    `${DEFS}; if [ -n "$X" ]; then V0=HOME=/tmp/dirty; fi; env ${REFS} ${RUN}`,
    `${DEFS}; [ -n "$X" ] || V0=HOME=/fake/home/sub; env ${REFS} ${RUN}`,
    `${DEFS}; { [ -n "$X" ] && V0=HOME=/fake/home/sub; }; env ${REFS} ${RUN}`,
    `${DEFS}; for V0 in a b; do :; done; env ${REFS} ${RUN}`,
    `${DEFS}; f() { V0=$1; }; f "$X"; env ${REFS} ${RUN}`,
    `${DEFS}; echo x | read V0; env ${REFS} ${RUN}`,
    `${DEFS}; eval "V0=$X"; env ${REFS} ${RUN}`,
    `${DEFS}; declare V0=$X; env ${REFS} ${RUN}`,
    `${DEFS}; printf -v V0 %s "$X"; env ${REFS} ${RUN}`,
    `${DEFS}; : \${V0:=x}; V0=\${V0/r6/$X}; env ${REFS} ${RUN}`,
    // The live DB or data dir among the words.
    spliced({ DB_PATH: join(DATA, "standup.db") }),
    `${DEFS}; S=STANDUP_DATA_DIR=${DATA}; env ${REFS} $S ${RUN}`,
    // A changed IFS.
    `IFS=:; ${spliced()}`,
    `${DEFS}; IFS=/; env ${REFS} ${RUN}`,
    `IFS=$X; ${spliced()}`,
    `unset IFS; ${spliced()}`,
    // The values reached the command some other way.
    `V0=HOME=/tmp/r6 env $V0 ${RUN}`,
    `${DEFS}; bash -c 'env ${REFS} ${RUN}'`,
    // An outward step after a run the floor can follow.
    `${spliced()} && git push origin main`,
  ];
  test.each(risky)("holds %p", (command) => {
    expectHeld(command);
  });

  // Each word is one the floor can follow, and whatever HOME or option it hands env names nothing the floor guards.
  const unread = [
    `${DEFS}; V0="$(echo HOME=/tmp/r6)"; env ${REFS} ${RUN}`,
    `${DEFS}; V0=\`echo HOME=/tmp/r6\`; env ${REFS} ${RUN}`,
    `${DEFS}; V0+=x; env ${REFS} ${RUN}`,
    // Computed values the floor models but the shell may not produce.
    `D=$(mktemp -d); ${spliced({ HOME: "$D" })}`,
    spliced({ HOME: "$(mktemp -d)" }),
    spliced({ HOME: "$TMPDIR/r6" }),
    spliced({ HOME: "~/x" }),
    // A HOME that isn't a fresh temp dir, or a scratch path missing or elsewhere.
    spliced({ HOME: "/fake/home/sub" }),
    spliced({ HOME: "/home/u" }),
    spliced({ HOME: "/tmp/../home/u" }),
    spliced({ HOME: "/tmp/r6/../../fake/home" }),
    spliced({ HOME: "/tmp" }),
    spliced({ HOME: LINKED }),
    spliced({ HOME: DANGLING }),
    spliced({ HOME: "/tmp/dirty" }),
    spliced({ XDG_CACHE_HOME: null }),
    spliced({ HOME: null }),
    `${split({ HOME: null }).defs}; HOME=/tmp/r6 env ${split({ HOME: null }).refs} ${RUN}`,
    // Options and programs among the words.
    `${DEFS}; O=-i; env $O ${REFS} ${RUN}`,
    `${DEFS}; O=-u; P=PATH; env $O $P ${REFS} ${RUN}`,
    `${DEFS}; O=-uPATH; env $O ${REFS} ${RUN}`,
    `${DEFS}; O=-C/tmp; env $O ${REFS} ${RUN}`,
    `${DEFS}; O=--chdir=/tmp; env $O ${REFS} ${RUN}`,
    `${DEFS}; O=--split-string=HOME=/tmp/dirty; env $O ${REFS} ${RUN}`,
    `${DEFS}; O=-u; env ${REFS} $O PATH ${RUN}`,
    `${DEFS}; P=sh; env ${REFS} $P -c id`,
    `${DEFS}; P=bun; env ${REFS} $P run test`,
    `${DEFS}; P=git; env ${REFS} $P status`,
    `${DEFS}; env ${REFS} bun run test`,
    `${DEFS}; env ${REFS} git status`,
    `${DEFS}; env ${REFS} sh -c 'bun test x.test.ts'`,
    // Pathname expansion.
    spliced({ HOME: "/tmp/r6*" }),
    spliced({ HOME: "/tmp/r?" }),
    spliced({ HOME: "/tmp/[r]6" }),
    spliced({ KNOWLEDGE_DIR: "/tmp/r6/*" }),
    `set -f; ${spliced({ HOME: "/tmp/r6*" })}`,
    // A file written into the temp home first, as the prefix form allows.
    `echo '[alias] x = !sh' > /tmp/r6/.gitconfig; ${spliced()}`,
    `${DEFS}; mkdir -p /tmp/r6/.config/git; cp /tmp/evil.cfg /tmp/r6/.config/git/config; env ${REFS} ${RUN}`,
    // Exported, the values reach the inner shell.
    `export ${DEFS.replace(/; /g, " ")}; bash -c 'env ${REFS} ${RUN}'`,
  ];
  test.each(unread)("allows %p, unread", (command) => {
    expectAllowed(command);
  });
});

describe("10. `env $E`, E all the assignments in one string", () => {
  // bash splits `$E` into the assignments; zsh hands env one word and HOME is `/tmp/r6 XDG_CONFIG_HOME=…`, with nothing
  // else set. Either way the run's HOME is moved elsewhere and the command names nothing the floor guards: it is unread.
  const zshOneWord = [
    `E="${E}"; env $E ${RUN}`,
    `E='${E}'; env $E ${RUN}`,
    `E="${E}"; env \${E} ${RUN}`,
    `E="${env({}, "\n")}"; env $E ${RUN}`,
    `E="${env({}, "\n  ")}"; env $E ${RUN}`,
    `E="${E}"\nenv $E ${RUN}`,
    `E="${E}"; env $E ${RUN}; env $E bun test x.test.ts; env $E bunx tsc --noEmit`,
    `E="${E}" && env $E ${RUN}`,
    `E="${E}"; env -- $E ${RUN}`,
    `A="${env({ HOME: null, XDG_CONFIG_HOME: null })}"; B="HOME=/tmp/r6 XDG_CONFIG_HOME=/tmp/r6/.config"; env $A $B ${RUN}`,
    `E="${env({ HOME: null })}"; env HOME=/tmp/r6 $E ${RUN}`,
    `E="${env({}, "\t")}"; env $E ${RUN}`,
  ];
  test.each(zshOneWord)("allows %p, one word under zsh, unread", (command) => {
    expectAllowed(command);
  });

  test("`env \"$E\"` hands env one assignment, as zsh does `env $E`, and is allowed, unread", () => {
    for (const command of [`E="${E}"; env "$E" ${RUN}`, `E="${E}"; env "\${E}" ${RUN}`, `E="${env({}, "\n")}"; env "$E" ${RUN}`]) expectAllowed(command);
  });

  test("the same forms still hold on an outward step or with the live DB in E", () => {
    for (const command of [
      `E="${E}"; env $E git push origin HEAD`,
      `E="${E}"; env "$E" ${RUN} && git push origin main`,
      `E="${env({ DB_PATH: join(DATA, "standup.db") })}"; env $E ${RUN}`,
    ]) expectHeld(command);
  });
});

/** The scratch env with every value under `$T` (`HOME=$T XDG_CONFIG_HOME=$T/config …`). */
const TVARS: Record<string, string> = {
  HOME: "$T",
  XDG_CONFIG_HOME: "$T/config",
  XDG_DATA_HOME: "$T/data",
  XDG_STATE_HOME: "$T/state",
  XDG_CACHE_HOME: "$T/cache",
  DB_PATH: "$T/db/x.db",
  STANDUP_SQLITE_PATH: "$T/db/x.db",
  KNOWLEDGE_DIR: "$T/k",
  STANDUP_INTERNAL_ROOT: "$T/i",
  STANDUP_PROJECT_DOCS_DIR: "$T/d",
};
const tenv = (over: Record<string, string | null> = {}) =>
  Object.entries({ ...TVARS, ...over })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
const TE = tenv();
const WEB = "T=/tmp/standup-webdocs-XvMJCE";

describe("12. the scratch env built on a variable assigned earlier, `T=/tmp/…; HOME=$T …`", () => {
  const safe = [
    `${WEB}; ${TE} ${RUN}`,
    `${WEB}; ${TE} bun test x.test.ts`,
    `${WEB}; ${TE} bunx tsc --noEmit`,
    `${WEB}\n${TE} ${RUN}`,
    `${WEB} && ${TE} ${RUN}`,
    `T='/tmp/standup-webdocs-XvMJCE'; ${TE} ${RUN}`,
    `${WEB}; ${tenv({ HOME: '"$T"', DB_PATH: '"${T}/db/x.db"' })} ${RUN}`,
    `${WEB}; ${tenv({ KNOWLEDGE_DIR: "${T}/k" })} ${RUN}`,
    `${WEB}; env ${TE} ${RUN}`,
    `${WEB}; ${TE} ${RUN} > /tmp/r6.log 2>&1`,
    `${WEB}; U=$T/u; ${tenv({ HOME: "$U" })} ${RUN}`,
    // Directories made empty, for the run to fill.
    `mkdir -p /tmp/r6 && ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.config /tmp/r6/.local/share /tmp/r6/.local/state /tmp/r6/.cache && ${E} ${RUN}`,
    `${WEB}; mkdir -p $T/config $T/data $T/db && ${TE} ${RUN}`,
    `mkdir -p /tmp/r6; ${spliced()}`,
    `D=/tmp/r6; ${spliced({ HOME: "$D" })}`,
    `${WEB}; ${split({ HOME: "$T" }).defs}; env ${REFS} ${RUN}`,
    `${WEB}; ${split({ HOME: null, XDG_CONFIG_HOME: null }).defs}; env HOME=$T XDG_CONFIG_HOME=$T/config ${split({ HOME: null, XDG_CONFIG_HOME: null }).refs} ${RUN}`,
    `mkdir -p /tmp/r6; mkdir -p /tmp/r6; ${E} ${RUN}`,
    // Steps alongside that write nothing and run only what passes output through.
    `${E} ${RUN} 2>&1 | tail -20`,
    `${WEB}; ${TE} ${RUN} 2>&1 | tail -5`,
    `${E} ${RUN} 2>&1 | grep -E 'pass|fail'`,
    // Steps after the run, which it can't see.
    `${E} ${RUN}; echo done`,
    `${E} ${RUN}; tail -5 /tmp/r6.log`,
  ];
  test.each(safe)("allows %p", (command) => {
    expectAllowed(command);
  });

  // A scratch env under a `$T` the floor can't pin to one fresh temp dir is only unread: the dirs it
  // names may be anywhere, but the command names nothing the floor guards, so it runs.
  const unread = [
    // T unknown, computed, or not the same on every path.
    `${TE} ${RUN}`,
    `T=$X; ${TE} ${RUN}`,
    `T=$(cat /tmp/t); ${TE} ${RUN}`,
    `T=$(echo /tmp/r6); ${TE} ${RUN}`,
    `T=$(mktemp -d); ${TE} ${RUN}`,
    "T=`mktemp -d`; " + `${TE} ${RUN}`,
    `T=$TMPDIR/r6; ${TE} ${RUN}`,
    `T=~/x; ${TE} ${RUN}`,
    `read -r T < /tmp/t; ${TE} ${RUN}`,
    `if [ -n "$X" ]; then ${WEB}; fi; ${TE} ${RUN}`,
    `${WEB}; [ -n "$X" ] && T=/fake/home/sub; ${TE} ${RUN}`,
    `${WEB}; T=/fake/home/sub; ${TE} ${RUN}`,
    `${WEB}; T+=x; ${TE} ${RUN}`,
    `${WEB}; for T in /tmp/a /fake/home; do :; done; ${TE} ${RUN}`,
    `${WEB}; f() { T=$1; }; f "$X"; ${TE} ${RUN}`,
    `${WEB}; echo x | read T; ${TE} ${RUN}`,
    `${WEB}; unset T; ${TE} ${RUN}`,
    `${WEB}; T=\${T/tmp/$X}; ${TE} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "${T:-/fake/home}" })} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "${T%/*}" })} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "$T$X" })} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "$T/$(echo x)" })} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "$TT" })} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "$HOME" })} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "$1" })} ${RUN}`,
    // A T that isn't a fresh temp dir.
    `T=/tmp/../home/u; ${TE} ${RUN}`,
    `T=/tmp/../fake/home; ${TE} ${RUN}`,
    `T=/tmp; ${TE} ${RUN}`,
    `T=${LINKED}; ${TE} ${RUN}`,
    `T=${DANGLING}; ${TE} ${RUN}`,
    `T=/tmp/dirty; ${TE} ${RUN}`,
    `T=/fake/home/sub; ${TE} ${RUN}`,
    `${WEB}; ${tenv({ HOME: "$T/../../fake/home" })} ${RUN}`,
    `${WEB}; ${tenv({ XDG_STATE_HOME: null })} ${RUN}`,
    `${WEB}; ${tenv({ DB_PATH: null })} ${RUN}`,
    `${WEB}; ${tenv({ KNOWLEDGE_DIR: null })} ${RUN}`,
    // Not a plain check run in the worktree.
    `${WEB}; ${TE} bun run test`,
    `${WEB}; ${TE} bun test --preload /tmp/evil.ts x.test.ts`,
    `${WEB}; ${TE} bun test --preload=/tmp/evil.ts x.test.ts`,
    `${WEB}; ${TE} bun test -r/tmp/evil.ts x.test.ts`,
    `${WEB}; ${TE} bun test -c /tmp/b.toml x.test.ts`,
    `${WEB}; ${TE} git status`,
    `${WEB}; ${TE} sh -c 'bun test x.test.ts'`,
    `${WEB}; cd /tmp && ${TE} bun test /tmp/x.test.ts`,
    // A config the run's Bun would read, under a T the floor doesn't follow into.
    `T=/tmp/bunhome; ${TE} ${RUN}`,
    `T=/tmp/bunxdg; ${TE} ${RUN}`,
    // A second run after a first under the same T.
    `${WEB}; ${TE} ${RUN}; ${TE} bun test x.test.ts`,
  ];
  test.each(unread)("allows %p, unread", (command) => {
    expectAllowed(command);
  });

  // What the scratch dirs already hold, or get from a step the floor doesn't read into, is unread, and the
  // command names nothing the floor guards.
  const unreadFills = [
    // A config the run's Bun would read, already there or a link to where a step writes one.
    `${env({ HOME: "/tmp/bunhome" })} ${RUN}`,
    `${env({ XDG_CONFIG_HOME: "/tmp/bunxdg/config" })} ${RUN}`,
    `${env({ HOME: "/tmp/lnkcfg" })} ${RUN}`,
    `echo 'preload = ["/tmp/evil.ts"]' > /tmp/later.toml; ${env({ HOME: "/tmp/lnkcfg" })} ${RUN}`,
    // A scratch dir filled from an archive, a copy, a clone or a tool.
    `mkdir /tmp/r6 && tar -xf /tmp/e.tar -C /tmp/r6 && ${E} ${RUN}`,
    `tar -xf /tmp/e.tar -C /tmp/r6 && ${E} ${RUN}`,
    `unzip -o /tmp/e.zip -d /tmp/r6 && ${E} ${RUN}`,
    `cp -r /tmp/kit/. /tmp/r6 && ${E} ${RUN}`,
    `rsync -a /tmp/kit/ /tmp/r6/ && ${E} ${RUN}`,
    `git clone /tmp/evil-repo /tmp/r6 && ${E} ${RUN}`,
    `some-tool init /tmp/r6; ${E} ${RUN}`,
    `mkdir -p /tmp/r6 && some-tool init; ${E} ${RUN}`,
    `mv /tmp/kit /tmp/r6 && ${E} ${RUN}`,
    // A second run after a first under the same scratch home.
    `${DEFS}; env ${REFS} ${RUN}; env ${REFS} bun test x.test.ts`,
    `${E} bun test x.test.ts && ${E} ${RUN}`,
    // Output piped to a program the floor doesn't know.
    `${E} ${RUN} | some-tool`,
  ];
  test.each(unreadFills)("allows %p, unread", (command) => {
    expectAllowed(command);
  });

  const risky = [
    // The live DB, or an outward step, named in the command.
    `${WEB}; ${tenv({ DB_PATH: join(DATA, "standup.db") })} ${RUN}`,
    `${WEB}; ${TE} git push origin HEAD`,
    `${WEB}; ${TE} timeout 5 git push`,
    `${env({ HOME: "/tmp/bunhome" })} ${RUN} && git push origin main`,
    `tar -xf /tmp/e.tar -C /tmp/r6 && ${E} ${RUN} && git push origin main`,
    // A config the run's Bun or git would read, written into the temp home first.
    `${WEB}; echo 'preload = ["/tmp/evil.ts"]' > $T/.bunfig.toml; ${TE} ${RUN}`,
    `${WEB}; mkdir -p $T/config; echo 'preload = ["/tmp/evil.ts"]' > $T/config/.bunfig.toml; ${TE} ${RUN}`,
    `echo 'preload = ["/tmp/evil.ts"]' > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `cp /tmp/evil.toml /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `mkdir -p /tmp/r6 && cp /tmp/evil.toml /tmp/r6/.bunfig.toml && ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.config && cp /tmp/evil.toml /tmp/r6/.config/.bunfig.toml && ${E} ${RUN}`,
    `mkdir -p /tmp/r6; touch /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.bunfig.toml; rmdir /tmp/r6/.bunfig.toml; cp /tmp/evil.toml /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `mkdir -p /tmp/r6 && ln -s /tmp/evil.toml /tmp/r6/.bunfig.toml && ${E} ${RUN}`,
    `tar -xf /tmp/e.tar -C /tmp && ${E} ${RUN}`,
    `curl -sSo /tmp/r6/.bunfig.toml https://example.com/x && ${E} ${RUN}`,
    `python3 -c "open('/tmp/r6/.bunfig.toml','w').write('x')"; ${E} ${RUN}`,
    `mkdir -p /tmp/r6 && mount --bind /tmp/kit /tmp/r6 && ${E} ${RUN}`,
    `echo x > /tmp/r6/.bunfig.toml; ${E} bun test x.test.ts; ${E} ${RUN}`,
    // Writes by redirect in any spelling, and by steps run alongside.
    `echo x >> /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `echo x &> /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `echo x >& /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `echo x 1> /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `echo x >| /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `echo x 2>&1 > /tmp/r6/.config/.bunfig.toml; ${E} ${RUN}`,
    `ls > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `{ echo x; } > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `(echo x) > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `for i in 1; do echo x; done > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `if true; then echo x; fi > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `exec > /tmp/r6/.bunfig.toml; ${E} ${RUN}`,
    `echo x > $X/.bunfig.toml; ${E} ${RUN}`,
    `${WEB}; echo x > $T/.bunfig.toml; ${TE} ${RUN}`,
    `${WEB}; echo x > "$T/config/.bunfig.toml"; ${TE} ${RUN}`,
    `cd /tmp/r6 && echo x > .bunfig.toml; cd ${ROOT}; ${E} ${RUN}`,
    `${E} ${RUN} | tee /tmp/r6/.bunfig.toml`,
    `${E} ${RUN} | cp /tmp/evil.toml /tmp/r6/.bunfig.toml`,
    `${E} ${RUN} & cp /tmp/evil.toml /tmp/r6/.bunfig.toml`,
    `cp /tmp/evil.toml /tmp/r6/.bunfig.toml & ${E} ${RUN}`,
    `cp /tmp/evil.toml /tmp/r6/.bunfig.toml | ${E} ${RUN}`,
    `bun() { cp /tmp/evil.toml /tmp/r6/.bunfig.toml; command bun "$@"; }; ${E} ${RUN}`,
  ];
  test.each(risky)("holds %p", (command) => {
    expectHeld(command);
  });

  test("a /tmp HOME on an outward step holds; on a local one it is allowed", () => {
    for (const command of [`HOME=/tmp/x git push origin HEAD`, `${WEB}; HOME=$T git push origin HEAD`, `${WEB}; ${TE} git push origin HEAD`]) expectHeld(command);
    expectAllowed(`env HOME=/tmp/x git status`);
  });
});

/** The scratch env under `$T` with T a fresh temp dir. */
const R6 = "T=/tmp/r6";

describe("10. a check run the shell may not start as written", () => {
  const safe = [
    `${WEB}; HOME=$T XDG_CONFIG_HOME=$T/c XDG_DATA_HOME=$T/d XDG_STATE_HOME=$T/s XDG_CACHE_HOME=$T/ca DB_PATH=$T/x.db STANDUP_SQLITE_PATH=$T/x.db KNOWLEDGE_DIR=$T/k STANDUP_INTERNAL_ROOT=$T/i bun test x.test.ts`,
    `mkdir -p /tmp/r6 && ${E} ${RUN}`,
    `env ${E} ${RUN}`,
    `${R6}; ${TE} ${RUN}`,
    `${R6}; : \${U:-x}; ${TE} ${RUN}`,
    `cd ${ROOT}; ${E} ${RUN}`,
  ];
  test.each(safe)("allows %p", (command) => {
    expectAllowed(command);
  });

  // T assigned or reassigned in ways the floor doesn't follow leaves the run's HOME and XDG dirs
  // unread, and the command names nothing the floor guards, so it runs.
  const unread = [
    `${R6}; command env ${TE} ${RUN}`,
    `${R6}; : \${T::=/fake/home}; ${TE} ${RUN}`,
    `${R6}; : \${T:=/fake/home}; ${TE} ${RUN}`,
    `${R6}; : \${T=/fake/home}; ${TE} ${RUN}`,
    `${R6}; X='a[T=1]'; : $(( X )); ${TE} ${RUN}`,
    `${R6}; X=T; : \${!X}; ${TE} ${RUN}`,
    `${R6}; declare -n R=T; ${TE} ${RUN}`,
    // zsh hook functions run with no call and may reassign T before the run expands it.
    `${R6}; TRAPDEBUG() { T=/fake/home; }; ${TE} ${RUN}`,
    `${R6}; TRAPZERR() { T=/fake/home; }; ${TE} ${RUN}`,
    `${R6}; chpwd() { T=/fake/home; }; cd ${ROOT}; ${TE} ${RUN}`,
    `${R6}; precmd() { T=/fake/home; }; ${TE} ${RUN}`,
    `${R6}; preexec() { T=/fake/home; }; ${TE} ${RUN}`,
    `${R6}; TRAPDEBUG() { T=/fake/home; }; env ${TE} ${RUN}`,
    // A `*_functions` array names functions zsh runs the same way.
    `${R6}; chpwd_functions=(f); cd ${ROOT}; ${TE} ${RUN}`,
    `${R6}; precmd_functions+=(f); ${TE} ${RUN}`,
    `${R6}; preexec_functions=(f); env ${TE} ${RUN}`,
    // Steps backgrounded before the run, and a cwd recalled rather than known.
    `${R6}; { T=/fake/home; } & ${TE} ${RUN}`,
    `${R6}; (T=/fake/home) & ${TE} ${RUN}`,
    `${R6}; cd /tmp; cd - ; ${TE} ${RUN}`,
  ];
  test.each(unread)("allows %p, unread", (command) => {
    expectAllowed(command);
  });

  // A run the shell may start some other way, with nothing the floor guards named, is unread.
  const unreadForms = [
    // A wrapper before `env`, or a function or alias in place of a word the run is made of.
    `command env ${E} bun test x.test.ts`,
    `builtin command env ${E} bun test x.test.ts`,
    `nice env ${E} ${RUN}`,
    `timeout 60 env ${E} ${RUN}`,
    `nohup env ${E} ${RUN}`,
    `command() { builtin command "$@"; }; command env ${E} ${RUN}`,
    `env() { command env "$@"; }; env ${E} ${RUN}`,
    `bun() { sh /tmp/evil.sh; }; env ${E} ${RUN}`,
    `alias env='command env'\nenv ${E} ${RUN}`,
    `alias bun='sh /tmp/evil.sh'\n${E} ${RUN}`,
    `alias bun='sh /tmp/evil.sh'\nenv ${E} ${RUN}`,
    // Assignments the floor doesn't follow, before the written-out form.
    `${R6}; X='a[T=1]'; : $(( X )); ${E} ${RUN}`,
    `${R6}; X=T; : "\${!X}"; ${E} ${RUN}`,
    // Steps backgrounded before the run, and a cwd recalled rather than known.
    `sleep 1 & ${E} ${RUN}`,
    `coproc sleep 1; ${E} ${RUN}`,
    `cd /tmp; cd -; ${E} ${RUN}`,
    `pushd /tmp; popd; ${E} ${RUN}`,
    `pushd ${ROOT}; ${E} ${RUN}`,
    `cd $X; ${E} ${RUN}`,
    // A dir made where a config file goes, or one others can write.
    `mkdir -p /tmp/r6/.config/git/config && ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.config/git/config/x && ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.config/git && ${E} ${RUN}`,
    `mkdir -p -m 777 /tmp/r6 && ${E} ${RUN}`,
    `mkdir -pm777 /tmp/r6 && ${E} ${RUN}`,
    `mkdir -m777 -p /tmp/r6/.config && ${E} ${RUN}`,
    `mkdir --mode=777 -p /tmp/r6 && ${E} ${RUN}`,
    `mkdir --mode 777 -p /tmp/r6 && ${E} ${RUN}`,
  ];
  test.each(unreadForms)("allows %p, unread", (command) => {
    expectAllowed(command);
  });

  const risky = [
    // A dir made where the run's Bun config goes.
    `mkdir -p /tmp/r6/.bunfig.toml && ${E} ${RUN}`,
    // The same forms beside an outward step.
    `command env ${E} bun test x.test.ts && git push origin main`,
    `bun() { sh /tmp/evil.sh; }; env ${E} ${RUN}; git push origin main`,
    `sleep 1 & ${E} ${RUN} && git push origin main`,
  ];
  test.each(risky)("holds %p", (command) => {
    expectHeld(command);
  });
});

/** The verdict on `command` with the worker's own env holding `inherited` and nothing else. */
function bashInheriting(command: string, inherited: Readonly<Record<string, string | undefined>>): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, { ...probes(), env: (name) => inherited[name] });
}

describe("10. the dirs Standup's code takes from STANDUP_WORKTREE_ROOT, STANDUP_PROJECTS_PATH, KNOWLEDGE_DIR and STANDUP_INTERNAL_ROOT", () => {
  const forms = [`${E} ${RUN}`, `env ${E} ${RUN}`, spliced()];

  test.each(forms)("%p is allowed with none of them inherited, or each inherited empty or as a scratch dir", (command) => {
    for (const inherited of [{}, { STANDUP_WORKTREE_ROOT: "", STANDUP_PROJECTS_PATH: "" }, { STANDUP_WORKTREE_ROOT: "/tmp/r6/w", STANDUP_PROJECTS_PATH: "/tmp/r6/projects.json" }]) {
      expect({ command, inherited, v: bashInheriting(command, inherited) }).toEqual({ command, inherited, v: { action: "allow" } });
    }
  });

  // Inherited from the worker's env, they are in every command it runs; the command names none of them, so the run is unread.
  test.each(forms)("%p is allowed with one inherited at the live data dir, a relative path or a path outside /tmp", (command) => {
    for (const inherited of [
      { STANDUP_WORKTREE_ROOT: join(DATA, "worktrees") },
      { STANDUP_PROJECTS_PATH: join(DATA, "projects.json") },
      { STANDUP_WORKTREE_ROOT: "worktrees" },
      { STANDUP_PROJECTS_PATH: "./projects.json" },
      { STANDUP_WORKTREE_ROOT: "/var/tmp/w" },
      { STANDUP_WORKTREE_ROOT: "/tmp/r6/w", STANDUP_PROJECTS_PATH: join(HOME, "projects.json") },
    ]) {
      expect({ command, inherited, v: bashInheriting(command, inherited) }).toEqual({ command, inherited, v: { action: "allow" } });
    }
    const outward = `${command} && git push origin main`;
    expect({ outward, action: bashInheriting(outward, { STANDUP_PROJECTS_PATH: join(DATA, "projects.json") }).action }).toEqual({ outward, action: "hold" });
  });

  test("set in the command or its shell, one at the live data dir outside worktrees/ holds; the worktrees dir, a relative or a computed one is unread", () => {
    for (const command of [
      `${E} STANDUP_PROJECTS_PATH=${join(DATA, "projects.json")} ${RUN}`,
      `STANDUP_PROJECTS_PATH=${join(DATA, "projects")} env ${E} ${RUN}`,
    ]) expectHeld(command);
    for (const command of [
      `${E} STANDUP_WORKTREE_ROOT=${join(DATA, "worktrees")} ${RUN}`,
      `${E} STANDUP_PROJECTS_PATH=projects.json ${RUN}`,
      `env ${E} STANDUP_WORKTREE_ROOT=${join(DATA, "worktrees")} ${RUN}`,
      `STANDUP_WORKTREE_ROOT=${join(DATA, "worktrees")}; ${E} ${RUN}`,
      `STANDUP_PROJECTS_PATH=$X; ${E} ${RUN}`,
      `${env({ KNOWLEDGE_DIR: "knowledge" })} ${RUN}`,
    ]) expectAllowed(command);
    for (const command of [`${E} STANDUP_WORKTREE_ROOT=/tmp/r6/w STANDUP_PROJECTS_PATH=/tmp/r6/projects.json ${RUN}`, `STANDUP_WORKTREE_ROOT=/tmp/r6/w; ${E} ${RUN}`]) {
      expect({ command, v: bashInheriting(command, {}) }).toEqual({ command, v: { action: "allow" } });
    }
  });

  test("set in the command, a scratch dir there stands in for a live one inherited", () => {
    const command = `${E} STANDUP_WORKTREE_ROOT=/tmp/r6/w ${RUN}`;
    expect(bashInheriting(command, { STANDUP_WORKTREE_ROOT: join(DATA, "worktrees") })).toEqual({ action: "allow" });
  });
});

/** TE with every `$T` spelled `$name`. */
const via = (name: string) => TE.replace(/\$T\b/g, `$${name}`);

describe("10. a name the shell keeps itself is no written-out value", () => {
  // `$_` is the last word of the previous command, `$PWD` and `$OLDPWD` follow `cd`: none is only what an assignment
  // wrote, so the scratch dirs under one are unread, and a check run naming nothing the floor guards runs.
  test.each(["_", "PWD", "OLDPWD"])("the prefix form with the scratch dirs under $%s is allowed, unread", (name) => {
    expectAllowed(`${name}=/tmp/r6; ${via(name)} ${RUN}`);
    expectAllowed(`${name}=/tmp/r6; cd /tmp; cd ${ROOT}; ${via(name)} ${RUN}`);
  });

  test.each(["PWD", "OLDPWD"])("the `env` form with the scratch dirs under $%s is allowed, unread", (name) => {
    expectAllowed(`${name}=/tmp/r6; env ${via(name)} ${RUN}`);
    expectAllowed(`${name}=HOME=/tmp/r6; ${split({ HOME: null }).defs}; env $${name} ${split({ HOME: null }).refs} ${RUN}`);
    expectHeld(`${name}=HOME=/tmp/r6; ${split({ HOME: null }).defs}; env $${name} ${split({ HOME: null }).refs} git push origin main`);
  });

  test("the `env` form holds with the scratch dirs under $_", () => {
    expectHeld(`_=/tmp/r6; env ${via("_")} ${RUN}`);
    expectHeld(`_=HOME=/tmp/r6; ${split({ HOME: null }).defs}; env $_ ${split({ HOME: null }).refs} ${RUN}`);
  });

  test("zsh's tied and lowercase names are allowed too, unread", () => {
    for (const name of ["TERMINFO_DIRS", "t", "path", "HOME", "IFS"]) expectAllowed(`${name}=/tmp/r6; ${via(name)} ${RUN}`);
  });

  test("zsh's unbraced subscript of a name is no written-out value: a write through it to the live DB holds, a HOME through it is unread", () => {
    expectHeld(`D=/tmp//fake/home/.local/share/standup/standup.db; echo x > "$D[5,-1]"`);
    expectAllowed(`T=/tmp//fake/home/sub; ${tenv({ HOME: '"$T[5,-1]"' })} ${RUN}`);
  });

  test("a name only assignments set is still written out", () => {
    expectAllowed(`T=/tmp/x; ${TE} ${RUN}`);
    expectAllowed(`T=/tmp/x; env ${TE} ${RUN}`);
  });
});

describe("10. a scratch HOME holding Claude Code's settings", () => {
  // A scratch HOME already holding them is unread.
  const unread = [`${env({ HOME: "/tmp/claudehome" })} ${RUN}`, `${env({ HOME: "/tmp/claudejson" })} ${RUN}`, `env ${env({ HOME: "/tmp/claudehome" })} ${RUN}`];
  test.each(unread)("allows %p, unread", (command) => {
    expectAllowed(command);
  });

  // A `.claude.json` written at a fixed name in the shared temp dir may be another session's scratch HOME's.
  const risky = [
    `echo '{}' > /tmp/r6/.claude.json; ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.claude.json && ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.claude && echo '{"hooks":{}}' > /tmp/r6/.claude/settings.json; ${E} ${RUN}`,
    `mkdir -p /tmp/r6/.claude/settings.json && ${E} ${RUN}`,
    `${env({ HOME: "/tmp/claudehome" })} ${RUN} && git push origin main`,
  ];
  test.each(risky)("holds %p", (command) => {
    expectHeld(command);
  });
});

describe("10. writes into the scratch dirs earlier in the command", () => {
  test("a DB written where the scratch XDG_DATA_HOME puts Standup's data dir holds", () => {
    expectHeld(`mkdir -p /tmp/r6/.local/share/standup && echo x > /tmp/r6/.local/share/standup/standup.db; ${E} ${RUN}`);
  });

  // A write into a scratch dir under /tmp names nothing the floor guards: the run that follows is unread.
  const unread = [
    `echo x > /tmp/r6/.local/state/x; ${E} ${RUN}`,
    `echo x > /tmp/r6/.cache/x; ${E} ${RUN}`,
    `mkdir -p /tmp/r6/k && echo '# planted' > /tmp/r6/k/doc.md && ${E} ${RUN}`,
    `echo x > /tmp/r6/i/x; ${E} ${RUN}`,
    `echo x > /tmp/r6/d/x.md; ${E} ${RUN}`,
    `echo x > /tmp/r6/standup.db; ${E} ${RUN}`,
    `cp /tmp/evil.db /tmp/r6/standup.db && ${E} ${RUN}`,
  ];
  test.each(unread)("allows %p, unread", (command) => {
    expectAllowed(command);
  });

  test("a scratch write still holds beside an outward step, or with DB_PATH at the live DB", () => {
    expectHeld(`echo x > /tmp/r6/standup.db; ${E} ${RUN} && git push origin main`);
    expectHeld(`echo x > /tmp/r6/standup.db; ${env({ DB_PATH: join(DATA, "standup.db") })} ${RUN}`);
  });

  test("an empty dir already there, or one this command made, is allowed", () => {
    expectAllowed(`${env({ HOME: EMPTY })} ${RUN}`);
    expectAllowed(`mkdir -p /tmp/r6/k /tmp/r6/i /tmp/r6/.local/share && ${E} ${RUN}`);
  });

  // What an earlier run left (a DB, logs, a cache, knowledge files) is no config the run loads.
  test.each([
    `${env({ XDG_DATA_HOME: "/tmp/planted/data" })} ${RUN}`,
    `${env({ XDG_STATE_HOME: "/tmp/planted/state" })} ${RUN}`,
    `${env({ XDG_CACHE_HOME: "/tmp/planted/cache" })} ${RUN}`,
    `${env({ KNOWLEDGE_DIR: "/tmp/planted/k" })} ${RUN}`,
    `${env({ STANDUP_INTERNAL_ROOT: "/tmp/planted/i" })} ${RUN}`,
    `${env({ STANDUP_PROJECT_DOCS_DIR: "/tmp/planted/d" })} ${RUN}`,
    `${env({ DB_PATH: "/tmp/planted/x.db" })} ${RUN}`,
    `env ${env({ KNOWLEDGE_DIR: "/tmp/planted/k" })} ${RUN}`,
    `${E} STANDUP_WORKTREE_ROOT=/tmp/planted/i ${RUN}`,
  ])("allows %p with leftovers from an earlier run", (command) => {
    expectAllowed(command);
  });

  test("a reused scratch tree with an earlier run's leftovers still passes case 12's form", () => {
    expectAllowed(`${WEB}; ${TE} ${RUN}`);
    expectAllowed(`${WEB}; ${TE} bun test x.test.ts`);
    expectAllowed(`${WEB}; env ${TE} ${RUN}`);
    expectAllowed(`${WEB}; mkdir -p $T/config $T/data $T/db && ${TE} ${RUN}`);
  });

  test("a Bun config written into the reused tree first still holds; a standup.db there is unread and allowed", () => {
    expectHeld(`${WEB}; echo 'preload = ["/tmp/evil.ts"]' > $T/.bunfig.toml; ${TE} ${RUN}`);
    expectAllowed(`${WEB}; echo x > $T/data/standup/standup.db; ${TE} ${RUN}`);
  });

  test("a config file already in a tree under T is unread and allowed; Claude Code's written into a fixed T holds", () => {
    for (const command of [`T=/tmp/claudehome; ${TE} ${RUN}`, `T=/tmp/bunhome; ${TE} ${RUN}`, `T=/tmp/dirty; ${TE} ${RUN}`]) expectAllowed(command);
    expectHeld(`${WEB}; echo '{}' > $T/.claude.json; ${TE} ${RUN}`);
    expectAllowed(`T=$(mktemp -d); echo '{}' > $T/.claude.json; ${TE} ${RUN}`);
  });
});

describe("10. env a check run's Bun takes from elsewhere", () => {
  test("a relative path climbing with `..` is unread and allowed", () => {
    for (const command of [`${E} FOO=../x ${RUN}`, `${E} NODE_PATH=../../lib ${RUN}`, `${E} FOO=a/../../b ${RUN}`, `env ${E} FOO=../x ${RUN}`, `${E} FOO=a:../b ${RUN}`]) expectAllowed(command);
    expectAllowed(`${E} NODE_ENV=test ${RUN}`);
    expectHeld(`${E} FOO=../x ${RUN} && git push origin main`);
  });

  // Inherited, they are in the worker's env for every command it runs; the command names none of them.
  test("the state, token, socket, install, icons and agent-config paths Standup's code reads are allowed inherited at a live place", () => {
    for (const inherited of [
      { STANDUP_SLACK_STATE: join(DATA, "slack", "threads.json") },
      { STANDUP_SLACK_PERSONA_STATE: join(DATA, "persona.json") },
      { STANDUP_SLACK_ASK_STATE: join(DATA, "asks.json") },
      { STANDUP_WRITE_TOKEN_FILE: join(DATA, "write-token") },
      { STANDUP_OWNER_TOKEN_FILE: join(DATA, "owner-token") },
      { STANDUP_PUBLIC_KB_SOCKET: join(DATA, "public", "kb.sock") },
      { STANDUP_INSTALL_DIR: INSTALL },
      { ICONS_DIR: join(DATA, "icons") },
      { CODEX_HOME: join(HOME, ".codex") },
      { CLAUDE_CONFIG_DIR: join(HOME, ".claude") },
      { ICONS_DIR: "icons" },
    ]) {
      for (const command of [`${E} ${RUN}`, `env ${E} ${RUN}`]) {
        expect({ command, inherited, v: bashInheriting(command, inherited) }).toEqual({ command, inherited, v: { action: "allow" } });
      }
    }
    const command = `${E} ${RUN} && git push origin main`;
    expect({ command, action: bashInheriting(command, { STANDUP_WRITE_TOKEN_FILE: join(DATA, "write-token") }).action }).toEqual({ command, action: "hold" });
  });

  test("set in the command at the live data dir, they hold; elsewhere they are unread and allowed", () => {
    expectHeld(`${E} STANDUP_WRITE_TOKEN_FILE=${join(DATA, "write-token")} ${RUN}`);
    for (const command of [`${E} ICONS_DIR=icons ${RUN}`, `env ${E} CODEX_HOME=${join(HOME, ".codex")} ${RUN}`]) expectAllowed(command);
    expect(bashInheriting(`${E} ICONS_DIR=/tmp/r6/icons ${RUN}`, {})).toEqual({ action: "allow" });
  });

  test("`--env-file` and an env file Bun loads from the cwd are unread and allowed", () => {
    for (const command of [`${E} bun test --env-file=/tmp/e.env x.test.ts`, `${E} bun test --env-file /tmp/e.env x.test.ts`, `env ${E} bun test --env-file=/tmp/e.env x.test.ts`]) expectAllowed(command);
    for (const dir of ["envdir", "envtest", "envlocal"]) {
      const command = `${E} bun test x.test.ts`;
      expect({ dir, v: bash(command, join(ROOT, dir)) }).toEqual({ dir, v: { action: "allow" } });
      expect({ dir, v: bash(`env ${command}`, join(ROOT, dir)) }).toEqual({ dir, v: { action: "allow" } });
    }
    expectAllowed(`echo STANDUP_WORKTREE_ROOT=${join(DATA, "worktrees")} > .env; ${E} ${RUN}`);
    expect(bash(`${E} bun test x.test.ts`, join(ROOT, "plain"))).toEqual({ action: "allow" });
    expectHeld(`${E} bun test --env-file=/tmp/e.env x.test.ts && git push origin main`);
  });
});

describe("10. `bun test` options: those that pick tests and report to the terminal, and those the floor doesn't read", () => {
  const safe = [
    `${E} bun test --timeout 5000 x.test.ts`,
    `${E} bun test --timeout=5000 x.test.ts`,
    `${E} bun test --bail x.test.ts`,
    `${E} bun test --bail=1 x.test.ts`,
    `${E} bun test -t adds x.test.ts`,
    `${E} bun test --test-name-pattern=adds x.test.ts`,
    `${E} bun test --only --rerun-each 2 x.test.ts`,
    `${E} bun test --coverage x.test.ts`,
  ];
  test.each(safe)("allows %p", (command) => {
    expectAllowed(command);
  });

  // Options the floor doesn't read leave the run unread, and a run naming nothing the floor guards runs.
  const unread = [
    "--reporter=junit --reporter-outfile=/tmp/r6.xml",
    "--reporter=junit --reporter-outfile /tmp/r6.xml",
    "--coverage --coverage-dir /tmp/c",
    "--coverage-reporter=lcov",
    "--env-file=/tmp/e.env",
    "--preload ./x.ts",
    "--preload=./x.ts",
    "-r ./x.ts",
    "-r./x.ts",
    "--require ./x.ts",
    "--import ./x.ts",
    "--config=/tmp/b.toml",
    "-c/tmp/b.toml",
    "--define process.env.HOME:'\"/fake/home\"'",
    "--define=X:1",
    "-d X:1",
    "--tsconfig-override /tmp/t.json",
    "--tsconfig-override=/tmp/t.json",
    "--inspect",
    "--inspect=127.0.0.1:9229",
    "--inspect-brk",
    "--inspect-wait",
    "--watch",
    "--hot",
    "--timeout x",
  ];
  test.each(unread)("allows `bun test %s`, unread", (opts) => {
    expectAllowed(`${E} bun test ${opts} x.test.ts`);
    expectAllowed(`env ${E} bun test ${opts} x.test.ts`);
  });

  test.each(["--coverage --coverage-dir=/fake/home/.local/share/standup", "--reporter=junit --reporter-outfile=/fake/home/.local/share/standup/r6.xml"])(
    "holds `bun test %s`, naming the live data dir",
    (opts) => {
      expectHeld(`${E} bun test ${opts} x.test.ts`);
      expectHeld(`env ${E} bun test ${opts} x.test.ts`);
    },
  );

  test("an option the floor doesn't read still holds beside an outward step", () => {
    expectHeld(`${E} bun test --preload ./x.ts x.test.ts && git push origin main`);
  });
});
