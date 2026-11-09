import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Redirects that duplicate or close a file descriptor (`2>&1`, `>&2`, `1>&2`,
 * `2>&-`, `>&1`, `&>/dev/null`, `|&`) write no file, and a redirect into the
 * worker's own TMPDIR (the launch's scratch dir, which the hook's own env
 * names) writes the worker's own scratch space: neither is "an existing file
 * outside the worktree", from a cwd of /tmp or of a worktree under the data
 * dir, with the hook's TMPDIR set or unset (it then falls back to the
 * config's scratch dir). This covers the scratch-instance seeding commands
 * that mint a /tmp root, record it in `$TMPDIR/live-root`, read it back and
 * run a seed script from `$TMPDIR` under `env -i`, whatever the script does.
 * Writes over files outside the worktree (`/etc/x`, `~/.bashrc`,
 * `$HOME/file`), into another launch's scratch dir, or through a TMPDIR that
 * names another launch's dir still hold, as does a target the floor can't
 * place; and none of those holds names `.` as the file it overwrites.
 */

const HOME = join("/", "local", "home", "u");
const ROOT = join(HOME, ".local", "share", "standup", "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const ID = "a1a1a1a1-0000-4000-8000-0000000000a1";
const OTHER = "a2a2a2a2-0000-4000-8000-0000000000a2";
const DATA = join(HOME, ".local", "share", "standup");
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const S = join(SCRATCH_ROOT, ID);
const O = join(SCRATCH_ROOT, OTHER);
const BUN_BIN = join(HOME, ".bun", "bin");
const WORKER_PATH = `${BUN_BIN}:/usr/local/bin:/usr/bin:/bin`;
const SEED = join(S, "seed-profile.ts");

function config(scratch = true): FloorConfig {
  return {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: ID,
    ...(scratch ? { scratchRoot: SCRATCH_ROOT, scratchDir: S } : {}),
    root: ROOT,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: DATA,
    floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
    installDir: INSTALL,
    protectedPaths: [join(DATA, "secrets"), join(DATA, "worker-tokens"), join(DATA, "review-media"), join(DATA, "review-scratch"), SCRATCH_ROOT],
    worktreeRoots: [join(DATA, "worktrees")],
    tmpDirs: ["/tmp", "/var/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
}

const DIRS = ["/", "/tmp", "/etc", ROOT, S, O, join(HOME, ".cache")];
/** A link to the directory /etc, which a step may point elsewhere before a redirect onto it. */
const DIR_LINK = join(HOME, "dl");
const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(S, "live-root")]: "/tmp/live-Ab12Cd\n",
  [join(O, "live-root")]: "/tmp/live-Ab12Cd\n",
  [join(BUN_BIN, "bun")]: "\x7fELF",
  "/etc/x": "x\n",
  [join(HOME, ".bashrc")]: "x\n",
  [join(HOME, "file")]: "x\n",
};

function probes(tmpdir: string | undefined): Partial<FloorProbes> {
  const dirs = new Set<string>(DIRS);
  for (const f of [...Object.keys(FILES), ...DIRS]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const env: Record<string, string> = { HOME, PATH: WORKER_PATH, ...(tmpdir === undefined ? {} : { TMPDIR: tmpdir }) };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p) || p === DIR_LINK,
    executable: (p) => p === join(BUN_BIN, "bun"),
    isDirectory: (p) => dirs.has(p) || p === DIR_LINK,
    listDir: () => null,
    realpath: (p) => (p === DIR_LINK ? "/etc" : p in FILES || dirs.has(p) ? p : null),
    lstat: (p) =>
      p === DIR_LINK
        ? { symlink: true, file: false, nlink: 1 }
        : p in FILES
          ? { symlink: false, file: true, nlink: 1 }
          : dirs.has(p)
            ? { symlink: false, file: false, nlink: 1 }
            : null,
    homeDir: () => HOME,
    env: (name) => env[name],
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

let saved: { tmp: string | undefined; path: string | undefined };
beforeEach(() => {
  saved = { tmp: process.env.TMPDIR, path: process.env.PATH };
});
afterEach(() => {
  if (saved.tmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved.tmp;
  process.env.PATH = saved.path;
  delete FILES[SEED];
});

/** The verdict on `command` run from `cwd`, with the hook's TMPDIR `tmpdir` (unset when undefined) and the worker's PATH. */
function run(command: string, cwd: string, tmpdir: string | undefined, scratch = true): FloorVerdict {
  if (tmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmpdir;
  process.env.PATH = WORKER_PATH;
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config(scratch), probes(tmpdir));
}

const CWDS = ["/tmp", ROOT];
const TMPDIRS: Array<[string, string | undefined]> = [
  ["the own scratch dir", S],
  ["unset", undefined],
];

/** The scratch-instance seeding commands: mint a /tmp root, record it in `$TMPDIR/live-root`, then read it back; each runs a seed script from `$TMPDIR` under `env -i`. */
const SEED_MINT = `L=$(mktemp -d -p /tmp live-XXXXXX); mkdir -p $L/home $L/tmp $L/xdg/config $L/xdg/data $L/xdg/state $L/xdg/cache $L/data $L/knowledge $L/internal $L/docs $L/tmux; echo $L > $TMPDIR/live-root; echo $L; cd /tmp && env -i PATH="$(dirname $(which bun)):/usr/bin:/bin" HOME=$L/home TMPDIR=$L/tmp KNOWLEDGE_DIR=$L/knowledge DB_PATH=$L/data/standup.db bun $TMPDIR/seed-profile.ts ${ROOT} $L/data/standup.db $L/knowledge u 2>&1 | tail -5`;
const SEED_REUSE = `L=$(cat $TMPDIR/live-root); cd /tmp && env -i PATH="$(dirname $(which bun)):/usr/bin:/bin" HOME=$L/home TMPDIR=$L/tmp KNOWLEDGE_DIR=$L/knowledge DB_PATH=$L/data/standup.db bun $TMPDIR/seed-profile.ts ${ROOT} $L/data/standup.db $L/knowledge u 2>&1 | tail -3; sqlite3 $L/data/standup.db "select count(*), count(writer_stamp) from knowledge"`;

/** Seed scripts of ordinary shapes, and none at all. */
const SEED_SCRIPTS: Array<[string, string | null]> = [
  ["a bun:sqlite writer", `import { Database } from "bun:sqlite";\nconst [root, dbPath, kdir, owner] = process.argv.slice(2);\nconst db = new Database(dbPath);\ndb.run("create table if not exists knowledge (id text)");\nconsole.log(root, kdir, owner);\n`],
  ["a Bun shell run", `import { $ } from "bun";\nconst [root] = process.argv.slice(2);\nawait $\`bun run kb:seed 2>&1\`.cwd(root);\n`],
  ["a spawn", `const [root] = process.argv.slice(2);\nBun.spawnSync(["bun", "run", "kb:seed"], { cwd: root, env: process.env, stdout: "inherit" });\n`],
  ["a file writer", `import { writeFileSync } from "fs";\nconst [, , kdir] = process.argv.slice(2);\nwriteFileSync(kdir + "/x.md", "# x\\n");\n`],
  ["no script", null],
];

const ALLOWED = [
  "echo hi 2>&1 | tail -3",
  "echo hi >&2",
  "echo hi 1>&2",
  "echo hi 2>&-",
  "echo hi 1>&-",
  "echo hi >&-",
  "echo hi &>/dev/null",
  "echo hi >&1",
  "echo hi 2>& 1",
  "echo hi 2>&1-",
  "echo hi |& tail -3",
  "echo hi 2>&1 >/dev/null",
  "echo hi 3>&1 1>&2 2>&3 3>&-",
  "exec 2>&1",
  "{ echo a; echo b; } 2>&1 | tail -3",
  "( echo a ) 2>&1 | tail -3",
  "X=$( echo a 2>&1 )",
  "echo $L > $TMPDIR/live-root",
  "L=/tmp/live-Ab12Cd; echo $L > $TMPDIR/live-root",
  "echo $L >> $TMPDIR/live-root",
  "echo x | tee $TMPDIR/live-root",
  "L=$(mktemp -d -p /tmp live-XXXXXX); echo $L > $TMPDIR/live-root",
  SEED_MINT,
  SEED_REUSE,
];

for (const cwd of CWDS) {
  for (const [label, tmpdir] of TMPDIRS) {
    describe(`from ${cwd}, the hook's TMPDIR ${label}`, () => {
      test.each(ALLOWED)("%p is allowed", (command) => {
        expect(run(command, cwd, tmpdir)).toEqual({ action: "allow" });
      });

      test.each(SEED_SCRIPTS)("the seeding commands with %s in $TMPDIR are allowed", (_name, text) => {
        if (text !== null) FILES[SEED] = text;
        expect(run(SEED_MINT, cwd, tmpdir)).toEqual({ action: "allow" });
        expect(run(SEED_REUSE, cwd, tmpdir)).toEqual({ action: "allow" });
      });

      test.each([
        ["echo x > /etc/x", "destructive", "/etc/x"],
        ["echo x > $HOME/file", "destructive", "$HOME/file"],
        [`echo x > ${O}/live-root`, null, `${O}/live-root`],
      ])("%p still holds, naming its target", (command, category, target) => {
        const v = run(command, cwd, tmpdir);
        expect(v.action).toBe("hold");
        if (v.action !== "hold") return;
        if (category !== null) expect<string>(v.category).toBe(category);
        expect(v.reason).toContain(target);
        expect(v.reason).not.toContain("overwrites .,");
      });

      test("a write over ~/.bashrc still holds", () => {
        const v = run("echo x > ~/.bashrc", cwd, tmpdir);
        expect(v.action).toBe("hold");
        if (v.action === "hold") expect(v.reason).not.toContain("overwrites .,");
      });
    });
  }
}

// A `>` onto a directory fails with "Is a directory" and writes nothing, so `.`, `/etc` or a dir named by `$(dirname …)` is
// never an overwrite; a dir an earlier step may delete, and a file in it, still are.
describe("a redirect onto an existing directory", () => {
  test.each([
    ["echo x > .", "/tmp"],
    ["echo x > /etc", ROOT],
    ["echo x > /etc/", ROOT],
    ["echo x > $(dirname $(which bun))", "/tmp"],
    ["echo x >> /etc", ROOT],
  ])("%p from %s is no write", (command, cwd) => {
    expect(run(command, cwd, S)).toEqual({ action: "allow" });
  });

  test.each([
    ["rm -rf /etc; echo x > /etc", ROOT],
    ["echo x > /etc/x", ROOT],
    ["echo x > ./.bashrc", HOME],
    ["echo x > ~/dl", ROOT],
    ["ln -sfn ~/file ~/dl; echo x > ~/dl", ROOT],
    ["echo x > ~/dl & ln -sfn ~/file ~/dl", ROOT],
  ])("%p from %s still holds",(command, cwd) => {
    expect(run(command, cwd, S).action).toBe("hold");
  });
});

describe("a TMPDIR the floor can't trust", () => {
  test.each(CWDS)("from %s, a TMPDIR naming another launch's scratch dir holds a write there", (cwd) => {
    const v = run("echo $L > $TMPDIR/live-root", cwd, O);
    expect(v.action).toBe("hold");
    if (v.action === "hold") expect(v.reason).toContain("$TMPDIR/live-root");
  });

  // A write the floor can't place is held only when its text names a denylist target or a guarded file (unplacedWriteTier):
  // these stay unplaced, never read as a write over `.`.
  test.each(CWDS)("from %s, an unset TMPDIR and no scratch dir in the config leave $TMPDIR/live-root unplaced, not `.`", (cwd) => {
    expect(run("echo $L > $TMPDIR/live-root", cwd, undefined, false)).toEqual({ action: "allow" });
  });

  test.each(CWDS)("from %s, a redirect to a path a program prints is unplaced, not `.`", (cwd) => {
    expect(run("echo x > $(some-tool --print-path)/out", cwd, S)).toEqual({ action: "allow" });
  });

  test.each(CWDS)("from %s, an unplaced redirect that names ~/.claude still holds", (cwd) => {
    const v = run("echo x > $(some-tool --print-path)/.claude/settings.json", cwd, S);
    expect(v.action).toBe("hold");
    if (v.action === "hold") expect(v.reason).not.toContain("overwrites .,");
  });
});
