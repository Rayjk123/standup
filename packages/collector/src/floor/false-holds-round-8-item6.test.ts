import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A variable set from `mktemp -d` anchored under /tmp (`-p /tmp`, `-dp /tmp`,
 * `-p /tmp -d`, `--directory -p /tmp`, `--tmpdir=/tmp`, a /tmp/ template)
 * names a new dir under /tmp: paths built on it (`$R/data`, `"$R/"`) are
 * /tmp paths, in one command and across lines, and after a step that hides
 * TMPDIR from the floor (a -p dir without -t doesn't read it). Where the floor can't pin the
 * dir under /tmp (an unknown or owner-side -p, a template that climbs out,
 * a TMPDIR it can't vouch for), where the variable may hold something else
 * (reassigned, a fallback after `||`, used before it is set), or where the
 * path climbs out of the dir (`$R/..`), the path is as unknown as before.
 */

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

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "notes.txt")]: "a\nb\nc\n",
  [join(ROOT, "packages", "collector", "src", "floor-r8-x", "a.test.ts")]: "import { test } from 'bun:test';\ntest('a', () => {});\n",
  [join(DATA, "secrets", "token")]: "s3cret\n",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, HOME]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const exists = (p: string) => p in FILES || dirs.has(p);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists,
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    lstat: (p) => (exists(p) ? { symlink: false, file: !dirs.has(p), nlink: 1 } : null),
    realpath: (p) => (exists(p) ? p : null),
    homeDir: () => HOME,
    env: () => undefined,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** `tmpdir` is the TMPDIR the classifying process has: the worker's scratch dir in the hook, none in the collector. */
function bash(command: string, cwd = ROOT, tmpdir: string | undefined = OWN_SCRATCH): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, { ...probes(), env: (name) => (name === "TMPDIR" ? tmpdir : undefined) });
}

function verdict(command: string, tmpdir: string | undefined = OWN_SCRATCH): { command: string; action: string; category: string | null; reason: string } {
  const v = bash(command, ROOT, tmpdir);
  return { command, action: v.action, category: v.action === "hold" ? v.category : null, reason: v.action === "hold" ? v.reason : "" };
}

/** The isolated test run: every path var under `$R`, its dirs made first. */
const ISOLATED_RUN =
  "mkdir -p $R/home $R/xdg/config $R/xdg/data $R/xdg/cache $R/xdg/state $R/tmp $R/data $R/knowledge $R/internal && env -i PATH=/home/u/.bun/bin:/usr/local/bin:/usr/bin:/bin HOME=$R/home XDG_CONFIG_HOME=$R/xdg/config XDG_DATA_HOME=$R/xdg/data XDG_CACHE_HOME=$R/xdg/cache XDG_STATE_HOME=$R/xdg/state TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/data/standup.db STANDUP_SQLITE_PATH=$R/data/standup.sqlite KNOWLEDGE_DIR=$R/knowledge STANDUP_INTERNAL_ROOT=$R/internal bun test packages/collector/src/floor-r8-x/a.test.ts > /tmp/r8-x-test.log 2>&1";

const MKTEMPS = [
  "R=$(mktemp -d -p /tmp floor-x-XXXXXX)",
  "R=$(mktemp -d -p /tmp)",
  'R="$(mktemp -d -p /tmp foo.XXXX)"',
  "R=$(mktemp -d -p /tmp -t x.XXXX)",
  "R=$(mktemp -dp /tmp)",
  "R=$(mktemp -p /tmp -d)",
  "R=$(mktemp --directory -p /tmp)",
  "R=$(mktemp -d --tmpdir=/tmp x.XXXX)",
  "R=$(mktemp -d /tmp/x.XXXXXX)",
];

const BODIES = [
  "mkdir -p $R/home $R/data && echo hi > $R/data/x.txt && rm -rf $R",
  'cp notes.txt "$R/"; ls "$R"',
  'cd "$R" && git init -q',
  'cd "$R" && git init -q && echo x > f && git add f && git -c user.email=a@b -c user.name=a commit -qm x',
  'git -C "$R" init -q',
  "rm -rf $R",
  'rm -rf -- "$R"',
  'rm -rf "$R"/data',
  'echo hi > "${R}/x.txt"; cat "${R}"/x.txt',
  'printf "%s\\n" a b > "$R/list"; wc -l < "$R/list"',
  'trap \'rm -rf "$R"\' EXIT; echo hi > "$R/x"',
  'cp -r packages "$R/"; ls -la "$R/packages"',
  'mkdir -p "$R/a/b"; touch "$R/a/b/c"; find "$R" -type f; rm -rf "$R"',
  'cd "$R"; mkdir sub; cd sub; echo x > y; cd /; rm -rf "$R"',
  'tar -cf "$R/x.tar" notes.txt && tar -xf "$R/x.tar" -C "$R"',
  'ln -s "$R/a" "$R/b"; ls "$R"',
  'mv "$R/a" "$R/b" 2>/dev/null; echo done',
  'git diff > "$R/patch.diff"',
];

describe("paths under a fresh mktemp dir under /tmp", () => {
  test.each(MKTEMPS)("write, copy, list and remove are allowed: %s", (head) => {
    for (const sep of [" && ", "; ", "\n"]) {
      for (const body of BODIES) {
        const command = `${head}${sep}${body}`;
        for (const tmpdir of [OWN_SCRATCH, undefined]) expect(verdict(command, tmpdir)).toEqual({ command, action: "allow", category: null, reason: "" });
      }
    }
  });

  test.each([
    'R=$(mktemp -d -p /tmp); S=$R/sub; mkdir -p "$S"; echo x > "$S/y"',
    'R=$(mktemp -d -p /tmp)/sub; mkdir -p "$R"; echo x > "$R/y"',
    'R=$(mktemp -d -p /tmp) S="$R/sub"; mkdir -p "$S"',
    'declare R=$(mktemp -d -p /tmp); echo x > "$R/y"',
    'readonly R=$(mktemp -d -p /tmp); echo x > "$R/y"',
    'local R=$(mktemp -d -p /tmp); echo x > "$R/y"',
    '{ R=$(mktemp -d -p /tmp); }; echo x > "$R/y"',
    'R=$(mktemp -d -p /tmp); (cd "$R" && echo x > y)',
    'R=$(mktemp -d -p /tmp); pushd "$R" >/dev/null; echo x > y; popd >/dev/null',
    'R=$(mktemp -d -p /tmp); for f in a b c; do echo "$f" > "$R/$f"; done; ls "$R"',
    "R=$(mktemp -d -p /tmp); cat > \"$R/x\" <<'EOF'\nhello\nEOF\ncat \"$R/x\"",
    'R=$(mktemp -d -p /tmp); export R; sh -c \'echo x > "$R/y"\'',
    'R=$(mktemp -d -p /tmp); bash -c "echo x > $R/y"',
    'R=$(mktemp -d -p /tmp); echo "$R"; ls -la "$R"; du -sh "$R"',
    'R=$(mktemp -d -p /tmp); git worktree list > "$R/wt.txt"',
    'R=$(mktemp -d -p /tmp); git clone -q . "$R/clone"',
    'R=$(mktemp -d -p /tmp); cp -a . "$R/copy"',
    'R=$(mktemp -d -p /tmp); rsync -a ./ "$R/copy/"',
    'R=$(mktemp -d -p /tmp); unzip -q x.zip -d "$R"',
    'R=$(mktemp -d -p /tmp); cd "$R" || exit 1; git init -q; git status',
    'R=$(mktemp -d -p /tmp); echo hi | tee "$R/x" >/dev/null',
    'R=$(mktemp -d -p /tmp); sort notes.txt -o "$R/sorted"',
    'R=$(mktemp -d -p /tmp); bun test packages/collector/src/floor-r8-x/ > "$R/log" 2>&1; tail -5 "$R/log"',
    'R=$(mktemp -d -p /tmp); HOME=$R/home git config --global user.name x',
    'R=$(mktemp -d -p /tmp); env HOME="$R" git config --global user.name x',
  ])("more shapes are allowed: %s", (command) => {
    for (const tmpdir of [OWN_SCRATCH, undefined]) expect(verdict(command, tmpdir)).toEqual({ command, action: "allow", category: null, reason: "" });
  });

  // After a step that may set variables the floor can't see (shell setup a tool prints, `printf -v` of a name it can't read),
  // TMPDIR is unknown; a -p dir without -t is the dir mktemp uses whatever TMPDIR holds.
  test.each(["R=$(mktemp -d -p /tmp floor-x-XXXXXX)", "R=$(mktemp -dp /tmp)", "R=$(mktemp -p /tmp -d)", "R=$(mktemp --directory -p /tmp)", "R=$(mktemp -d --tmpdir=/tmp x.XXXX)", "R=$(mktemp -d /tmp/x.XXXXXX)"])(
    "allowed after variables blur: %s",
    (head) => {
      for (const pre of ['eval "$(mise activate bash)"', 'eval "$(direnv export bash)"', 'printf -v "$n" x']) {
        for (const body of ["mkdir -p $R/home $R/data && echo hi > $R/data/x.txt && rm -rf $R", 'cp notes.txt "$R/"; ls "$R"', ISOLATED_RUN]) {
          const command = `${pre}; ${head} && ${body}`;
          expect(verdict(command)).toEqual({ command, action: "allow", category: null, reason: "" });
        }
      }
    },
  );

  test.each(MKTEMPS)("the isolated test run is allowed: %s", (head) => {
    for (const sep of [" && ", "; ", "\n"]) {
      const command = `${head}${sep}${ISOLATED_RUN}`;
      expect(verdict(command)).toEqual({ command, action: "allow", category: null, reason: "" });
    }
  });
});

describe("a mktemp dir the floor can't pin, or a path that leaves it, stays held", () => {
  const BODY = "mkdir -p $R/home $R/data && echo hi > $R/data/x.txt && rm -rf $R";
  test.each([
    'R=$(mktemp -d -p "$X")',
    "R=$(mktemp -d -p ~/.local/share/standup)",
    `R=$(mktemp -d -p ${DATA})`,
    "R=$(mktemp -d -p /tmp/../fake/home)",
    "R=$(mktemp -d --tmpdir=$HOME)",
    "R=$(TMPDIR=/fake/home mktemp -d)",
    "R=$(TMPDIR=/fake/home/.local/share/standup mktemp -d)",
    "export TMPDIR=/fake/home; R=$(mktemp -d)",
    // Reassigned afterwards to something the floor can't read, or the live data dir.
    "R=$(mktemp -d -p /tmp); R=$(cat /tmp/where)",
    `R=$(mktemp -d -p /tmp); R=${DATA}`,
    // The mktemp may not have run.
    "R=$(mktemp -d -p /tmp) || R=~",
    "false && R=$(mktemp -d -p /tmp)",
    "if false; then R=$(mktemp -d -p /tmp); fi",
  ])("held: %s", (head) => {
    for (const sep of ["; ", "\n"]) {
      const command = `${head}${sep}${BODY}`;
      expect(verdict(command).action).toBe("hold");
    }
  });

  // With TMPDIR unknown, a dir mktemp takes from it (`-t`, no -p, an empty -p) is unknown too.
  test.each(["R=$(mktemp -d)", "R=$(mktemp -d -t x.XXXX)", "R=$(mktemp -d -p /tmp -t x.XXXX)", 'R=$(mktemp -d -p "")', "R=$(mktemp -d --tmpdir x.XXXX)", 'R=$(mktemp -d -p "$TMPDIR")'])(
    "held after variables blur: %s",
    (head) => {
      for (const pre of ['eval "$(mise activate bash)"', 'printf -v "$n" x']) {
        const command = `${pre}; ${head} && rm -rf $R/data && echo hi > $R/x`;
        expect(verdict(command, undefined).action).toBe("hold");
      }
    },
  );

  test.each([
    "R=$(mktemp -d -p /tmp); rm -rf $R/..",
    'R=$(mktemp -d -p /tmp); rm -rf "$R/../.."',
    `R=$(mktemp -d -p /tmp); rm -rf $R/../..${HOME}`,
    "R=$(mktemp -d -p /tmp); rm -rf $R/../../fake/home/.local/share/standup",
    // Used before it is set: an empty $R puts the path at the root of the disk.
    "rm -rf $R/fake/home; R=$(mktemp -d -p /tmp)",
    "echo hi > $R/fake/home/.bashrc; R=$(mktemp -d -p /tmp)",
  ])("held: %s", (command) => {
    expect(verdict(command).action).toBe("hold");
  });

  test("held: the live data dir under a fresh dir's name", () => {
    expect(verdict(`R=$(mktemp -d -p /tmp); cp -r ${DATA} "$R/"`).action).toBe("hold");
    expect(verdict(`R=$(mktemp -d -p /tmp); cat ${join(DATA, "secrets", "token")} > $R/x`).action).toBe("hold");
  });
});
