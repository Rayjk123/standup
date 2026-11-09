import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";

/** The home dir as the launcher writes it, and where it resolves: a home that is a symlink to another volume. */
const HOME = join("/", "fake", "home");
const REAL_HOME = join("/", "fake", "data", "home");

function layout(home: string) {
  const data = join(home, ".local", "share", "standup");
  const scratchRoot = join(home, ".cache", "standup-scratch");
  return {
    data,
    root: join(data, "worktrees", "standup", "feat-1"),
    scratchRoot,
    s: join(scratchRoot, "launch-1"),
    o: join(scratchRoot, "launch-2"),
  };
}

const W = layout(HOME);
const R = layout(REAL_HOME);
const INSTALL = join("/", "fake", "install");
const FLOOR = join(INSTALL, "packages", "collector", "src", "floor");

const config: FloorConfig = {
  ...buildLaunchFloorConfig(
    { launchId: "launch-1", root: R.root, workerToken: "x".repeat(64), replyPublicKey: "test" },
    { DB_PATH: join(W.data, "standup.db"), HOME, XDG_CACHE_HOME: join(HOME, ".cache"), STANDUP_INSTALL_DIR: INSTALL }
  ),
  floorPaths: [FLOOR],
  installDir: INSTALL,
};

const OUTWARD_PY = 'import subprocess\nsubprocess.run(["git", "push", "origin", "HEAD:main"], check=True)\n';
const DB_PY = 'import sqlite3, os\nc = sqlite3.connect(os.path.expanduser("~/.local/share/standup/standup.db"))\nprint(c.execute("select 1").fetchall())\n';
const PLAIN_PY = 'print("hello")\n';
const SH = ["#!/bin/sh", "git push origin HEAD:main", "aws s3 rm s3://prod-bucket --recursive", ""].join("\n");

const FILES: Record<string, string> = {
  [join(R.root, ".git")]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [join(R.root, "package.json")]: JSON.stringify({ scripts: { test: "bun test" } }),
  [join(R.s, "q.py")]: OUTWARD_PY,
  [join(R.s, "db.py")]: DB_PY,
  [join(R.s, "plain.py")]: PLAIN_PY,
  [join(R.s, "run.sh")]: SH,
  [join(R.s, "common-prompt.md")]: "## Rules\nNever run `git push`.\nRead ~/.local/share/standup/secrets/owner.json? No.\n",
  [join(R.o, "q.py")]: PLAIN_PY,
  [join(R.scratchRoot, "first-launch", "q.py")]: OUTWARD_PY,
  [join(R.scratchRoot, "first-launch", "run.sh")]: SH,
  ...Object.fromEntries(
    ["secrets.json", ".env", "token", "credentials", "standup.db", "owner.json", "h/.aws/credentials", "h/.ssh/id_rsa", "h/.netrc", "h/.config/standup/owner-token"].map((n) => [join(R.s, n), PLAIN_PY])
  ),
  [join(R.data, "secrets", "owner.json")]: "{}",
  [join(R.data, "worker-tokens", "launch-1")]: "tok",
  [join(R.data, "standup.db")]: "",
};

const LINKS: Record<string, string> = {
  [HOME]: REAL_HOME,
  [join(R.s, "secrets-link")]: join(R.data, "secrets"),
  [join(R.s, "other-link")]: R.o,
};

function resolve(p: string): string {
  for (const [from, to] of Object.entries(LINKS)) if (p === from || p.startsWith(`${from}/`)) return resolve(to + p.slice(from.length));
  return p;
}

function probes(env: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", "/var/tmp", R.root, R.s, R.o]);
  for (const f of [...Object.keys(FILES), ...Object.keys(LINKS), ...Object.values(LINKS)]) {
    for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  }
  for (const t of Object.values(LINKS)) dirs.add(t);
  dirs.delete(join(R.root, ".git"));
  const present = (p: string) => p in FILES || dirs.has(p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p) => {
      const r = resolve(p);
      return r in FILES ? { ok: true, text: FILES[r]! } : { ok: false, reason: "missing" };
    },
    exists: (p) => present(resolve(p)),
    isDirectory: (p) => dirs.has(resolve(p)),
    listDir: (p) => {
      const r = resolve(p);
      if (!dirs.has(r)) return null;
      const names = new Set<string>();
      for (const q of [...dirs, ...Object.keys(FILES), ...Object.keys(LINKS)]) {
        if (q.startsWith(`${r === "/" ? "" : r}/`) && q !== r) names.add(q.slice(r.length + (r === "/" ? 0 : 1)).split("/")[0]!);
      }
      return [...names];
    },
    realpath: (p) => {
      const r = resolve(p);
      return present(r) ? r : null;
    },
    lstat: (p) => {
      if (p in LINKS) return { symlink: true, file: false, nlink: 1 };
      const r = resolve(p);
      return r in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(r) ? { symlink: false, file: false, nlink: 1 } : null;
    },
    homeDir: () => HOME,
    env: (name) => env[name],
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

const ENV = { HOME, TMPDIR: W.s, TMP: W.s, TEMP: W.s };

function bash(command: string, cwd = R.root): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(ENV));
}

const S = W.s;
const O = W.o;

/** The adopted launch's config: its scratch dir is named for the session's first launch. */
const adopted: FloorConfig = {
  ...buildLaunchFloorConfig(
    { launchId: "launch-1", scratchId: "first-launch", root: R.root, workerToken: "x".repeat(64), replyPublicKey: "test" },
    { DB_PATH: join(W.data, "standup.db"), HOME, XDG_CACHE_HOME: join(HOME, ".cache"), STANDUP_INSTALL_DIR: INSTALL }
  ),
  floorPaths: [FLOOR],
  installDir: INSTALL,
};

/*
 * A worker prints a script it wrote to its own scratch dir (its TMPDIR) so a
 * reviewer sees it, then runs it. The scratch root is protected, but the own
 * scratch dir below it is the worker's: printing a file there is a read of
 * the worker's own data whatever the file says, with the config the launcher
 * builds (written under a home dir that is a symlink) and $TMPDIR as the hook
 * inherits it. Running an outward script, and reading another launch's
 * scratch dir, the secrets or the worker tokens, or climbing or linking out
 * of the own dir, stay held.
 */
describe("printing a script in the own scratch dir", () => {
  const saved = process.env.TMPDIR;
  beforeAll(() => {
    process.env.TMPDIR = S;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  });

  test("the launcher's config names the own scratch dir under a private scratch root", () => {
    expect(config.scratchDir).toBe(S);
    expect(config.protectedPaths).not.toContain(W.scratchRoot);
    expect(config.privatePaths?.map((p) => p.path)).toContain(W.scratchRoot);
  });

  test.each([
    `cat ${S}/q.py`,
    `cat ${R.s}/q.py`,
    `cat ${S}/db.py`,
    `cat ${S}/plain.py`,
    `cat ${S}/run.sh`,
    `cat ${S}/common-prompt.md`,
    `cat $TMPDIR/q.py`,
    `cat "$TMPDIR/q.py"`,
    `cat ~/.cache/standup-scratch/launch-1/q.py`,
    `sed -n '1,200p' ${S}/q.py`,
    `sed -n '1,50p' ${S}/plain.py`,
    `head -50 ${S}/q.py`,
    `nl ${S}/q.py`,
    `wc -l ${S}/q.py`,
    `less ${S}/q.py`,
    `cat -n ${S}/q.py`,
    `cat ${S}/q.py | head -40`,
    `cat ${S}/q.py ${S}/run.sh`,
    `cat ${S}/q.py 2>/dev/null`,
    `cat $TMPDIR/q.py; echo; cat $TMPDIR/db.py`,
    `sed -n '1,200p' $TMPDIR/q.py`,
    `sed -n 1,200p $TMPDIR/run.sh`,
    `sed -n '1,50p' "$TMPDIR/run.sh"`,
    `head -n 200 $TMPDIR/run.sh`,
    `cat $TMP/q.py`,
    `cat \${TMPDIR}/q.py`,
    `cat \${TMPDIR:-/tmp}/q.py`,
    `cat ~/.cache/standup-scratch/launch-1/run.sh`,
    `cat $HOME/.cache/standup-scratch/launch-1/run.sh`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([`cat q.py`, `cat ./run.sh`, `sed -n '1,200p' q.py`, `sed -n '1,50p' run.sh`, `nl db.py`, `wc -l run.sh`, `cat ../launch-1/q.py`])("allows %p from the scratch dir", (command) => {
    expect(bash(command, S)).toEqual({ action: "allow" });
  });

  test.each([`cat ${S}/q.py`, `cat $TMPDIR/run.sh`, `sed -n '1,50p' $TMPDIR/db.py`])("allows %p from /tmp", (command) => {
    expect(bash(command, "/tmp")).toEqual({ action: "allow" });
  });

  test.each(["secrets.json", ".env", "token", "credentials", "standup.db", "owner.json", "h/.aws/credentials", "h/.ssh/id_rsa", "h/.netrc", "h/.config/standup/owner-token"])(
    "allows printing %p in it, by a secret-like name",
    (name) => {
      const held = [`cat ${S}/${name}`, `cat $TMPDIR/${name}`, `head -5 ${S}/${name}`, `tail -5 ${S}/${name}`, `sed -n '1,50p' ${S}/${name}`].filter((c) => bash(c).action !== "allow");
      expect(held).toEqual([]);
    }
  );

  test.each([`cat ${W.scratchRoot}/first-launch/q.py`, `sed -n '1,50p' ${W.scratchRoot}/first-launch/q.py`, `cat ${R.scratchRoot}/first-launch/run.sh`])("allows %p for an adopted launch", (command) => {
    expect(classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: R.root }, adopted, probes(ENV))).toEqual({ action: "allow" });
  });

  test.each([
    `cat ${S}/plain.py && python3 ${S}/plain.py`,
    `cat $TMPDIR/plain.py; python3 $TMPDIR/plain.py`,
    `python3 ${S}/plain.py`,
    `python3 -I ${S}/plain.py`,
    `sed -n '1,200p' ${S}/plain.py && python3 ${S}/plain.py`,
  ])("allows printing and running a local script: %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([`cat ${S}/q.py && python3 ${S}/q.py`, `python3 $TMPDIR/q.py`, `sh ${S}/run.sh`, `cat $TMPDIR/run.sh; sh $TMPDIR/run.sh`])("holds running an outward script: %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });

  test.each([
    `cat ${O}/q.py`,
    `sed -n '1,50p' ${O}/q.py`,
    `cat ${S}/../launch-2/q.py`,
    `cat $TMPDIR/../launch-2/q.py`,
    `cat ${S}/other-link/q.py`,
    `cat ${W.scratchRoot}/first-launch/q.py`,
  ])("holds %p for Persona, not as an owner-side secret", (command) => {
    const verdict = bash(command);
    expect(verdict).toMatchObject({ action: "hold", category: "standup-ops" });
    if (verdict.action === "hold") expect(verdict.ownerReserved).toBeUndefined();
  });

  test.each([
    `cat ${S}/secrets-link/owner.json`,
    `cat ${S}/../../../.local/share/standup/secrets/owner.json`,
    `cat ${W.data}/secrets/owner.json`,
    `cat ${W.data}/worker-tokens/launch-1`,
  ])("holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper", ownerReserved: true });
  });

  test("holds the own launch's dir once a session was adopted into another's", () => {
    expect(classifyToolCall({ toolName: "Bash", toolInput: { command: `cat ${S}/q.py` }, cwd: R.root }, adopted, probes(ENV))).toMatchObject({ action: "hold", category: "standup-ops" });
  });
});

describe("$TMPDIR naming another launch's scratch dir", () => {
  test("holds a read through it", () => {
    const verdict = classifyToolCall({ toolName: "Bash", toolInput: { command: `cat $TMPDIR/q.py` }, cwd: R.root }, config, probes({ ...ENV, TMPDIR: O }));
    expect(verdict).toMatchObject({ action: "hold", category: "standup-ops" });
  });
});
