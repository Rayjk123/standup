import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import { FLOOR_GATE, FLOOR_OWNER_GATE } from "./gate.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The org profile's review write tool (corp-mcp's ReviewWrite, action
 * update-description) only rewrites a review's own description or summary,
 * as `corp-review --revise R-… --description …` does, so it is the same
 * `review` hold on gate safety_floor. Every other action of the tool, the
 * tool under another server, and an update-description whose description is
 * a file the floor protects or can't place stay owner-only.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = "/home/tester/code/standup-worktrees/proj/feat-1a2b3c";
const SCRATCH = `${HOME}/.cache/standup-scratch/launch-1`;

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

const FILES: Record<string, string> = {
  [`${ROOT}/d.md`]: "## What\n- x\n",
  [`${ROOT}/.git`]: "gitdir: /tmp/x\n",
  [`${SCRATCH}/review-desc.md`]: "## Intent\n- y\n",
  ["/tmp/review-desc.md"]: "## Intent\n- z\n",
  [`${DATA}/secrets/token.txt`]: "secret\n",
  [`${DATA}/standup.db`]: "",
  [`${DATA}/logs/run.txt`]: "log\n",
};
const DIRS = new Set<string>([ROOT, SCRATCH, "/tmp", "/", DATA, `${DATA}/secrets`, `${DATA}/logs`]);

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

const TOOL = "mcp__corp-mcp__ReviewWrite";
const PLUGIN_TOOL = "mcp__plugin_corp-agents_corp-mcp__ReviewWrite";

type Gate = typeof FLOOR_GATE | typeof FLOOR_OWNER_GATE;
const gateOf = (v: FloorVerdict): Gate | null => (v.action === "hold" ? (v.ownerOnly ? FLOOR_OWNER_GATE : FLOOR_GATE) : null);

describe("update-description is held like `corp-review --revise` on the worker's own review", () => {
  const bash = classify("Bash", { command: "corp-review --revise R-123 --description d.md" });

  test("`corp-review --revise R-123 --description d.md` is a review hold on safety_floor", () => {
    expect(bash.action).toBe("hold");
    if (bash.action !== "hold") return;
    expect(bash.category).toBe("review");
    expect(gateOf(bash)).toBe(FLOOR_GATE);
  });

  const SAME: Array<[string, Record<string, unknown>]> = [
    [TOOL, { action: "update-description", reviewId: "R-123", description: "## Intent\n- tighten the floor\n" }],
    [TOOL, { action: "update-description", reviewId: "R-123", description: `${ROOT}/d.md` }],
    [TOOL, { action: "update-description", reviewId: "R-123", description: `${SCRATCH}/review-desc.md` }],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "/tmp/review-desc.md" }],
    [TOOL, { action: "update-description", reviewId: "R-123", summary: "Floor: hold update-description as a review" }],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "Fix the parser", summary: "Parser fix", revision: 2 }],
    [PLUGIN_TOOL, { action: "update-description", reviewId: "R-123", description: "## Intent\n- x\n" }],
  ];
  for (const [toolName, input] of SAME) {
    test(`${toolName} ${JSON.stringify(input)} gets the same hold as \`corp-review --revise\``, () => {
      const v = classify(toolName, input);
      expect(v.action).toBe("hold");
      if (v.action !== "hold" || bash.action !== "hold") return;
      expect(v.category).toBe(bash.category);
      expect(gateOf(v)).toBe(gateOf(bash));
      expect(!!v.ownerReserved).toBe(!!bash.ownerReserved);
    });
  }
});

describe("the tool's other actions, other servers and unsafe descriptions stay owner-only", () => {
  const OWNER: Array<[string, Record<string, unknown>, FloorCategory]> = [
    [TOOL, { action: "create-comment", reviewId: "R-123", content: "LGTM" }, "outward"],
    [TOOL, { action: "reply-to-comment", reviewId: "R-123", parentRef: "r1p1", content: "done" }, "outward"],
    [TOOL, { action: "update-comment", reviewId: "R-123", ref: "r1p1", content: "x" }, "outward"],
    [TOOL, { action: "resolve-comment", reviewId: "R-123", ref: "r1p1" }, "outward"],
    [TOOL, { action: "delete-comment", reviewId: "R-123", ref: "r1p1" }, "outward"],
    [TOOL, { action: "publish-comments", reviewId: "R-123", revision: 1 }, "outward"],
    [TOOL, { action: "upload-attachment", reviewId: "R-123", filePath: "/tmp/shot.png" }, "outward"],
    [TOOL, { action: "publish-revision", reviewId: "R-123" }, "outward"],
    [TOOL, { action: "add-reviewer", reviewId: "R-123", entityId: "someone" }, "outward"],
    [TOOL, { action: "remove-reviewer", reviewId: "R-123", entityId: "someone" }, "outward"],
    [TOOL, { action: "add-dependency", reviewId: "R-123", dependsOn: "R-1" }, "outward"],
    [TOOL, { action: "remove-dependency", reviewId: "R-123", dependsOn: "R-1", force: true }, "outward"],
    [TOOL, { action: "retry-analyzer", reviewId: "R-123", partnerId: "coverage" }, "outward"],
    [TOOL, { action: "approve", reviewId: "R-123" }, "outward"],
    [TOOL, { action: "merge", reviewId: "R-123" }, "outward"],
    [TOOL, { action: "revise", reviewId: "R-123" }, "outward"],
    [TOOL, { action: "abandon", reviewId: "R-123" }, "outward"],
    [TOOL, { action: "Update-Description", reviewId: "R-123", description: "x" }, "outward"],
    [TOOL, { action: " update-description", reviewId: "R-123", description: "x" }, "outward"],
    [TOOL, { action: ["update-description"], reviewId: "R-123", description: "x" }, "outward"],
    [TOOL, { action: 1, reviewId: "R-123" }, "outward"],
    [TOOL, { reviewId: "R-123", description: "x" }, "outward"],
    [TOOL, { reviewId: "R-1" }, "outward"],
    ["mcp__evil__ReviewWrite", { action: "update-description", reviewId: "R-123", description: "x" }, "outward"],
    ["mcp__plugin_x_evil__ReviewWrite", { action: "update-description", reviewId: "R-123", description: "x" }, "outward"],
    ["mcp__corp-mcp__ReviewCreate", { action: "update-description", reviewId: "R-123", description: "x" }, "outward"],
    ["mcp__corp-mcp__ReviewWriteX", { action: "update-description", reviewId: "R-123", description: "x" }, "outward"],
    // The server reads a description that names a file and posts its contents.
    [TOOL, { action: "update-description", reviewId: "R-123", description: `${DATA}/secrets/token.txt` }, "floor-tamper"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "~/.local/share/standup/secrets/token.txt" }, "floor-tamper"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: `${DATA}/standup.db` }, "floor-tamper"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: `${DATA}/logs/run.txt` }, "outward"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "notes/desc.md" }, "outward"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "desc.md" }, "outward"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "$HOME/desc.md" }, "outward"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: { path: "/tmp/review-desc.md" } }, "outward"],
    [TOOL, { action: "update-description", reviewId: "R-123", description: "see http://localhost:7777/api/asks" }, "collector-api"],
  ];
  for (const [toolName, input, category] of OWNER) {
    test(`${toolName} ${JSON.stringify(input)} stays ${category} on safety_floor_owner`, () => {
      const v = classify(toolName, input);
      expect(v.action).toBe("hold");
      if (v.action !== "hold") return;
      expect(v.category).toBe(category);
      expect(gateOf(v)).toBe(FLOOR_OWNER_GATE);
    });
  }

  test("a secret or DB description is a high-risk hold", () => {
    for (const description of [`${DATA}/secrets/token.txt`, `${DATA}/standup.db`]) {
      const v = classify(TOOL, { action: "update-description", reviewId: "R-123", description });
      expect(v.action).toBe("hold");
      if (v.action !== "hold") return;
      expect(v.ownerReserved).toBe(true);
    }
  });
});
