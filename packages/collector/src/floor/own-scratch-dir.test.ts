import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A launch's own scratch dir, `<scratchRoot>/<launchId>` from its floor
 * config, is the worker's to write as its worktree and /tmp are, though the
 * scratch root it lies in is protected. Writes there by Write, Edit and Bash
 * (mkdir, a redirect, cp, rm) are allowed, including a long command whose
 * heredoc body `cat` only copies to a file and which holds code that climbs
 * (`dirname`, `"../a"`): that body runs nothing. The same writes under another
 * launch's scratch dir, Standup's secrets dir or its data dir still hold, as
 * do a climb in code that runs, a body that names another launch's dir, a
 * heredoc that expands or goes on to a program (`rg --pre`, `strings @f`, a
 * function named `cat`), and a carriage return the shell reads into the
 * delimiter. The bodies may be inside subshells, groups and `if`s, and hold
 * code with empty calls, `function` and PATH. The config's home is read as
 * written and through a symlinked home (`/home/u` -> `/local/home/u`).
 */

const LINK_HOME = join("/", "home", "u");
const HOME = join("/", "local", "home", "u");
const ROOT = join(HOME, ".local", "share", "standup", "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const ID = "a1a1a1a1-0000-4000-8000-0000000000a1";
const OTHER = "a2a2a2a2-0000-4000-8000-0000000000a2";

/** The config the launcher builds (buildLaunchFloorConfig), rooted at `home`. */
function configFor(home: string): FloorConfig {
  const data = join(home, ".local", "share", "standup");
  const scratchRoot = join(home, ".cache", "standup-scratch");
  return {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: ID,
    scratchRoot,
    scratchDir: join(scratchRoot, ID),
    root: ROOT,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: data,
    floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
    installDir: INSTALL,
    protectedPaths: [join(data, "secrets"), join(data, "worker-tokens"), join(data, "review-media"), join(data, "review-scratch"), scratchRoot],
    worktreeRoots: [join(data, "worktrees")],
    tmpDirs: ["/tmp", "/var/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
}

const DIRS = ["/", "/tmp", ROOT, join(HOME, ".cache", "standup-scratch", ID), join(HOME, ".cache", "standup-scratch", OTHER), join(HOME, ".local", "share", "standup", "secrets")];
const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(HOME, ".cache", "standup-scratch", ID, "a.txt")]: "x\n",
  [join(HOME, ".cache", "standup-scratch", OTHER, "a.txt")]: "x\n",
};

function probes(home: string): Partial<FloorProbes> {
  const dirs = new Set<string>(DIRS);
  for (const f of [...Object.keys(FILES), ...DIRS]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const real = (p: string): string => (p === LINK_HOME || p.startsWith(`${LINK_HOME}/`) ? HOME + p.slice(LINK_HOME.length) : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (real(p) in FILES ? { ok: true, text: FILES[real(p)]! } : { ok: false, reason: "missing" }),
    exists: (p) => real(p) in FILES || dirs.has(real(p)),
    executable: () => false,
    isDirectory: (p) => dirs.has(real(p)),
    listDir: () => null,
    realpath: (p) => (real(p) in FILES || dirs.has(real(p)) ? real(p) : null),
    lstat: (p) => (p === LINK_HOME ? { symlink: true, file: false, nlink: 1 } : real(p) in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(real(p)) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => home,
    env: (name) => ({ HOME: home, TMPDIR: join(home, ".cache", "standup-scratch", ID) })[name],
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

const CLIMBING_CODE = `import a from "../a";\nconst d = dirname(f);\nconst p = f.split("/");\n`;
/** Code as a worker writes it: empty calls, `function`, PATH and `hash` as names. */
const REAL_CODE = `import { dirname } from "path";\nexport function up(p: string) {\n  return dirname(p);\n}\nconst hash = process.env.PATH;\nconsole.log(up(process.cwd()), hash);\n`;

for (const home of [HOME, LINK_HOME]) {
  const S = join(home, ".cache", "standup-scratch", ID);
  const O = join(home, ".cache", "standup-scratch", OTHER);
  const DATA = join(home, ".local", "share", "standup");
  const call = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict => {
    process.env.TMPDIR = S;
    return classifyToolCall({ toolName, toolInput, cwd: ROOT }, configFor(home), probes(home));
  };

  describe(`the launch's own scratch dir (home ${home})`, () => {
    test.each([
      ["Write", { file_path: `${S}/n.txt`, content: "x" }],
      ["Write", { file_path: `${S}/x.ts`, content: CLIMBING_CODE }],
      ["Edit", { file_path: `${S}/a.txt`, old_string: "x", new_string: "y" }],
      ["Bash", { command: `mkdir -p ${S}/d` }],
      ["Bash", { command: `echo hi > ${S}/out.log` }],
      ["Bash", { command: `cp ${ROOT}/package.json ${S}/p.json` }],
      ["Bash", { command: `rm -rf ${S}/d` }],
      ["Bash", { command: `echo ${"x".repeat(5000)} > ${S}/big.txt` }],
      ["Bash", { command: `mkdir -p ${S}/d && cat > ${S}/d/x.ts <<'EOF'\n${CLIMBING_CODE}EOF` }],
      ["Bash", { command: `mkdir -p ${S}/d && cat > ${S}/d/x.ts <<EOF\n${CLIMBING_CODE}EOF\nls ${S}/d` }],
      ["Bash", { command: `cat <<"EOF" >> ${S}/notes.md\n${CLIMBING_CODE.repeat(200)}EOF` }],
      ["Bash", { command: `cat > ${S}/x.ts <<'EOF'\n${REAL_CODE}EOF` }],
      ["Bash", { command: `( cd ${S} && cat > x.ts <<'EOF'\n${REAL_CODE}EOF\n)` }],
      ["Bash", { command: `{ mkdir -p ${S}/d; cat > ${S}/d/x.ts <<'EOF'\n${REAL_CODE}EOF\n}; if true; then head ${S}/d/x.ts; fi` }],
      ["Bash", { command: `[ -d ${S}/d ] || mkdir -p ${S}/d; cat > ${S}/d/x.ts 2>/dev/null <<'EOF'\n${REAL_CODE}EOF` }],
      ["Bash", { command: `cat > ~/.cache/standup-scratch/${ID}/x.ts <<'EOF'\n${CLIMBING_CODE}EOF` }],
      ["Bash", { command: `cat > $HOME/.cache/standup-scratch/${ID}/x.ts <<'EOF'\n${CLIMBING_CODE}EOF` }],
      ["Bash", { command: `cat > \${HOME}/.cache/standup-scratch/${ID}/x.ts <<'EOF'\n${CLIMBING_CODE}EOF` }],
    ])("%s %p is allowed", (tool, input) => {
      expect(call(tool, input)).toEqual({ action: "allow" });
    });
  });

  describe(`another launch's scratch dir, Standup's secrets and data dirs (home ${home})`, () => {
    test.each([
      ["Write", { file_path: `${O}/n.txt`, content: "x" }],
      ["Edit", { file_path: `${O}/a.txt`, old_string: "x", new_string: "y" }],
      ["Bash", { command: `mkdir -p ${O}/d` }],
      ["Bash", { command: `echo hi > ${O}/out.log` }],
      ["Bash", { command: `cp ${ROOT}/package.json ${O}/p.json` }],
      ["Bash", { command: `rm -rf ${O}/d` }],
      ["Bash", { command: `mkdir -p ${S}/../${OTHER}/d` }],
      ["Write", { file_path: `${DATA}/secrets/n.txt`, content: "x" }],
      ["Bash", { command: `mkdir -p ${DATA}/secrets/d` }],
      ["Bash", { command: `echo hi > ${DATA}/secrets/owner.token` }],
      ["Bash", { command: `cp ${ROOT}/package.json ${DATA}/secrets/p.json` }],
      ["Bash", { command: `rm -rf ${DATA}/secrets` }],
      ["Write", { file_path: `${DATA}/standup.db`, content: "x" }],
      ["Bash", { command: `echo hi > ${DATA}/standup.db` }],
      ["Bash", { command: `rm -rf ${DATA}/worktrees` }],
    ])("%s %p holds", (tool, input) => {
      expect(call(tool, input).action).toBe("hold");
    });
  });

  describe(`climbs past the own scratch dir (home ${home})`, () => {
    test.each([
      `python3 -c 'import os; print(os.listdir(os.path.dirname("${S}")))'`,
      `cat > ${S}/x <<'EOF'\n${O}/a.txt\nEOF`,
      `cat > ${S}/x <<EOF\n$(ls "$(dirname ${S})")\nEOF`,
      `cat > /dev/stdout <<'EOF' | python3\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF`,
      `cat <<'EOF' | python3 > ${S}/out\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF`,
      `cat > ${S}/x.py <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\npython3 ${S}/x.py`,
      `cat > ${S}/y.sh <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\nrg --pre python3 . ${S}/y.sh`,
      `cat > ${S}/y.sh <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\nrg --pre=python3 x ${S}/y.sh`,
      `cat > ~/.cache/standup-scratch/${ID}/x <<'EOF'\n${O}/a.txt\nEOF`,
      `cd ${S}\ncat > f <<'EOF'\n../../standup-scratch/${OTHER}/a.txt\nEOF\nstrings @f`,
      `cd ${S}\ncat > f <<'EOF'\n../../standup-scratch/${OTHER}/a.txt\nEOF\nfile -f f`,
      `cd ${S}\ncat > f <<'EOF'\n../../standup-scratch/${OTHER}/a.txt\nEOF\nsha256sum -c f`,
      `cat > ${S}/s <<'EOF'\ncat "$(dirname ${S})/${OTHER}/a.txt"\nEOF\nrg --pre=sh . ${S}/s`,
      `cat > ${S}/x <<\rEOF\nhi\n\rEOF\npython3 -c 'import os; print(os.listdir(os.path.dirname("${S}")))'\nEOF`,
      `cat > ${S}/x <<\r'EOF'\nhi\n\rEOF\ncat "$(dirname ${S})/${OTHER}/a.txt"\nEOF`,
      `cat() { python3 "$@"; }\ncat > ${S}/x <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF`,
      `X=1 cat > ${S}/x <<'EOF'\nprint(dirname("${S}"))\nEOF\nwhile true; do python3 ${S}/x; done`,
      `cat 2>/dev/stdout > ${S}/x <<'EOF' | python3\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF`,
      `cat > ${S}/x <<EO\\\nF\n$(python3 -c 'import os; print(os.listdir(os.path.dirname("${S}")))')\nEOF`,
      `cat > ${S}/x.py <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\nmkdir -p /tmp/q/"$"'(python3 ${S}/x.py)' && cd /tmp/q/* && echo \${PWD@P}`,
      `cat > ${S}/x.py <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\nprintf -v x '%b' 'b[\\x24(python3 ${S}/x.py)]'; [ -v 'a[x]' ]`,
      `cat > ${S}/x.py <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\ntest -v 'a[x]'`,
      `cat > ${S}/x.py <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\necho $[x]`,
      `( cat > ${S}/x.py <<'EOF'\nimport os\nprint(os.listdir(os.path.dirname("${S}")))\nEOF\npython3 ${S}/x.py )`,
    ])("%p holds", (command) => {
      expect(call("Bash", { command }).action).toBe("hold");
    });
  });
}
