import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Screenshots and recordings saved to /tmp, the worktree or the launch's
 * review scratch dir: the worker's own copy of the screenshot helper names
 * /tmp as a page root, which is no more a delete of /tmp than `os.tmpdir()`
 * is. A capture whose file lands on something real outside those (a shell rc
 * file, an SSH key, the install, Standup's data, a link out of /tmp) still
 * holds, for the helper's `--out` as for any screen capture tool's output.
 */

const REPO = resolve(import.meta.dir, "../../../..");
const SHIPPED = ["scripts/pipeline-screenshot.ts", "scripts/pipeline-recording.ts", "packages/shared/src/review.ts", "packages/shared/src/pipeline.ts"];
const PAGE = "http://localhost:5173/";

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(DATA, "review-scratch", "launch-1");
const HELPER = "bun scripts/pipeline-screenshot.ts";

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

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "shots", "old.png")]: "png",
  [join(HOME, ".zshrc")]: "export X=1\n",
  [join(HOME, ".ssh", "authorized_keys")]: "ssh-ed25519 AAAA\n",
  [join(HOME, "work", "notes.md")]: "notes\n",
  [join(DATA, "standup.db")]: "",
  "/tmp/old.png": "png",
  "/tmp/standup-screenshots-1000/old.png": "png",
  [join(SCRATCH, "old.png")]: "png",
};
for (const f of SHIPPED) {
  const text = readFileSync(join(REPO, f), "utf8");
  FILES[join(ROOT, f)] = text;
  FILES[join(INSTALL, f)] = text;
}
/** Symlinks in /tmp: to a real file outside the worktree, to a shell rc file, and to one that doesn't exist yet. */
const LINKS: Record<string, string> = {
  "/tmp/link.png": join(HOME, "work", "notes.md"),
  "/tmp/rc.png": join(HOME, ".zshrc"),
  "/tmp/dangling.png": join(HOME, ".bash_profile"),
};

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of [...Object.keys(files), ...Object.keys(LINKS)]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in LINKS ? (LINKS[p]! in files ? LINKS[p]! : null) : p in files || dirs.has(p) ? p : null),
    lstat: (p) => (p in LINKS ? { symlink: true, file: false, nlink: 1 } : p in files ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, extra: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes({ ...FILES, ...extra }));
}

/** A worker script `t.ts` in the worktree holding `source`, run with bun. */
function script(source: string, args = ""): FloorVerdict {
  return bash(`bun t.ts${args ? ` ${args}` : ""}`, { [join(ROOT, "t.ts")]: source });
}

function expectHeld(v: FloorVerdict, category: FloorCategory): void {
  expect(v).toMatchObject({ action: "hold", category });
}

const INLINE = (path: string) =>
  `bun -e 'import { chromium } from "playwright"; const b = await chromium.launch(); const p = await b.newPage(); await p.goto("${PAGE}"); await p.screenshot({ path: "${path}", fullPage: true }); await b.close();'`;

describe("4. screenshots and recordings saved to /tmp or the worker's own dirs", () => {
  test.each([
    `${HELPER} ${PAGE} --out /tmp/standup-screenshots-1000/x.png`,
    `${HELPER} ${PAGE} --out /tmp/standup-screenshots-1000/old.png`,
    `${HELPER} ${PAGE} --out=/tmp/x.png --full-page --width 1280 --height 800`,
    `${HELPER} ${PAGE}`,
    `${HELPER} ${PAGE} --out shots/x.png`,
    `${HELPER} ${PAGE} --out ${ROOT}/shots/old.png`,
    `${HELPER} ${PAGE} --out ${SCRATCH}/a.png`,
    `${HELPER} --record ${PAGE} --out /tmp/r.webm --duration-ms 4000`,
    `mkdir -p /tmp/standup-screenshots-1000 && ${HELPER} ${PAGE} --out /tmp/standup-screenshots-1000/x.png`,
    `bun ./scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/old.png`,
    `bunx playwright screenshot ${PAGE} /tmp/x.png`,
    `npx playwright screenshot --full-page ${PAGE} /tmp/shot.png`,
    `bunx playwright screenshot --full-page --viewport-size=1280,800 ${PAGE} shots/a.png`,
    `bunx playwright screenshot ${PAGE} /tmp/old.png`,
    `chromium --headless --screenshot=/tmp/x.png ${PAGE}`,
    `google-chrome --headless=new --screenshot=/tmp/a.png --window-size=1280,800 http://127.0.0.1:5173`,
    `google-chrome --headless=new --screenshot=/tmp/old.png ${PAGE}`,
    `chromium --headless --print-to-pdf=${ROOT}/shots/page.pdf ${PAGE}`,
    `import -window root /tmp/x.png`,
    `import -window root png:/tmp/x.png`,
    `magick import -window root /tmp/x.png`,
    `scrot -d 1 x.png`,
    `bunx playwright screenshot --browser chromium --wait-for-selector '[data-ready]' ${PAGE} /tmp/x.png`,
    `bunx playwright screenshot ${PAGE} /tmp/x.png --full-page`,
    `scrot /tmp/x.png`,
    `scrot /tmp/old.png`,
    INLINE("/tmp/x.png"),
    INLINE("/tmp/old.png"),
    INLINE("shots/old.png"),
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

});

/** The worker's copy of the screenshot helper with `extra` appended, so it no longer reads as the install's. */
const changedHelper = (extra: string): Record<string, string> => ({
  [join(ROOT, SHIPPED[0]!)]: `${FILES[join(ROOT, SHIPPED[0]!)]}\n${extra}`,
});

describe("4. a worker file that names /tmp and isn't the install's own copy still holds", () => {
  test.each([
    'import { readdirSync, writeFileSync } from "fs";\nimport { join } from "path";\nfor (const f of readdirSync("/tmp")) console.log(f);\nwriteFileSync(join("/tmp", "x.txt"), "");\n',
    'import { rmSync, renameSync, realpathSync } from "fs";\nconst roots = ["/tmp"].map((r) => realpathSync(r));\nrenameSync("/tmp/a.part", "/tmp/a.png");\nrmSync("/tmp/a.part", { force: true });\nconsole.log(roots);\n',
  ])("a worker script of its own that names /tmp as a root holds: %p", (source) => {
    expectHeld(script(source), "destructive");
  });

  test.each<[string, string]>([
    ["a `..` join", 'import { writeFileSync as w } from "fs";\nw(join("/tmp", "..", "fake", "home", "work", "notes.md"), "");\n'],
    ["an argv join", 'import { writeFileSync as w } from "fs";\nw(join("/tmp", process.argv[2]!), "");\n'],
    ["a link in /tmp", 'import { writeFileSync as w } from "fs";\nw(join("/tmp", "link.png"), "");\n'],
    ["an unlink walk", 'import { readdirSync as r, unlinkSync as u } from "fs";\nfor (const f of r("/tmp")) u(join("/tmp", f));\n'],
  ])("the helper changed to write through %s holds", (_, extra) => {
    const v = bash(`${HELPER} ${PAGE} --out /tmp/x.png`, changedHelper(extra));
    expectHeld(v, "destructive");
    expect(v.action === "hold" && v.reason).toContain("names /tmp");
  });

  // Only the reviewed helper is exempt: another file the install ships, byte for byte the same, may still join the root with argv.
  test.each([
    ["scripts/other-tool.ts", 'import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join("/tmp", process.argv[2]!), "");\n'],
    ["scripts/pipeline-recording.ts", 'import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join("/tmp", process.argv[2]!), "");\n'],
  ])("a shipped %s that writes a path from its arguments under /tmp holds", (file, source) => {
    const v = bash(`bun ${file} ../fake/home/.zshrc`, { [join(ROOT, file)]: source, [join(INSTALL, file)]: source });
    expectHeld(v, "destructive");
    expect(v.action === "hold" && v.reason).toContain("names /tmp");
  });

  test("the helper holds when the install's copy can't be read", () => {
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command: `${HELPER} ${PAGE} --out /tmp/x.png` }, cwd: ROOT }, config, {
      ...probes(FILES),
      readFile: (p) => (p === join(INSTALL, SHIPPED[0]!) ? { ok: false, reason: "unreadable" } : p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    });
    expectHeld(v, "destructive");
  });
});

describe("4. a capture whose output lands on something real still holds", () => {
  test.each<[string, FloorCategory]>([
    [`${HELPER} ${PAGE} --out ~/.zshrc`, "floor-tamper"],
    [`${HELPER} ${PAGE} --out ~/.ssh/authorized_keys`, "floor-tamper"],
    [`${HELPER} ${PAGE} --out=$HOME/.ssh/authorized_keys`, "floor-tamper"],
    [`${HELPER} ${PAGE} --out ${INSTALL}/x.png`, "floor-tamper"],
    [`${HELPER} ${PAGE} --out ${DATA}/standup.db`, "floor-tamper"],
    [`${HELPER} ${PAGE} --out /tmp/link.png`, "destructive"],
    [`${HELPER} ${PAGE} --out /tmp/rc.png`, "floor-tamper"],
    [`${HELPER} ${PAGE} --out /tmp/dangling.png`, "destructive"],
    [`${HELPER} ${PAGE} --out "$(cat /tmp/p)/.zshrc"`, "destructive"],
    [`chromium --headless --screenshot=$HOME/.ssh/authorized_keys ${PAGE}`, "floor-tamper"],
    [`google-chrome --headless=new --screenshot=${HOME}/work/notes.md ${PAGE}`, "destructive"],
    [`chromium --headless --print-to-pdf=/tmp/link.png ${PAGE}`, "destructive"],
    [`npx playwright screenshot ${PAGE} ~/.ssh/authorized_keys`, "floor-tamper"],
    [`bunx playwright screenshot --full-page ${PAGE} ~/work/notes.md`, "destructive"],
    [`bunx playwright screenshot ${PAGE} /tmp/dangling.png`, "destructive"],
    [`scrot ~/.ssh/authorized_keys`, "floor-tamper"],
    [`scrot ~/work/notes.md`, "destructive"],
    [`scrot /tmp/link.png`, "destructive"],
    [`import -window root ~/work/notes.md`, "destructive"],
    [INLINE(`${HOME}/work/notes.md`), "destructive"],
    [INLINE(`${HOME}/.zshrc`), "floor-tamper"],
    [INLINE("/tmp/link.png"), "destructive"],
  ])("holds %p as %p", (command, category) => {
    expectHeld(bash(command), category);
  });

  test("an output path the floor can't place is a write, held only when the call names a guarded file", () => {
    expect(bash(`${HELPER} ${PAGE} --out "$(cat /tmp/p)"`)).toEqual({ action: "allow" });
  });

  // A script's own `--out` over an existing file of the owner's replaces only that file, which the script's code is read for.
  test.each([
    `${HELPER} ${PAGE} --out ~/work/notes.md`,
    `${HELPER} ${PAGE} -o ~/work/notes.md`,
    `${HELPER} --record ${PAGE} --out ~/work/notes.md`,
    `cd /tmp && bun ${ROOT}/scripts/pipeline-screenshot.ts ${PAGE} --out ../fake/home/work/notes.md`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    `bash -c 'scrot ~/work/notes.md'`,
    `timeout 10 scrot ~/work/notes.md`,
    `env DISPLAY=:0 import -window root ~/work/notes.md`,
    `sh -c "bunx playwright screenshot ${PAGE} ~/work/notes.md"`,
    `cd ~/work && ${ROOT}/node_modules/.bin/playwright screenshot ${PAGE} notes.md`,
    `import -window root png:${HOME}/work/notes.md`,
    `magick import -window root ${HOME}/work/notes.md`,
    `cd ~/work && scrot notes.md`,
    `cd ~/work && import -window root notes.md`,
    `chromium --headless -screenshot=${HOME}/work/notes.md ${PAGE}`,
    `bunx playwright screenshot ${PAGE} ~/work/notes.md --full-page`,
    `bunx playwright codegen --output=${HOME}/work/notes.md ${PAGE}`,
    `bunx playwright codegen -o${HOME}/work/notes.md ${PAGE}`,
  ])("holds the capture's output however it is started: %p", (command) => {
    const v = bash(command);
    expectHeld(v, "destructive");
    expect(v.action === "hold" && v.reason).toContain("saves its output over");
  });

  test.each<[string, FloorCategory]>([
    [`${HELPER} ${PAGE} --out /tmp/a.png && rm -rf ~/work`, "destructive"],
    [`scrot /tmp/a.png; rm ~/work/notes.md`, "destructive"],
    [`bunx playwright screenshot ${PAGE} /tmp/a.png && mv /tmp/a.png ~/work/notes.md`, "destructive"],
    [`${HELPER} ${PAGE} --out /tmp/a.png && cp /tmp/a.png ~/.zshrc`, "floor-tamper"],
  ])("holds a destructive step chained with a capture: %p", (command, category) => {
    expectHeld(bash(command), category);
  });
});

describe("4. code that names a temp root and may remove a tree, or the tmux socket, still holds", () => {
  test.each([
    'import { rmSync } from "fs";\nrmSync("/tmp", { recursive: true, force: true });\n',
    'import { rmSync } from "fs";\nconst o = { recursive: true };\nrmSync("/tmp", o);\n',
    'import { rmSync } from "fs";\nrmSync("/tmp", { "recursive": true });\n',
    'import { rmSync } from "fs";\nrmSync("/tmp", { ...{ recursive: true } });\n',
    'import { rmSync } from "fs";\nrmSync("/tmp", { force: true, ["recur" + "sive"]: true });\n',
    'import { rm } from "fs/promises";\nawait rm("/tmp/", { recursive: true });\n',
    'import { remove } from "fs-extra";\nawait remove("/tmp");\n',
    'import fse from "fs-extra";\nimport { writeFileSync } from "fs";\nfse.emptyDirSync("/tmp");\nwriteFileSync("x", "");\n',
    'import { removeSync } from "fs-extra";\nimport { writeFileSync } from "fs";\nremoveSync("/tmp");\nwriteFileSync("x", "");\n',
    'import { rimraf } from "rimraf";\nimport { writeFileSync } from "fs";\nawait rimraf("/tmp");\nwriteFileSync("x", "");\n',
    'import { unlinkSync } from "fs";\nimport { join } from "path";\nunlinkSync(join("/tmp", "tmux-1000", "default"));\n',
    'import { unlinkSync } from "fs";\nimport { join } from "path";\nunlinkSync(join("/tmp", `tmux-${process.getuid()}`, "default"));\n',
  ])("holds %p as destructive", (source) => {
    expectHeld(script(source), "destructive");
  });

  test("python's shutil.rmtree over the temp root holds", () => {
    const v = bash("python3 t.py", { [join(ROOT, "t.py")]: 'import shutil\nshutil.rmtree("/tmp")\n' });
    expect(v.action).toBe("hold");
  });

  test("an argv that deletes the temp root holds", () => {
    expect(script('import { spawnSync } from "child_process";\nspawnSync("rm", ["-rf", "/tmp"]);\n').action).toBe("hold");
  });

  test("a worker script's output option is read as the file it saves", () => {
    const writer = 'import { writeFileSync } from "fs";\nconst at = process.argv.indexOf("--out");\nwriteFileSync(process.argv[at + 1]!, "x");\n';
    expect(script(writer, "--out /tmp/x.txt")).toEqual({ action: "allow" });
    expect(script(writer, "--out shots/x.txt")).toEqual({ action: "allow" });
    expect(script(writer, "--out ~/work/notes.md")).toEqual({ action: "allow" });
    expectHeld(script(writer, "--output=/tmp/link.png"), "destructive");
    expectHeld(script(writer, "-o ~/.zshrc"), "floor-tamper");
  });
});
