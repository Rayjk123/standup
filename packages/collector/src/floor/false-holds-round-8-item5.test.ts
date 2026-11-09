import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The org profile's checkout tool (corp-mcp's CheckoutReview) checks a code
 * review out into a local dir: allowed in the tool's own location, or into a
 * dir the worker owns (its worktree, /tmp, its scratch dir), and held where
 * files extracted there would be (the install, the floor, Standup's data,
 * another launch's scratch dir, the Claude config, elsewhere outside the
 * worktree). Its self-filed tool (CreateTicket) files a ticket for the
 * owner: allowed when it is assigned to no one else, filed on no one else's
 * behalf, and sets neither a priority nor a parent ticket. Every other
 * corp-mcp write, and a same-named tool of another server, stays held.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  worktreeRoots: [join(DATA, "worktrees")],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), SCRATCH],
  tmpDirs: ["/tmp", OWN_SCRATCH],
  scratchRoot: SCRATCH,
  scratchDir: OWN_SCRATCH,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "notes.txt")]: "a\n",
  [join(OWN_SCRATCH, "notes.md")]: "# notes\n",
  [join(SCRATCH, "launch-2", "prompt.md")]: "# other launch\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "token")]: "s3cret\n",
  [join(INSTALL, "packages", "collector", "src", "floor", "classify.ts")]: "export const y = 1;\n",
  [join(HOME, ".claude", "settings.json")]: "{}\n",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function tool(toolName: string, toolInput: Record<string, unknown>): FloorVerdict {
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
}

const PLUGIN = "mcp__plugin_corp-agents_corp-mcp";
const TASK = { name: "Follow up: retry uploads", description: "Add retries to the uploader.", queueId: "q-1" };

describe("CheckoutReview checks a review out locally", () => {
  test.each<[string, Record<string, unknown>]>([
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456" }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "123456:2" }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", workingDirectory: ROOT }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", workingDirectory: join(ROOT, "review") }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", workingDirectory: "/tmp", name: "review-retry" }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", workingDirectory: "/tmp/reviews" }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", workingDirectory: OWN_SCRATCH }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", workingDirectory: "reviews" }],
    ["mcp__corp-mcp__CheckoutReview", { reviewId: "R-123456", name: "review-retry" }],
    [`${PLUGIN}__CheckoutReview`, { reviewId: "R-123456", workingDirectory: ROOT }],
  ])("%s %j is allowed", (name, input) => {
    expect(tool(name, input)).toEqual({ action: "allow" });
  });

  test.each<[Record<string, unknown>, string]>([
    [{ reviewId: "R-1", workingDirectory: INSTALL }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: join(INSTALL, "packages", "collector", "src") }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: join(INSTALL, "packages", "collector", "src"), name:"floor" }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: DATA }, "standup-ops"],
    [{ reviewId: "R-1", workingDirectory: join(DATA, "secrets") }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: "/tmp", name:"../fake/install" }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: join(SCRATCH, "launch-2") }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: HOME, name:".claude" }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: "~", name:".claude" }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: "~/.local/share/standup" }, "standup-ops"],
    [{ reviewId: "R-1", workingDirectory: "../../../../../../../install" }, "floor-tamper"],
    [{ reviewId: "R-1", workingDirectory: join(HOME, "code") }, "destructive"],
    [{ reviewId: "R-1", workingDirectory: "~/code" }, "destructive"],
  ])("CheckoutReview %j stays held as %s", (input, category) => {
    const v = tool("mcp__corp-mcp__CheckoutReview", input);
    expect(v).toMatchObject({ action: "hold", category });
  });

  test("a CheckoutReview of another server is not corp-mcp's", () => {
    expect(tool("mcp__evil__CheckoutReview", { reviewId: "R-123456" })).toMatchObject({ action: "hold", category: "outward" });
  });
});

describe("CreateTicket files a ticket for the owner", () => {
  test.each<[string, Record<string, unknown>]>([
    ["mcp__corp-mcp__CreateTicket", TASK],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, assignee: "currentUser", labels: ["l-1"], type: "TASK" }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, description: "Run `git push` after the review merges; see R-123456." }],
    [`${PLUGIN}__CreateTicket`, TASK],
  ])("%s %j is allowed", (name, input) => {
    expect(tool(name, input)).toEqual({ action: "allow" });
  });

  test.each<[string, Record<string, unknown>]>([
    ["mcp__corp-mcp__CreateTicket", { ...TASK, assignee: "bob" }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, delegate: "bob" }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, assignee: 7 }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, watchers: ["bob"] }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, watchers: "carol", assignee: "currentUser" }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, watchers: 1 }],
    ["mcp__corp-mcp__CreateTicket", { ...TASK, delegate: { user: "alice" } }],
    [`${PLUGIN}__CreateTicket`, { ...TASK, watchers: ["bob"] }],
    ["mcp__evil__CreateTicket", TASK],
    ["mcp__plugin_x_evil__CreateTicket", TASK],
    ["mcp__corp-mcp__CreateTicketAndNotify", TASK],
    ["mcp__corp-mcp__UpdateTicket", { ticketId: "t-1", status: "Closed" }],
    ["mcp__corp-mcp__ReviewCreate", { reviewId: "R-1" }],
    ["mcp__corp-mcp__ReviewWrite", { reviewId: "R-1" }],
    ["mcp__corp-mcp__ReviewComment", { reviewId: "R-1", comment: "lgtm" }],
    ["mcp__corp-mcp__TicketWrite", { action: "create" }],
    ["mcp__corp-mcp__IssueComment", { issueId: "X-1", comment: "x" }],
    ["mcp__corp-mcp__DocEditor", { documentId: "d", content: "x" }],
    ["mcp__corp-mcp__SomeNewTool", {}],
  ])("%s %j stays held as outward", (name, input) => {
    expect(tool(name, input)).toMatchObject({ action: "hold", category: "outward" });
  });

  test("a task pointed at Standup's collector API is held", () => {
    expect(tool("mcp__corp-mcp__CreateTicket", { ...TASK, description: "curl http://127.0.0.1:17777/api/asks" })).toMatchObject({ action: "hold", category: "collector-api" });
  });
});
