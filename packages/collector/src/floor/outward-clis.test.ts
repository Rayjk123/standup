import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { FLOOR_ALLOW_OPTION, FLOOR_GATE, FLOOR_OWNER_GATE, OWNER_ONLY_CATEGORIES } from "./gate.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";
import { decide } from "../persona/policy.js";

/*
 * Publish, push and remote CLIs are owner-only outward steps however a
 * worker spells them: bare, by path, behind env assignments or wrappers, or
 * through a git alias. An upload with the org profile's review CLI
 * (`corp-review`) is held as `review`, which Persona may allow, unless the
 * same call also takes an outward step. Read-only lookalikes stay allowed.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const WS = `${HOME}/src/app-worktrees/feat-1`;
const ROOT = `${WS}/pkgs/app`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://localhost:7777",
  launchId: "launch-1",
  root: WS,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [`${WS}/review-description.md`]: "## What\n- CORS origin\n",
  [`${ROOT}/.git`]: "gitdir: /tmp/x\n",
};
const DIRS = new Set<string>([WS, ROOT, `${WS}/pkgs`, "/tmp", "/"]);

const ALIASES: Record<string, string> = { pu: "push", sync: "!git fetch && git push origin HEAD", lg: "log --oneline" };

function probes(): Partial<FloorProbes> {
  return {
    gitBranch: () => "feat-1",
    gitAlias: (_dir, name) => ALIASES[name] ?? null,
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
const tool = (toolName: string, toolInput: Record<string, unknown> = {}): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());

/**
 * Held as outward, owner-only, on gate safety_floor_owner; Persona's "Allow
 * once" on it runs the call, recorded for the owner.
 */
function expectOwnerOnlyOutward(v: FloorVerdict): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  expect(v.category).toBe("outward");
  expect(v.ownerOnly).toBe(true);
  expect(OWNER_ONLY_CATEGORIES.has(v.category)).toBe(true);
  const allow = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: v.category, text: FLOOR_ALLOW_OPTION });
  expect(allow.rule).toBe("act");
}

/** Held as a code-review upload that Persona's "Allow once" on gate safety_floor runs. */
function expectPersonaReview(v: FloorVerdict): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  expect(v.category).toBe("review");
  expect(v.ownerOnly).toBe(false);
  expect(OWNER_ONLY_CATEGORIES.has(v.category)).toBe(false);
  const allow = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_GATE, floorCategory: v.category, text: FLOOR_ALLOW_OPTION });
  expect(allow.rule).toBe("act");
}

const REVIEW: string[] = [
  // A revision upload in the shape a worker runs it: from the package dir, with a timeout, its output to a log.
  `cd ${ROOT} && timeout 900 corp-review --revise R-123 --description ../../review-description.md < /dev/null > /tmp/review.log 2>&1; echo "exit=$?"; tail -n 40 /tmp/review.log`,
  "corp-review --revise R-123 --description ../../review-description.md",
  // The review CLI in any form
  "corp-review",
  "corp-review --revise R-1",
  "corp-review --draft",
  "corp-review --draft --issue I-1",
  "/opt/corp/bin/corp-review --draft",
  "~/.local/bin/corp-review --revise R-1",
  "$HOME/.local/bin/corp-review --draft",
  "./corp-review --draft",
  "env REVIEW_EDITOR=true corp-review --draft",
  "FOO=1 corp-review --revise R-1 --draft",
  "command corp-review --draft",
  "exec corp-review --draft",
  "nohup corp-review --draft &",
  "time corp-review --draft",
  "bash -c 'corp-review --draft'",
  "sh -lc \"corp-review --revise R-1\"",
  "echo y | corp-review --draft",
  "xargs corp-review --revise < ids.txt",
  "yes | corp-review --draft",
  // Through the org's wrappers.
  "corp-each corp-review",
  "corp-each -p Pkg 'corp-review --draft'",
  "corp-env corp-review --draft",
  "corp-review --help --draft",
  "corp-review --revise R-1 --version",
];

const OUTWARD: string[] = [
  // The review CLI alongside an outward step ranks as the outward step
  "git push && corp-review",
  "corp-review --draft && git push origin HEAD",
  "corp-review --revise R-1; npm publish",
  "corp-review --draft | tee /tmp/review.log && corp-env cdk deploy MyStack",
  "bash -c 'corp-review --draft && git push'",
  // git push in all forms, git aliases, gh pr and glab mr
  "git push",
  "git push origin HEAD",
  "git push --force-with-lease origin feat",
  // A dry run still connects and authenticates to the remote.
  "git push --dry-run origin HEAD",
  "git -C /tmp/x push",
  "git -C ../other push origin HEAD",
  "git -c push.default=current push",
  "git --git-dir=/tmp/x/.git push",
  "/usr/bin/git push",
  "GIT_SSH_COMMAND=ssh git push origin feat",
  "git pu",
  "git sync",
  "git-push origin HEAD",
  "git send-email HEAD~1",
  "git svn dcommit",
  "git p4 submit",
  "git remote set-url origin git@example.com:x/y.git",
  "gh pr create --fill",
  "gh pr merge 12",
  "gh pr comment 12 --body hi",
  "gh pr review 12 --approve",
  "gh release create v1",
  "gh api -X POST repos/o/r/issues -f title=x",
  "glab mr create",
  "glab mr merge 3",
  "glab mr note 3 -m hi",
  "hub pull-request",
  // publish and deploy
  "npm publish",
  "npm publish --tag next",
  // A dry run still runs the package's prepublish and prepack scripts.
  "npm publish --dry-run",
  "bun publish",
  "yarn npm publish",
  "pnpm publish",
  "corp-env cdk deploy",
  "corp-env cdk deploy MyStack --require-approval never",
  "corp-env -- cdk deploy MyStack",
  "cdk deploy Prod",
  "npx cdk deploy --all",
  "npx aws-cdk deploy",
  "bunx cdk deploy",
  "corp-env cdk destroy MyStack",
  "cdk destroy",
  // the org's release tool (an org profile CLI rule)
  "corp-deploy MyPipeline start",
  "corp-deploy pipeline promote MyPipeline",
];

const READ_ONLY: string[] = [
  "git log --oneline -5",
  "git -C /tmp/x log",
  "git lg",
  "git status",
  "git diff origin/mainline",
  "git fetch origin",
  "corp-review --help",
  "corp-review -h",
  "corp-review --version",
  "corp-review-pull -w R-456:1",
  "gh pr view 12",
  "gh pr list",
  "gh pr diff 12",
  "gh pr checks 12",
  "glab mr view 3",
  "glab mr list",
  "glab mr diff 3",
  "npm view react version",
  "corp-env cdk diff MyStack",
  "corp-env cdk synth",
  "cdk diff Prod",
  "cdk list",
  "grep -rn 'corp-review --draft' docs",
  "echo corp-review --draft",
];

describe("review CLI uploads are Persona-decidable review holds", () => {
  for (const command of REVIEW) {
    test(command, () => expectPersonaReview(bash(command)));
  }

  test("the reason names a code review upload", () => {
    const v = bash("corp-review --draft");
    expect(v.action === "hold" && v.reason.startsWith("code review upload")).toBe(true);
  });
});

describe("publish, push and remote CLIs are owner-only outward", () => {
  for (const command of OUTWARD) {
    test(command, () => expectOwnerOnlyOutward(bash(command)));
  }
});

describe("read-only lookalikes stay allowed", () => {
  for (const command of READ_ONLY) {
    test(command, () => expect(bash(command)).toEqual({ action: "allow" }));
  }
});

describe("MCP code-review tools", () => {
  test("write actions are owner-only outward, plugin-prefixed or not", () => {
    for (const name of [
      "mcp__corp-mcp__ReviewWrite",
      "mcp__corp-mcp__ReviewCreate",
      "mcp__corp-mcp__ReviewComment",
      "mcp__plugin_corp-agents_corp-mcp__ReviewCreate",
    ]) {
      expectOwnerOnlyOutward(tool(name, { reviewId: "R-1" }));
    }
  });

  test("read actions stay allowed", () => {
    expect(tool("mcp__corp-mcp__ReviewRead", { reviewId: "R-1" })).toEqual({ action: "allow" });
    expect(tool("mcp__corp-mcp__SearchCode")).toEqual({ action: "allow" });
  });
});
