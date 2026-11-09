import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * sed run with a print-only script (addresses and the p, =, l and q
 * commands, under -n, -E/-r and any number of -e) on files the worker may
 * read only reads. A script that runs a command (`e`, `s///e`), writes
 * (`w`, `W`, `s///w`, `-i`), reads another file (`r`, `R`), or splices in a
 * value the floor can't know still holds, as does sed on a secret or on
 * the live data dir. The machine is virtual.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
const PATHS = [
  "/fake/home/.bun/bin",
  `${INSTALL}/node_modules/.bin`,
  `${INSTALL}/packages/node_modules/.bin`,
  `${INSTALL}/packages/collector/node_modules/.bin`,
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`, `${DATA}/review-scratch`, `${DATA}/review-media`],
  worktreeRoots: [`${DATA}/worktrees`],
  tmpDirs: ["/tmp", "/var/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILE = "packages/collector/src/floor/classify.ts";

const FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [`${ROOT}/${FILE}`]: readFileSync(join(import.meta.dir, "classify.ts"), "utf8"),
  [`${ROOT}/notes.txt`]: "a\nb\nc\n",
  [`${DATA}/secrets/owner.key`]: "k\n",
  [`${DATA}/standup.db`]: "db\n",
};

/** Where the home dir really is when `HOME` is a symlink to it, as on hosts with `/home/u -> /data/home/u`. */
const LOCAL_HOME = "/fake/data/home";

function probes(env: Record<string, string>, linkedHome: boolean): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  if (linkedHome) for (const d of ["/fake/data", LOCAL_HOME]) dirs.add(d);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  // Files are keyed under HOME; with a linked home, a path under LOCAL_HOME is the same file.
  const key = (p: string) => (linkedHome && under(p, LOCAL_HOME) ? HOME + p.slice(LOCAL_HOME.length) : p);
  const known = (p: string) => key(p) in FILES || dirs.has(bare(key(p)));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (key(dir) === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (key(p) in FILES ? { ok: true, text: FILES[key(p)]! } : { ok: false, reason: "missing" }),
    exists: (p) => known(p),
    isDirectory: (p) => dirs.has(bare(key(p))),
    lstat: (p) =>
      linkedHome && bare(p) === HOME
        ? { symlink: true, file: false, nlink: 1 }
        : key(p) in FILES
          ? { symlink: false, file: true, nlink: 1 }
          : dirs.has(bare(key(p)))
            ? { symlink: false, file: false, nlink: 1 }
            : null,
    listDir: (raw) => {
      const p = bare(key(raw));
      return dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (!known(p) ? null : linkedHome && under(key(p), HOME) ? LOCAL_HOME + key(p).slice(HOME.length) : p),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    env: (name) => env[name],
    now: () => Date.now(),
  };
}

function bash(command: string, linkedHome: boolean): FloorVerdict {
  const cwd = linkedHome ? LOCAL_HOME + ROOT.slice(HOME.length) : ROOT;
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes({ PATH: PATHS, HOME }, linkedHome));
}

function verdicts(commands: string[], linkedHome = false): Array<{ command: string; verdict: FloorVerdict }> {
  return commands.map((command) => ({ command, verdict: bash(command, linkedHome) }));
}

const LAYOUTS = [
  { name: "home dir", linkedHome: false },
  { name: "home dir linked to /data/home, cwd given by its real path", linkedHome: true },
];

describe.each(LAYOUTS)("sed with a print-only script ($name)", ({ linkedHome }) => {
  test("on a worktree file only reads", () => {
    const commands = [
      `sed -n '120,180p' ${FILE}`,
      `sed -n '/^export function foo/,/^}/p' ${FILE}`,
      `sed -n '10,20p;30,40p' ${FILE}`,
      `sed -n 5p ${FILE}`,
      `sed -n '$p' ${FILE}`,
      `sed -n '/start/,+20p' ${FILE}`,
      `sed -n -e 1p -e '$=' ${FILE}`,
      `sed -E -n '/^(a|b)$/p' notes.txt`,
      `sed -rn '2,3l' notes.txt`,
      `sed 3q notes.txt`,
      `sed -n "1,50p" ${ROOT}/${FILE}`,
      `a=10; b=20; sed -n "\${a},\${b}p" ${FILE}`,
      `git show main:${FILE} | sed -n '1,50p'`,
      `grep -n foo ${FILE} | sed -n '1,5p'`,
      `sed -n '1,$p' ${FILE} | head -5`,
      `sed -n '/foo/{=;p}' ${FILE}`,
      `sed -n --expression='2,3p' ${FILE}`,
      `sed -n '1,3p' ${FILE} 2>/dev/null`,
      `n=12; sed -n "$((n-2)),$((n+2))p" ${FILE}`,
      `sed -n '1,5p' /tmp/x.txt`,
      `cd packages/collector && sed -n '1,5p' src/floor/classify.ts`,
      `sed -n '/^  private sed(/,/^  }$/p' ${FILE}`,
      `sed -n '/a/,/b/{/c/p}' notes.txt`,
      `sed -n 's/a/b/p' notes.txt`,
      `sed -n '1~2p;0,/b/p' notes.txt`,
      `sed -n -- '1p' notes.txt`,
      `sed -ne '1,5p' notes.txt`,
      `f=notes.txt; sed -n "1,5p" "$f"`,
      `sed -n "$(grep -n foo ${FILE} | head -1 | cut -d: -f1),+5p" ${FILE}`,
      `sed -n '1,5p' < notes.txt`,
      `for f in notes.txt ${FILE}; do sed -n 1p "$f"; done`,
      `sed -n '1,5p' notes.txt ${FILE}`,
    ];
    expect(verdicts(commands, linkedHome)).toEqual(commands.map((command) => ({ command, verdict: { action: "allow" } })));
  });
});

describe.each(LAYOUTS)("sed that runs, writes, reads another file or splices an unknown value ($name)", ({ linkedHome }) => {
  test("still holds, for what the script or operand does", () => {
    const FLOOR_FILE = `${INSTALL}/packages/collector/src/floor/classify.ts`;
    const cases: Array<[string, string]> = [
      [`sed -n '1e git push origin HEAD:main' notes.txt`, "`git push` publishes to a remote"],
      [`sed -n '1e pkill -f collector' notes.txt`, "`pkill` kills processes"],
      [`sed -n 'e' notes.txt`, "runs its input as commands (the `e` command)"],
      [`sed -n '1,2w ${DATA}/standup.db' notes.txt`, "Standup's database"],
      [`sed -n '1W ${FLOOR_FILE}' notes.txt`, `sed w writes ${FLOOR_FILE}`],
      [`sed -n '1r ${DATA}/secrets/owner.key' notes.txt`, "owner-side secrets"],
      [`sed -n '1R ${DATA}/standup.db' notes.txt`, "Standup's database"],
      [`sed 's/a/b/w ${DATA}/standup.db' notes.txt`, "Standup's database"],
      [`sed 's/a/id/e' notes.txt`, "runs its input as commands (the `e` flag)"],
      [`sed 's/.*/git push origin HEAD:main/e' notes.txt`, "`git push` publishes to a remote"],
      [`sed -i '1d' ${FLOOR_FILE}`, `sed -i writes ${FLOOR_FILE}`],
      [`sed -n "\${X}p" notes.txt`, "can't read the sed script"],
      [`a=$(git log -1 --format=%s); sed -n "\${a}p" notes.txt`, "can't read the sed script"],
      [`sed -n "1p;\${X}" notes.txt`, "can't read the sed script"],
      [`sed -n 1p ${DATA}/secrets/owner.key`, "owner-side secrets"],
      [`sed -n 1p ${DATA}/standup.db`, "Standup's database"],
      [`git show main:${FILE} | sed -n '1e git push origin HEAD:main'`, "`git push` publishes to a remote"],
    ];
    const seen = cases.map(([command, reason]) => {
      const verdict = bash(command, linkedHome);
      return { command, action: verdict.action, reasonMatches: verdict.action === "hold" && verdict.reason.includes(reason) };
    });
    expect(seen).toEqual(cases.map(([command]) => ({ command, action: "hold", reasonMatches: true })));
  });
});
