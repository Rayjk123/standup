import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { FLOOR_ALLOW_OPTION, FLOOR_GATE, FLOOR_OWNER_GATE } from "./gate.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";
import { decide } from "../persona/policy.js";

/*
 * The gate each kind of code-review call reaches; Persona's "Allow once" on
 * either gate runs the call. An upload with the org profile's review CLI
 * (`corp-review`) is a `review` hold on gate safety_floor, and so is its
 * review write tool's update-description, which only rewrites a review's
 * description as `corp-review --revise` does; a call that also pushes,
 * publishes or deploys, and the other code-review MCP writes, stay
 * owner-only `outward` on gate safety_floor_owner.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = "/home/tester/code/standup-worktrees/proj/feat-1a2b3c";

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
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

const FILES: Record<string, string> = { [`${ROOT}/d.md`]: "## What\n- x\n", [`${ROOT}/.git`]: "gitdir: /tmp/x\n" };
const DIRS = new Set<string>([ROOT, "/tmp", "/"]);

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

const classify = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());

type Expected = { action: "allow" } | { category: FloorCategory; gate: typeof FLOOR_GATE | typeof FLOOR_OWNER_GATE };

const SAMPLES: Array<[string, Record<string, unknown>, Expected]> = [
  ["Bash", { command: "corp-review --draft" }, { category: "review", gate: FLOOR_GATE }],
  ["Bash", { command: "corp-review --revise R-1 --draft --description d.md" }, { category: "review", gate: FLOOR_GATE }],
  ["Bash", { command: "corp-review --draft --issue I-1" }, { category: "review", gate: FLOOR_GATE }],
  ["Bash", { command: "git push && corp-review" }, { category: "outward", gate: FLOOR_OWNER_GATE }],
  ["Bash", { command: "corp-review --draft && corp-env cdk deploy MyStack" }, { category: "outward", gate: FLOOR_OWNER_GATE }],
  ["Bash", { command: "git push origin HEAD" }, { category: "outward", gate: FLOOR_OWNER_GATE }],
  ["mcp__corp-mcp__ReviewCreate", { reviewId: "R-1" }, { category: "outward", gate: FLOOR_OWNER_GATE }],
  ["mcp__corp-mcp__ReviewWrite", { reviewId: "R-1" }, { category: "outward", gate: FLOOR_OWNER_GATE }],
  ["mcp__corp-mcp__ReviewWrite", { action: "update-description", reviewId: "R-1", description: `${ROOT}/d.md` }, { category: "review", gate: FLOOR_GATE }],
  ["mcp__corp-mcp__ReviewWrite", { action: "publish-revision", reviewId: "R-1" }, { category: "outward", gate: FLOOR_OWNER_GATE }],
  ["Bash", { command: "corp-review --help" }, { action: "allow" }],
];

describe("code-review calls reach the gate their category gives them", () => {
  for (const [toolName, input, expected] of SAMPLES) {
    test(`${toolName} ${JSON.stringify(input)}`, () => {
      const v = classify(toolName, input);
      if ("action" in expected) {
        expect(v).toEqual({ action: "allow" });
        return;
      }
      expect(v.action).toBe("hold");
      if (v.action !== "hold") return;
      expect(v.category).toBe(expected.category);
      expect(v.ownerOnly ? FLOOR_OWNER_GATE : FLOOR_GATE).toBe(expected.gate);
      const allow = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: expected.gate, floorCategory: v.category, text: FLOOR_ALLOW_OPTION });
      expect(allow.rule).toBe("act");
    });
  }
});
