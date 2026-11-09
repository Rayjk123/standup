import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * HOME set to another dir is allowed, a fresh dir under the temp dir, a
 * computed value and a temp home already holding configuration included:
 * the floor holds only what the call's own text names on its denylist. HOME
 * set to Standup's data dir or the install, a DB_PATH at Standup's live
 * database, and steps that write the real home's startup files, ~/.claude or
 * Standup's data still hold, as do mutating AWS calls whatever HOME is.
 * DB_PATH (standup.db included) and STANDUP_DATA_DIR under the temp dir are
 * the run's own scratch. The outputs
 * programs write where an option or operand says (git's work tree and output
 * files, cpio, uniq, xxd, base64, script, bun test's reporter and coverage,
 * curl's %output, sqlite3's dot commands) are checked as writes of those
 * paths. The machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
/** A temp path that is a symlink to the real home. */
const LINKED = join("/", "tmp", "linked-home");
/** A temp path that is a symlink to Standup's data dir. */
const LINKED_DATA = join("/", "tmp", "linked-data");
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
  // Every `bun test` preloads a guard that writes a stub into a temp dir, as the repository's does.
  [join(ROOT, "bunfig.toml")]: '[test]\npreload = ["./test-guard.ts"]\n',
  [join(ROOT, "test-guard.ts")]:
    'import { chmodSync, mkdtempSync, writeFileSync } from "fs";\nimport { tmpdir } from "os";\nimport { join } from "path";\nconst dir = mkdtempSync(join(tmpdir(), "guard-"));\nwriteFileSync(join(dir, "systemctl"), "#!/bin/sh\\nexit 1\\n");\nchmodSync(join(dir, "systemctl"), 0o755);\n',
  [join(ROOT, "x.test.ts")]: SAFE_TEST,
  [join(ROOT, "packages", "collector", "src", "floor", "foo.test.ts")]: SAFE_TEST,
  [join(DATA, "standup.db")]: "",
  [join(HOME, ".aws", "credentials")]: "[default]\n",
  [join(HOME, ".claude", "settings.json")]: "{}",
  // Temp homes already holding configuration tools read from HOME.
  [join("/", "tmp", "dirty", ".gitconfig")]: "[core]\n\thooksPath = /tmp/evil\n",
  [join("/", "tmp", "dirty-bun", ".bunfig.toml")]: 'preload = ["/tmp/evil.ts"]\n',
  [join("/", "tmp", "dirty-xdg", ".config", "git", "config")]: "[core]\n\tfsmonitor = /tmp/evil.sh\n",
  // Temp homes holding code tools load from entries that aren't dot entries, Bun's cache, or just a file.
  [join("/", "tmp", "hb", "pkg-cache", "packages", "Evil", "lib", "x.jar")]: "",
  [join("/", "tmp", "rhome", "R", "library", "evil", "R", "evil")]: "",
  [join("/", "tmp", "nm", "node_modules", "evil", "index.js")]: "",
  [join("/", "tmp", "p5", "perl5", "lib", "perl5", "Evil.pm")]: "",
  [join("/", "tmp", "bunc", ".bun", "install", "cache", "evil@1.0.0", "index.js")]: "",
  [join("/", "tmp", "plain", "notes.txt")]: "",
  // Configuration ready to copy into a temp home.
  [join("/", "tmp", "kit", ".gitconfig")]: "[core]\n\thooksPath = /tmp/evil\n",
  // Scripts that write into a temp home.
  [join("/", "tmp", "script.sed")]: "w /tmp/h/.gitconfig\n",
  [join("/", "tmp", "w.awk")]: 'BEGIN { print "[core]" > "/tmp/h/.gitconfig" }\n',
};
/** A temp path that is a symlink to the temp home /tmp/h. */
const LINKED_SCRATCH = join("/", "tmp", "lh");

function probes(): Partial<FloorProbes> {
  // /tmp/r5-home: a temp home an earlier run made and left empty.
  const dirs = new Set<string>(["/", "/tmp", ROOT, join("/", "tmp", "x"), join("/", "tmp", "h"), join("/", "tmp", "r5-home")]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const links: Record<string, string> = { [LINKED]: HOME, [LINKED_DATA]: DATA, [DANGLING]: join(HOME, "nowhere"), [LINKED_SCRATCH]: join("/", "tmp", "h") };
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

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category?: string): void {
  if (category) expect(v).toMatchObject({ action: "hold", category });
  else expect(v.action).toBe("hold");
}

/** Held, for whatever reason. */
function expectCommandHeld(command: string): void {
  expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
}

/** Allowed, reported with the command. */
function expectCommandAllowed(command: string, cwd?: string): void {
  expect({ command, v: bash(command, cwd) }).toEqual({ command, v: { action: "allow" } });
}

describe("9. HOME set to a dir under the temp dir", () => {
  // A temp HOME is allowed: the call's text names nothing the floor holds.
  const tempHomes = [
    "HOME=/tmp/x bun test packages/collector/src/floor/foo.test.ts",
    "env HOME=/tmp/h STANDUP_DATA_DIR=/tmp/h/data bun run typecheck",
    "export HOME=/tmp/h; bun test x.test.ts",
    "D=/tmp/x; HOME=$D mkdir $D/a",
    "HOME=/tmp/new-home bun test x.test.ts",
    "HOME=/tmp/x/ bun test x.test.ts",
    "HOME=/tmp/h bun test x.test.ts > /tmp/h/out.log 2>&1",
    "mkdir -p /tmp/new-home/.config && HOME=/tmp/new-home bun test x.test.ts",
    "mkdir -p /tmp/x/a && touch /tmp/x/a/b && HOME=/tmp/x bun test x.test.ts",
    "HOME=$(mktemp -d) bun test x.test.ts",
    "export HOME=`mktemp -d`; bun test x.test.ts",
    "HOME=$(mktemp -d) bun test x.test.ts > /tmp/log 2>&1",
    "HOME=$(mktemp -d) timeout 600 bun test x.test.ts",
    "HOME=/tmp/x bun test packages/collector/src/floor/foo.test.ts > /tmp/log 2>&1",
    "env HOME=/tmp/h STANDUP_DATA_DIR=/tmp/h/data bun run typecheck > /tmp/log 2>&1",
    "export HOME=/tmp/h; bun test x.test.ts > /tmp/log 2>&1",
    "HOME=/tmp/x timeout 600 bun test packages/collector/src/floor/foo.test.ts > /tmp/log 2>&1",
    "env HOME=/tmp/h STANDUP_DATA_DIR=/tmp/h/data timeout 600 bun run typecheck",
    "export HOME=/tmp/h; timeout 600 bun test x.test.ts > /tmp/log 2>&1",
    "export HOME=/tmp/h; git status; git diff; git log -1; cat x.test.ts; ls; grep adds x.test.ts; echo done",
    "HOME=/tmp/h git -C /tmp status",
    "HOME=/tmp/h git --no-pager diff",
    "HOME=/tmp/x bun test --coverage x.test.ts",
    `python3 -c "print(1)"; HOME=/tmp/h git status`,
    "curl -sS https://example.com/x | head -1; HOME=/tmp/h git status",
    "wget -qO- https://example.com/x | head -1; HOME=/tmp/h git status",
  ];
  test.each(tempHomes)("allows %p, which sets HOME", (command) => {
    expectCommandAllowed(command);
  });

  // A DB_PATH naming standup.db under the temp dir is the run's own scratch: the bare name is no denylist target.
  const tempHomesNamingDb = [
    "HOME=/tmp/r5-home DB_PATH=/tmp/r5-home/standup.db bun test",
    "HOME=/tmp/r5-missing DB_PATH=/tmp/r5-missing/standup.db bun test",
    "HOME=/tmp/r5-home DB_PATH=/tmp/r5-home/standup.db bun test > /tmp/log 2>&1",
    "HOME=/tmp/r5-home DB_PATH=/tmp/r5-home/standup.db timeout 600 bun test",
  ];
  test.each(tempHomesNamingDb)("allows %p, which sets HOME and names a scratch standup.db", (command) => {
    expectCommandAllowed(command);
  });

  // A DB_PATH at Standup's live database names the data dir.
  const tempHomesNamingLiveDb = [
    `HOME=/tmp/r5-home DB_PATH=${join(DATA, "standup.db")} bun test`,
    `HOME=/tmp/r5-home DB_PATH=${join(DATA, "standup.db")} timeout 600 bun test > /tmp/log 2>&1`,
  ];
  test.each(tempHomesNamingLiveDb)("holds %p, which sets HOME and names the live standup.db", (command) => {
    expectCommandHeld(command);
  });

  test.each(["STANDUP_DATA_DIR=/tmp/h/data bun test x.test.ts", "DB_PATH=/tmp/h/standup.db bun test x.test.ts"])("allows %p, Standup's data kept under the temp dir", (command) => {
    expectAllowed(bash(command));
  });

  test("the real home, by any spelling, is allowed", () => {
    expectAllowed(bash(`HOME=${HOME} bun test x.test.ts`));
    expectAllowed(bash(`HOME=${LINKED} bun test x.test.ts`));
  });

  const allowedHomes = [
    // Other real homes, and dirs under the real one.
    "/home/x",
    "/root",
    join(HOME, "sub"),
    join(LINKED, "sub"),
    // The temp dir itself, and paths that climb out of it or are relative.
    "/tmp",
    "/tmp/../fake/home/x",
    "/tmp/x/../h",
    "tmp/x",
    // Temp homes already holding configuration tools read, code they load, or anything at all.
    "/tmp/dirty",
    "/tmp/dirty-bun",
    "/tmp/dirty-xdg",
    "/tmp/hb",
    "/tmp/rhome",
    "/tmp/nm",
    "/tmp/p5",
    "/tmp/bunc",
    "/tmp/plain",
    // A link that leads nowhere yet.
    DANGLING,
  ];
  test.each(allowedHomes)("allows HOME=%p", (home) => {
    expectCommandAllowed(`HOME=${home} bun test x.test.ts`, "/tmp");
    expectCommandAllowed(`export HOME=${home}; bun test x.test.ts`, "/tmp");
  });

  // Standup's data dir, its link, and the install.
  test.each([DATA, LINKED_DATA, INSTALL])("holds HOME=%p", (home) => {
    expectHeld(bash(`HOME=${home} bun test x.test.ts`, "/tmp"), "unclassified");
    expectHeld(bash(`export HOME=${home}; bun test x.test.ts`, "/tmp"), "unclassified");
  });

  test("a HOME the floor can't read is allowed", () => {
    for (const command of ["HOME=$X bun test x.test.ts", "HOME=$(cat /tmp/p) bun test x.test.ts", "export HOME=`cat /tmp/p`; bun test x.test.ts", 'env HOME="$X" bun test x.test.ts', `HOME=$(mktemp -d -p ${HOME}) bun test x.test.ts`]) {
      expectCommandAllowed(command);
    }
  });

  test("a temp home holding anything is allowed", () => {
    for (const command of [
      "HOME=/tmp/hb pkg-build test",
      "HOME=/tmp/rhome Rscript -e 'library(evil)'",
      "HOME=/tmp/nm bun test x.test.ts",
      "HOME=/tmp/p5 bun test x.test.ts",
      "HOME=/tmp/bunc bun test x.test.ts",
      "HOME=/tmp/plain bun test x.test.ts",
    ]) expectCommandAllowed(command);
  });

  test("a HOME the floor can't read, followed by a push, holds", () => {
    expectHeld(bash("HOME=$X bun test x.test.ts; git push origin main"));
    expectHeld(bash("HOME=/tmp/hb pkg-build test && git push origin main"));
  });

  const plants = [
    "printf '[core]\\n\\thooksPath = /tmp/evil\\n' > /tmp/h/.gitconfig; HOME=/tmp/h git status",
    "cp -r /tmp/evil/. /tmp/h && HOME=/tmp/h git status",
    "cp /tmp/evil.cfg /tmp/h/.gitconfig && HOME=/tmp/h git status",
    "mv /tmp/evil /tmp/new-home && HOME=/tmp/new-home git status",
    "tar -xf /tmp/e.tar -C /tmp/h && HOME=/tmp/h git status",
    "ln -s /tmp/evil.cfg /tmp/h/.gitconfig; HOME=/tmp/h git status",
    "HOME=/tmp/h git status; cp /tmp/evil.cfg /tmp/h/.npmrc",
    "mkdir -p /tmp/h/.config/git && cp /tmp/evil.cfg /tmp/h/.config/git/config && HOME=/tmp/h git status",
    "HOME=/tmp/h bash -c 'cp -r /tmp/evil/. \"$HOME\"; git status'",
    "cp -rT /tmp/evil /tmp/h && HOME=/tmp/h git status",
    "cp -r /tmp/evil /tmp/h && HOME=/tmp/h git status",
    "rsync -a /tmp/evil/ /tmp/h/ && HOME=/tmp/h git status",
    "git clone /tmp/evil-repo /tmp/new-home && HOME=/tmp/new-home git status",
    "HOME=/tmp/h git status; unzip -o /tmp/e.zip -d /tmp/h",
  ];
  test.each(plants)("allows %p, which writes into the temp home's configuration", (command) => {
    expectCommandAllowed(command);
  });

  const heldPlants = [
    "export HOME=/tmp/h; echo 'preload = [\"/tmp/evil.ts\"]' > ~/.bunfig.toml; bun test x.test.ts",
    "export HOME=/tmp/h; echo 'preload = [\"/tmp/evil.ts\"]' > $HOME/.bunfig.toml; bun test x.test.ts",
    "tar -xf /tmp/e.tar -C /tmp && HOME=/tmp/h git status",
    "export HOME=/tmp/h; cp /tmp/evil.cfg /tmp/h/.* ; git status",
  ];
  test.each(heldPlants)("holds %p, which names a home startup file or writes where the floor can't bound", (command) => {
    expectHeld(bash(command));
  });

  // The same steps without HOME set write only scratch files.
  const literalPlants = plants.filter((p) => !/~|\$HOME|-C \/tmp &&|\.\*/.test(p));
  test.each(literalPlants.map((p) => p.replace(/(?:export )?HOME=\/tmp\/[\w-]+;? ?/, "")))("without HOME set, %p is allowed", (command) => {
    expectAllowed(bash(command));
  });

  test("~ and a bare cd name the real home's files, which hold", () => {
    for (const command of [
      "HOME=/tmp/x; rm -rf ~/.cache",
      "HOME=/tmp/x; cd; rm -rf .cache",
      "HOME=/tmp/h; sqlite3 ~/.local/share/standup/standup.db .tables",
      "HOME=/tmp/x rm -rf ~/.cache",
      "HOME=/tmp/h sqlite3 ~/.local/share/standup/standup.db .tables",
      "export HOME=$X; rm -rf ~/.cache",
      "HOME=/tmp/x; unset HOME; rm -rf ~/.cache",
      "false && HOME=/tmp/x; rm -rf ~/.ssh",
      "false && export HOME=/tmp/x; rm -rf $HOME/.ssh",
      'if [ -n "$X" ]; then HOME=/tmp/x; fi; rm -rf ~/.ssh',
      'if [ -n "$X" ]; then export HOME=/tmp/x; fi; cd; rm -rf .ssh',
      "(HOME=/tmp/x); rm -rf ~/.ssh",
      "HOME=/tmp/x bash -c true; rm -rf ~/.ssh",
      "for HOME in /tmp/x /fake/home; do :; done; rm -rf ~/.ssh",
      "HOME=/tmp/dirty; rm -rf ~/.gitconfig",
      "HOME=/fake/home/sub; cd; rm -rf .cache",
    ]) expectCommandHeld(command);
    expectHeld(bash("rm -rf ~/.cache"));
    expectHeld(bash("rm -rf ~/.claude"), "floor-tamper");
    expectHeld(bash("HOME=/tmp/x rm -rf ~/.claude"), "floor-tamper");
    expect(bash("sqlite3 ~/.local/share/standup/standup.db .tables").action).toBe("hold");
  });

  test("$HOME after a temp HOME assignment, and ~ only read, are allowed", () => {
    for (const command of ["export HOME=/tmp/x; rm -rf $HOME/.cache", "HOME=/tmp/x; touch --reference=~/.cache /tmp/x/stamp"]) expectCommandAllowed(command);
  });

  test("a bare cd with HOME given by a prefix holds", () => {
    for (const command of [
      "export HOME=/tmp/x; HOME=/fake/home cd; rm -rf .cache",
      "export HOME=/tmp/x; HOME=/fake/home cd; rm -rf .ssh",
      "export HOME=/tmp/x; HOME=/fake/home cd; rm -f .gitconfig",
      "export HOME=/tmp/x; HOME=/fake/home cd --; rm -rf .cache",
      "export HOME=/tmp/x; HOME=/fake/home cd -L; rm -rf .cache",
      "export HOME=/tmp/x; HOME=$X cd; rm -rf .cache",
      "export HOME=/tmp/h; HOME=/tmp/x cd; rm -rf .cache",
    ]) expectCommandHeld(command);
  });

  test("an AWS call with HOME set is judged as it is without HOME", () => {
    for (const home of ["/tmp/x", "/tmp/h", HOME]) {
      for (const call of ["aws s3 ls", "aws sts get-caller-identity", "aws s3 rm s3://bucket/key", "aws s3 cp x.test.ts s3://bucket/key"]) {
        const plain = bash(call);
        expect({ home, call, v: bash(`HOME=${home} ${call}`).action }).toEqual({ home, call, v: plain.action });
      }
    }
    expectHeld(bash("HOME=/tmp/x aws s3 rm s3://bucket/key"), "aws");
  });
});

describe("9. writes into a temp HOME are allowed unless the call names a held target", () => {
  const allowed = [
    // Code writing where the floor can't name.
    `python3 -c "open('/tmp/h/.gitconfig','w').write('[core]\\n\\thooksPath = /tmp/evil\\n')"; HOME=/tmp/h git status`,
    `python3 -c "import shutil; shutil.copytree('/tmp/evil','/tmp/h',dirs_exist_ok=True)"; HOME=/tmp/h git status`,
    `python3 -c "import subprocess; subprocess.run(['cp','/tmp/evil.cfg','/tmp/h/.gitconfig'])"; HOME=/tmp/h git status`,
    `bun -e "require('fs').writeFileSync('/tmp/h/.gitconfig', '[core]')"; HOME=/tmp/h git status`,
    `node -e "require('fs').copyFileSync('/tmp/evil.cfg', '/tmp/h/.gitconfig')"; HOME=/tmp/h git status`,
    `HOME=/tmp/h bash -c "node -e \\"require('fs').writeFileSync(process.env.HOME + '/.gitconfig', 'x')\\"; git status"`,
    // Downloads.
    "curl -sSo /tmp/h/.gitconfig https://example.com/x; HOME=/tmp/h git status",
    "curl -sSLo /tmp/h/.gitconfig https://example.com/x; HOME=/tmp/h git status",
    "curl -O --output-dir /tmp/h https://example.com/.gitconfig; HOME=/tmp/h git status",
    "curl -sSLO https://example.com/.gitconfig; HOME=/tmp/h git status",
    "wget -q -P /tmp/h https://example.com/.gitconfig; HOME=/tmp/h git status",
    "wget -q --directory-prefix=/tmp/h https://example.com/.gitconfig; HOME=/tmp/h git status",
    "cd /tmp/h && wget -q https://example.com/.gitconfig && HOME=/tmp/h git status",
    "HOME=/tmp/h git status; curl -K /tmp/cfg https://example.com/x",
    // Programs the floor has no rule for.
    "zstd -d /tmp/e.zst -o /tmp/h/.gitconfig; HOME=/tmp/h git status",
    "some-tool --out=/tmp/h/.gitconfig; HOME=/tmp/h git status",
    "some-tool -o/tmp/h/.gitconfig; HOME=/tmp/h git status",
    "cd /tmp/h && some-tool fetch; HOME=/tmp/h git status",
    "some-tool $X; HOME=/tmp/h git status",
    "HOME=/tmp/h some-tool init; HOME=/tmp/h git status",
    "export HOME=/tmp/h; some-tool init; git status",
    "some-tool --version; HOME=/tmp/h git status",
    "HOME=/tmp/h some-tool --version",
    // Entries tools load code from.
    "cp -r /tmp/evil /tmp/h/node_modules && HOME=/tmp/h bun test x.test.ts",
    "cp -r /tmp/evil /tmp/h/R && HOME=/tmp/h Rscript -e 'library(evil)'",
    "cp -r /tmp/evil /tmp/h/perl5 && HOME=/tmp/h bun test x.test.ts",
    "cp -r /tmp/evil /tmp/h/pkg-cache && HOME=/tmp/h pkg-build test",
    // Other writers.
    "sed -n 'w /tmp/h/.gitconfig' /tmp/evil.cfg; HOME=/tmp/h git status",
    `awk 'BEGIN { print "[core]" > "/tmp/h/.gitconfig" }'; HOME=/tmp/h git status`,
    `perl -e 'open(my $f, ">", "/tmp/h/.gitconfig"); print $f "x"'; HOME=/tmp/h git status`,
    "echo /tmp/h/.gitconfig | xargs -I{} cp /tmp/evil.cfg {}; HOME=/tmp/h git status",
    "find /tmp/kit -name .gitconfig -exec cp {} /tmp/h/ \\;; HOME=/tmp/h git status",
    `perl -e 'open(F, ">/tmp/h/.gitconfig"); print F "x"'; HOME=/tmp/h git status`,
    "export HOME=/tmp/h; git config --global core.hooksPath /tmp/evil; git status",
    "git config --file /tmp/h/.gitconfig core.hooksPath /tmp/evil; HOME=/tmp/h git status",
    "cat > /tmp/h/.gitconfig <<'EOF'\n[core]\n\thooksPath = /tmp/evil\nEOF\nHOME=/tmp/h git status",
    "export HOME=/tmp/h; pip install --user /tmp/evilpkg; python3 -c 'print(1)'",
    "D=$(mktemp -d); cp /tmp/kit/.gitconfig $D; HOME=$D git status",
    // Links made by something other than ln, then written through.
    "tar -xf /tmp/l.tar -C /tmp/stage && cp /tmp/kit/.gitconfig /tmp/stage/l/ && HOME=/tmp/h git status",
    "git clone /tmp/evil-repo /tmp/stage && cp /tmp/kit/.gitconfig /tmp/stage/l/.gitconfig && HOME=/tmp/h git status",
    "ln -s /tmp/h /tmp/lnk; cp /tmp/kit/.gitconfig /tmp/lnk/; HOME=/tmp/h git status",
    "ln -s /tmp/h /tmp/lnk; cp /tmp/kit/.gitconfig /tmp/lnk/.gitconfig; HOME=/tmp/h git status",
    "ln -s /tmp/h/.gitconfig /tmp/out; cp /tmp/kit/.gitconfig /tmp/out; HOME=/tmp/h git status",
    "ln -s /tmp/h/.gitconfig /tmp/out; echo '[core]' > /tmp/out; HOME=/tmp/h git status",
    "python3 -m zipfile -e /tmp/l.zip /tmp/stage; cp /tmp/kit/.gitconfig /tmp/stage/l/; HOME=/tmp/h git status",
    "unzip /tmp/l.zip -d /tmp/stage; cp /tmp/kit/.gitconfig /tmp/stage/l/; HOME=/tmp/h git status",
    "cp -a /tmp/lh /tmp/stage; cp /tmp/kit/.gitconfig /tmp/stage/; HOME=/tmp/h git status",
    "cp -P /tmp/lh /tmp/stage; cp /tmp/kit/.gitconfig /tmp/stage/; HOME=/tmp/h git status",
    "mv /tmp/lh /tmp/stage; cp /tmp/kit/.gitconfig /tmp/stage/; HOME=/tmp/h git status",
    "rsync -a /tmp/lh /tmp/stage; cp /tmp/kit/.gitconfig /tmp/stage/; HOME=/tmp/h git status",
    "cp /tmp/kit/.gitconfig /tmp/lh/; HOME=/tmp/h git status",
    "ln -s /tmp/h /tmp/lnk; cp /tmp/kit/.gitconfig /tmp/lnk; HOME=/tmp/h git status",
    "ln -s /tmp/h /tmp/lnk; tar -xf /tmp/e.tar -C /tmp/lnk; HOME=/tmp/h git status",
    "ln -s /tmp/h /tmp/lnk; cd /tmp/lnk && cp /tmp/kit/.gitconfig .; HOME=/tmp/h git status",
    "ln -sfn /tmp/h /tmp/lnk && cp -r /tmp/kit/. /tmp/lnk/ && HOME=/tmp/h git status",
    "git checkout HEAD -- lnk && cp /tmp/kit/.gitconfig lnk/ && HOME=/tmp/h git status",
    // The temp home named by ~+, ~- or $PWD.
    "cd /tmp/h && cp /tmp/kit/.gitconfig ~+/ && HOME=/tmp/h git status",
    "cd /tmp/h; cd /tmp; cp /tmp/kit/.gitconfig ~-/; HOME=/tmp/h git status",
    "cd /tmp/h && echo '[core]' > ~+/.gitconfig; HOME=/tmp/h git status",
    "cd /tmp/h && cp /tmp/kit/.gitconfig $PWD/ && HOME=/tmp/h git status",
    // Writers whose destination the floor may not record.
    // An ordinary archive extracted into a temp dir: its names stay below the dir.
    "tar -xf /tmp/e.tar -C /tmp/x; HOME=/tmp/h git status",
    "tar -xf /tmp/e.tar -C $TMPDIR/x; HOME=/tmp/h git status",
    "cd /tmp/h && patch -p1 < /tmp/evil.patch; HOME=/tmp/h git status",
    "patch -d /tmp/h -p1 < /tmp/evil.patch; HOME=/tmp/h git status",
    "patch -o /tmp/h/.gitconfig /dev/null < /tmp/evil.patch; HOME=/tmp/h git status",
    "dd if=/tmp/evil.cfg of=/tmp/h/.gitconfig; HOME=/tmp/h git status",
    "sort -o /tmp/h/.gitconfig /tmp/evil.cfg; HOME=/tmp/h git status",
    "shuf -o /tmp/h/.gitconfig -n 100 /tmp/evil.cfg; HOME=/tmp/h git status",
    "iconv -f utf8 -t utf8 -o /tmp/h/.gitconfig /tmp/evil.cfg; HOME=/tmp/h git status",
    "openssl enc -d -base64 -in /tmp/e.b64 -out /tmp/h/.gitconfig; HOME=/tmp/h git status",
    "gpg -o /tmp/h/.gitconfig -d /tmp/e.gpg; HOME=/tmp/h git status",
    "wget -O /tmp/h/.gitconfig https://example.com/x; HOME=/tmp/h git status",
    `sqlite3 /tmp/x.db ".cd /tmp/h" ".once .gitconfig" "select 1"; HOME=/tmp/h git status`,
    "bun build x.test.ts --outfile=/tmp/h/.gitconfig; HOME=/tmp/h git status",
    "bun build x.test.ts --outdir /tmp/h/.node_modules; HOME=/tmp/h git status",
    "printf 'a\\n[core]\\n.\\nw /tmp/h/.gitconfig\\nq\\n' | ed -s; HOME=/tmp/h git status",
    "sed -e 's/x/y/w /tmp/h/.gitconfig' /tmp/evil.cfg; HOME=/tmp/h git status",
    "sed -f /tmp/script.sed /tmp/evil.cfg; HOME=/tmp/h git status",
    "awk -f /tmp/w.awk; HOME=/tmp/h git status",
    "find /tmp/kit -maxdepth 0 -fprintf /tmp/h/.gitconfig '[core]\\n\\thooksPath = /tmp/evil\\n'; HOME=/tmp/h git status",
    "find /tmp/kit -fprint /tmp/h/.gitconfig; HOME=/tmp/h git status",
    "scp /tmp/kit/.gitconfig /tmp/h/; HOME=/tmp/h git status",
    "exec 3> /tmp/h/.gitconfig; echo '[core]' >&3; HOME=/tmp/h git status",
    // Git steps that write a work tree, by options, the environment or config.
    "git apply --unsafe-paths --directory=/tmp/h /tmp/evil.patch; HOME=/tmp/h git status",
    "git apply --unsafe-paths /tmp/evil.patch; HOME=/tmp/h git status",
    "cd /tmp/h && git --git-dir=/tmp/evil-repo/.git checkout HEAD -- .; HOME=/tmp/h git status",
    "GIT_DIR=/tmp/evil-repo/.git git -C /tmp/h checkout -f HEAD -- .; HOME=/tmp/h git status",
    "git -c core.worktree=/tmp/h checkout HEAD -- .; HOME=/tmp/h git status",
    "git -c core.worktree=/tmp/h checkout HEAD -- .gitconfig; HOME=/tmp/h git status",
    "W=/tmp/h git --config-env=core.worktree=W checkout HEAD -- .gitconfig; HOME=/tmp/h git status",
    "git checkout-index -a --pref=/tmp/h/; HOME=/tmp/h git status",
    `git --git-dir=${ROOT}/.git --work-tree=h -C /tmp checkout HEAD -- .gitconfig; HOME=/tmp/h git status`,
    "git worktree add /tmp/new-home; HOME=/tmp/new-home git status",
    "git init /tmp/h && git -C /tmp/h pull /tmp/evil-repo; HOME=/tmp/h git status",
    "git -C /tmp/h clone /tmp/evil-repo .; HOME=/tmp/h git status",
    "cd /tmp/h && git clone /tmp/evil-repo .; HOME=/tmp/h git status",
    "git clone /tmp/evil-repo /tmp/h/.config; HOME=/tmp/h git status",
    // Config setters run with the temp home.
    "export HOME=/tmp/h; git config set --global core.hooksPath /tmp/evil; git status",
    "export HOME=/tmp/h; git config --global --add include.path /tmp/evil.cfg; git status",
    "HOME=/tmp/h git config --global core.fsmonitor /tmp/evil.sh; HOME=/tmp/h git status",
    "export HOME=/tmp/h; npm config set script-shell /tmp/evil.sh; npm test",
    "export HOME=/tmp/h; pnpm config set script-shell /tmp/evil.sh; npm test",
    "export HOME=/tmp/h; yarn config set script-shell /tmp/evil.sh; npm test",
    "export HOME=/tmp/h; npx npm config set script-shell /tmp/evil.sh; npm test",
    "export HOME=/tmp/h; bun x npm config set script-shell /tmp/evil.sh; npm test",
    "export HOME=/tmp/h; yarn config set script-shell /tmp/evil.sh; yarn test",
    "export HOME=/tmp/h; pnpm config set script-shell /tmp/evil.sh; pnpm test",
    "export HOME=/tmp/h; python3 -m pip install --user /tmp/evilpkg; git status",
    "export HOME=/tmp/h; crudini --set /tmp/h/.gitconfig core hooksPath /tmp/evil; git status",
    // HOME assignment forms.
    "HOME=/tmp/dirt; HOME+=y; git status",
    "declare -x HOME=/tmp/dirty; git status",
    "typeset -x HOME=/tmp/dirty; git status",
    "readonly HOME=/tmp/dirty; git status",
    "f() { local HOME=/tmp/dirty; git status; }; f",
    "printf -v HOME %s /tmp/dirty; git status",
    "read -r HOME <<< /tmp/dirty; git status",
    "unset HOME; : ${HOME:=/tmp/dirty}; git status",
    "HOME[0]=/tmp/dirty; git status",
    "env HOME=/tmp/h HOME=/tmp/dirty git status",
    "HOME=/tmp/h HOME=/tmp/dirty git status",
    "env -S 'HOME=/tmp/dirty git status'",
    "HOME=/tmp/h; export HOME=/tmp/dirt$(echo y); git status",
    // AWS reads with a temp HOME.
    "export HOME=/tmp/h; aws s3 ls",
    "HOME=/tmp/h; aws s3 ls",
    // Writes alongside a temp HOME.
    "rm -rf /tmp/new-home && mkdir -p /tmp/new-home/.config && HOME=/tmp/new-home bun test x.test.ts",
    "export HOME=/tmp/h; bun test x.test.ts 2>&1 | tee /tmp/h/run.log",
    "cp /tmp/kit/.gitconfig /tmp/stage/x; HOME=/tmp/h git status",
    "HOME=/tmp/h git status; git checkout -b feat",
    "git diff --output=/tmp/d.patch; HOME=/tmp/h git status",
    "uniq /tmp/a.txt /tmp/b.txt; HOME=/tmp/h git status",
    "HOME=/tmp/x bun test x.test.ts --reporter=junit --reporter-outfile=/tmp/junit.xml",
    // A merge into a temp HOME's startup file: git merge-file names no held target.
    "touch /tmp/h/.gitconfig; git merge-file /tmp/h/.gitconfig /dev/null /tmp/evil.cfg; HOME=/tmp/h git status",
  ];
  test.each(allowed)("allows %p", (command) => {
    expectCommandAllowed(command);
  });

  const held = [
    // Archives whose member and link names may be absolute or climb out: they may land anywhere, the real home included.
    "tar -xPf /tmp/e.tar; HOME=/tmp/h git status",
    "tar --absolute-names -xf /tmp/e.tar; HOME=/tmp/h git status",
    "cpio -i < /tmp/e.cpio; HOME=/tmp/h git status",
    "cpio -id < /tmp/e.cpio; HOME=/tmp/h git status",
    "bsdtar -xPf /tmp/e.tar; HOME=/tmp/h git status",
    "unzip -: /tmp/e.zip; HOME=/tmp/h git status",
    // Code and downloads naming the real home's startup files.
    `export HOME=/tmp/h; python3 -c "import os; open(os.path.expanduser('~/.gitconfig'),'w').write('x')"; git status`,
    "HOME=/tmp/h bash -c 'curl -sSo ~/.gitconfig https://example.com/x; git status'",
    // A download tool that sends a write request.
    "aria2c -d /tmp/h https://example.com/.gitconfig; HOME=/tmp/h git status",
    // A write to a path the floor can't resolve.
    `awk -v f=/tmp/h/.gitconfig 'BEGIN { print "[core]" > f }'; HOME=/tmp/h git status`,
    // A merge into a temp HOME followed by a push.
    "touch /tmp/h/.gitconfig; git merge-file /tmp/h/.gitconfig /dev/null /tmp/evil.cfg; HOME=/tmp/h git status; git push origin main",
    // The real home named by a nested HOME.
    "export HOME=/tmp/x; HOME=/fake/home bash -c 'cd; rm -rf .cache'",
    "export HOME=/tmp/x; env HOME=/fake/home bash -c 'rm -rf ~/.cache'",
    // AWS changes with a temp HOME, however they are reached.
    "HOME=/tmp/h sh -c 'aws s3 rm s3://b/k'",
    "HOME=/tmp/h timeout 5 aws s3 rm s3://b/k",
    "HOME=/tmp/h env aws s3 rm s3://b/k",
    "HOME=/tmp/h xargs aws s3 rm s3://b/k < /dev/null",
    "HOME=/tmp/h python3 -m awscli s3 rm s3://b/k",
    "HOME=$(mktemp -d) aws s3 rm s3://b/k",
    "export HOME=/tmp/h; s5cmd rm s3://b/k",
    // Writes through links into the real home's settings.
    `ln -s ${HOME}/.claude /tmp/lnk; cp /tmp/kit/.gitconfig /tmp/lnk/`,
    `ln -s ${HOME} /tmp/lnk; cp /tmp/kit/settings.json /tmp/lnk/.claude/`,
    `ln -s ${HOME} /tmp/lnk; cp /tmp/kit/settings.json /tmp/lnk/.claude/settings.json`,
    `ln -s ${HOME}/.claude /tmp/lnk2; echo '{}' > /tmp/lnk2/settings.json`,
  ];
  test.each(held)("holds %p", (command) => {
    expectCommandHeld(command);
  });

  test("the same writes with no HOME set are judged as before", () => {
    expectAllowed(bash("python3 -c \"open('/tmp/h/out.txt','w').write('x')\""));
    expectAllowed(bash("cd /tmp/h && some-tool fetch"));
  });
});

describe("9. npm set and npm get are npm config set and get", () => {
  test("npm set is npm config set", () => {
    expectAllowed(bash("HOME=/tmp/h npm set script-shell /tmp/evil.sh; HOME=/tmp/h npm test"));
    expectAllowed(bash("npm set script-shell /tmp/evil.sh; npm test"));
    expectAllowed(bash("npm set fund false"));
    expectHeld(bash("npm set script-shell /tmp/evil.sh; npm test; git push origin main"));
  });
});
