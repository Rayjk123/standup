#!/usr/bin/env bun
/*
 * Live check of worker hygiene on a throwaway install: per-launch scratch dirs
 * on disk as the worker's TMPDIR, the idle reaper pausing a worker and the
 * next message resuming it, a registered process stopped when its job closes,
 * and a dry run of the orphan sweep over this host's real process table.
 *
 *   bun packages/collector/e2e/worker-hygiene.live.ts [--cache-parent /var/tmp] [--console]
 *
 * One scratch collector runs from this checkout with its own data dir, DB,
 * owner token, ports, HOME/XDG dirs and worker tmux server (its own
 * `<data>/tmux/workers` socket). Every `claude` it starts is
 * worker-hygiene-stub-claude.ts: a launched worker posts hook events as
 * Claude Code would and sits at an idle prompt; a Persona turn answers
 * "[silent]". The worker is launched through Persona's launch_session (so it
 * belongs to a job) and its job closed with close_job; --console launches it
 * through the console's launch route instead and ends it with the cleanup
 * route.
 *
 * The run dir is a `mktemp -d` under /tmp. The worker's scratch dirs live
 * under XDG_CACHE_HOME, which is put in a second temp dir under
 * --cache-parent (default /var/tmp), because /tmp is often a tmpfs and the
 * check asserts the scratch dir is not. Both are left for inspection.
 *
 * Prints a JSON summary of samples ({name, request, response, ok, problems})
 * on stdout, progress on stderr, and exits 0 only when every sample holds.
 *
 * Isolation: children get an environment built from scratch (no Slack, ntfy,
 * caller tmux or Standup settings); the live install's ports are refused;
 * every tmux call of this run goes to the scratch collector's workers socket
 * (`-S`, exact `=name` targets), and teardown kills only that server, the
 * scratch collector this run spawned, and the dummy server its stub started.
 */
import { randomBytes, randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { Subprocess } from "bun";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { workerTmuxSocket } from "@standup/shared/owner-token";
import { SCRATCH_MARKER } from "@standup/shared/scratch";
import { collectorPortSet } from "@standup/shared/topology";
import { findOrphans, type OrphanTarget } from "../src/orphan-sweep.js";
import { createProcessSystem } from "../src/process-registry.js";
import { canonicalPath } from "../src/restart/state.js";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}
const log = (...args: unknown[]) => console.error("[hygiene-live]", ...args);

const COLLECTOR_DIR = resolve(import.meta.dir, "..");
const REPO = resolve(COLLECTOR_DIR, "../..");
const STUB = join(import.meta.dir, "worker-hygiene-stub-claude.ts");
const BUN = process.execPath;
const CONSOLE_MODE = process.argv.includes("--console");
const OWNER = process.env.USER || "owner";
const PROJECT = "hygiene";

// The collector runs from this checkout only, never the live install's. The
// live install is STANDUP_INSTALL_DIR. When it is unset, the check can't be
// made, and the run is refused unless STANDUP_E2E_NOT_LIVE=1 says this
// checkout is not the live install. The live data dir is never read.
const liveInstalls = [process.env.STANDUP_INSTALL_DIR?.trim()]
  .filter((dir): dir is string => !!dir)
  .map(canonicalPath);
const repoReal = canonicalPath(REPO);
if (liveInstalls.some((live) => repoReal === live || repoReal.startsWith(`${live}/`))) {
  throw new Error(`refusing to run the collector from ${REPO}: it is the live Standup install`);
}
if (liveInstalls.length === 0 && process.env.STANDUP_E2E_NOT_LIVE !== "1") {
  throw new Error(
    `refusing to run the collector from ${REPO}: no live install is known (set STANDUP_INSTALL_DIR to it, or STANDUP_E2E_NOT_LIVE=1 when this checkout is not one)`
  );
}
if (!existsSync(join(COLLECTOR_DIR, "src", "index.ts")) || !existsSync(STUB)) throw new Error(`${COLLECTOR_DIR} is not a collector package with the stub`);

// ── Run dirs ────────────────────────────────────────────────────────────────

const R = realpathSync(mkdtempSync("/tmp/standup-hygiene-"));
const cacheParent = resolve(opt("cache-parent") ?? "/var/tmp");
const CACHE_RUN = realpathSync(mkdtempSync(join(cacheParent, "standup-hygiene-cache-")));
const XDG_CACHE_HOME = join(CACHE_RUN, "cache");
const SCRATCH_ROOT = join(XDG_CACHE_HOME, "standup-scratch");
const DATA = join(R, "data");
const BIN = join(R, "bin");
for (const d of [
  "data/secrets",
  "home",
  "xdg/config",
  "xdg/data",
  "xdg/state",
  "knowledge",
  "icons",
  "internal",
  "worktrees",
  "tmp",
  "tmux",
  "bin",
  "transcripts",
  "claude-config",
  "project-docs",
]) {
  mkdirSync(join(R, d), { recursive: true, mode: 0o700 });
}
mkdirSync(XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
for (const p of [R, CACHE_RUN, STUB, BUN]) {
  if (p.includes("'")) throw new Error(`${p} has a single quote; the shims can't quote it`);
}
log(`run dir ${R}; cache dir ${CACHE_RUN}`);

// ── Ports ───────────────────────────────────────────────────────────────────

// The live install's collector ports (public and both slots, by default and as
// this environment sets them), its console and vite ports, and the range its
// second collectors use.
const REFUSED = new Set<number>([...collectorPortSet({}), ...collectorPortSet(process.env), 5173, 15173]);
const refusedPort = (port: number) => REFUSED.has(port) || (port >= 7787 && port <= 7858);
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
const takenPorts = new Set<number>();
const API_PORT = await pickPort("collector", takenPorts);
const WS_PORT = await pickPort("ws", takenPorts);
const API = `http://127.0.0.1:${API_PORT}`;
log(`ports: collector ${API_PORT}, ws ${WS_PORT}`);

// ── Secrets, shims, fixtures ────────────────────────────────────────────────

const TOKEN_FILE = join(DATA, "secrets", "owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const ownerToken = readFileSync(TOKEN_FILE, "utf8").trim();

// The scratch collector's workers' tmux socket; every tmux call of this run goes there.
const SOCK = workerTmuxSocket(DATA);
mkdirSync(dirname(SOCK), { recursive: true, mode: 0o700 });
const whichTmux = Bun.which("tmux");
if (!whichTmux) throw new Error("tmux is not on PATH");
const REAL_TMUX = realpathSync(whichTmux);
if (REAL_TMUX.startsWith(`${R}/`)) throw new Error(`tmux resolves into the run dir (${REAL_TMUX})`);
writeFileSync(join(BIN, "tmux"), `#!/bin/sh\nexec '${REAL_TMUX}' -S '${SOCK}' "$@"\n`);
chmodSync(join(BIN, "tmux"), 0o755);

// The dummy server a worker starts and registers: it lives in the run dir, as
// a worker's own script would, never under the install dir (which the
// registry refuses). argv: <info json> <port file>.
const DUMMY = join(BIN, "dummy-server.ts");
writeFileSync(
  DUMMY,
  [
    'import { writeFileSync } from "fs";',
    "const [out, portFile] = process.argv.slice(2);",
    'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });',
    "if (portFile) { try { writeFileSync(portFile, String(server.port)); } catch {} }",
    "writeFileSync(out!, JSON.stringify({ pid: process.pid, port: server.port }));",
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n")
);

writeFileSync(
  join(BIN, "claude"),
  `#!/bin/sh\nHYGIENE_RUN_DIR='${R}' HYGIENE_API='${API}' HYGIENE_BUN='${BUN}' HYGIENE_DUMMY='${DUMMY}' exec '${BUN}' '${STUB}' "$@"\n`
);
chmodSync(join(BIN, "claude"), 0o755);
// The worker's stub starts the dummy server when this exists.
writeFileSync(join(R, "start-dummy"), "1\n");

writeFileSync(
  join(R, "projects.toml"),
  [
    "[[project]]",
    `id = "${PROJECT}"`,
    `name = "${PROJECT}"`,
    "repos = []",
    `branch = "main"`,
    `worktreeRoot = "${join(R, "worktrees")}"`,
    "bypassPermissions = false",
    "",
  ].join("\n")
);

const PATH = [...new Set([BIN, dirname(BUN), "/usr/bin", "/bin"])].join(":");
const env: Record<string, string> = {
  PATH,
  USER: OWNER,
  LOGNAME: OWNER,
  SHELL: "/bin/sh",
  LANG: process.env.LANG || "C.UTF-8",
  TERM: "xterm-256color",
  ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  HOME: join(R, "home"),
  XDG_CONFIG_HOME: join(R, "xdg/config"),
  XDG_DATA_HOME: join(R, "xdg/data"),
  XDG_STATE_HOME: join(R, "xdg/state"),
  XDG_CACHE_HOME,
  TMPDIR: join(R, "tmp"),
  TMP: join(R, "tmp"),
  TEMP: join(R, "tmp"),
  TMUX_TMPDIR: join(R, "tmux"),
  CLAUDE_CONFIG_DIR: join(R, "claude-config"),
  DB_PATH: join(DATA, "standup.db"),
  // A library path that doesn't exist: sqlite-vec stays off (STANDUP_DISABLE_VEC too).
  STANDUP_SQLITE_PATH: join(R, "no-sqlite", "libsqlite3.so"),
  STANDUP_DISABLE_VEC: "1",
  KNOWLEDGE_DIR: join(R, "knowledge"),
  ICONS_DIR: join(R, "icons"),
  STANDUP_PROJECTS_PATH: join(R, "projects.toml"),
  STANDUP_INTERNAL_ROOT: join(R, "internal"),
  STANDUP_WORKTREE_ROOT: join(R, "worktrees"),
  STANDUP_PROJECT_DOCS_DIR: join(R, "project-docs"),
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  STANDUP_WRITE_TOKEN_FILE: join(DATA, "secrets", "write-token"),
  COLLECTOR_PORT: String(API_PORT),
  WS_PORT: String(WS_PORT),
  STANDUP_BIND_HOST: "127.0.0.1",
  STANDUP_GATEWAY: "0",
  STANDUP_PERSONA: CONSOLE_MODE ? "0" : "1",
  STANDUP_PERSONA_COALESCE_S: "1",
  // A worker idle 6s is paused (3s once its job is closed); the reaper ticks every second.
  STANDUP_IDLE_REAP_MS: "6000",
  STANDUP_IDLE_REAP_CLOSED_MS: "3000",
  STANDUP_REAPER_INTERVAL_MS: "1000",
  STANDUP_HOST_HEADROOM: "0",
  // The scratch collector never signals anything on its own: the sweep is dry-run here instead.
  STANDUP_ORPHAN_SWEEP: "0",
  STANDUP_DIGEST: "0",
  STANDUP_KB_NIGHTLY_SWEEP: "0",
  STANDUP_KNOWLEDGE_REVERIFY: "0",
  STANDUP_NATIVE_MEMORY_EXCLUDE_HOME: "1",
  EMBEDDING_PROVIDER: "",
  NTFY_TOPIC: "",
  NTFY_OWNER_TOPICS: "",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
};

// Pre-flight: every path a child is pointed at is this run's, `claude` and
// `tmux` resolve to this run's shims, and nothing of the caller's leaks in.
{
  const inRun = (p: string) => resolve(p).startsWith(`${R}/`) || resolve(p).startsWith(`${CACHE_RUN}/`);
  for (const k of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TMUX_TMPDIR",
    "CLAUDE_CONFIG_DIR",
    "DB_PATH",
    "STANDUP_SQLITE_PATH",
    "KNOWLEDGE_DIR",
    "ICONS_DIR",
    "STANDUP_PROJECTS_PATH",
    "STANDUP_INTERNAL_ROOT",
    "STANDUP_WORKTREE_ROOT",
    "STANDUP_PROJECT_DOCS_DIR",
    "STANDUP_OWNER_TOKEN_FILE",
    "STANDUP_WRITE_TOKEN_FILE",
  ]) {
    if (!inRun(env[k]!)) throw new Error(`${k} ${env[k]} is outside the run dirs`);
  }
  if (!inRun(SOCK)) throw new Error(`the workers socket ${SOCK} is outside the run dir`);
  const leaked = Object.keys(env).filter((k) => k.startsWith("SLACK_") || k === "TMUX" || k === "TMUX_PANE" || k === "STANDUP_WORKER_TOKEN_FILE");
  if (leaked.length) throw new Error(`scratch env carries ${leaked.join(", ")}`);
  for (const [tool, want] of [["claude", join(BIN, "claude")], ["tmux", join(BIN, "tmux")]] as const) {
    const got = Bun.spawnSync(["sh", "-c", `command -v ${tool}`], { env }).stdout.toString().trim();
    if (got !== want) throw new Error(`${tool} on the scratch PATH resolves to ${got || "nothing"}, not ${want}`);
  }
  for (const tool of ["findmnt", "setsid", "ps", "git"]) {
    if (!Bun.which(tool, { PATH })) throw new Error(`${tool} is not on the scratch PATH`);
  }
  const fs = Bun.spawnSync(["findmnt", "-no", "FSTYPE", "-T", XDG_CACHE_HOME]).stdout.toString().trim();
  log(`XDG_CACHE_HOME ${XDG_CACHE_HOME} is on ${fs || "an unknown filesystem"}`);
  if (fs === "tmpfs") log("warning: --cache-parent is a tmpfs, so sample A's not-tmpfs check will fail");
}
writeFileSync(join(R, "env.json"), JSON.stringify(env, null, 2) + "\n", { mode: 0o600 });

/** The real tmux, on this run's workers socket only. */
function privateTmux(...args: string[]) {
  return Bun.spawnSync([REAL_TMUX, "-S", SOCK, ...args], { env, stdout: "pipe", stderr: "pipe" });
}

// ── Collector ───────────────────────────────────────────────────────────────

let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn([BUN, "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env,
    stdout: Bun.file(join(R, "collector.log")),
    stderr: Bun.file(join(R, "collector.err.log")),
  });
  log(`collector pid ${collector.pid}`);
}
async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (collector?.exitCode !== null || collector.signalCode !== null) {
      throw new Error(`scratch collector exited (${collector?.exitCode ?? collector?.signalCode}); see ${R}/collector.err.log`);
    }
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(250);
  }
  throw new Error("scratch collector never answered /health");
}

type Json = Record<string, any>;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, owner = true): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(owner ? { "x-standup-owner-token": ownerToken, [DEFAULT_IDENTITY_HEADER]: OWNER } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return { status: res.status, json: Array.isArray(parsed) ? { items: parsed } : (parsed as Json) };
  } catch {
    return { status: res.status, json: { raw: text.slice(0, 300) } };
  }
}

async function waitFor<T>(label: string, timeoutMs: number, fn: () => Promise<T | null | undefined> | T | null | undefined, pollMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && (v as unknown) !== false) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
    await Bun.sleep(pollMs);
  }
}

function readJsonLines(file: string): Json[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Json];
      } catch {
        return [];
      }
    });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function launchOf(id: string): Promise<Json> {
  const { status, json } = await call("GET", `/api/launches/${id}`);
  if (status !== 200) throw new Error(`GET /api/launches/${id}: ${status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function checkpointsOf(sessionId: string): Promise<Json[]> {
  const { json } = await call("GET", "/api/checkpoints?limit=500");
  return ((json.items ?? []) as Json[]).filter((c) => c.sessionId === sessionId);
}

// ── Persona ─────────────────────────────────────────────────────────────────

const PERSONA_TOKEN_FILE = join(R, "persona-token");
let personaToken: string | null = null;
/** Persona's token, copied by the stub from the first Persona turn's MCP config (a message starts one). */
async function ensurePersonaToken(): Promise<string> {
  if (personaToken) return personaToken;
  const sent = await call("POST", "/api/persona/messages", { text: "worker-hygiene live check: hello", idempotencyKey: randomUUID() });
  if (sent.status >= 300) throw new Error(`POST /api/persona/messages: ${sent.status} ${JSON.stringify(sent.json).slice(0, 200)}`);
  personaToken = await waitFor("a Persona turn's token", 60_000, () => (existsSync(PERSONA_TOKEN_FILE) ? readFileSync(PERSONA_TOKEN_FILE, "utf8").trim() || null : null), 500);
  return personaToken;
}
/** Calls a Persona tool through the collector's Persona tool route, as Persona's MCP server does; the parsed result. */
async function personaTool(name: string, args: Json): Promise<{ status: number; result: Json; raw: Json }> {
  const token = await ensurePersonaToken();
  const { status, json } = await call("POST", "/api/persona/tool", { name, arguments: args }, { "x-standup-persona-token": token }, false);
  const text = (json.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
  let result: Json;
  try {
    result = JSON.parse(text) as Json;
  } catch {
    result = { text };
  }
  if (json.isError) result = { error: text };
  return { status, result, raw: json };
}

// ── Samples ─────────────────────────────────────────────────────────────────

type Sample = { name: string; request: string; response: Json; ok: boolean; problems: string[] };
const samples: Sample[] = [];
function record(name: string, request: string, response: Json, problems: string[]): Sample {
  const s: Sample = { name, request, response, ok: problems.length === 0, problems };
  samples.push(s);
  log(`${s.ok ? "PASS" : "FAIL"} ${name}${s.ok ? "" : `: ${problems.join("; ")}`}`);
  return s;
}

let dummyPid: number | undefined;
let cleaned = false;
async function teardown(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  // The dummy server this run's stub started, only when its command line is still that script's.
  if (dummyPid && alive(dummyPid)) {
    const args = createProcessSystem().argsOf(dummyPid) ?? "";
    if (args.includes(DUMMY)) {
      try {
        process.kill(dummyPid, "SIGKILL");
        log(`killed the leftover dummy server ${dummyPid}`);
      } catch {
        // gone meanwhile
      }
    }
  }
  if (collector && collector.exitCode === null && collector.signalCode === null) {
    collector.kill("SIGTERM");
    const exited = await Promise.race([collector.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
    if (!exited) collector.kill("SIGKILL");
  }
  // Only the scratch collector's workers server, by its own socket.
  if (existsSync(SOCK)) privateTmux("kill-server");
  log(`left ${R} and ${CACHE_RUN} for inspection`);
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void teardown().finally(() => process.exit(code)));
}

async function main(): Promise<void> {
  startCollector();
  await waitForHealth();
  log("collector healthy");

  // ── Launch ──
  let launchId: string;
  let jobId: string | undefined;
  if (CONSOLE_MODE) {
    const req = { task: "worker-hygiene live check: sit at the prompt." };
    const res = await call("POST", `/api/projects/${PROJECT}/launch`, req);
    const problems = res.status === 200 && res.json.launch?.id ? [] : [`launch route answered ${res.status}`];
    record("launch (console)", `POST /api/projects/${PROJECT}/launch ${JSON.stringify(req)}`, { status: res.status, launch: res.json.launch ?? res.json }, problems);
    if (problems.length) return;
    launchId = res.json.launch.id as string;
  } else {
    const args = { task: "worker-hygiene live check: sit at the prompt.", projectId: PROJECT, title: "hygiene live check", reason: "isolated live check of worker hygiene" };
    const res = await personaTool("launch_session", args);
    const problems: string[] = [];
    if (res.status !== 200 || res.result.error) problems.push(`launch_session failed: ${res.result.error ?? res.status}`);
    if (!res.result.launchId || !res.result.jobId) problems.push("launch_session returned no launchId/jobId (held or queued?)");
    record("launch (Persona launch_session)", `POST /api/persona/tool launch_session ${JSON.stringify(args)}`, { status: res.status, result: res.result }, problems);
    if (problems.length) return;
    launchId = res.result.launchId as string;
    jobId = res.result.jobId as string;
  }
  const running = await waitFor("the launch running with a session", 90_000, async () => {
    const l = await launchOf(launchId);
    if (l.status === "failed") throw new Error(`launch failed: ${l.error}`);
    return l.status === "running" && l.sessionId ? l : null;
  });
  const sessionId = running.sessionId as string;
  const tmuxSession = running.tmuxSession as string;
  const worktreePath = running.worktreePath as string;
  log(`launch ${launchId} running: session ${sessionId}, pane ${tmuxSession}`);
  const scratchDir = join(SCRATCH_ROOT, launchId);

  // ── A: TMPDIR on disk ──
  {
    const first = await waitFor("the worker's env line", 30_000, () => readJsonLines(join(R, "claude-env.log")).find((e) => e.sessionId === sessionId && !e.resume) ?? null).catch(() => null);
    const problems: string[] = [];
    const markerFile = join(scratchDir, SCRATCH_MARKER);
    const marker = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim() : null;
    if (!first) problems.push("the stub never logged its env");
    else {
      if (first.TMPDIR !== scratchDir) problems.push(`TMPDIR is ${first.TMPDIR}, not ${scratchDir}`);
      if (first.TMP !== scratchDir || first.TEMP !== scratchDir) problems.push(`TMP/TEMP are ${first.TMP}/${first.TEMP}`);
      if (!first.fstype) problems.push("the TMPDIR filesystem type could not be read");
      else if (first.fstype === "tmpfs") problems.push("TMPDIR is on tmpfs");
    }
    if (marker !== launchId) problems.push(`marker ${markerFile} holds ${JSON.stringify(marker)}, not the launch id`);
    record(
      "A: worker TMPDIR is its disk-backed scratch dir",
      `launch ${launchId}; the stub records TMPDIR/TMP/TEMP and findmnt -no FSTYPE -T "$TMPDIR"`,
      { expectedTmpdir: scratchDir, collectorTmpdir: env.TMPDIR, worker: first, marker: { file: markerFile, content: marker } },
      problems
    );
  }

  // ── B: reap + resume ──
  {
    const problems: string[] = [];
    const reaped = await waitFor("the idle reaper to pause the worker", 90_000, async () => {
      const l = await launchOf(launchId);
      return l.reapedAt ? l : null;
    }).catch((err: Error) => {
      problems.push(err.message);
      return null;
    });
    const paneAfterPause = privateTmux("has-session", "-t", `=${tmuxSession}`).exitCode === 0;
    const pausedCheckpoint = reaped ? (await checkpointsOf(sessionId)).find((c) => String(c.summary).startsWith("Paused after")) : undefined;
    if (reaped) {
      if (reaped.status !== "running") problems.push(`a paused launch reads ${reaped.status}, not running`);
      if (paneAfterPause) problems.push("the pane is still up after the pause");
      if (!pausedCheckpoint) problems.push('no "Paused after" checkpoint');
    }
    const sendReq = { text: "worker-hygiene live check: continue" };
    const sent = reaped ? await call("POST", `/api/sessions/${sessionId}/send`, sendReq) : { status: 0, json: {} };
    if (reaped && sent.status !== 200) problems.push(`send answered ${sent.status}: ${JSON.stringify(sent.json).slice(0, 200)}`);
    const after = reaped ? await launchOf(launchId) : null;
    const argvLines = readJsonLines(join(R, "claude-argv.log"));
    const resumedArgv = argvLines.find((a) => a.resume === sessionId);
    const resumeFlag = resumedArgv ? (resumedArgv.argv as string[]).indexOf("--resume") : -1;
    if (reaped) {
      if (!resumedArgv || resumeFlag < 0 || (resumedArgv.argv as string[])[resumeFlag + 1] !== sessionId) problems.push(`the stub was not re-run with --resume ${sessionId}`);
      if (after?.status !== "running") problems.push(`after the send the launch is ${after?.status}`);
      if (after?.reapedAt) problems.push("reapedAt is still set after the send");
    }
    const resumedCheckpoint = reaped ? await waitFor("the resume checkpoint", 10_000, async () => (await checkpointsOf(sessionId)).find((c) => c.summary === "Resumed after idle pause.") ?? null).catch(() => null) : null;
    if (reaped && !resumedCheckpoint) problems.push('no "Resumed after idle pause." checkpoint');
    const delivered = reaped
      ? await waitFor("the message typed into the resumed pane", 15_000, () => readJsonLines(join(R, "claude-input.log")).find((i) => i.pid === resumedArgv?.pid && String(i.prompt).includes(sendReq.text)) ?? null).catch(() => null)
      : null;
    if (reaped && !delivered) problems.push("the message never reached the resumed stub");
    record(
      "B: idle worker paused, resumed by the next message",
      `wait for GET /api/launches/${launchId} reapedAt; POST /api/sessions/${sessionId}/send ${JSON.stringify(sendReq)}`,
      {
        paused: reaped ? { status: reaped.status, reapedAt: reaped.reapedAt, reapReason: reaped.reapReason, paneUp: paneAfterPause } : null,
        pausedCheckpoint: pausedCheckpoint?.summary ?? null,
        send: { status: sent.status, body: sent.json },
        resumedArgv: resumedArgv ?? null,
        afterSend: after ? { status: after.status, reapedAt: after.reapedAt ?? null } : null,
        resumedCheckpoint: resumedCheckpoint?.summary ?? null,
        delivered: delivered ?? null,
      },
      problems
    );
  }

  // ── C: registered dummy stopped with the job ──
  {
    const problems: string[] = [];
    const reg = await waitFor("the stub's registration of the dummy server", 30_000, () => (existsSync(join(R, "register.json")) ? (JSON.parse(readFileSync(join(R, "register.json"), "utf8")) as Json) : null)).catch(() => null);
    const pid = reg?.request?.pid as number | undefined;
    dummyPid = pid;
    if (!reg) problems.push("the stub never registered the dummy");
    else if (reg.status !== 200 || reg.response?.process?.pid !== pid) problems.push(`register answered ${reg.status}: ${JSON.stringify(reg.response ?? reg.error).slice(0, 200)}`);
    const before = await call("GET", `/api/processes?launchId=${launchId}`);
    const listedBefore = ((before.json.processes ?? []) as Json[]).some((p) => p.pid === pid);
    const aliveBefore = pid ? alive(pid) : false;
    if (pid && !listedBefore) problems.push("the dummy isn't listed live before the close");
    // It survived the idle pause in B: a paused worker of an open job keeps its processes.
    if (pid && !aliveBefore) problems.push("the dummy was already gone before the close (the pause should have kept it)");

    let closeRequest: string;
    let closeResponse: Json;
    if (CONSOLE_MODE || !jobId) {
      closeRequest = `POST /api/launches/${launchId}/cleanup (substitute for close_job: no Persona job)`;
      const res = await call("POST", `/api/launches/${launchId}/cleanup`, {});
      closeResponse = { status: res.status, body: res.json };
      if (res.status !== 200) problems.push(`cleanup answered ${res.status}`);
    } else {
      const args = { jobId, status: "cancelled", outcome: "worker-hygiene live check finished", reason: "end of the isolated live check" };
      closeRequest = `POST /api/persona/tool close_job ${JSON.stringify(args)}`;
      const res = await personaTool("close_job", args);
      closeResponse = { status: res.status, result: res.result };
      if (res.status !== 200 || res.result.error) problems.push(`close_job failed: ${res.result.error ?? res.status}`);
    }
    const gone = pid ? await waitFor("the dummy server to exit", 20_000, () => (!alive(pid) ? true : null)).catch(() => false) : false;
    if (pid && !gone) problems.push(`the dummy ${pid} is still alive after the close`);
    const after = await call("GET", `/api/processes?launchId=${launchId}`);
    const listedAfter = ((after.json.processes ?? []) as Json[]).some((p) => p.pid === pid);
    if (listedAfter) problems.push("the dummy is still listed live after the close");
    const scratchLeft = existsSync(scratchDir);
    if (scratchLeft) problems.push(`the scratch dir ${scratchDir} is still there`);
    record(
      "C: registered dummy server stopped when the job closes",
      `stub POST /api/processes/register ${JSON.stringify(reg?.request ?? {})}; ${closeRequest}; GET /api/processes?launchId=${launchId}`,
      {
        register: reg,
        before: { status: before.status, listed: listedBefore, alive: aliveBefore },
        close: closeResponse,
        after: { status: after.status, listed: listedAfter, processes: after.json.processes ?? after.json, dummyAlive: pid ? alive(pid) : null },
        scratchDirRemoved: !scratchLeft,
      },
      problems
    );
  }

  // ── D: orphan sweep, dry run ──
  {
    const problems: string[] = [];
    const sys = createProcessSystem();
    const table = sys.processTable();
    const targets: OrphanTarget[] = [{ launchId, ...(jobId ? { jobId } : {}), sessionId, paths: [scratchDir, worktreePath].filter(Boolean) }];
    const orphans = table ? findOrphans(table, targets, { selfPid: collector!.pid, uid: sys.uid(), installDir: REPO }) : [];
    if (!table) problems.push("ps could not be read");
    const outside = orphans.filter((o) => !(o.path.startsWith(`${R}/`) || o.path.startsWith(`${CACHE_RUN}/`)));
    if (outside.length) problems.push(`${outside.length} orphan(s) matched a path outside the run dirs`);
    record(
      "D: orphan sweep dry run over this host's ps",
      `findOrphans(ps -ww -eo pid=,ppid=,pgid=,uid=,lstart=,args=, targets of finished launch ${launchId}) — no signal sent`,
      {
        rowsScanned: table?.length ?? 0,
        targets,
        wouldStop: orphans.map((o) => ({ pid: o.row.pid, ppid: o.row.ppid, pgid: o.row.pgid, path: o.path, args: o.row.args.slice(0, 200) })),
      },
      problems
    );
  }
}

let fatal: string | undefined;
try {
  await main();
} catch (err) {
  fatal = (err as Error).stack ?? String(err);
  log(`fatal: ${fatal}`);
} finally {
  await teardown();
}
const ok = !fatal && samples.length > 0 && samples.every((s) => s.ok);
console.log(JSON.stringify({ ok, runDir: R, cacheDir: CACHE_RUN, collectorLog: join(R, "collector.err.log"), ...(fatal ? { fatal } : {}), samples }, null, 2));
process.exit(ok ? 0 : 1);
