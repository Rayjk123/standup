import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A tool that fills its own cache: the impeccable skill launcher run by a
 * relative path from its skill dir or by its full path, and scripts that
 * mkdir, curl -o and chmod into `${XDG_CACHE_HOME:-~/.cache}/<tool>` or
 * `~/.<tool>` are local work, not destructive. Writes into Standup's install,
 * its floor, its data dir, its scratch root and shell startup files stay held.
 */

const HOME = "/home/alice";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;
const SKILL = `${HOME}/.claude/skills/impeccable`;
const LAUNCHER = `${SKILL}/scripts/impeccable`;
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ENGINE = `${SKILL}/scripts/bin/${OS}-${ARCH}/impeccable`;

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: ["111122223333"],
  ownerHosts: ["devbox-alice-*"],
  worktreeRoots: [`${DATA}/worktrees`],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  scratchRoot: `${HOME}/.cache/standup-scratch`,
  scratchDir: `${HOME}/.cache/standup-scratch/launch-1`,
  protectedPaths: [`${DATA}/secrets`, `${HOME}/.cache/standup-scratch`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  readOnlyMcpTools: [],
};

/** A detector fetch that fills `${XDG_CACHE_HOME:-~/.cache}/<name>` and runs nothing it downloaded. */
function cacheFill(cache: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `CACHE="${cache}"`,
    'mkdir -p "$CACHE"',
    'curl -fsSL -o "$CACHE/detector.js" https://cdn.example.com/detector/1.2.0/detector.js',
    'chmod +x "$CACHE/detector.js"',
    'echo "cached $CACHE/detector.js"',
    "",
  ].join("\n");
}

const FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /srv/standup/.git/worktrees/feat-1\n",
  [`${ROOT}/package.json`]: '{"name":"x"}\n',
  [`${ROOT}/src/app.tsx`]: "export {};\n",
  [`${FLOOR}/hook.ts`]: "",
  [`${INSTALL}/x.ts`]: "export {};\n",
  [`${HOME}/.bashrc`]: "\n",
  [LAUNCHER]: readFileSync(join(import.meta.dir, "fixtures", "false-holds", "impeccable-launcher.sh.txt"), "utf8"),
  [`${SKILL}/scripts/VERSION`]: "0.1.14\n",
  [`${SKILL}/SKILL.md`]: "# impeccable\n",
  // Tool-own cache fills.
  [`${ROOT}/scripts/fetch-detector.sh`]: cacheFill("${XDG_CACHE_HOME:-$HOME/.cache}/impeccable"),
  [`${HOME}/.claude/skills/detector/scripts/fetch.sh`]: cacheFill("${XDG_CACHE_HOME:-$HOME/.cache}/detector"),
  [`${HOME}/.claude/skills/detector/scripts/fetch-dot.sh`]: cacheFill("$HOME/.detector/cache"),
  // Negatives: the same shape aimed at what the floor guards.
  [`${ROOT}/scripts/fill-standup-cache.sh`]: cacheFill("$HOME/.cache/standup-scratch/other-launch"),
  [`${ROOT}/scripts/fill-data.sh`]: cacheFill("$HOME/.local/share/standup/cache"),
  [`${ROOT}/scripts/fill-install.sh`]: cacheFill("/opt/standup/packages/collector/src/floor/cache"),
  [`${ROOT}/scripts/wipe-install.sh`]: '#!/bin/sh\nrm -rf "/opt/standup/packages/collector/src/floor"\n',
  [`${ROOT}/scripts/wipe-data.sh`]: '#!/bin/sh\nrm -rf "$HOME/.local/share/standup"\n',
  [`${ROOT}/scripts/rc.sh`]: '#!/bin/sh\nCACHE="$HOME/.cache/impeccable"\nmkdir -p "$CACHE"\necho "export PATH=$CACHE:\\$PATH" >> "$HOME/.bashrc"\n',
  [`${ROOT}/scripts/fetch-run.sh`]: cacheFill("$HOME/.cache/impeccable") + 'node "$HOME/.cache/impeccable/detector.js" src/\n',
};
const UNREADABLE: Record<string, "binary"> = { [ENGINE]: "binary" };
const DIRS = new Set<string>([ROOT, `${ROOT}/src`, `${ROOT}/scripts`, "/tmp", "/", `${SKILL}/scripts/bin/${OS}-${ARCH}`]);
for (const f of [...Object.keys(FILES), ...Object.keys(UNREADABLE), ...DIRS]) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => {
      if (p in FILES) return { ok: true, text: FILES[p]! };
      if (p in UNREADABLE) return { ok: false, reason: UNREADABLE[p]! };
      return { ok: false, reason: "missing" };
    },
    exists: (p) => p in FILES || p in UNREADABLE || DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    executable: (p) => (p in UNREADABLE || p in FILES ? true : null),
    listDir: () => [],
    realpath: (p) => (p in FILES || p in UNREADABLE || DIRS.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    env: () => undefined,
    now: () => Date.now(),
  };
}

interface Row {
  command: string;
  cwd?: string;
  expect: "allow" | { category: FloorCategory };
}

function run(row: Row): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command: row.command }, cwd: row.cwd ?? ROOT }, config, probes());
}

function check(row: Row): void {
  const v = run(row);
  const label = `${row.cwd ?? "<root>"} $ ${row.command}`;
  const got = v.action === "allow" ? "allow" : { category: v.category, reason: v.reason };
  if (row.expect === "allow") expect({ label, got }).toEqual({ label, got: "allow" });
  else expect({ label, category: v.action === "hold" ? v.category : "allow" }).toEqual({ label, category: row.expect.category });
}

/** Tool-own cache work the floor allows. */
const ALLOWED: Row[] = [
  { command: `${LAUNCHER} detect src/`, expect: "allow" },
  { command: "~/.claude/skills/impeccable/scripts/impeccable detect src/", expect: "allow" },
  { command: "scripts/impeccable detect", cwd: SKILL, expect: "allow" },
  { command: "./scripts/impeccable detect", cwd: SKILL, expect: "allow" },
  { command: `scripts/impeccable detect ${ROOT}/src`, cwd: SKILL, expect: "allow" },
  { command: `cd ${SKILL} && ${LAUNCHER} detect ${ROOT}/src`, expect: "allow" },
  { command: "sh scripts/fetch-detector.sh", expect: "allow" },
  { command: "./scripts/fetch-detector.sh", expect: "allow" },
  { command: `sh ${HOME}/.claude/skills/detector/scripts/fetch.sh`, expect: "allow" },
  { command: `sh ${HOME}/.claude/skills/detector/scripts/fetch-dot.sh`, expect: "allow" },
  { command: 'mkdir -p ~/.cache/impeccable && curl -fsSL -o ~/.cache/impeccable/detector.js https://cdn.example.com/detector.js && chmod +x ~/.cache/impeccable/detector.js', expect: "allow" },
];

/** What stays held: the same writes aimed at Standup's install, floor, data dir, scratch root or shell startup files. */
const HELD: Row[] = [
  { command: "sh scripts/fill-standup-cache.sh", expect: { category: "floor-tamper" } },
  { command: "sh scripts/fill-data.sh", expect: { category: "standup-ops" } },
  { command: "sh scripts/fill-install.sh", expect: { category: "floor-tamper" } },
  { command: "sh scripts/wipe-install.sh", expect: { category: "floor-tamper" } },
  { command: "sh scripts/wipe-data.sh", expect: { category: "floor-tamper" } },
  { command: "sh scripts/rc.sh", expect: { category: "floor-tamper" } },
  { command: "sh scripts/fetch-run.sh", expect: { category: "unclassified" } },
  // The launcher off the allowance is read as the script it is: its download path's writes hold.
  { command: `${LAUNCHER} hooks on`, expect: { category: "destructive" } },
  { command: "scripts/impeccable hooks on", cwd: SKILL, expect: { category: "destructive" } },
  { command: "scripts/impeccable critique --target src/app.tsx", cwd: SKILL, expect: { category: "destructive" } },
  { command: "impeccable/scripts/impeccable detect", cwd: `${HOME}/.claude/skills`, expect: { category: "destructive" } },
  { command: `scripts/impeccable detect ${HOME}/.claude`, cwd: SKILL, expect: { category: "destructive" } },
  { command: "scripts/impeccable detect ../../settings.json", cwd: SKILL, expect: { category: "destructive" } },
  { command: "../scripts/impeccable detect", cwd: `${SKILL}/reference`, expect: { category: "destructive" } },
  { command: "IMPECCABLE_BIN=/bin/rm scripts/impeccable detect", cwd: SKILL, expect: { category: "floor-tamper" } },
  { command: "f() { :; }; scripts/impeccable detect", cwd: SKILL, expect: { category: "destructive" } },
  // A relative spelling after a `cd`: where the shell really is may not be where the `cd` names.
  { command: `cd ${SKILL} && scripts/impeccable detect ${ROOT}/src`, expect: { category: "destructive" } },
  { command: `cd ${SKILL} extra; scripts/impeccable detect`, expect: { category: "destructive" } },
  { command: `env cd ${SKILL}; scripts/impeccable detect`, expect: { category: "destructive" } },
  { command: `pushd ${SKILL} extra; scripts/impeccable detect`, expect: { category: "destructive" } },
  { command: "echo x >> ~/.bashrc", expect: { category: "floor-tamper" } },
];

describe("a tool filling its own cache is allowed", () => {
  for (const row of ALLOWED) test(`${row.cwd ?? ""} ${row.command}`, () => check(row));
});

describe("the same writes into what the floor guards stay held", () => {
  for (const row of HELD) test(`${row.cwd ?? ""} ${row.command}`, () => check(row));
});
