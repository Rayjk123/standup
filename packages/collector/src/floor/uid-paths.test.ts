import { expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A path built from the worker's uid (`$(id -u)`) resolves to that uid, so a
 * write under /tmp through a variable set earlier in the same command
 * classifies like the literal path would. `$UID` stays unknown: ksh leaves
 * it unset, so `/tmp/$UID` may be /tmp itself.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join("/", "fake", "install", "packages", "collector", "src", "floor")],
  installDir: join("/", "fake", "install"),
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = { [join(ROOT, ".git")]: "gitdir: /fake/repo/.git/worktrees/feat-1\n", "/tmp/x/a.png": "png" };

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, {
    gitBranch: () => "standup/feat-1",
    homeDir: () => HOME,
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || Object.keys(FILES).some((f) => f.startsWith(`${p}/`)),
    isDirectory: (p) => !(p in FILES) && Object.keys(FILES).some((f) => f.startsWith(`${p}/`)),
    realpath: (p) => p,
    listDir: () => [],
  });
}

test("a screenshot dir named by the uid, made and written through a variable", () => {
  for (const command of [
    "D=/tmp/standup-screenshots-$(id -u); mkdir -p $D && chmod 700 $D && cp /tmp/x/a.png $D/",
    'D="/tmp/standup-screenshots-$(id -u)"; mkdir -p "$D" && cp /tmp/x/a.png "$D/"',
  ]) {
    expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
  }
});

test("the shared tmux socket dir named by the uid, or a uid a shell may leave unset, still holds", () => {
  for (const command of ["rm -rf /tmp/tmux-$(id -u)", "D=/tmp/tmux-$(id -u); rm -rf $D", "ksh -c 'rm -rf /tmp/$UID'"]) {
    const v = bash(command);
    expect({ command, category: v.action === "hold" ? v.category : null }).toEqual({ command, category: "destructive" });
  }
});
