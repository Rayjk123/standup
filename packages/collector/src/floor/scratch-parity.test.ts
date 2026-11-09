import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { decodeFloorConfig, encodeFloorConfig, type FloorCategory, type FloorConfig, type FloorVerdict } from "./gate.js";

/*
 * A launch's own scratch dir (`~/.cache/standup-scratch/<launchId>`, its
 * TMPDIR) against /tmp, on a virtual machine laid out as classify.test.ts
 * lays it out. Whatever the floor allows or holds below /tmp it allows or
 * holds the same way below the own scratch dir; nothing of that carries to
 * another launch's scratch dir, the scratch root, the cache dirs above it or
 * anything else in the home dir, nor through a link out of the scratch dir.
 * The one exception is an isolated run's env: the scratch dir lies under the
 * real home dir, so an isolation rooted there earns no credit for code that
 * climbs from it, and a /tmp-isolated run that keeps the inherited TMPDIR,
 * TMP or TEMP (the scratch dir) has no one root at all.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;
const ID = "a8a8a8a8-0000-4000-8000-0000000000a8";
const OTHER_ID = "9a8b7c6d-1111-2222-3333-444455556666";
const SCRATCH_ROOT = `${HOME}/.cache/standup-scratch`;
/** The protected toolchain dir beside the scratch root, and a launch-named dir in it that is no scratch dir. */
const CACHE_STANDUP = `${HOME}/.cache/standup`;
const NOT_SCRATCH = `${CACHE_STANDUP}/scratch/${ID}`;
const S = `${SCRATCH_ROOT}/${ID}`;
const O = `${SCRATCH_ROOT}/${OTHER_ID}`;

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: ID,
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`, SCRATCH_ROOT],
  tmpDirs: ["/tmp"],
  scratchDir: S,
  scratchRoot: SCRATCH_ROOT,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [`${ROOT}/package.json`]: JSON.stringify({ scripts: { test: "bun test" } }),
  [`${ROOT}/x.tgz`]: "",
  [`${ROOT}/.git`]: "gitdir: /srv/standup/.git/worktrees/feat-1\n",
  // The DB's path under the home dir with no DB_PATH in front of it: only the isolation's HOME moves it.
  [`${ROOT}/scripts/home-ref.ts`]: 'import { homedir } from "os";\nimport { join } from "path";\nconsole.log(join(homedir(), ".local", "share", "standup", "standup.db"));\n',
  [`${HOME}/notes.txt`]: "x",
  [`${HOME}/.cache/f`]: "x",
  [`${DATA}/standup.db`]: "",
  [`${FLOOR}/hook.ts`]: "",
  ["/tmp/scratch/out.txt"]: "",
  [`${S}/scratch/out.txt`]: "",
  [`${O}/scratch/out.txt`]: "",
  [`${NOT_SCRATCH}/out.txt`]: "",
  ["/tmp/bashrc-link"]: "",
  [`${S}/bashrc-link`]: "",
};

/** Files with a second hard link elsewhere (`ln ~/.bashrc $S/bashrc-link`). */
const HARD_LINKED: ReadonlySet<string> = new Set(["/tmp/bashrc-link", `${S}/bashrc-link`]);

const BASE_DIRS = [
  ROOT, "/", "/tmp", "/tmp/w", "/tmp/tmux-1000", S, `${S}/w`, `${S}/tmux-1000`, `${S}/playwright`, O, `${O}/w`, `${HOME}/.cache/x`,
  `${NOT_SCRATCH}/w`, `${CACHE_STANDUP}/playwright`, `${CACHE_STANDUP}/w`, `${SCRATCH_ROOT}-x/w`,
];

/** Links on the virtual machine, from where they sit to where they lead. */
type Links = Record<string, string>;

const LINKS: Links = {
  "/tmp/home-link": HOME,
  [`${S}/home-link`]: HOME,
  [`${S}/other-link`]: O,
  [`${S}/root-link`]: SCRATCH_ROOT,
};

function machine(links: Links) {
  const dirs = new Set<string>([...BASE_DIRS, ...Object.values(links)]);
  for (const f of [...Object.keys(FILES), ...dirs, ...Object.keys(links)]) {
    for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  }
  dirs.delete(`${ROOT}/.git`);
  const resolve = (p: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (p === from || p.startsWith(`${from}/`)) return resolve(to + p.slice(from.length));
    }
    return p;
  };
  const present = (p: string) => p in FILES || dirs.has(p);
  return { dirs, resolve, present };
}

function probes(links: Links = LINKS): Partial<FloorProbes> {
  const m = machine(links);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p) => {
      const r = m.resolve(p);
      return r in FILES ? { ok: true, text: FILES[r]! } : { ok: false, reason: "missing" };
    },
    exists: (p) => m.present(m.resolve(p)),
    isDirectory: (p) => m.dirs.has(m.resolve(p)),
    listDir: (p) => {
      const r = m.resolve(p);
      if (!m.dirs.has(r)) return null;
      const names = new Set<string>();
      for (const q of [...m.dirs, ...Object.keys(FILES), ...Object.keys(links)]) {
        if (q.startsWith(`${r === "/" ? "" : r}/`) && q !== r) names.add(q.slice(r.length + (r === "/" ? 0 : 1)).split("/")[0]!);
      }
      return [...names];
    },
    realpath: (p) => {
      const r = m.resolve(p);
      return m.present(r) ? r : null;
    },
    lstat: (p) => {
      if (p in links) return { symlink: true, file: false, nlink: 1 };
      const r = m.resolve(p);
      return r in FILES ? { symlink: false, file: true, nlink: HARD_LINKED.has(r) ? 2 : 1 } : m.dirs.has(r) ? { symlink: false, file: false, nlink: 1 } : null;
    },
    homeDir: () => HOME,
    env: () => undefined,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

function bash(command: string, cfg: FloorConfig = config, links: Links = LINKS): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, cfg, probes(links));
}

function tool(toolName: string, toolInput: Record<string, unknown>): FloorVerdict {
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
}

/** A verdict as allow or the category it holds under. */
function outcome(v: FloorVerdict): "allow" | FloorCategory {
  return v.action === "hold" ? v.category : "allow";
}

/** HOME, every XDG dir, the DB and SQLite paths, and the knowledge and internal dirs a check run sets, under `dir`. */
const iso = (dir: string, omit: string | null = null) =>
  Object.entries({
    HOME: `${dir}/h`,
    XDG_DATA_HOME: `${dir}/d`,
    XDG_CONFIG_HOME: `${dir}/c`,
    XDG_STATE_HOME: `${dir}/s`,
    XDG_CACHE_HOME: `${dir}/k`,
    DB_PATH: `${dir}/standup.db`,
    STANDUP_SQLITE_PATH: `${dir}/standup.db`,
    KNOWLEDGE_DIR: `${dir}/kb`,
    STANDUP_INTERNAL_ROOT: `${dir}/internal`,
  })
    .filter(([k]) => k !== omit)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

/** TMPDIR, TMP and TEMP all set to `dir`: the launcher sets each to the own scratch dir, so an isolated run moves all three. */
const tmps = (dir: string) => `TMPDIR=${dir} TMP=${dir} TEMP=${dir}`;

/** The temp env an isolated run moves under /tmp, into the same root as `iso("/tmp/i")`. */
const TM = tmps("/tmp/i/t");

/** The temp env moved into the same root below the own scratch dir as `iso(\`${S}/i\`)`. */
const STM = tmps(`${S}/i/t`);

/** The same operation below /tmp and below the own scratch dir (`@` stands for the dir), and what it comes to below /tmp. */
const PARITY: [string, "allow" | FloorCategory][] = [
  ["echo hi > @/out.txt", "allow"],
  ["echo hi >> @/w/log.txt", "allow"],
  ["echo hi > @/scratch/out.txt", "allow"],
  ["mkdir -p @/w/a && touch @/w/a/b", "allow"],
  ["cp package.json @/w/", "allow"],
  ["cat @/scratch/out.txt", "allow"],
  ["grep -rn foo @/w", "allow"],
  ["rm -rf @/w", "allow"],
  ["rm -rf @/playwright", "allow"],
  ["rm -f @/scratch/out.txt", "allow"],
  ["rm -rf @/w/*", "allow"],
  ["rm -rf @/tc-floor-*", "allow"],
  ["rm -rf @/*", "destructive"],
  ["rm -rf @/tmux*", "destructive"],
  ["rm -rf @", "destructive"],
  ["rm -rf @/", "destructive"],
  ["echo hi > @/standup-tc-$$.log", "allow"],
  ['echo hi >> "@/standup-tc-$$.log"', "allow"],
  // A write to a path the floor can't place, naming no denylist target, runs.
  ['echo hi >> "@/standup-tc-$RANDOM.log"', "allow"],
  ["d=$(mktemp -d -p @) && echo x > $d/f && rm -rf $d", "allow"],
  ["d=$(mktemp -p @ x.XXXXXX) && rm -f $d", "allow"],
  ["export TMPDIR=@; d=$(mktemp -d); echo x > $d/f; rm -rf $d", "allow"],
  ["export TMPDIR=@; rm -rf $TMPDIR/w", "allow"],
  ["tar -xzf x.tgz -C @/w", "allow"],
  ["ln -sfn @/w @/w2 && rm -rf @/w2", "allow"],
  ["ln -s ~ @/l && rm -rf @/l/notes.txt", "floor-tamper"],
  ["cd @ && rm -rf w", "allow"],
  ["cd @/w && rm -rf ../scratch", "allow"],
  ["find @/w -name '*.log' -delete", "allow"],
  ["mv @/w @/w3", "allow"],
  ["rm -rf @/home-link/", "floor-tamper"],
  ["echo x > @/home-link/notes.txt", "destructive"],
  ["rm -rf @/tmux-1000", "destructive"],
  // A check run that leaves an isolation var unset, or sets HOME to the dir itself, is no isolated run below
  // either; like any check run without isolation credit, it runs.
  [`${iso("@/i", "KNOWLEDGE_DIR")} ${TM} bun test src/floor`, "allow"],
  [`HOME=@ ${iso("@/i", "HOME")} ${TM} bun test src/floor`, "allow"],
  // A path in interpreter code that steps through `..` but stays below the dir.
  [`bun -e 'console.log(require("fs").readFileSync("@/w/../scratch/out.txt", "utf8"))'`, "allow"],
  // Literals a `+` joins into a path below the dir.
  [`bun -e 'console.log(require("fs").readFileSync("@" + "/scratch/out.txt", "utf8"))'`, "allow"],
  // `parents` as a keyword argument or a flag climbs nothing.
  [`python3 -c 'from pathlib import Path; Path("@/w/n").mkdir(parents=True, exist_ok=True)'`, "allow"],
  ["git log --parents -n 1 > @/out.txt", "allow"],
  // Ordinary string work on a scratch file's contents.
  [`python3 -c 'print([l.strip().split(",") for l in open("@/w/rows.csv")])'`, "allow"],
  [`bun -e 'console.log(require("fs").readFileSync("@/w/out.txt", "utf8").replace(/\\s+/g, " ").split(" ").slice(0, 3))'`, "allow"],
];

describe("the own scratch dir is scratch space exactly as /tmp is", () => {
  test("each operation comes to the same below the own scratch dir as below /tmp", () => {
    const got = PARITY.map(([template]) => ({ template, tmp: outcome(bash(template.replaceAll("@", "/tmp"))), own: outcome(bash(template.replaceAll("@", S))) }));
    expect(got).toEqual(PARITY.map(([template, expected]) => ({ template, tmp: expected, own: expected })));
  }, 60000);

  test("Write and Edit of a file below it run like ones below /tmp", () => {
    for (const dir of ["/tmp", S]) {
      expect({ dir, v: outcome(tool("Write", { file_path: `${dir}/w/f.txt`, content: "x" })) }).toEqual({ dir, v: "allow" });
      expect({ dir, v: outcome(tool("Edit", { file_path: `${dir}/scratch/out.txt`, old_string: "a", new_string: "b" })) }).toEqual({ dir, v: "allow" });
      expect({ dir, v: outcome(tool("Read", { file_path: `${dir}/scratch/out.txt` })) }).toEqual({ dir, v: "allow" });
    }
  });
});

describe("nothing else in the home dir is trusted as scratch", () => {
  const HELD: [string, FloorCategory][] = [
    // Another launch's scratch dir.
    [`echo hi > ${O}/out.txt`, "floor-tamper"],
    [`echo hi > ${O}/standup-tc-$$.log`, "floor-tamper"],
    [`rm -rf ${O}/w`, "floor-tamper"],
    [`rm -rf ${O}`, "floor-tamper"],
    [`cat ${O}/scratch/out.txt`, "floor-tamper"],
    [`d=$(mktemp -d -p ${O}) && rm -rf $d`, "floor-tamper"],
    [`tar -xzf x.tgz -C ${O}/w`, "floor-tamper"],
    // The scratch root and the cache dirs above it. Climbing out of the own
    // dir lands in the protected root.
    [`echo hi > ${S}/a-$$/../../x`, "floor-tamper"],
    [`rm -rf ${SCRATCH_ROOT}/*`, "floor-tamper"],
    ["rm -rf ~/.cache/standup-scratch/*", "floor-tamper"],
    ["rm -rf ~/.cache/standup-scratch", "floor-tamper"],
    ["echo x > ~/.cache/standup-scratch/f", "floor-tamper"],
    // ~/.cache/standup is the toolchain's, not scratch: a launch-named dir there is ordinary home-dir ground.
    [`rm -rf ${NOT_SCRATCH}/w`, "destructive"],
    [`rm -rf ${NOT_SCRATCH}`, "destructive"],
    [`echo x > ${NOT_SCRATCH}/out.txt`, "destructive"],
    [`rm -rf ${CACHE_STANDUP}/w`, "destructive"],
    [`rm -rf ${CACHE_STANDUP}/playwright`, "floor-tamper"],
    // Names that share a prefix with the scratch root or the own dir are neither (a command's text that
    // spells out the protected root's path, even as a longer name's prefix, is held for naming it).
    [`rm -rf ${SCRATCH_ROOT}-x/w`, "floor-tamper"],
    [`rm -rf ${S}x/w`, "floor-tamper"],
    ["rm -rf ~/.cache/standup*", "floor-tamper"],
    [`rm -rf ${SCRATCH_ROOT}`, "floor-tamper"],
    [`echo x > ${SCRATCH_ROOT}/f`, "floor-tamper"],
    [`ls ${SCRATCH_ROOT}`, "floor-tamper"],
    ["rm -rf ~/.cache/standup", "floor-tamper"],
    ["rm -rf ~/.cache", "floor-tamper"],
    ["rm -rf ~/.cache/x", "destructive"],
    ["echo x > ~/.cache/f", "destructive"],
    ["rm -rf $HOME/notes.txt", "destructive"],
    // Climbing out of the own scratch dir.
    [`rm -rf ${S}/../${OTHER_ID}/w`, "floor-tamper"],
    [`echo x > ${S}/../f`, "floor-tamper"],
    [`rm -rf ${S}/../../x`, "floor-tamper"],
    [`rm -rf ${S}/../*`, "floor-tamper"],
    // Links in the own scratch dir that lead out of it.
    [`rm -rf ${S}/home-link/`, "floor-tamper"],
    [`rm -rf ${S}/home-link/notes.txt`, "destructive"],
    [`echo x > ${S}/home-link/notes.txt`, "destructive"],
    [`rm -rf ${S}/other-link/w`, "floor-tamper"],
    // A glob there matches through such a link too.
    [`rm -rf ${S}/*/x`, "floor-tamper"],
    [`echo x > ${S}/other-link/out.txt`, "floor-tamper"],
    [`cat ${S}/other-link/scratch/out.txt`, "floor-tamper"],
    [`rm -rf ${S}/root-link/${OTHER_ID}`, "floor-tamper"],
    // Links the command makes there first.
    [`ln -s ${O} ${S}/l && rm -rf ${S}/l/w`, "floor-tamper"],
    [`ln -s ${O} ${S}/l && echo x > ${S}/l/f`, "floor-tamper"],
    [`ln -s ~ ${S}/l && rm -rf ${S}/l/notes.txt`, "floor-tamper"],
    // A glob that reaches past the own dir's name, a cd out of it, a move into another launch's dir.
    [`rm -rf ${S}*`, "floor-tamper"],
    [`rm -rf ${SCRATCH_ROOT}/${ID.slice(0, 8)}*`, "floor-tamper"],
    [`cd ${S} && rm -rf ../${OTHER_ID}/w`, "floor-tamper"],
    [`mv ${S}/w ${O}/w`, "floor-tamper"],
    [`find ${SCRATCH_ROOT} -name x -delete`, "floor-tamper"],
    // A TMPDIR the worker points at another launch's dir.
    [`export TMPDIR=${O}; d=$(mktemp -d); rm -rf $d`, "floor-tamper"],
    [`export TMPDIR=${O}; rm -rf $TMPDIR/x`, "floor-tamper"],
    [`TMPDIR=${O}; echo x > $TMPDIR/f`, "floor-tamper"],
    // A check run whose scratch env lands in another launch's dir or the scratch root.
    [`${iso(`${O}/i`)} bun test src/floor`, "floor-tamper"],
    [`${iso(`${S}/../x`)} bun test src/floor`, "floor-tamper"],
    // Interpreter code naming a path that starts in the own dir and climbs out of it into another launch's.
    [`bun -e 'console.log(require("fs").readFileSync("${S}/x/../../${OTHER_ID}/scratch/out.txt", "utf8"))'`, "floor-tamper"],
    [`python3 -c 'print(open("${S}/w/../../${OTHER_ID}/scratch/out.txt").read())'`, "floor-tamper"],
    // The same climb split across literals: joined by `+`, or as parts a join() climbs through.
    [`python3 -c 'print(open("${S}" + "/../${OTHER_ID}/scratch/out.txt").read())'`, "floor-tamper"],
    [`bun -e 'console.log(require("fs").readFileSync("${S}" + "/../${OTHER_ID}/scratch/out.txt", "utf8"))'`, "floor-tamper"],
    [`python3 -c 'import os; print(open(os.path.join("${S}", "..", "${OTHER_ID}", "scratch", "out.txt")).read())'`, "floor-tamper"],
    [`bun -e 'const { join } = require("path"); console.log(require("fs").readFileSync(join("${S}", "..", "${OTHER_ID}", "scratch/out.txt"), "utf8"))'`, "floor-tamper"],
    [`python3 -c 'import os; print(open(os.path.join("${S}", os.pardir, "${OTHER_ID}", "scratch", "out.txt")).read())'`, "floor-tamper"],
    [`python3 -c 'import os; print(open(os.path.join("${S}", "." + ".", "${OTHER_ID}", "scratch", "out.txt")).read())'`, "floor-tamper"],
    [`python3 -c 'import os; print(open(os.path.join(os.path.dirname("${S}"), "${OTHER_ID}", "scratch", "out.txt")).read())'`, "floor-tamper"],
    [`python3 -c 'from pathlib import Path; print((Path("${S}").parent / "${OTHER_ID}" / "scratch" / "out.txt").read_text())'`, "floor-tamper"],
    [`python3 -c 'from pathlib import Path; print((Path("${S}").parents[0] / "${OTHER_ID}" / "scratch" / "out.txt").read_text())'`, "floor-tamper"],
    // String surgery that cuts the own dir's name off. Swapping the id with a
    // general-purpose call (`s.replace(id, other)`) is not told apart from
    // ordinary string work, as a sibling of a /tmp scratch dir never was.
    [`bun -e 'const s = "${S}"; console.log(require("fs").readFileSync(s.slice(0, s.lastIndexOf("/")) + "/${OTHER_ID}/scratch/out.txt", "utf8"))'`, "floor-tamper"],
    [`bun -e 'const s = "${S}"; console.log(require("fs").readFileSync(s.split("/").slice(0, -1).join("/") + "/${OTHER_ID}/scratch/out.txt", "utf8"))'`, "floor-tamper"],
    [`python3 -c 's = "${S}"; print(open(s[:s.rfind("/")] + "/${OTHER_ID}/scratch/out.txt").read())'`, "floor-tamper"],
    [`python3 -c 's = "${S}"; print(open(s[:-${ID.length}] + "${OTHER_ID}/scratch/out.txt").read())'`, "floor-tamper"],
    // `..` spelled without its dots.
    [`bun -e 'const { join } = require("path"); console.log(require("fs").readFileSync(join("${S}", ".".repeat(2), "${OTHER_ID}", "scratch/out.txt"), "utf8"))'`, "floor-tamper"],
    [`python3 -c 'import os; print(open(os.path.join("${S}", chr(46) * 2, "${OTHER_ID}", "scratch", "out.txt")).read())'`, "floor-tamper"],
    [`python3 -c 'import os; print(open(os.path.join("${S}", "." * 2, "${OTHER_ID}", "scratch", "out.txt")).read())'`, "floor-tamper"],
  ];

  test("operations there still hold", () => {
    expect(HELD.map(([command]) => ({ command, outcome: outcome(bash(command)) }))).toEqual(HELD.map(([command, category]) => ({ command, outcome: category })));
  }, 60000);

  test("what reaches no scratch dir, secret or Standup data there runs", () => {
    const RUNS = [
      // /tmp's climb lands outside the scratch root: a new file, no denylist target.
      "echo hi > /tmp/a-$$/../../x",
      // A check run with its scratch env elsewhere in the home dir earns no isolation credit, and runs as any check run does.
      `${iso(`${NOT_SCRATCH}/i`)} bun test src/floor`,
      `${iso(`${HOME}/.cache/iso`)} bun test src/floor`,
      `${iso(`${S}/home-link/iso`)} bun test src/floor`,
    ];
    expect(RUNS.map((command) => ({ command, outcome: outcome(bash(command)) }))).toEqual(RUNS.map((command) => ({ command, outcome: "allow" })));
  }, 60000);

  test("the scratch root and the toolchain's ~/.cache/standup are told apart at path boundaries", () => {
    const rows: [string, "allow" | FloorCategory][] = [
      [`${SCRATCH_ROOT}/new.txt`, "floor-tamper"],
      [`${SCRATCH_ROOT}-x/w/new.txt`, "allow"],
      [`${S}/playwright/new.txt`, "allow"],
      [`${CACHE_STANDUP}/new.txt`, "allow"],
      [`${CACHE_STANDUP}/playwright/new.txt`, "floor-tamper"],
      [`${CACHE_STANDUP}-scratch-not/new.txt`, "allow"],
    ];
    expect(rows.map(([file_path]) => ({ file_path, outcome: outcome(tool("Write", { file_path, content: "x" })) }))).toEqual(rows.map(([file_path, o]) => ({ file_path, outcome: o })));
  });

  test("a scratch dir the config names that isn't the launch's own grants nothing", () => {
    const mismatched: FloorConfig = { ...config, scratchDir: O };
    // The hook decodes its config and drops the dir...
    expect(decodeFloorConfig(encodeFloorConfig(mismatched)).scratchDir).toBeUndefined();
    // ...and the classifier, handed it anyway, trusts neither dir.
    for (const cfg of [mismatched, decodeFloorConfig(encodeFloorConfig(mismatched)), { ...config, scratchDir: undefined }, { ...config, scratchRoot: `${HOME}/.cache` }]) {
      for (const command of [`rm -rf ${S}/w`, `rm -rf ${O}/w`, `echo hi > ${S}/out.txt`, `${iso(`${S}/i`)} bun test src/floor`]) {
        const v = bash(command, cfg);
        expect({ command, scratchDir: cfg.scratchDir, scratchRoot: cfg.scratchRoot, held: v.action === "hold" }).toEqual({ command, scratchDir: cfg.scratchDir, scratchRoot: cfg.scratchRoot, held: true });
      }
    }
  });

  test("an own scratch dir that is itself a link grants nothing", () => {
    for (const to of [HOME, O, `${HOME}/.cache`, DATA, ROOT]) {
      const links: Links = { [S]: to };
      for (const command of [`rm -rf ${S}/w`, `echo hi > ${S}/out.txt`, `rm -rf ${S}/*`, `${iso(`${S}/i`)} bun test src/floor`]) {
        const v = bash(command, config, links);
        expect({ to, command, held: v.action === "hold" }).toEqual({ to, command, held: true });
      }
    }
  });

  test("a scratch dir that resolves into the data dir or the install grants nothing", () => {
    for (const links of [{ [SCRATCH_ROOT]: `${DATA}/x` }, { [SCRATCH_ROOT]: `${INSTALL}/x` }] as Links[]) {
      const v = bash(`rm -rf ${S}/w`, config, links);
      expect({ links, held: v.action === "hold" }).toEqual({ links, held: true });
    }
  });
});

describe("isolation credit below /tmp and below the own scratch dir", () => {
  /** A verdict as allow, or the category it holds under, whether it is owner-reserved, and whether it holds as a read of Standup's DB. */
  type Held = "allow" | { category: FloorCategory; ownerReserved: boolean; dbRead: boolean };
  const held = (v: FloorVerdict): Held =>
    v.action === "hold" ? { category: v.category, ownerReserved: v.ownerReserved === true, dbRead: v.reason.includes("workers may not read Standup's database") } : "allow";
  /** What a run with no isolation credit comes to: code naming the DB's path under the home dir is a read of the live DB. */
  const DB_READ: Held = { category: "floor-tamper", ownerReserved: true, dbRead: true };
  /** What an isolated run comes to: Standup's own code, run against the isolated env, which names no live data. */
  const OPS: Held = "allow";
  const DB_TAIL = '".local", "share", "standup", "standup.db"';
  /** Inline code that climbs `n` dirs from `from()` (os's homedir or tmpdir) and names the DB's path under the home dir. */
  const jsClimb = (from: "homedir" | "tmpdir", n: number) =>
    `bun -e 'import { ${from} } from "os"; import { dirname, join } from "path"; console.log(join(${"dirname(".repeat(n)}${from}()${")".repeat(n)}, ${DB_TAIL}))'`;
  const homeRef = `bun -e 'import { homedir } from "os"; import { join } from "path"; console.log(join(homedir(), ${DB_TAIL}))'`;
  const rowsOf = (rows: [string, Held][], cfg: FloorConfig = config) =>
    expect(rows.map(([command]) => ({ command, v: held(bash(command, cfg)) }))).toEqual(rows.map(([command, v]) => ({ command, v })));

  test("the same isolated run below /tmp and below the own scratch dir", () => {
    const NO_CREDIT: [string, "allow" | FloorCategory, "allow" | FloorCategory][] = [
      // A check run runs in either.
      [`${iso("@/i")} ${tmps("@/i/t")} bun test src/floor`, "allow", "allow"],
      [`${iso("@/i")} ${tmps("@/i/t")} bunx tsc --noEmit -p .`, "allow", "allow"],
      // An isolated run of Standup's code that doesn't climb runs under one root in either.
      [`${iso("@/i")} ${tmps("@/i/t")} bun run scripts/home-ref.ts`, "allow", "allow"],
      // Leaving TMPDIR, TMP and TEMP at the inherited scratch dir earns nothing in either.
      [`${iso("@/i")} bun test src/floor`, "allow", "allow"],
      [`${iso("@/i")} bun run scripts/home-ref.ts`, "floor-tamper", "floor-tamper"],
    ];
    const got = NO_CREDIT.map(([template]) => ({ template, tmp: outcome(bash(template.replaceAll("@", "/tmp"))), own: outcome(bash(template.replaceAll("@", S))) }));
    expect(got).toEqual(NO_CREDIT.map(([template, tmp, own]) => ({ template, tmp, own })));
  }, 60000);

  test("a root below the own scratch dir, in the real home dir, earns no credit for code that climbs from it", () => {
    rowsOf([
      [`${iso(`${S}/i`)} ${STM} python3 -c 'from pathlib import Path; print(Path.home().parents[4] / ".local/share/standup/standup.db")'`, DB_READ],
      [`${iso(`${S}/i`)} ${STM} python3 -c 'import os; print(os.path.join(os.path.expanduser("~"), os.pardir, os.pardir, os.pardir, os.pardir, os.pardir, ${DB_TAIL}))'`, DB_READ],
      [`${iso(`${S}/i`)} ${STM} bun -e 'import { join } from "path"; console.log(join(process.env["HO"+"ME"], "../../../../..", ${DB_TAIL}))'`, DB_READ],
      [`${iso(`${S}/i`)} ${STM} ${jsClimb("homedir", 5)}`, DB_READ],
      [`${iso(`${S}/i`)} ${STM} bun -e 'import { join } from "path"; console.log(join(process.env.XDG_DATA_HOME, "..", "..", "..", "..", "..", ${DB_TAIL}))'`, DB_READ],
      // No climb at all: the root's own dirs.
      [`${iso(`${S}/i`)} ${STM} ${homeRef}`, OPS],
      [`${iso(`${S}/i`)} ${STM} bun run scripts/home-ref.ts`, OPS],
      // Vars split between the own scratch dir and /tmp share no root below either.
      [`${iso("/tmp/i")} XDG_DATA_HOME=${S}/d ${TM} bun run scripts/home-ref.ts`, DB_READ],
      [`${iso("/tmp/i")} DB_PATH=${S}/standup.db ${TM} bun run scripts/home-ref.ts`, DB_READ],
      [`${iso(`${S}/i`)} ${TM} bun run scripts/home-ref.ts`, DB_READ],
    ]);
    // A check run runs either way.
    for (const command of [`${iso(`${S}/i`)} ${STM} bun test src/floor`, `${iso(`${S}/i`)} bun test src/floor`, `${iso(`${S}/i`)} ${TM} bunx tsc --noEmit -p .`]) {
      expect({ command, outcome: outcome(bash(command)) }).toEqual({ command, outcome: "allow" });
    }
  }, 60000);

  test("a /tmp-isolated run earns credit only with TMPDIR, TMP and TEMP moved under /tmp or unset", () => {
    rowsOf([
      // Inherited, all three are the scratch dir.
      [`${iso("/tmp/i")} bun run scripts/home-ref.ts`, DB_READ],
      [`${iso("/tmp/i")} ${homeRef}`, DB_READ],
      [`${iso("/tmp/i")} ${jsClimb("tmpdir", 3)}`, DB_READ],
      [`${iso("/tmp/i")} ${jsClimb("homedir", 5)}`, DB_READ],
      // Moving one or two leaves the rest there.
      [`${iso("/tmp/i")} TMPDIR=/tmp/x/t bun run scripts/home-ref.ts`, DB_READ],
      [`${iso("/tmp/i")} TMPDIR=/tmp/x/t TMP=/tmp/x/t ${jsClimb("tmpdir", 3)}`, DB_READ],
      // Moving one into the scratch dir, or below the home dir.
      [`${iso("/tmp/i")} TMPDIR=${S}/t TMP=/tmp/x/t TEMP=/tmp/x/t bun run scripts/home-ref.ts`, DB_READ],
      [`${iso("/tmp/i")} TMPDIR=/tmp/x/t TMP=${HOME}/.cache/t TEMP=/tmp/x/t bun run scripts/home-ref.ts`, DB_READ],
      [`${iso("/tmp/i")} TMPDIR=/tmp/home-link/t TMP=/tmp/x/t TEMP=/tmp/x/t bun run scripts/home-ref.ts`, DB_READ],
      // All three moved under /tmp, or unset: credit, as with no scratch dir at all.
      [`${iso("/tmp/i")} ${TM} bun run scripts/home-ref.ts`, OPS],
      [`${iso("/tmp/i")} ${TM} ${homeRef}`, OPS],
      [`${iso("/tmp/i")} ${TM} ${jsClimb("tmpdir", 3)}`, OPS],
      [`${iso("/tmp/i")} ${TM} ${jsClimb("homedir", 5)}`, OPS],
      [`env -u TMPDIR -u TMP -u TEMP ${iso("/tmp/i")} bun run scripts/home-ref.ts`, OPS],
      [`unset TMPDIR TMP TEMP; ${iso("/tmp/i")} bun run scripts/home-ref.ts`, OPS],
      [`export ${TM}; ${iso("/tmp/i")} bun run scripts/home-ref.ts`, OPS],
      // An `env -u` the command undoes with an assignment it can't read is no unset.
      [`env -u TMPDIR TMPDIR="$X" ${iso("/tmp/i")} TMP=/tmp/x/t TEMP=/tmp/x/t bun run scripts/home-ref.ts`, DB_READ],
      // An `env -S` string runs with the env `env` was handed before it, which the shell around it doesn't show.
      [`export ${iso("/tmp/i")} ${TM}; env TMPDIR=${S} HOME=${HOME} -S 'bun run scripts/home-ref.ts'`, DB_READ],
      [`export ${iso("/tmp/i")} ${TM}; env -S 'bun run scripts/home-ref.ts'`, DB_READ],
      [`export ${iso("/tmp/i")} ${TM}; bun run scripts/home-ref.ts`, OPS],
      // A temp dir that a link made earlier in the command may lead out of.
      [`${iso("/tmp/i")} ${tmps("/tmp/i/l")} bun run scripts/home-ref.ts`, OPS],
      [`ln -s ~ /tmp/i/l && ${iso("/tmp/i")} ${tmps("/tmp/i/l")} bun run scripts/home-ref.ts`, DB_READ],
      [`python3 -c 'import os;os.symlink(os.path.expanduser("~"),"/tmp/i/l")' && ${iso("/tmp/i")} ${tmps("/tmp/i/l")} bun run scripts/home-ref.ts`, DB_READ],
      // A temp dir in a root of its own: the vars share no root below /tmp.
      [`${iso("/tmp/i")} ${tmps("/tmp/x/t")} bun run scripts/home-ref.ts`, DB_READ],
    ]);
    // A check run runs with credit or without it.
    for (const [command, expected] of [
      [`${iso("/tmp/i")} bun test src/floor`, "allow"],
      [`${iso("/tmp/i")} TMPDIR=/tmp/x/t bun test src/floor`, "allow"],
      [`${iso("/tmp/i")} ${TM} bun test src/floor`, "allow"],
      [`unset TMPDIR TMP TEMP; ${iso("/tmp/i")} bun test src/floor`, "allow"],
    ] as const) {
      expect({ command, outcome: outcome(bash(command)) }).toEqual({ command, outcome: expected });
    }
  }, 60000);

  test("with no scratch dir in the config, an inherited TMPDIR counts as it does on a launch without one", () => {
    const bare: FloorConfig = { ...config, scratchDir: undefined, scratchRoot: undefined };
    rowsOf([[`${iso("/tmp/i")} bun run scripts/home-ref.ts`, OPS]], bare);
    expect(outcome(bash(`${iso("/tmp/i")} bun test src/floor`, bare))).toBe("allow");
  }, 60000);

  test("the shell's own climbs out of a scratch HOME or TMPDIR still hold", () => {
    const rows = [
      `export HOME=${S}/h; cat "$HOME/../../../../.local/share/standup/standup.db"`,
      `export TMPDIR=${S}; cd $TMPDIR/../../.. && cat .local/share/standup/standup.db`,
      `export TMPDIR=${S}; cat "$TMPDIR/../../../.local/share/standup/standup.db"`,
    ];
    for (const command of rows) {
      const v = bash(command);
      expect({ command, held: v.action === "hold" ? { category: v.category, ownerReserved: v.ownerReserved === true } : "allow" }).toEqual({
        command,
        held: { category: "floor-tamper", ownerReserved: true },
      });
    }
  }, 60000);
});

describe("Write and Edit of a hard-linked file", () => {
  test("hold as a rewrite of every link to it, below the own scratch dir as below /tmp", () => {
    for (const file_path of ["/tmp/bashrc-link", `${S}/bashrc-link`]) {
      for (const [toolName, input] of [["Write", { file_path, content: "x" }], ["Edit", { file_path, old_string: "a", new_string: "b" }]] as const) {
        const v = tool(toolName, input);
        expect({ toolName, file_path, held: v.action === "hold" ? { category: v.category, ownerReserved: v.ownerReserved === true } : "allow" }).toEqual({
          toolName,
          file_path,
          held: { category: "floor-tamper", ownerReserved: true },
        });
      }
    }
  });
});

describe("a launch that keeps another launch's scratch dir (a resumed session)", () => {
  const RESUMED = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const resumed: FloorConfig = { ...config, launchId: RESUMED, scratchId: ID, scratchDir: S };

  test("treats that dir as its own, as the launch that made it does", () => {
    const decoded = decodeFloorConfig(encodeFloorConfig(resumed));
    expect(decoded.scratchDir).toBe(S);
    for (const command of [`echo hi > ${S}/out.txt`, `d=$(mktemp -d -p ${S}) && echo x > $d/f && rm -rf $d`, `rm -rf ${S}/w`]) {
      expect({ command, own: outcome(bash(command, decoded)), first: outcome(bash(command)) }).toEqual({ command, own: "allow", first: "allow" });
    }
    // Neither earns isolation credit for an env below it: a DB read from there holds in both.
    const check = `${iso(`${S}/i`)} ${TM} bun run scripts/home-ref.ts`;
    expect({ own: outcome(bash(check, decoded)), first: outcome(bash(check)) }).toEqual({ own: "floor-tamper", first: "floor-tamper" });
  });

  test("without the scratch id, the dir is another launch's", () => {
    const decoded = decodeFloorConfig(encodeFloorConfig({ ...resumed, scratchId: undefined }));
    expect(decoded.scratchDir).toBeUndefined();
    for (const command of [`echo hi > ${S}/out.txt`, `d=$(mktemp -d -p ${S}) && rm -rf $d`]) {
      expect({ command, own: outcome(bash(command, decoded)) }).toEqual({ command, own: "floor-tamper" });
    }
  });
});
