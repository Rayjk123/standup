#!/usr/bin/env bun
/*
 * Live-update regression suite for the Standup console, on a throwaway
 * install: a scratch collector with its own data dir, owner token, project,
 * git repo, tmux server and ports; the console's dev server proxied to it; and
 * headless Chromium signed in with a login code minted from the scratch token.
 * Every `claude` the collector runs is fake-claude.ts: Persona turns answer
 * through the real Persona tool route, launched workers idle in their panes.
 *
 *   bun packages/web/e2e/live-updates.e2e.ts [--playwright /path/to/node_modules/playwright]
 *     [--api-port N --ws-port N --web-port N --relay-port N] [--out /dir] [--keep]
 *
 * Playwright comes from --playwright, else $STANDUP_PLAYWRIGHT, else
 * /tmp/standup-pw/node_modules/playwright. Ports are picked free at run time
 * unless given; the live install's ports are refused. Everything the run
 * writes lives in /tmp/standup-live-e2e-<run>, removed at the end (kept with
 * --keep); the matrix, screenshots and collector logs go to --out (default
 * /tmp/standup-live-e2e-out-<run>).
 *
 * The browser's socket reaches the collector through a TCP relay that can go
 * silent (stop forwarding both ways on the connections it holds, without
 * closing them) or drop (close every connection and refuse new ones until
 * restored).
 *
 * Surfaces (each one a change the console must show without a reload):
 *   a  a Persona reply
 *   b  a worker transcript event
 *   c  an approval card appearing and another being approved; a worker
 *      ask_human raising the alert strip
 *   d  a job's status changing; a job tag added to one message and removed
 *      from another
 *   e  a review packet arriving in the Review tab
 *   f  a pipeline stage change
 * Conditions (one episode each: every surface is triggered while it holds):
 *   1  steady state
 *   2  a silently dead socket
 *   3  a collector restart
 *   4  a hidden tab with throttled timers whose socket goes silent, shown again
 *   5  a network drop (relay closed and refusing, browser offline), restored
 * The page is loaded once at boot; any reload or unexpected navigation after
 * that fails the episode. The exit code is non-zero on any failure.
 */
import { createHmac, randomBytes, randomUUID } from "crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import type { Socket, Subprocess } from "bun";
import type { Browser, BrowserContext, Page } from "playwright";
import { refuseLiveInstall } from "./seed-realistic";
import { liveWorkersPath } from "../src/lib/liveWorkers";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const SCRATCH = `/tmp/standup-live-e2e-${RUN}`;
const OUT = resolve(opt("out") ?? `/tmp/standup-live-e2e-out-${RUN}`);
const KEEP = process.argv.includes("--keep");
const PLAYWRIGHT = opt("playwright") ?? process.env.STANDUP_PLAYWRIGHT ?? "/tmp/standup-pw/node_modules/playwright";
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const BUN = process.execPath;

// The live install's console, collector, socket and test-console ports, and the range its second collectors use.
const REFUSED_PORTS = [7777, 7778, 5173, 5199, 15173];
const REFUSED_RANGE = { from: 7787, to: 7858 };
function refusedPort(port: number): boolean {
  return REFUSED_PORTS.includes(port) || (port >= REFUSED_RANGE.from && port <= REFUSED_RANGE.to);
}

async function portFree(port: number): Promise<boolean> {
  for (const hostname of ["127.0.0.1", "::1"]) {
    const taken = await Bun.connect({ hostname, port, socket: { data() {}, open(s) { s.end(); }, error() {} } }).then(
      () => true,
      () => false
    );
    if (taken) return false;
  }
  return true;
}

async function pickPort(name: string, taken: Set<number>): Promise<number> {
  const given = opt(name);
  if (given) {
    const port = Number(given);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--${name} ${given} is not a port`);
    if (refusedPort(port)) throw new Error(`--${name} ${port} belongs to the live install`);
    if (taken.has(port) || !(await portFree(port))) throw new Error(`--${name} ${port} is already in use`);
    taken.add(port);
    return port;
  }
  for (let i = 0; i < 50; i++) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    if (!refusedPort(port) && !taken.has(port) && (await portFree(port))) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port for ${name}`);
}

// Settings no process of this run may inherit: Slack and ntfy delivery, the
// caller's Persona and worker credentials, its tmux server, and a bind host
// that would take the scratch collector off loopback.
const DROPPED_ENV = new Set([
  "STANDUP_PERSONA",
  "STANDUP_WORKER_TOKEN_FILE",
  "STANDUP_PERSONAL_AWS_ACCOUNTS",
  "TMUX",
  "TMUX_PANE",
  "STANDUP_BIND_HOST",
]);
const droppedEnvKey = (k: string) => DROPPED_ENV.has(k) || k.startsWith("SLACK_") || k.startsWith("NTFY_");
// The only settings a child of this run takes from the caller's environment;
// everything else a child sees is set below, pointing into the run dir.
const INHERITED_ENV = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"] as const;
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(INHERITED_ENV.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
}
// What this process (which hosts vite and drives Playwright) drops besides:
// every Standup setting, the live install's paths and ports, Claude config,
// embedding provider and AWS credentials. Its own Standup settings for the
// run are set later, pointing into the run dir.
const HOST_DROPPED = new Set(["DB_PATH", "COLLECTOR_PORT", "WS_PORT", "KNOWLEDGE_DIR", "ICONS_DIR", "TMUX_TMPDIR", "CLAUDE_CONFIG_DIR"]);
const hostDroppedKey = (k: string) =>
  droppedEnvKey(k) || HOST_DROPPED.has(k) || ["STANDUP_", "AWS_", "EMBEDDING_", "XDG_"].some((p) => k.startsWith(p));
// Before vite or Playwright is loaded: the dev server runs in this process.
for (const k of Object.keys(process.env)) if (hostDroppedKey(k)) delete process.env[k];

const taken = new Set<number>();
const API_PORT = await pickPort("api-port", taken);
const WS_PORT = await pickPort("ws-port", taken);
const WEB_PORT = await pickPort("web-port", taken);
const RELAY_PORT = await pickPort("relay-port", taken);
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

if (existsSync(SCRATCH)) throw new Error(`${SCRATCH} already exists`);
mkdirSync(SCRATCH, { mode: 0o700 });
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin", "home", "tmux", "worktrees", "work", "transcripts", "repo"]) {
  mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
}
// The run dir really is that name directly in the real /tmp, so every prefix
// check against it below is a check of real locations; it and its data dir
// are directories of this user's, not symlinks.
{
  const realTmp = realpathSync("/tmp");
  const real = realpathSync(SCRATCH);
  if (real !== join(realTmp, basename(SCRATCH))) throw new Error(`${SCRATCH} resolves to ${real}, not into ${realTmp}`);
  for (const d of [SCRATCH, join(SCRATCH, "data")]) {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a plain directory`);
    if (st.uid !== process.getuid!()) throw new Error(`${d} is owned by uid ${st.uid}, not ${process.getuid!()}`);
  }
}
mkdirSync(OUT, { recursive: true });
console.log(`run ${RUN}: scratch ${SCRATCH}, out ${OUT}`);
console.log(`ports: collector ${API_PORT}, ws ${WS_PORT}, relay ${RELAY_PORT}, console ${WEB_PORT}`);

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = readFileSync(TOKEN_FILE, "utf8").trim();

const SCRATCH_BIN = join(SCRATCH, "bin");
const claudeShim = join(SCRATCH_BIN, "claude");
writeFileSync(claudeShim, `#!/bin/sh\nexec ${BUN} ${join(import.meta.dir, "fake-claude.ts")} "$@"\n`);
chmodSync(claudeShim, 0o755);

// Every tmux call of this run, the scratch collector's included, goes to a
// private server on this socket: the scratch collector's workers' socket
// (`<its data dir>/tmux/workers`, which it names with -S itself), and the
// shim first on its PATH pins any other tmux call to the same one.
const TMUX_SOCK = join(SCRATCH, "data", "tmux", "workers");
mkdirSync(dirname(TMUX_SOCK), { recursive: true, mode: 0o700 });
const whichTmux = Bun.which("tmux");
if (!whichTmux) throw new Error("tmux is not on PATH");
const REAL_TMUX = realpathSync(whichTmux);
if (REAL_TMUX === SCRATCH || REAL_TMUX.startsWith(`${SCRATCH}/`)) throw new Error(`tmux resolves into the run dir (${REAL_TMUX})`);
const tmuxShim = join(SCRATCH_BIN, "tmux");
writeFileSync(tmuxShim, `#!/bin/sh\nexec ${REAL_TMUX} -S ${TMUX_SOCK} "$@"\n`);
chmodSync(tmuxShim, 0o755);

const scratchEnv: Record<string, string> = {
  ...inheritedEnv(),
  TERM: process.env.TERM || "xterm-256color",
  PATH: `${SCRATCH_BIN}:${process.env.PATH}`,
  HOME: join(SCRATCH, "home"),
  TMUX_TMPDIR: join(SCRATCH, "tmux"),
  DB_PATH: join(SCRATCH, "data/standup.db"),
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  COLLECTOR_PORT: String(API_PORT),
  WS_PORT: String(WS_PORT),
  KNOWLEDGE_DIR: join(SCRATCH, "knowledge"),
  ICONS_DIR: join(SCRATCH, "icons"),
  STANDUP_PROJECTS_PATH: join(SCRATCH, "projects.toml"),
  STANDUP_INTERNAL_ROOT: join(SCRATCH, "internal"),
  STANDUP_WORKTREE_ROOT: join(SCRATCH, "worktrees"),
  STANDUP_PERSONA_COALESCE_S: "1",
  STANDUP_PERSONA_HOLD: "open_job",
  STANDUP_WEB_URL: `${ORIGIN}/`,
};

// Pre-flight: no tmux call of this run can reach the default socket, and no
// process of this run carries a dropped setting.
{
  const inRun = (p: string) => resolve(p).startsWith(`${SCRATCH}/`);
  if (!inRun(TMUX_SOCK)) throw new Error(`the tmux socket ${TMUX_SOCK} is outside the run dir`);
  if (!inRun(scratchEnv.TMUX_TMPDIR!)) throw new Error(`TMUX_TMPDIR ${scratchEnv.TMUX_TMPDIR} is outside the run dir`);
  const entries = scratchEnv.PATH!.split(":");
  const firstTmux = entries.findIndex((dir) => dir && existsSync(join(dir, "tmux")));
  if (entries[firstTmux] !== SCRATCH_BIN) throw new Error(`${SCRATCH_BIN} is not ahead of every PATH entry holding tmux`);
  const resolved = Bun.spawnSync(["sh", "-c", "command -v tmux"], { env: scratchEnv }).stdout.toString().trim();
  if (resolved !== tmuxShim) throw new Error(`tmux on the scratch PATH resolves to ${resolved || "nothing"}, not the shim`);
  for (const [name, env, dropped] of [
    ["scratch children", scratchEnv, droppedEnvKey],
    ["this process (vite)", process.env, hostDroppedKey],
  ] as const) {
    const leaked = Object.keys(env).filter(dropped);
    if (leaked.length) throw new Error(`${name} env still carries ${leaked.join(", ")}`);
  }
  // Every path a child is pointed at lives in the run dir.
  for (const k of ["HOME", "TMUX_TMPDIR", "DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_PROJECTS_PATH", "STANDUP_INTERNAL_ROOT", "STANDUP_WORKTREE_ROOT"]) {
    if (!inRun(scratchEnv[k]!)) throw new Error(`${k} ${scratchEnv[k]} is outside the run dir`);
  }
  // Neither the database nor HOME resolves into the live install's data dir.
  refuseLiveInstall(scratchEnv.DB_PATH!);
  refuseLiveInstall(scratchEnv.HOME!);
}

/** The real tmux, on this run's private socket only. */
function privateTmux(...args: string[]) {
  return Bun.spawnSync([REAL_TMUX, "-S", TMUX_SOCK, ...args], { env: scratchEnv });
}

function git(...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], {
    cwd: join(SCRATCH, "repo"),
    env: scratchEnv,
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}
git("init", "-q", "-b", "main");
writeFileSync(join(SCRATCH, "repo/README.md"), "scratch repo for the live-update suite\n");
git("add", "README.md");
git("commit", "-q", "-m", "initial");

const PROJECT = "e2e";
writeFileSync(
  join(SCRATCH, "projects.toml"),
  [
    "[[project]]",
    `id = "${PROJECT}"`,
    `name = "${PROJECT}"`,
    `repos = ["${join(SCRATCH, "repo")}"]`,
    `branch = "main"`,
    `worktreeRoot = "${join(SCRATCH, "worktrees")}"`,
    "bypassPermissions = false",
    "",
  ].join("\n")
);

// ── Scratch collector ───────────────────────────────────────────────────────

let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn([BUN, "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, `collector-${Date.now()}.log`)),
    stderr: Bun.file(join(SCRATCH, `collector-${Date.now()}.err.log`)),
  });
  console.log(`  collector pid ${collector.pid}`);
}
async function waitForHttp(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (collector?.exitCode !== null || collector.signalCode !== null) {
      throw new Error(`scratch collector exited (${collector?.exitCode ?? collector?.signalCode})`);
    }
    try {
      await fetch(`${API}/api/projects`);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("scratch collector never came up");
}
async function stopCollector(): Promise<void> {
  if (collector && collector.exitCode === null && collector.signalCode === null) {
    collector.kill("SIGTERM");
    await collector.exited;
  }
}

// ── Relay between the dev server and the collector's socket ────────────────

type Pair = { client: Socket<Pair>; upstream?: Socket<{ pair: Pair }>; silent: boolean; queued: Uint8Array[] };
const pairs = new Set<Pair>();
let refusing = false;
const relay = Bun.listen<Pair>({
  hostname: "127.0.0.1",
  port: RELAY_PORT,
  socket: {
    async open(client) {
      const pair: Pair = { client, silent: false, queued: [] };
      client.data = pair;
      if (refusing) {
        client.end();
        return;
      }
      pairs.add(pair);
      try {
        pair.upstream = await Bun.connect<{ pair: Pair }>({
          hostname: "127.0.0.1",
          port: WS_PORT,
          data: { pair },
          socket: {
            data(up, chunk) {
              if (!up.data.pair.silent) up.data.pair.client.write(chunk);
            },
            close(up) {
              if (!up.data.pair.silent) up.data.pair.client.end();
            },
            error() {},
          },
        });
        for (const chunk of pair.queued) pair.upstream.write(chunk);
        pair.queued = [];
      } catch {
        pairs.delete(pair);
        client.end();
      }
    },
    data(client, chunk) {
      const pair = client.data;
      if (pair.silent || refusing) return;
      if (pair.upstream) pair.upstream.write(chunk);
      else pair.queued.push(new Uint8Array(chunk));
    },
    close(client) {
      const pair = client.data;
      pairs.delete(pair);
      if (!pair.silent) pair.upstream?.end();
    },
    error() {},
  },
});
const relayControl = {
  /** Stops forwarding on every connection held now, both ways, without closing it; later connections pass. */
  silence(): number {
    let n = 0;
    for (const pair of pairs) {
      if (!pair.silent) n++;
      pair.silent = true;
    }
    return n;
  },
  /** Closes every connection and refuses new ones until restore(). */
  drop(): number {
    refusing = true;
    const n = pairs.size;
    for (const pair of [...pairs]) {
      pairs.delete(pair);
      pair.client.end();
      pair.upstream?.end();
    }
    return n;
  },
  restore(): void {
    refusing = false;
  },
  /** Closes the connections left silent; their clients have replaced them by now. */
  reapSilent(): void {
    for (const pair of [...pairs]) {
      if (!pair.silent) continue;
      pairs.delete(pair);
      pair.client.end();
      pair.upstream?.end();
    }
  },
};

// ── Collector API ──────────────────────────────────────────────────────────

type Json = Record<string, any>;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, owner = true) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(owner ? { "x-standup-owner-token": token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
async function must(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, owner = true): Promise<Json> {
  const res = await call(method, path, body, headers, owner);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  return res.json;
}
async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined | null | false>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await Bun.sleep(250);
  }
}

const sendMessage = async (text: string, jobId?: string): Promise<string> => {
  const res = await must("POST", "/api/persona/messages", { text, idempotencyKey: randomUUID(), ...(jobId ? { jobId } : {}) });
  return res.message.id as string;
};

const PERSONA_MCP = join(SCRATCH, "internal/persona/mcp-config.json");
function readPersonaToken(): string | null {
  try {
    return JSON.parse(readFileSync(PERSONA_MCP, "utf8")).mcpServers.standup.env.STANDUP_PERSONA_TOKEN ?? null;
  } catch {
    return null;
  }
}
// The Persona token the collector issued this boot, set after the boot's first turn.
let personaToken: string | null = null;
let personaTokenBefore: string | null = null;
async function currentPersonaToken(): Promise<string> {
  if (personaToken) return personaToken;
  personaToken = await waitFor("this boot's Persona token", 20000, async () => {
    const t = readPersonaToken();
    return t && t !== personaTokenBefore ? t : null;
  });
  return personaToken;
}
async function personaTool(name: string, args: Json): Promise<Json> {
  const res = await call("POST", "/api/persona/tool", { name, arguments: args }, { "x-standup-persona-token": await currentPersonaToken() }, false);
  if (res.status >= 300 || res.json.error || res.json.isError) throw new Error(`persona tool ${name}: ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  return res.json;
}

async function pendingApprovalFor(tag: string): Promise<Json | undefined> {
  const { approvals } = await must("GET", "/api/persona/approvals?status=pending");
  return (approvals as Json[]).find((a) => JSON.stringify(a).includes(tag));
}
async function jobFor(tag: string): Promise<Json | undefined> {
  const { jobs } = await must("GET", "/api/persona/jobs");
  return (jobs as Json[]).find((j) => j.title === `job ${tag}`);
}

const pendingAskPolls = new Set<AbortController>();
/** Raises a worker ask_human; its long-poll is left open, as a worker's would be. */
function raiseAsk(session: WorkerSession, question: string): void {
  const ctl = new AbortController();
  pendingAskPolls.add(ctl);
  void fetch(`${API}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: session.id, cwd: session.cwd, question, options: ["yes", "no"], timeout_s: 3600, request_id: randomUUID() }),
    signal: ctl.signal,
  })
    .catch(() => {})
    .finally(() => pendingAskPolls.delete(ctl));
}
async function pendingAskFor(question: string): Promise<Json | undefined> {
  const asks = (await must("GET", "/api/asks/pending")) as unknown as Json[];
  return asks.find((a) => a.question === question);
}

type WorkerSession = { id: string; cwd: string; transcript: string };
async function startSession(cwd: string): Promise<WorkerSession> {
  const id = randomUUID();
  const transcript = join(SCRATCH, "transcripts", `${id}.jsonl`);
  writeFileSync(
    transcript,
    JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: id, timestamp: new Date().toISOString(), cwd, message: { role: "user", content: "scratch worker" } }) + "\n"
  );
  await must("POST", "/hook", { session_id: id, cwd, transcript_path: transcript, hook_event_name: "SessionStart", source: "startup" });
  return { id, cwd, transcript };
}
async function workerEvent(s: WorkerSession, text: string): Promise<void> {
  appendFileSync(
    s.transcript,
    JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      sessionId: s.id,
      timestamp: new Date().toISOString(),
      cwd: s.cwd,
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n"
  );
  await must("POST", "/hook", {
    session_id: s.id,
    cwd: s.cwd,
    transcript_path: s.transcript,
    hook_event_name: "PostToolUse",
    tool_use_id: `toolu_${randomBytes(8).toString("hex")}`,
    tool_name: "Bash",
    tool_input: {},
  });
}

type Launched = { launchId: string; session: WorkerSession };
// The tmux sessions the scratch collector's launches report.
const launchedPanes: string[] = [];
async function launchWorker(task: string): Promise<Launched> {
  const { launch } = await must("POST", `/api/projects/${PROJECT}/launch`, { task });
  const ready = await waitFor(`launch ${launch.id} running`, 90000, async () => {
    const l = await must("GET", `/api/launches/${launch.id}`);
    if (l.status === "failed") throw new Error(`launch failed: ${l.error}`);
    return l.status === "running" ? l : null;
  });
  if (ready.tmuxSession) launchedPanes.push(ready.tmuxSession);
  const session = await startSession(ready.worktreePath);
  return { launchId: launch.id, session };
}
async function submitReview(w: Launched, title: string): Promise<void> {
  const workerToken = readFileSync(join(SCRATCH, "data/worker-tokens", w.launchId), "utf8").trim();
  await must(
    "POST",
    "/api/reviews/submit",
    {
      session_id: w.session.id,
      cwd: w.session.cwd,
      packet: {
        title,
        intent: "One sentence.",
        changes: [{ area: "a", bullets: ["b"], files: [] }],
        validation: { samples: [], tests: { summary: "ok" } },
        risks: { risks: [], questions: [] },
        links: [],
      },
    },
    { "x-standup-worker-token": workerToken },
    false
  );
}

// ── Browser ────────────────────────────────────────────────────────────────

/*
 * Runs in every page before its own scripts: a hidden-tab switch (the
 * visibility state, its events, and Chrome's intensive timer throttling,
 * which holds a hidden tab's timers to one-minute boundaries), a record of
 * when the reconnecting banner appeared, an open-socket count, and a boot
 * marker a reload would replace.
 */
function pageHarness(): void {
  const w = window as any;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const ALIGN_MS = 60_000;
  const state = { hidden: false, hiddenAt: 0 };
  Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (state.hidden ? "hidden" : "visible") });
  Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => state.hidden });
  const nativeHasFocus = Document.prototype.hasFocus;
  Document.prototype.hasFocus = function (this: Document) {
    return state.hidden ? false : nativeHasFocus.call(this);
  };

  type Timer = { fn: unknown; args: unknown[]; native: number | null; interval: number | null; deferred: boolean };
  const timers = new Map<number, Timer>();
  let nextId = 1;
  const arm = (id: number, delay: number) => {
    const t = timers.get(id);
    if (!t) return;
    t.native = nativeSetTimeout(() => fire(id), Math.max(0, delay));
  };
  const run = (id: number) => {
    const t = timers.get(id);
    if (!t) return;
    t.deferred = false;
    if (t.interval !== null) arm(id, t.interval);
    else timers.delete(id);
    try {
      if (typeof t.fn === "function") (t.fn as (...a: unknown[]) => void)(...t.args);
      else (0, eval)(String(t.fn));
    } catch (err) {
      nativeSetTimeout(() => {
        throw err;
      }, 0);
    }
  };
  // A timer due while hidden waits for the next whole minute since the tab was hidden.
  const fire = (id: number) => {
    const t = timers.get(id);
    if (!t) return;
    if (state.hidden && !t.deferred) {
      const elapsed = Date.now() - state.hiddenAt;
      const boundary = state.hiddenAt + Math.ceil((elapsed + 1) / ALIGN_MS) * ALIGN_MS;
      t.deferred = true;
      arm(id, boundary - Date.now());
      return;
    }
    run(id);
  };
  const add = (fn: unknown, ms: unknown, args: unknown[], repeat: boolean): number => {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, args, native: null, interval: repeat ? Math.max(delay, 1) : null, deferred: false });
    arm(id, delay);
    return id;
  };
  const clear = (id: unknown) => {
    const t = timers.get(Number(id));
    if (!t) return;
    if (t.native !== null) nativeClearTimeout(t.native);
    timers.delete(Number(id));
  };
  w.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, false);
  w.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => add(fn, ms, args, true);
  w.clearTimeout = clear;
  w.clearInterval = clear;

  const open = new Set<WebSocket>();
  const Native = window.WebSocket;
  class Counted extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (new URL(String(url), location.href).pathname === "/ws") {
        this.addEventListener("open", () => open.add(this));
        this.addEventListener("close", () => open.delete(this));
      }
    }
  }
  w.WebSocket = Counted;

  const bannerSeen: number[] = [];
  let bannerUp = false;
  const watchBanner = () => {
    const up = !!document.querySelector('[data-testid="connection-banner"]');
    if (up && !bannerUp) bannerSeen.push(Date.now());
    bannerUp = up;
  };
  new MutationObserver(watchBanner).observe(document, { childList: true, subtree: true });

  w.__e2e = {
    boot: `${Date.now()}-${Math.random()}`,
    sockets: () => open.size,
    bannerSince: (since: number) => bannerUp || bannerSeen.some((t) => t >= since),
    bannerUp: () => bannerUp,
    hide() {
      state.hidden = true;
      state.hiddenAt = Date.now();
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("blur"));
    },
    show() {
      state.hidden = false;
      for (const [id, t] of timers) {
        if (!t.deferred) continue;
        if (t.native !== null) nativeClearTimeout(t.native);
        t.native = nativeSetTimeout(() => run(id), 0);
      }
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    },
  };
}

type Tab = { name: string; page: Page; boot: string; navigations: string[]; allowed: Set<string> };

// ── The matrix ─────────────────────────────────────────────────────────────

const SURFACES = [
  { id: "a", label: "a persona reply" },
  { id: "b", label: "b worker event" },
  { id: "c", label: "c approval + ask_human" },
  { id: "d", label: "d job status + tag" },
  { id: "e", label: "e review packet" },
  { id: "f", label: "f pipeline stage" },
] as const;
type SurfaceId = (typeof SURFACES)[number]["id"];
const CONDITIONS = [
  { id: "1-steady", label: "steady", limitS: 5 },
  { id: "2-silent", label: "silent ws", limitS: 40 },
  { id: "3-restart", label: "restart", limitS: 40 },
  { id: "4-hidden", label: "hidden tab", limitS: 40 },
  { id: "5-offline", label: "net drop", limitS: 40 },
] as const;
type Cell = { surface: string; condition: string; ok: boolean; seconds: number | null; limitS: number; error?: string };
const cells: Cell[] = [];
const extras: { check: string; condition: string; ok: boolean; detail?: string }[] = [];

let browser: Browser | undefined;
let vite: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  for (const ctl of pendingAskPolls) ctl.abort();
  await browser?.close().catch(() => {});
  await stopCollector().catch(() => {});
  await vite?.close().catch(() => {});
  relay.stop(true);
  privateTmux("kill-server");
  try {
    mkdirSync(join(OUT, "logs"), { recursive: true });
    for (const f of readdirSync(SCRATCH)) if (f.startsWith("collector-")) cpSync(join(SCRATCH, f), join(OUT, "logs", f));
  } catch {
    // The logs are a convenience; the matrix is already written.
  }
  if (!KEEP && !OUT.startsWith(`${SCRATCH}/`)) rmSync(SCRATCH, { recursive: true, force: true });
  else console.log(`kept ${SCRATCH}`);
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

function writeMatrix(): void {
  const width = 30;
  const head = ["surface".padEnd(width), ...CONDITIONS.map((c) => `${c.id} (≤${c.limitS}s)`.padEnd(20))].join("");
  const lines = [head];
  for (const s of SURFACES) {
    const row = [s.label.padEnd(width)];
    for (const c of CONDITIONS) {
      const cell = cells.find((x) => x.surface === s.id && x.condition === c.id);
      const text = !cell ? "-" : `${cell.ok ? "PASS" : "FAIL"} ${cell.seconds === null ? "—" : `${cell.seconds.toFixed(1)}s`}`;
      row.push(text.padEnd(20));
    }
    lines.push(row.join(""));
  }
  console.log(`\n${lines.join("\n")}`);
  for (const e of extras) console.log(`${e.ok ? "PASS" : "FAIL"} ${e.condition} ${e.check}${e.detail ? `: ${e.detail}` : ""}`);
  for (const c of cells.filter((x) => !x.ok)) console.log(`  FAIL ${c.condition} ${c.surface}: ${c.error}`);
  writeFileSync(
    join(OUT, "matrix.json"),
    JSON.stringify({ run: RUN, ports: { api: API_PORT, ws: WS_PORT, web: WEB_PORT, relay: RELAY_PORT }, surfaces: SURFACES, conditions: CONDITIONS, cells, extras }, null, 2)
  );
}

let fatal: unknown;
try {
  startCollector();
  await waitForHttp();

  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: String(API_PORT),
    SCRATCH_WS_PORT: String(RELAY_PORT),
    SCRATCH_WEB_PORT: String(WEB_PORT),
  });
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  // No HMR or file watching: an edit elsewhere in the tree must not reload the page mid-run.
  vite = await createServer({
    configFile: join(import.meta.dir, "vite.scratch.config.ts"),
    logLevel: "warn",
    server: { hmr: false, watch: null },
  });
  await vite!.listen();

  // ── Fixtures the episodes build on ──
  console.log("setup");
  const worker = await startSession(join(SCRATCH, "work"));
  const statusJobTag = `JOB-st${RUN}`;
  const tagJobTag = `JOB-tg${RUN}`;
  await sendMessage(statusJobTag);
  await sendMessage(tagJobTag);
  for (const tag of [statusJobTag, tagJobTag]) {
    const approval = await waitFor(`approval for ${tag}`, 30000, () => pendingApprovalFor(tag));
    await must("POST", `/api/persona/approvals/${approval.id}/approve`, {});
  }
  const statusJob = await waitFor("the status job", 30000, () => jobFor(statusJobTag));
  const tagJob = await waitFor("the tag job", 30000, () => jobFor(tagJobTag));
  await currentPersonaToken();
  // Each episode resolves the previous episode's card, ask and tag and leaves new ones.
  const chain = {
    jobTag: `JOB-c0${RUN}`,
    askQuestion: `ASKH-q0${RUN}?`,
    tagMessageId: await sendMessage(`TAG-t0${RUN}`, tagJob.id),
    jobStatus: "active" as "active" | "waiting_user",
    reviews: 0,
  };
  await sendMessage(chain.jobTag);
  raiseAsk(worker, chain.askQuestion);
  await waitFor(`approval for ${chain.jobTag}`, 30000, () => pendingApprovalFor(chain.jobTag));
  await waitFor(`ask ${chain.askQuestion}`, 30000, () => pendingAskFor(chain.askQuestion));

  // ── Browser, loaded once ──
  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  browser = await chromium.launch({ env: scratchEnv });
  /** A browser context with the page harness, no host but the console's, signed in with a fresh login code. */
  const signedInContext = async (): Promise<BrowserContext> => {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(pageHarness);
    await ctx.route("**/*", (route) => {
      const host = new URL(route.request().url()).host;
      return host === `localhost:${WEB_PORT}` ? route.continue() : route.abort();
    });
    const expiry = String(Math.floor(Date.now() / 1000) + 600);
    const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
    const login = await ctx.newPage();
    await login.goto(`${ORIGIN}/__standup/login?code=${code}`);
    await login.close();
    return ctx;
  };
  const context = await signedInContext();

  const tabs: Tab[] = [];
  let booted = false;
  const openTab = async (name: string, path: string): Promise<Tab> => {
    const page = await context.newPage();
    const tab: Tab = { name, page, boot: "", navigations: [], allowed: new Set([`${ORIGIN}${path}`]) };
    page.on("pageerror", (err) => console.log(`  [${name}] PAGE ERROR: ${err.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" || m.text().startsWith("[ws]")) console.log(`  [${name}] ${m.type()}: ${m.text().slice(0, 160)}`);
    });
    page.on("framenavigated", (frame) => {
      if (booted && frame === page.mainFrame() && !tab.allowed.has(frame.url())) tab.navigations.push(frame.url());
    });
    await page.goto(`${ORIGIN}${path}`);
    tab.boot = await page.evaluate(() => (window as any).__e2e.boot as string);
    tabs.push(tab);
    return tab;
  };
  const persona = await openTab("persona", "/persona");
  const work = await openTab("work", liveWorkersPath({ kind: "s", id: worker.id }, true));
  const pipe = await openTab("pipeline", liveWorkersPath(null, true));
  const review = await openTab("review", "/review");
  booted = true;

  /** Moves a tab to `path` the way the app's own links do: history, no load. */
  const navigateInApp = async (tab: Tab, path: string) => {
    tab.allowed.add(`${ORIGIN}${path}`);
    await tab.page.evaluate((p) => {
      history.pushState({}, "", p);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }, path);
  };
  const reloaded = async (): Promise<string[]> => {
    const problems: string[] = [];
    for (const tab of tabs) {
      const boot = await tab.page.evaluate(() => (window as any).__e2e?.boot as string | undefined).catch(() => undefined);
      if (boot !== tab.boot) problems.push(`${tab.name} reloaded`);
      if (tab.navigations.length) problems.push(`${tab.name} navigated to ${tab.navigations.join(", ")}`);
    }
    return problems;
  };
  const shot = async (label: string, tab: Tab) => {
    await tab.page.screenshot({ path: join(OUT, `${label.replace(/[^a-z0-9-]+/gi, "-")}.png`) }).catch(() => {});
  };
  const visible = (tab: Tab, selector: string, ms = 30000) =>
    tab.page.locator(selector).first().waitFor({ state: "visible", timeout: ms });
  const text = (tab: Tab, needle: string) => tab.page.getByText(needle, { exact: false }).first();
  const jobRow = (tab: Tab, title: string, state?: string) =>
    tab.page.locator(state ? `[data-job-state="${state}"]` : "[data-job-state]").filter({ hasText: title }).first();
  const tagChip = (tab: Tab, messageId: string, jobId: string) =>
    tab.page.locator(`[data-message-id="${messageId}"] [data-testid="message-job-tag"][data-job-id="${jobId}"]`).first();
  const allConnected = async (ms: number) => {
    await waitFor("every tab's socket", ms, async () => {
      for (const tab of tabs) {
        const ok = await tab.page.evaluate(() => (window as any).__e2e.sockets() >= 1 && !(window as any).__e2e.bannerUp());
        if (!ok) return false;
      }
      return true;
    });
  };

  // The work tab shows the worker's transcript; the pipeline tab, a launched worker's info tab.
  await text(work, "scratch worker").waitFor({ timeout: 30000 }).catch(() => {});

  const statusLabel = (s: "active" | "waiting_user") => (s === "waiting_user" ? "needs_you" : "idle");

  for (const [index, condition] of CONDITIONS.entries()) {
    const x = `${index + 1}${RUN}`;
    console.log(`\n== ${condition.id} (${condition.label}) ==`);
    // ── Before the condition: the state each surface changes from, shown live ──
    let launched: Launched | undefined;
    const primeErrors: string[] = [];
    try {
      launched = await launchWorker(`live e2e episode ${condition.id}`);
      await navigateInApp(pipe, liveWorkersPath({ kind: "s", id: launched.session.id }, true));
      const infoTab = pipe.page.getByRole("button", { name: /^info$/i }).first();
      await infoTab.waitFor({ timeout: 30000 });
      await infoTab.click();
      await visible(pipe, '[data-testid="pipeline-view"] [data-stage="start"][aria-current="step"]');
    } catch (err) {
      primeErrors.push(`pipeline: ${String(err)}`);
    }
    const prime = async (label: string, wait: () => Promise<unknown>) => {
      try {
        await wait();
      } catch (err) {
        primeErrors.push(`${label}: ${String(err).slice(0, 200)}`);
      }
    };
    await prime("approval card", () => text(persona, `scratch repro ${chain.jobTag}`).waitFor({ timeout: 30000 }));
    await prime("tag", () => tagChip(persona, chain.tagMessageId, tagJob.id).waitFor({ timeout: 30000 }));
    await prime("job status", () => jobRow(persona, statusJob.title, statusLabel(chain.jobStatus)).waitFor({ timeout: 30000 }));
    await allConnected(30000).catch((err) => primeErrors.push(String(err)));
    if (primeErrors.length) console.log(`  prime problems: ${primeErrors.join("; ")}`);

    const prev = { ...chain };
    const nextStatus = chain.jobStatus === "active" ? "waiting_user" : "active";
    const triggerErrors = new Map<SurfaceId, string[]>();
    const noteTrigger = (s: SurfaceId) => (err: unknown) => {
      triggerErrors.set(s, [...(triggerErrors.get(s) ?? []), String(err).slice(0, 300)]);
    };
    let newTagMessageId = "";
    const trigger = async () => {
      const t = Date.now();
      await Promise.all([
        sendMessage(`MSG-${x}`).catch(noteTrigger("a")),
        workerEvent(worker, `EVT-${x}`).catch(noteTrigger("b")),
        (async () => {
          await sendMessage(`JOB-${x}`);
          const a = await pendingApprovalFor(prev.jobTag);
          if (!a) throw new Error(`no pending approval for ${prev.jobTag}`);
          await must("POST", `/api/persona/approvals/${a.id}/approve`, {});
        })().catch(noteTrigger("c")),
        (async () => {
          raiseAsk(worker, `ASKH-${x}?`);
          const a = await pendingAskFor(prev.askQuestion);
          if (!a) throw new Error(`no pending ask ${prev.askQuestion}`);
          await must("POST", `/api/asks/${a.id}/resolve`, { answer: "yes" });
        })().catch(noteTrigger("c")),
        (async () => {
          newTagMessageId = await sendMessage(`TAG-${x}`, tagJob.id);
          await must("DELETE", `/api/persona/messages/${prev.tagMessageId}/jobs/${tagJob.id}`);
          await personaTool("update_job", { jobId: statusJob.id, status: nextStatus });
        })().catch(noteTrigger("d")),
        (launched ? submitReview(launched, `PKT-${x}`) : Promise.reject(new Error("no launch"))).catch(noteTrigger("e")),
        (launched
          ? must("POST", "/api/pipeline/advance", { session_id: launched.session.id, cwd: launched.session.cwd, stage: "start" })
          : Promise.reject(new Error("no launch"))
        ).catch(noteTrigger("f")),
      ]);
      console.log(`  triggered in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    };

    // ── The condition ──
    let since = Date.now();
    let bannerFrom = 0;
    if (condition.id === "1-steady") {
      since = Date.now();
      await trigger();
    } else if (condition.id === "2-silent") {
      bannerFrom = Date.now();
      console.log(`  silenced ${relayControl.silence()} relay connection(s)`);
      await Bun.sleep(1000);
      since = Date.now();
      await trigger();
    } else if (condition.id === "3-restart") {
      await stopCollector();
      console.log("  collector stopped");
      personaTokenBefore = personaToken;
      personaToken = null;
      await Bun.sleep(1500);
      startCollector();
      await waitForHttp();
      since = Date.now();
      await trigger();
    } else if (condition.id === "4-hidden") {
      for (const tab of tabs) await tab.page.evaluate(() => (window as any).__e2e.hide());
      const hiddenAt = Date.now();
      console.log(`  hidden; silenced ${relayControl.silence()} relay connection(s)`);
      await Bun.sleep(3000);
      await trigger();
      await Bun.sleep(Math.max(0, hiddenAt + 45000 - Date.now()));
      since = Date.now();
      for (const tab of tabs) await tab.page.evaluate(() => (window as any).__e2e.show());
      console.log("  shown");
    } else if (condition.id === "5-offline") {
      bannerFrom = Date.now();
      console.log(`  dropped ${relayControl.drop()} relay connection(s); browser offline`);
      await context.setOffline(true);
      await Bun.sleep(2000);
      await trigger();
      await Bun.sleep(Math.max(0, bannerFrom + 12000 - Date.now()));
      relayControl.restore();
      await context.setOffline(false);
      since = Date.now();
      console.log("  back online");
    }
    const deadline = since + condition.limitS * 1000;

    const advanced = { ...chain };
    chain.jobTag = `JOB-${x}`;
    chain.askQuestion = `ASKH-${x}?`;
    chain.tagMessageId = newTagMessageId || chain.tagMessageId;
    chain.jobStatus = nextStatus;
    const reviewsPending = Number((await call("GET", "/api/reviews/pending-count")).json.count ?? 0);

    // ── What each surface must show, by the deadline ──
    type Check = { surface: SurfaceId; label: string; tab: Tab; wait: (ms: number) => Promise<unknown> };
    const checks: Check[] = [
      { surface: "a", label: "reply", tab: persona, wait: (ms) => text(persona, `echo MSG-${x}`).waitFor({ timeout: ms }) },
      { surface: "b", label: "transcript event", tab: work, wait: (ms) => text(work, `EVT-${x}`).waitFor({ timeout: ms }) },
      { surface: "c", label: "new approval card", tab: persona, wait: (ms) => text(persona, `scratch repro JOB-${x}`).waitFor({ timeout: ms }) },
      { surface: "c", label: "approved card's job", tab: persona, wait: (ms) => jobRow(persona, `job ${advanced.jobTag}`).waitFor({ timeout: ms }) },
      { surface: "c", label: "alert strip", tab: persona, wait: (ms) => text(persona, "waiting on you").waitFor({ timeout: ms }) },
      {
        surface: "d",
        label: `job ${statusLabel(nextStatus)}`,
        tab: persona,
        wait: (ms) => jobRow(persona, statusJob.title, statusLabel(nextStatus)).waitFor({ timeout: ms }),
      },
      { surface: "d", label: "tag added", tab: persona, wait: (ms) => tagChip(persona, chain.tagMessageId, tagJob.id).waitFor({ timeout: ms }) },
      {
        surface: "d",
        label: "tag removed",
        tab: persona,
        wait: (ms) => tagChip(persona, prev.tagMessageId, tagJob.id).waitFor({ state: "detached", timeout: ms }),
      },
      {
        surface: "e",
        label: "review card",
        tab: review,
        wait: (ms) => review.page.locator('[data-testid="review-card"]').filter({ hasText: `PKT-${x}` }).first().waitFor({ timeout: ms }),
      },
      {
        surface: "e",
        label: `review badge ${reviewsPending}`,
        tab: review,
        wait: (ms) =>
          review.page.locator('[data-testid="review-tab-badge"]').filter({ hasText: new RegExp(`^${reviewsPending}$`) }).first().waitFor({ timeout: ms }),
      },
      {
        surface: "f",
        label: "coding current",
        tab: pipe,
        wait: (ms) => visible(pipe, '[data-testid="pipeline-view"] [data-stage="coding"][aria-current="step"]', ms),
      },
    ];
    const outcomes = await Promise.all(
      checks.map(async (check) => {
        try {
          await check.wait(Math.max(1, deadline - Date.now()));
          return { check, ok: true, at: Date.now() };
        } catch (err) {
          return { check, ok: false, at: Date.now(), error: String(err).split("\n")[0] };
        }
      })
    );
    const navProblems = await reloaded();
    for (const s of SURFACES) {
      const mine = outcomes.filter((o) => o.check.surface === s.id);
      const failed = mine.filter((o) => !o.ok);
      const errors = [
        ...(triggerErrors.get(s.id) ?? []).map((e) => `trigger: ${e}`),
        ...failed.map((o) => `${o.check.label} not shown within ${condition.limitS}s (${o.check.tab.name} tab)`),
        ...navProblems,
      ];
      const seconds = failed.length ? null : Math.max(...mine.map((o) => (o.at - since) / 1000));
      const cell: Cell = { surface: s.id, condition: condition.id, ok: errors.length === 0, seconds, limitS: condition.limitS, ...(errors.length ? { error: errors.join("; ") } : {}) };
      cells.push(cell);
      console.log(`  ${cell.ok ? "PASS" : "FAIL"} ${s.label}${seconds !== null ? ` ${seconds.toFixed(1)}s` : ""}${cell.error ? ` — ${cell.error}` : ""}`);
      if (!cell.ok) for (const o of failed) await shot(`FAIL-${condition.id}-${s.id}-${o.check.tab.name}`, o.check.tab);
    }
    if (bannerFrom) {
      const seen = await Promise.all(tabs.map((tab) => tab.page.evaluate((t) => (window as any).__e2e.bannerSince(t) as boolean, bannerFrom)));
      const ok = seen.some(Boolean);
      extras.push({ check: "reconnecting banner shown", condition: condition.id, ok, detail: tabs.map((t, i) => `${t.name}:${seen[i] ? "yes" : "no"}`).join(" ") });
      console.log(`  ${ok ? "PASS" : "FAIL"} reconnecting banner shown`);
    }
    for (const tab of tabs) await shot(`${condition.id}-${tab.name}`, tab);
    relayControl.reapSilent();
    if (condition.id === "4-hidden") relayControl.restore();
  }

  // ── A Persona tab painted from the kept view still takes live updates ──
  // In a context of its own: the other open tabs write the same kept-view key
  // into a shared localStorage, which would overwrite the marked copy.
  console.log("\n== kept view ==");
  {
    const CACHE_KEY = "standup:personaSnapshot:v1";
    const marker = `KEPT-${RUN}`;
    const keptContext = await signedInContext();
    const page = await keptContext.newPage();
    page.on("pageerror", (err) => console.log(`  [kept] PAGE ERROR: ${err.message}`));
    const tab: Tab = { name: "kept", page, boot: "", navigations: [], allowed: new Set() };
    const check = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run();
        extras.push({ check: name, condition: "kept-view", ok: true });
        console.log(`  PASS ${name}`);
      } catch (err) {
        const detail = String(err).split("\n")[0]!.slice(0, 300);
        extras.push({ check: name, condition: "kept-view", ok: false, detail });
        console.log(`  FAIL ${name} — ${detail}`);
        await shot(`FAIL-kept-${name}`, tab);
      }
    };
    const threadRow = () => visible(tab, '[data-testid="persona-thread"] [data-message-id]', 30000);
    const kept = () =>
      waitFor("the kept Persona view in localStorage", 30000, () =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          return !!raw && (JSON.parse(raw).messages?.length ?? 0) > 0;
        }, CACHE_KEY)
      );
    let painted = false;
    await check("kept view saved", async () => {
      await page.goto(`${ORIGIN}/persona`);
      await threadRow();
      await kept();
      // A load that opens with the view kept by the last one, and keeps it in turn.
      await page.reload();
      await threadRow();
      await kept();
      painted = true;
    });
    if (painted) {
      // Before the next load's app code runs, the newest kept message's text is
      // swapped for a marker, and the page records whether the marker was ever
      // on screen: it can only come from the kept view, never the server.
      await page.addInitScript(
        ({ key, marker }) => {
          const w = window as any;
          w.__keptMarkerSeen = false;
          if (!sessionStorage.getItem("e2e-kept-marked")) {
            sessionStorage.setItem("e2e-kept-marked", "1");
            const raw = localStorage.getItem(key);
            if (raw) {
              const cache = JSON.parse(raw);
              const last = cache.messages[cache.messages.length - 1];
              if (last) last.text = marker;
              localStorage.setItem(key, JSON.stringify(cache));
            }
          }
          const look = () => {
            if (document.body?.textContent?.includes(marker)) w.__keptMarkerSeen = true;
          };
          new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
        },
        { key: CACHE_KEY, marker }
      );
      await page.reload();
      tab.boot = await page.evaluate(() => (window as any).__e2e.boot as string);
      await check("painted from the kept view", () =>
        waitFor("the kept marker on screen", 10000, () => page.evaluate(() => (window as any).__keptMarkerSeen === true))
      );
      await check("the kept rows replaced by the server's", () => text(tab, marker).waitFor({ state: "detached", timeout: 15000 }));
      await check("socket connected", () =>
        waitFor("the kept tab's socket", 30000, () => page.evaluate(() => (window as any).__e2e.sockets() >= 1))
      );

      const y = `kept${RUN}`;
      const nextStatus = chain.jobStatus === "active" ? "waiting_user" : "active";
      const since = Date.now();
      const triggered = await Promise.allSettled([
        sendMessage(`MSG-${y}`),
        sendMessage(`JOB-${y}`),
        personaTool("update_job", { jobId: statusJob.id, status: nextStatus }),
      ]);
      const triggerError = triggered.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (triggerError) console.log(`  trigger problem: ${String(triggerError.reason).slice(0, 300)}`);
      else chain.jobStatus = nextStatus;
      const limit = 10000;
      const left = () => Math.max(1, since + limit - Date.now());
      await check("kept view: reply arrives live", () => text(tab, `echo MSG-${y}`).waitFor({ timeout: left() }));
      await check("kept view: approval card arrives live", () => text(tab, `scratch repro JOB-${y}`).waitFor({ timeout: left() }));
      await check(`kept view: job ${statusLabel(nextStatus)} arrives live`, () =>
        jobRow(tab, statusJob.title, statusLabel(nextStatus)).waitFor({ timeout: left() })
      );
      await check("kept view: no reload", async () => {
        const boot = await page.evaluate(() => (window as any).__e2e?.boot as string | undefined);
        if (boot !== tab.boot) throw new Error("the kept tab reloaded");
      });
      await shot("kept-view", tab);
    }
    await keptContext.close().catch(() => {});
  }
} catch (err) {
  fatal = err;
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  // The launches' panes must be on the private server, never the default one.
  const listed = privateTmux("list-sessions", "-F", "#{session_name}").stdout.toString().split("\n").filter(Boolean);
  const onPrivate = launchedPanes.length > 0 && launchedPanes.every((p) => listed.includes(p));
  extras.push({
    check: "launches used the private tmux socket",
    condition: "all",
    ok: onPrivate,
    detail: `launched [${launchedPanes.join(", ")}], on ${TMUX_SOCK}: [${listed.join(", ")}]`,
  });
  writeMatrix();
  await cleanup();
}
const failed = cells.filter((c) => !c.ok).length + extras.filter((e) => !e.ok).length;
const expected = SURFACES.length * CONDITIONS.length;
console.log(`\n${cells.filter((c) => c.ok).length}/${expected} cells passed${fatal ? " (aborted)" : ""}; matrix at ${join(OUT, "matrix.json")}`);
process.exit(failed || fatal || cells.length < expected ? 1 : 0);
