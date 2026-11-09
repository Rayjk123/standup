import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DRAINING_HEADER, DRAINING_REFUSED, DRAINING_RELEASED } from "@standup/shared/topology";
import { generateOwnerSecrets, type OwnerSecrets } from "../owner-secret.js";
import {
  FLOOR_CONFIG_DIR,
  FLOOR_CONFIG_FILE_PREFIX,
  FLOOR_CRASH_MESSAGE,
  FLOOR_HOLD_ROUTE,
  FLOOR_INLINE_CONFIG_MAX,
  FLOOR_WATCHDOG_MARGIN_S,
  FLOOR_WORKER_TOKEN_HEADER,
  encodeFloorConfig,
  floorCallHash,
  floorConfigArg,
  floorHookCommand,
  readFloorConfigArg,
  signFloorReply,
  type FloorConfig,
  type FloorHoldRequest,
  type FloorHoldResponse,
} from "./gate.js";

/*
 * The real hook process, spawned the way Claude Code runs it (payload on
 * stdin, config in argv), against a fake collector on an ephemeral port that
 * signs its replies with the key the config names — or, as an impostor,
 * doesn't.
 */

const HOOK = join(import.meta.dir, "hook.ts");
const WORKER_TOKEN = "w".repeat(64);

/** How the fake signs a reply: with the config's key, another key, over another call, or not at all. */
type Signing = "valid" | "none" | "wrong-key" | "wrong-call" | "garbage";

/** A reply, optionally sent after `delayMs` (a held long-poll) with extra headers; "hang" never answers. */
type Reply = { status?: number; body: Partial<FloorHoldResponse>; signing?: Signing; delayMs?: number; headers?: Record<string, string> } | "hang";

interface FakeCollector {
  url: string;
  requests: FloorHoldRequest[];
  headers: Headers[];
  /** Replies served in order; the last one repeats. */
  replies: Reply[];
  stop(): void;
}

const secrets: OwnerSecrets = generateOwnerSecrets();
const otherSecrets: OwnerSecrets = generateOwnerSecrets();

function fakeCollector(port = 0): FakeCollector {
  const fake: FakeCollector = { url: "", requests: [], headers: [], replies: [], stop: () => {} };
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== FLOOR_HOLD_ROUTE) return new Response("not found", { status: 404 });
      const request = (await req.json()) as FloorHoldRequest;
      fake.requests.push(request);
      fake.headers.push(req.headers);
      const reply = fake.replies[Math.min(fake.requests.length - 1, fake.replies.length - 1)] ?? { body: { decision: "deny", askId: "a", answer: "" } };
      if (reply === "hang") return new Promise<Response>(() => {});
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      const body: Partial<FloorHoldResponse> = { ...reply.body };
      const signing = reply.signing ?? "valid";
      if (signing !== "none" && body.decision && typeof body.askId === "string" && typeof body.answer === "string") {
        const callHash =
          signing === "wrong-call"
            ? floorCallHash({ toolName: "Bash", toolInput: { command: "something else" }, cwd: request.cwd })
            : floorCallHash({ toolName: request.tool_name, toolInput: request.tool_input, cwd: request.cwd });
        const key = signing === "wrong-key" ? otherSecrets.replyPrivateKey : secrets.replyPrivateKey;
        body.signature =
          signing === "garbage"
            ? "not-a-signature"
            : signFloorReply(key, { requestId: request.request_id, askId: body.askId, decision: body.decision, answer: body.answer, callHash });
      }
      return Response.json(body, { status: reply.status ?? 200, headers: reply.headers ?? {} });
    },
  });
  fake.url = `http://localhost:${server.port}`;
  fake.stop = () => server.stop(true);
  return fake;
}

let root: string;
let collector: FakeCollector;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "floor-hook-test-"));
  collector = fakeCollector();
});

afterAll(() => {
  collector.stop();
  rmSync(root, { recursive: true, force: true });
});

function configFor(collectorUrl: string, waitSeconds = 20): FloorConfig {
  return {
    v: 1,
    collectorUrl,
    launchId: "launch-1",
    root,
    sharedBranches: ["main"],
    personalAwsAccounts: [],
    waitSeconds,
    standupDataDir: join(root, "standup-data"),
    floorPaths: [join(import.meta.dir)],
    installDir: join(root, "install"),
    protectedPaths: [join(root, "standup-data", "secrets")],
    tmpDirs: ["/tmp", "/var/tmp"],
    workerToken: WORKER_TOKEN,
    replyPublicKey: secrets.replyPublicKey,
  };
}

function payload(command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/dev/null",
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_123",
    ...extra,
  });
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  decision?: string;
  reason?: string;
}

function parseRun(code: number, stdout: string, stderr: string, started: number): Run {
  const run: Run = { code, stdout, stderr, ms: performance.now() - started };
  if (stdout.trim()) {
    const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    run.decision = out.hookSpecificOutput.permissionDecision;
    run.reason = out.hookSpecificOutput.permissionDecisionReason;
  }
  return run;
}

async function runHook(args: string[], stdin: string, env: Record<string, string> = {}): Promise<Run> {
  const started = performance.now();
  const proc = Bun.spawn([process.execPath, HOOK, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return parseRun(code, stdout, stderr, started);
}

/** Runs the full hook command through `sh -c`, as Claude Code does, from `cwd`. */
async function runCommand(command: string, stdin: string, cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const started = performance.now();
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return parseRun(code, stdout, stderr, started);
}

function encoded(waitSeconds?: number, url = collector.url): string {
  return encodeFloorConfig(configFor(url, waitSeconds));
}

describe("floor hook", () => {
  test("an ordinary call is allowed without touching the collector", async () => {
    collector.requests.length = 0;
    const r = await runHook([encoded()], payload("ls -la && bun test"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(collector.requests).toHaveLength(0);
  });

  test("a StructuredOutput result is allowed whatever its size or text; an unlisted tool with the same input is held", async () => {
    const finding = { title: "git push origin main then deploy", detail: "aws s3 cp ./dist s3://bucket/ --recursive && rm -rf ~/.cache && tmux kill-server" };
    const toolInput = { findings: Array.from({ length: 200 }, (_, i) => ({ ...finding, id: i })) };
    expect(JSON.stringify(toolInput).length).toBeGreaterThan(20000);
    collector.requests.length = 0;
    const allowed = await runHook([encoded()], payload("", { tool_name: "StructuredOutput", tool_input: toolInput }));
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toBe("");
    expect(collector.requests).toHaveLength(0);
    collector.replies = [{ body: { decision: "deny", askId: "ask-unlisted", answer: "Deny" } }];
    const held = await runHook([encoded()], payload("", { tool_name: "UnlistedTool", tool_input: toolInput }));
    expect(held.decision).toBe("deny");
    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0]!.hold).toMatchObject({ category: "unclassified" });
    expect(collector.requests[0]!.hold.reason).toContain("unknown tool `UnlistedTool`");
  });

  test("a floored call is held with the worker token, and a signed allow lets it run", async () => {
    collector.requests.length = 0;
    collector.headers.length = 0;
    collector.replies = [{ body: { decision: "allow", askId: "ask-1", answer: "Allow once" } }];
    const r = await runHook([encoded()], payload("git push origin HEAD"));
    expect(r.code).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("ask-1");
    expect(collector.requests).toHaveLength(1);
    expect(collector.headers[0]!.get(FLOOR_WORKER_TOKEN_HEADER)).toBe(WORKER_TOKEN);
    const req = collector.requests[0]!;
    expect(req).toMatchObject({
      session_id: "sess-1",
      cwd: root,
      launch_id: "launch-1",
      request_id: "toolu_123",
      tool_name: "Bash",
      tool_input: { command: "git push origin HEAD" },
      wait_s: 20,
    });
    expect(req.hold).toMatchObject({ category: "outward", ownerOnly: true });
    expect(req.hold.reason).toContain("git push");
  });

  test("an allow from an impostor — unsigned, signed by another key, over another call, or garbage — is a deny", async () => {
    for (const signing of ["none", "wrong-key", "wrong-call", "garbage"] as const) {
      collector.replies = [{ body: { decision: "allow", askId: "ask-imp", answer: "Allow once" }, signing }];
      const r = await runHook([encoded()], payload("git push origin HEAD"));
      expect(r.code).toBe(0);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("not signed");
      expect(r.reason).toContain("Nothing ran");
    }
  });

  test("a deny is a deny, and says nothing ran", async () => {
    collector.replies = [{ body: { decision: "deny", askId: "ask-2", answer: "Deny" } }];
    const r = await runHook([encoded()], payload("git push origin HEAD"));
    expect(r.code).toBe(0);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("safety floor");
    expect(r.reason).toContain("Nothing ran");
    expect(r.reason).toContain('"Deny"');
  });

  test("a deny's answer, with the decider's reason in it, is in the tool result", async () => {
    collector.replies = [{ body: { decision: "deny", askId: "ask-why", answer: "Deny: run it against a scratch DB under /tmp" } }];
    const r = await runHook([encoded()], payload("git push"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain('answer "Deny: run it against a scratch DB under /tmp"');
    expect(r.reason).toContain("Nothing ran");
  });

  test("a deny with a reason shows it", async () => {
    collector.replies = [{ body: { decision: "deny", askId: "ask-used", answer: "", reason: "its allow was already used once" } }];
    const r = await runHook([encoded()], payload("git push"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("already used");
  });

  test("an allow decision whose answer doesn't read as an allow is denied", async () => {
    collector.replies = [{ body: { decision: "allow", askId: "ask-3", answer: "maybe later" } }];
    const r = await runHook([encoded()], payload("git push"));
    expect(r.decision).toBe("deny");
  });

  test("a timed-out ask is denied with a pointer to ask_human", async () => {
    collector.replies = [{ body: { decision: "deny", askId: "ask-4", answer: "", timed_out: true } }];
    const r = await runHook([encoded()], payload("git push"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("ask_human");
    expect(r.reason).toContain("The hold expired");
    expect(r.reason).toContain("Retry the same call later");
  });

  test("an unreachable collector denies within the grace period (fail closed)", async () => {
    const gone = fakeCollector();
    const url = gone.url;
    gone.stop();
    const r = await runHook([encoded(20, url)], payload("git push"), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "700" });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("could not be reached");
    expect(r.reason).toContain("transient");
    expect(r.reason).toContain("retry the same call");
    expect(r.ms).toBeLessThan(5000);
  });

  test("a collector that comes back within the grace period (a restart) gets the ask, and its decision is honored", async () => {
    const first = fakeCollector();
    const port = Number(new URL(first.url).port);
    first.stop();
    const run = runHook([encoded(20, first.url)], payload("git push"), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "15000" });
    await Bun.sleep(1500);
    const back = fakeCollector(port);
    back.replies = [{ body: { decision: "allow", askId: "ask-back", answer: "yes" } }];
    const r = await run;
    back.stop();
    expect(r.decision).toBe("allow");
    expect(back.requests).toHaveLength(1);
    expect(r.ms).toBeGreaterThan(1400);
  });

  test("a 5xx is retried with the same request id and the later decision honored", async () => {
    collector.requests.length = 0;
    collector.replies = [
      { status: 503, body: { decision: "deny", askId: "x", answer: "" }, signing: "none" },
      { status: 500, body: { decision: "deny", askId: "x", answer: "" }, signing: "none" },
      { body: { decision: "allow", askId: "ask-5", answer: "yes" } },
    ];
    const r = await runHook([encoded()], payload("git push", { tool_use_id: "toolu_retry" }));
    expect(r.decision).toBe("allow");
    expect(collector.requests.map((q) => q.request_id)).toEqual(["toolu_retry", "toolu_retry", "toolu_retry"]);
  });

  // The unreachable grace is shortened to 700ms, so a hold held for 1.5s
  // stands in for one a drain releases after a minute of waiting.
  test("a hold a draining collector releases after waiting past the grace re-attaches at once and returns the decision", async () => {
    collector.requests.length = 0;
    collector.replies = [
      { status: 503, delayMs: 1500, headers: { [DRAINING_HEADER]: DRAINING_RELEASED }, body: { decision: "deny", askId: "", answer: "" }, signing: "none" },
      { body: { decision: "allow", askId: "ask-drained", answer: "Allow once" } },
    ];
    const r = await runHook([encoded()], payload("git push", { tool_use_id: "toolu_drain" }), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "700" });
    expect(r.decision).toBe("allow");
    expect(r.reason).toContain("ask-drained");
    expect(collector.requests.map((q) => q.request_id)).toEqual(["toolu_drain", "toolu_drain"]);
    expect(r.ms).toBeLessThan(1500 + 1000);
  });

  test("repeated releases keep re-attaching under the same id until a decision arrives", async () => {
    collector.requests.length = 0;
    const released: Reply = { status: 503, delayMs: 900, headers: { [DRAINING_HEADER]: DRAINING_RELEASED }, body: { decision: "deny", askId: "", answer: "" }, signing: "none" };
    collector.replies = [released, released, { body: { decision: "deny", askId: "ask-r", answer: "Deny" } }];
    const r = await runHook([encoded()], payload("git push", { tool_use_id: "toolu_rr" }), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "700" });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain('"Deny"');
    expect(collector.requests.map((q) => q.request_id)).toEqual(["toolu_rr", "toolu_rr", "toolu_rr"]);
  });

  test("a 5xx after a held wait longer than the grace is retried, not treated as unreachable", async () => {
    collector.requests.length = 0;
    collector.replies = [
      { status: 503, delayMs: 1500, headers: { [DRAINING_HEADER]: DRAINING_REFUSED }, body: { decision: "deny", askId: "", answer: "" }, signing: "none" },
      { body: { decision: "allow", askId: "ask-6", answer: "yes" } },
    ];
    const r = await runHook([encoded()], payload("git push", { tool_use_id: "toolu_5xx" }), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "700" });
    expect(r.decision).toBe("allow");
    expect(collector.requests.map((q) => q.request_id)).toEqual(["toolu_5xx", "toolu_5xx"]);
  });

  test("a released hold whose collector then stays unreachable past the grace fails closed", async () => {
    const draining = fakeCollector();
    draining.replies = [
      { status: 503, delayMs: 300, headers: { [DRAINING_HEADER]: DRAINING_RELEASED }, body: { decision: "deny", askId: "", answer: "" }, signing: "none" },
      "hang",
    ];
    const run = runHook([encoded(20, draining.url)], payload("git push", { tool_use_id: "toolu_gone" }), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "700" });
    for (let i = 0; i < 100 && draining.requests.length < 2; i++) await Bun.sleep(50);
    expect(draining.requests.map((q) => q.request_id)).toEqual(["toolu_gone", "toolu_gone"]);
    draining.stop();
    const r = await run;
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("could not be reached");
    expect(r.ms).toBeLessThan(5000);
  });

  test("connection-refused retries pick the hold back up once the collector is listening again within the grace", async () => {
    const first = fakeCollector();
    const port = Number(new URL(first.url).port);
    first.stop();
    const run = runHook([encoded(20, `http://localhost:${port}`)], payload("git push", { tool_use_id: "toolu_back" }), { STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "3000" });
    await Bun.sleep(800);
    const back = fakeCollector(port);
    back.replies = [{ body: { decision: "allow", askId: "ask-back", answer: "Allow once" } }];
    try {
      const r = await run;
      expect(r.decision).toBe("allow");
      expect(back.requests.map((q) => q.request_id)).toEqual(["toolu_back"]);
    } finally {
      back.stop();
    }
  });

  test("a 4xx is denied with the collector's error", async () => {
    collector.replies = [{ status: 403, body: { decision: "deny", askId: "", answer: "" }, signing: "none" }];
    const r = await runHook([encoded()], payload("git push"));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("403");
  });

  test("no decision before the deadline is a deny", async () => {
    collector.replies = ["hang"];
    const r = await runHook([encodeFloorConfig({ ...configFor(collector.url), waitSeconds: 0.5 })], payload("git push"), {});
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("in time");
    expect(r.ms).toBeLessThan(8000);
  }, 15_000);

  test("without a tool_use_id each call gets its own random request id", async () => {
    collector.requests.length = 0;
    collector.replies = [{ body: { decision: "deny", askId: "a", answer: "Deny" } }];
    const p = payload("git push", { tool_use_id: undefined });
    await runHook([encoded()], p);
    await runHook([encoded()], p);
    const [a, b] = collector.requests.map((q) => q.request_id);
    expect(a).toMatch(/^floor-[0-9a-f-]{36}$/);
    expect(b).toMatch(/^floor-[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  test("a malformed config denies, including one without the worker token or reply key", async () => {
    const { workerToken: _w, ...noToken } = configFor(collector.url);
    const { replyPublicKey: _k, ...noKey } = configFor(collector.url);
    const bad = [
      "",
      "not-base64!",
      Buffer.from('{"v":2}').toString("base64url"),
      Buffer.from(JSON.stringify(noToken)).toString("base64url"),
      Buffer.from(JSON.stringify(noKey)).toString("base64url"),
    ];
    for (const b of bad) {
      const r = await runHook([b], payload("ls"));
      expect(r.code).toBe(0);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("configuration");
    }
  });

  test("garbage stdin denies", async () => {
    for (const bad of ["", "not json", "[]", '{"tool_input":{}}']) {
      const r = await runHook([encoded()], bad);
      expect(r.code).toBe(0);
      expect(r.decision).toBe("deny");
    }
  });

  test("a hook that can't start exits 2 through the command wrapper", async () => {
    const command = floorHookCommand(configFor(collector.url), "/nonexistent/bun", HOOK);
    const r = await runCommand(command, payload("ls"), root);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(FLOOR_CRASH_MESSAGE);
  });
});

describe("the hook command", () => {
  test("runs from the floor dir with .env autoload off, its own bunfig, option env unset, under a watchdog", () => {
    const config = configFor(collector.url, 120);
    const command = floorHookCommand(config, "/opt/bun", "/opt/standup/floor/hook.ts");
    expect(command).toStartWith("cd '/opt/standup/floor' && unset BUN_OPTIONS NODE_OPTIONS NODE_PATH && ");
    expect(command).toContain("if command -v timeout >/dev/null 2>&1; then timeout -s KILL ");
    expect(command).toContain(`timeout -s KILL ${120 + FLOOR_WATCHDOG_MARGIN_S} '/opt/bun' --no-env-file '--config=/opt/standup/floor/bunfig.toml' '/opt/standup/floor/hook.ts' `);
    // Without coreutils `timeout` (stock macOS) the same invocation runs unwatched.
    expect(command).toContain("; else '/opt/bun' --no-env-file '--config=/opt/standup/floor/bunfig.toml' '/opt/standup/floor/hook.ts' ");
    expect(command).toEndWith(`|| { echo '${FLOOR_CRASH_MESSAGE}' >&2; exit 2; }`);
  });

  test("a config too large to carry inline is passed as a 0600 file the hook reads", async () => {
    const config = { ...configFor(collector.url), foreignRoots: Array.from({ length: 400 }, (_, i) => `/home/u/code/standup-worktrees/project/launch-${i}`) };
    const small = floorConfigArg(configFor(collector.url));
    expect(small).toBe(encodeFloorConfig(configFor(collector.url)));

    const arg = floorConfigArg(config);
    expect(arg).toStartWith(FLOOR_CONFIG_FILE_PREFIX);
    const file = arg.slice(FLOOR_CONFIG_FILE_PREFIX.length);
    expect(file).toBe(join(config.standupDataDir, FLOOR_CONFIG_DIR, "launch-1.b64"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFloorConfigArg(arg)).toEqual(config);

    const command = floorHookCommand(config, process.execPath, HOOK);
    expect(command.length).toBeLessThan(FLOOR_INLINE_CONFIG_MAX);
    const ordinary = await runCommand(command, payload("ls"), root);
    expect(ordinary.code).toBe(0);
    expect(ordinary.stdout).toBe("");

    collector.replies = [{ body: { decision: "allow", askId: "ask-file", answer: "Allow once" } }];
    const floored = await runCommand(command, payload("git push"), root);
    expect(floored.decision).toBe("allow");
  });

  test("a config file that is missing denies", async () => {
    const r = await runHook([`${FLOOR_CONFIG_FILE_PREFIX}${join(root, "no-such-config.b64")}`], payload("ls"));
    expect(r.code).toBe(0);
    expect(r.decision).toBe("deny");
  });

  test("the hook ignores a bunfig.toml preload, a .env and BUN_OPTIONS in the worker's cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "floor-evil-cwd-"));
    const marker = join(cwd, "preload-ran");
    try {
      writeFileSync(join(cwd, "evil.ts"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); console.log("PRELOADED");\n`);
      writeFileSync(join(cwd, "bunfig.toml"), `preload = [${JSON.stringify(join(cwd, "evil.ts"))}]\n`);
      writeFileSync(join(cwd, ".env"), "STANDUP_FLOOR_UNREACHABLE_GRACE_MS=1\n");
      const env = { BUN_OPTIONS: `--preload ${join(cwd, "evil.ts")}` };

      // An ordinary call: allowed by printing nothing, and nothing preloaded.
      const command = floorHookCommand(configFor(collector.url), process.execPath, HOOK);
      const ordinary = await runCommand(command, payload("ls"), cwd, env);
      expect(ordinary.code).toBe(0);
      expect(ordinary.stdout).toBe("");
      expect(existsSync(marker)).toBe(false);

      // A floored call still reads the collector's signed decision.
      collector.replies = [{ body: { decision: "allow", askId: "ask-cwd", answer: "Allow once" } }];
      const floored = await runCommand(command, payload("git push"), cwd, env);
      expect(floored.decision).toBe("allow");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the command's cwd is the floor dir and a .env there or in the worker's cwd is not loaded", async () => {
    const floorDir = mkdtempSync(join(tmpdir(), "floor-probe-dir-"));
    const cwd = mkdtempSync(join(tmpdir(), "floor-probe-cwd-"));
    try {
      const probe = join(floorDir, "hook.ts");
      writeFileSync(probe, `console.log(JSON.stringify({ cwd: process.cwd(), probe: process.env.FLOOR_PROBE ?? null }));\n`);
      writeFileSync(join(floorDir, "bunfig.toml"), "");
      writeFileSync(join(floorDir, ".env"), "FLOOR_PROBE=floor-dir\n");
      writeFileSync(join(cwd, ".env"), "FLOOR_PROBE=worker-cwd\n");
      mkdirSync(join(cwd, "sub"));
      const proc = Bun.spawn(["sh", "-c", floorHookCommand(configFor(collector.url), process.execPath, probe)], {
        cwd: join(cwd, "sub"),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const seen = JSON.parse(stdout) as { cwd: string; probe: string | null };
      expect(realpathSync(seen.cwd)).toBe(realpathSync(floorDir));
      expect(seen.probe).toBeNull();
    } finally {
      rmSync(floorDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("floor hook: worktree-isolated subagents", () => {
  /** A repository at `dir` with one commit, and a linked worktree of it at `${dir}-wt`. */
  function repoWithWorktree(dir: string): string {
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    mkdirSync(dir, { recursive: true });
    git("-C", dir, "init", "-q");
    git("-C", dir, "commit", "-q", "--allow-empty", "-m", "init");
    git("-C", dir, "worktree", "add", "-q", "-b", "feat", `${dir}-wt`);
    return `${dir}-wt`;
  }

  let installWorktree: string;
  let otherWorktree: string;
  beforeAll(() => {
    installWorktree = repoWithWorktree(join(root, "install"));
    otherWorktree = repoWithWorktree(join(root, "other-repo"));
  });

  function agentCall(cwd: string, toolInput: Record<string, unknown>, toolName = "Agent"): string {
    return payload("", { cwd, tool_name: toolName, tool_input: { description: "d", prompt: "p", ...toolInput } });
  }

  test("Agent and Task with isolation worktree from a worktree of the install are denied without a hold", async () => {
    collector.requests.length = 0;
    for (const tool of ["Agent", "Task"]) {
      const r = await runHook([encoded()], agentCall(installWorktree, { isolation: "worktree" }, tool));
      expect(r.code).toBe(0);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain("isolation:'worktree' would create the subagent's worktree inside the live Standup install");
    }
    expect(collector.requests).toHaveLength(0);
  });

  test("the install's own checkout is refused too", async () => {
    const r = await runHook([encoded()], agentCall(join(root, "install"), { isolation: "worktree" }));
    expect(r.decision).toBe("deny");
  });

  test("Agent without isolation is allowed", async () => {
    const r = await runHook([encoded()], agentCall(installWorktree, {}));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("isolation worktree in a repository that isn't the install is allowed", async () => {
    const r = await runHook([encoded()], agentCall(otherWorktree, { isolation: "worktree" }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("other tools carrying an isolation field are not refused", async () => {
    const r = await runHook([encoded()], agentCall(installWorktree, { isolation: "worktree" }, "TodoWrite"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a worker that changed directory out of the install's worktree is still refused via its project dir", async () => {
    const call = agentCall("/tmp", { isolation: "worktree" });
    const moved = await runHook([encoded()], call, { CLAUDE_PROJECT_DIR: installWorktree });
    expect(moved.decision).toBe("deny");
    const unrelated = await runHook([encoded()], call, { CLAUDE_PROJECT_DIR: otherWorktree });
    expect(unrelated.stdout).toBe("");
  });

  test("EnterWorktree from a worktree of the install is denied; from another repository it is allowed", async () => {
    const denied = await runHook([encoded()], payload("", { cwd: installWorktree, tool_name: "EnterWorktree", tool_input: {} }), {
      CLAUDE_PROJECT_DIR: "",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("EnterWorktree would create a worktree inside the live Standup install");
    const allowed = await runHook([encoded()], payload("", { cwd: otherWorktree, tool_name: "EnterWorktree", tool_input: {} }), {
      CLAUDE_PROJECT_DIR: "",
    });
    expect(allowed.stdout).toBe("");
  });

  test("a Workflow whose script spawns isolation worktree agents from the install's worktree is denied", async () => {
    const workflow = (script: string) =>
      payload("", { cwd: installWorktree, tool_name: "Workflow", tool_input: { script } });
    const denied = await runHook([encoded()], workflow("await agent({ prompt: 'p', isolation: 'worktree' })"), {
      CLAUDE_PROJECT_DIR: "",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("this workflow spawns agents with isolation:'worktree'");
    const allowed = await runHook([encoded()], workflow("await agent({ prompt: 'p' })"), { CLAUDE_PROJECT_DIR: "" });
    expect(allowed.stdout).toBe("");
  });
});
