import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `git branch` listings only read refs, whatever repository they run in.
 * Creating, deleting, renaming, copying, force-moving a branch or setting its
 * upstream changes the repository, so outside the worktree it is held.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = "/home/tester/code/standup-worktrees/proj/feat-1a2b3c";
const OTHER = "/home/tester/code/other";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: ["/opt/standup/packages/collector/src/floor"],
  installDir: "/opt/standup",
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = { [`${ROOT}/.git`]: "gitdir: /tmp/x\n" };
const DIRS = new Set<string>([ROOT, OTHER, `${OTHER}/.git`, "/tmp", "/"]);

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "feat",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || DIRS.has(p),
    isDirectory: (p) => DIRS.has(p),
    listDir: () => [],
    realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
  };
}

const bash = (command: string): FloorVerdict => classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());

const LISTINGS: string[] = [
  "branch",
  "branch -a",
  "branch -r",
  "branch -v",
  "branch -vv",
  "branch -av",
  "branch --all",
  "branch --remotes",
  "branch --list",
  "branch --list 'feat*'",
  "branch -l 'feat*'",
  "branch -a --list 'origin/*'",
  "branch --show-current",
  "branch --contains abc123",
  "branch -a --contains abc123",
  "branch -r --contains=abc123",
  "branch --no-contains abc123",
  "branch --merged main",
  "branch --no-merged origin/main",
  "branch --points-at HEAD",
  "branch --format '%(refname:short)'",
  "branch --sort=-committerdate",
  "branch --color=always -a",
];

const CHANGES: string[] = [
  "branch new-feature",
  "branch new-feature HEAD~1",
  "branch -d old",
  "branch -D old",
  "branch --delete old",
  "branch -m old new",
  "branch -M old new",
  "branch --move old new",
  "branch -c old new",
  "branch -f feat HEAD",
  "branch --force feat HEAD",
  "branch --set-upstream-to origin/feat",
  "branch --set-upstream-to=origin/feat feat",
  "branch -u origin/feat",
  "branch --unset-upstream",
  "branch --track feat origin/feat",
  "branch --edit-description",
];

describe("git branch listings are reads", () => {
  for (const args of LISTINGS) {
    test(`in the worktree: git ${args}`, () => expect(bash(`git ${args}`)).toEqual({ action: "allow" }));
    test(`in another repository: git -C ${OTHER} ${args}`, () => expect(bash(`git -C ${OTHER} ${args}`)).toEqual({ action: "allow" }));
  }
});

describe("git branch changes count as changes", () => {
  for (const args of CHANGES) {
    test(`in another repository: git -C ${OTHER} ${args}`, () => {
      const v = bash(`git -C ${OTHER} ${args}`);
      expect(v.action).toBe("hold");
      if (v.action === "hold") expect(v.category).toBe("destructive");
    });
  }
});
