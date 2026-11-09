import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Read-only git passes in any repository, the Standup install included:
 * `git symbolic-ref HEAD` with only a ref name reads where HEAD points, and
 * `git reflog` / `git reflog show` / `git reflog list` print history. Git
 * steps that write the install (commit, reset, checkout, push, a
 * symbolic-ref given a target, reflog delete/expire) stay held.
 */

const HOME = "/home/alice";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: ["111122223333"],
  nonProdAwsAccounts: ["444455556666"],
  ownerHosts: ["devbox-alice-*"],
  worktreeRoots: [`${DATA}/worktrees`],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  readOnlyMcpTools: [],
};

const FILES: Record<string, string> = {
  [`${DATA}/standup.db`]: "",
  [`${ROOT}/.git`]: "gitdir: /opt/standup/.git/worktrees/feat-1\n",
  [`${ROOT}/a.txt`]: "a\n",
  [`${FLOOR}/hook.ts`]: "",
  [`${INSTALL}/x.ts`]: "export {};\n",
  [`${INSTALL}/.git/HEAD`]: "ref: refs/heads/main\n",
};
const DIRS = new Set<string>([ROOT, "/tmp", "/", `${INSTALL}/.git`]);
for (const f of [...Object.keys(FILES), ...DIRS]) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: (dir) => (dir === INSTALL ? "main" : "standup/feat-1"),
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    executable: (p) => (p in FILES ? true : null),
    listDir: () => [],
    realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
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
  const label = `${row.command} (cwd ${row.cwd ?? ROOT})`;
  if (row.expect === "allow") {
    const got = v.action === "allow" ? "allow" : { category: v.category, reason: v.reason };
    expect({ label, got }).toEqual({ label, got: "allow" });
  } else {
    expect({ label, category: v.action === "hold" ? v.category : "allow" }).toEqual({ label, category: row.expect.category });
  }
}

/** Read-only git in the install, run there or reached with `-C`. */
const ALLOWED: Row[] = [
  { command: "git symbolic-ref HEAD", cwd: INSTALL, expect: "allow" },
  { command: "git symbolic-ref --short HEAD", cwd: INSTALL, expect: "allow" },
  { command: "git symbolic-ref -q --short HEAD", cwd: INSTALL, expect: "allow" },
  { command: `git -C ${INSTALL} symbolic-ref HEAD`, expect: "allow" },
  { command: `git -C ${INSTALL} symbolic-ref --short HEAD`, expect: "allow" },
  { command: "git reflog", cwd: INSTALL, expect: "allow" },
  { command: "git reflog -20", cwd: INSTALL, expect: "allow" },
  { command: "git reflog show", cwd: INSTALL, expect: "allow" },
  { command: "git reflog show -20", cwd: INSTALL, expect: "allow" },
  { command: "git reflog list", cwd: INSTALL, expect: "allow" },
  { command: "git reflog -n 20", cwd: INSTALL, expect: "allow" },
  { command: "git reflog HEAD", cwd: INSTALL, expect: "allow" },
  { command: "git reflog show --date=iso -n 5 main", cwd: INSTALL, expect: "allow" },
  { command: "git reflog exists refs/heads/main", cwd: INSTALL, expect: "allow" },
  { command: `git -C ${INSTALL} reflog -n 20`, expect: "allow" },
  { command: `git -C ${INSTALL} reflog show -20`, expect: "allow" },
  { command: `git -C ${INSTALL} reflog -20`, expect: "allow" },
  { command: `git -C ${INSTALL} reflog show main`, expect: "allow" },
  { command: "git log --oneline -5", cwd: INSTALL, expect: "allow" },
  { command: "git rev-parse HEAD", cwd: INSTALL, expect: "allow" },
  { command: "git status", cwd: INSTALL, expect: "allow" },
  { command: "git diff", cwd: INSTALL, expect: "allow" },
  { command: "git show HEAD", cwd: INSTALL, expect: "allow" },
  { command: `git -C ${INSTALL} log --oneline -5`, expect: "allow" },
  { command: `git -C ${INSTALL} status`, expect: "allow" },
];

/** Git steps that write the install stay held. */
const HELD: Row[] = [
  { command: 'git commit -m "x"', cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git reset --hard HEAD~1", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git checkout -- x.ts", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git push origin HEAD", cwd: INSTALL, expect: { category: "outward" } },
  { command: `git -C ${INSTALL} commit -m "x"`, expect: { category: "floor-tamper" } },
  { command: `git -C ${INSTALL} reset --hard HEAD~1`, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref HEAD refs/heads/x", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: `git -C ${INSTALL} symbolic-ref HEAD refs/heads/x`, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref -d HEAD", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref --delete HEAD", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref -qd HEAD", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref -m why HEAD refs/heads/x", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref HEAD $TARGET", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git reflog delete HEAD@{1}", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git reflog expire --expire=now --all", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: `git -C ${INSTALL} reflog delete HEAD@{1}`, expect: { category: "floor-tamper" } },
  { command: `git -C ${INSTALL} reflog expire --expire=now --all`, expect: { category: "floor-tamper" } },
  { command: "git reflog $SUB HEAD@{1}", cwd: INSTALL, expect: { category: "floor-tamper" } },
  // Newer git's `drop` and `write` change the log too.
  { command: "git reflog drop --all", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git reflog drop refs/heads/main", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: `git -C ${INSTALL} reflog drop --all`, expect: { category: "floor-tamper" } },
  { command: "git reflog write refs/heads/main 0000000 1111111 msg", cwd: INSTALL, expect: { category: "floor-tamper" } },
  // A dash-led target after the end of options is still a target.
  { command: "git symbolic-ref --end-of-options refs/heads/main -x", cwd: INSTALL, expect: { category: "floor-tamper" } },
  { command: "git symbolic-ref -- refs/heads/main -x", cwd: INSTALL, expect: { category: "floor-tamper" } },
  // In the worker's own worktree the reflog hold is the destructive one.
  { command: "git reflog expire --expire=now --all", expect: { category: "destructive" } },
];

describe("read-only git in the Standup install", () => {
  for (const row of ALLOWED) test(`allows: ${row.command} (cwd ${row.cwd ?? ROOT})`, () => check(row));
  for (const row of HELD) test(`holds: ${row.command} (cwd ${row.cwd ?? ROOT})`, () => check(row));
});
