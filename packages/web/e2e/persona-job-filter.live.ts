#!/usr/bin/env bun
/*
 * MANUAL, OWNER-RUN live check — not part of any automated suite; the owner
 * runs it by hand. Guardrails, each checked before anything is spawned:
 *  - One root, a mkdtemp dir under /tmp, holds HOME, XDG_*, TMPDIR/TMP/TEMP,
 *    DB_PATH, TMUX_TMPDIR, the owner token, knowledge, icons, projects, the
 *    internal and worktree roots and vite's cache. This process points its own
 *    TMPDIR, XDG_* and HOME there too before vite or Playwright loads, so
 *    their temp and profile dirs land in it (Bun caches os.homedir() at
 *    startup, so only code reading $HOME follows; Playwright's browsers are
 *    found by PLAYWRIGHT_BROWSERS_PATH).
 *  - The scratch collector gets an environment built from scratch (no
 *    TMUX/TMUX_PANE, Slack, ntfy, Persona/worker credentials or bind host),
 *    and runs with --no-env-file so no .env file adds to it.
 *  - The live install's ports (7777, 7778, 5173, 15173, 5199, 7787–7858) are
 *    refused.
 *  - Every call to the multiplexer carries `-S <root>/…` (a PATH shim for the
 *    collector's bare calls; the collector's worker server is on
 *    <root>/data/tmux/workers); teardown stops only those two servers.
 *  - No agent runs: STANDUP_PERSONA_STUB_TURNS=1 (asserted, and confirmed in
 *    the collector's log), so every Persona turn is answered in process with a
 *    scripted "stub reply". Only absolute PATH entries are passed down, none
 *    holding a `claude`, and the run stops if `command -v claude` finds one
 *    from the collector's own working directory.
 *  - The browser reaches only the scratch console.
 *  - Teardown is one shared promise: a signal (INT, TERM, HUP) or a failure
 *    anywhere, the pre-flight included, stops the collector (SIGKILL after
 *    10s), vite, the browser and both multiplexer servers, then removes the
 *    root; nothing is spawned once teardown has begun.
 *
 * Live check of the Persona view's job filter and the composer routing it
 * drives, on a throwaway install: a scratch collector with its own data dir,
 * owner token, project, private sockets and ports; the console's dev server
 * proxied to it; and headless Chromium (1440×900) signed in with a login code
 * minted from the scratch token. What Persona's turn reads of each owner
 * message is the collector's own formatUserMessage over the message's stored
 * inbox item (the stub turn records no prompt), read from the scratch DB once
 * the turn has consumed it.
 *
 *   bun --no-env-file packages/web/e2e/persona-job-filter.live.ts --out <dir> [--keep]
 *     [--playwright /path/to/node_modules/playwright] [--api-port N --ws-port N --web-port N]
 *
 * Playwright comes from --playwright, else $STANDUP_PLAYWRIGHT, else
 * /tmp/standup-pw/node_modules/playwright. Ports are picked free at run time
 * unless given. The root, /tmp/standup-job-filter-<run>-*, is removed at the
 * end (kept with --keep); screenshots, the summary and the collector's logs go
 * to <out>, which must be outside it (default /tmp/standup-job-filter-out-<run>).
 *
 * Fixtures: an untagged owner message makes the owner's console thread; once
 * its stub reply is stored, the run writes three jobs into the scratch DB with
 * the store's own createPersonaJob (Persona's open_job does the same insert)
 * and closes the third as cancelled with updatePersonaJob (close_job's status
 * write). These writes broadcast nothing, so every page loads after them. One
 * owner message is posted tagged to each job through the collector's API.
 *
 * The flow, once per theme (dark, then light; `standup.theme` in localStorage):
 *   1  open the job filter                                     -> jobfilter-<theme>-1-filter-open.png
 *   2  pick one job: ?tags=<id>, the filter bar shows           -> jobfilter-<theme>-2-filtered.png
 *   3  reload: the filter and the composer's route chip survive -> jobfilter-<theme>-3-route-chip.png
 *                                                                  (+ -3-route-chip-composer.png, the composer alone)
 *   4  send with the chip: the POST carries jobId, the stored message is tagged,
 *      and the turn's owner line carries [re job <id> "<title>"] -> jobfilter-<theme>-4-routed-sent.png
 *   5  clear the chip: ?tags is gone, the next send carries no jobId and no [re job
 *                                                               -> jobfilter-<theme>-5-cleared.png
 * The asserted lines and every check go to <out>/jobfilter-summary.json. The
 * exit code is non-zero on any failure.
 */
import { createHmac, randomBytes } from "crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import type { Browser, Page } from "playwright";
import { createPersonaJob, getPersonaInboxItem, getOrCreatePersonaConsoleThread, updatePersonaJob } from "../../store/src/index.ts";
import { formatUserMessage } from "../../collector/src/persona/prompt.ts";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const OUT = resolve(opt("out") ?? `/tmp/standup-job-filter-out-${RUN}`);
const KEEP = process.argv.includes("--keep");
const PLAYWRIGHT = opt("playwright") ?? process.env.STANDUP_PLAYWRIGHT ?? "/tmp/standup-pw/node_modules/playwright";
const GIVEN_PORTS = { "api-port": opt("api-port"), "ws-port": opt("ws-port"), "web-port": opt("web-port") };
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const BUN = process.execPath;

// The run's root: everything this run writes, and every env path a child gets, is under it.
const SCRATCH = mkdtempSync(`/tmp/standup-job-filter-${RUN}-`);
chmodSync(SCRATCH, 0o700);
const DB_PATH = join(SCRATCH, "data/standup.db");
const TMUX_SOCK = join(SCRATCH, "tmux.sock");
// The collector's own worker server (workerTmuxSocket: <dataDir>/tmux/workers), which its calls name with -S themselves.
const WORKERS_SOCK = join(SCRATCH, "data/tmux/workers");

// ── Teardown, armed before anything else can fail ──────────────────────────

let collector: Subprocess | undefined;
let vite: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
let browser: Browser | undefined;
let db: Database | undefined;
let realTmux: string | undefined;
let stopping = false;

/** Throws once teardown has begun, so nothing is spawned behind it. */
function stillRunning(): void {
  if (stopping) throw new Error("stopping: teardown has begun");
}

async function stopCollector(): Promise<void> {
  if (!collector || collector.exitCode !== null || collector.signalCode !== null) return;
  collector.kill("SIGTERM");
  const exited = await Promise.race([collector.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) {
    collector.kill("SIGKILL");
    await collector.exited;
  }
}

let teardown: Promise<void> | undefined;
let fatal: unknown;
/**
 * One teardown for every caller: a second call waits for the first. It writes
 * the summary first, so a run stopped by a signal leaves one too.
 */
function cleanup(): Promise<void> {
  stopping = true;
  teardown ??= (async () => {
    summary.checks = checks;
    summary.fatal = fatal ? String(fatal) : undefined;
    summary.pass = !fatal && checks.length > 0 && checks.every((c) => c.ok);
    try {
      writeFileSync(join(OUT, "jobfilter-summary.json"), JSON.stringify(summary, null, 2));
    } catch {
      // OUT was refused or never made; the console has the results.
    }
    await browser?.close().catch(() => {});
    try {
      db?.close();
    } catch {
      // Already closed.
    }
    await stopCollector().catch(() => {});
    await vite?.close().catch(() => {});
    // Only this run's own two servers, each named by its socket under the run root.
    if (realTmux && existsSync(TMUX_SOCK)) Bun.spawnSync([realTmux, "-S", TMUX_SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    if (realTmux && existsSync(WORKERS_SOCK)) Bun.spawnSync([realTmux, "-S", WORKERS_SOCK, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    try {
      mkdirSync(join(OUT, "jobfilter-logs"), { recursive: true });
      for (const f of readdirSync(SCRATCH)) if (f.startsWith("collector")) cpSync(join(SCRATCH, f), join(OUT, "jobfilter-logs", f));
    } catch {
      // The logs are a convenience; the summary is written above.
    }
    if (KEEP) console.log(`kept ${SCRATCH}`);
    else rmSync(SCRATCH, { recursive: true, force: true });
  })();
  return teardown;
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    // An interrupted run never passes, however many checks it got through.
    fatal ??= `stopped by ${signal}`;
    void cleanup().finally(() => process.exit(code));
  });
}

// ── Results ────────────────────────────────────────────────────────────────

type Json = Record<string, any>;
const checks: { check: string; ok: boolean; detail?: string }[] = [];
function record(check: string, ok: boolean, detail?: string): void {
  checks.push({ check, ok, ...(detail ? { detail } : {}) });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${check}${detail ? `: ${detail}` : ""}`);
}
async function step(check: string, fn: () => Promise<string | void>): Promise<boolean> {
  stillRunning();
  try {
    const detail = await fn();
    record(check, true, detail || undefined);
    return true;
  } catch (err) {
    record(check, false, String(err instanceof Error ? err.message : err).split("\n")[0]);
    return false;
  }
}
const summary: Json = { run: RUN, screenshots: {}, lines: {} };

// The live install's console, collector, socket, internal vite and test-console ports, and the range its second collectors use.
const REFUSED_PORTS = [7777, 7778, 5173, 15173, 5199];
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

async function pickPort(name: keyof typeof GIVEN_PORTS, taken: Set<number>): Promise<number> {
  const given = GIVEN_PORTS[name];
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
// caller's Persona and worker credentials, its terminal multiplexer, and a bind host
// that would take the scratch collector off loopback.
const DROPPED_ENV = new Set([
  "STANDUP_PERSONA",
  "STANDUP_WORKER_TOKEN_FILE",
  "STANDUP_PERSONAL_AWS_ACCOUNTS",
  "STANDUP_FFMPEG",
  "TMUX",
  "TMUX_PANE",
  "STANDUP_BIND_HOST",
  "STANDUP_LISTEN_PORT",
  "STANDUP_LISTEN_WS_PORT",
]);
const droppedEnvKey = (k: string) => DROPPED_ENV.has(k) || k.startsWith("SLACK_") || k.startsWith("NTFY_");
// The only settings a child of this run takes from the caller's environment;
// everything else a child sees is set below, pointing into the run dir.
const INHERITED_ENV = ["USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"] as const;
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(INHERITED_ENV.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
}

const JOBS = [
  { key: "alpha", title: "Fix the flaky checkout test", goal: "Make the checkout integration test pass reliably" },
  { key: "beta", title: "Migrate billing to the new ledger", goal: "Move billing writes onto the ledger service" },
  { key: "gamma", title: "Draft the Q3 latency report", goal: "Summarize p99 latency by region for Q3" },
];

try {
  if (OUT === SCRATCH || OUT.startsWith(`${SCRATCH}/`)) throw new Error(`--out ${OUT} is inside the run dir, which is removed at the end`);
  mkdirSync(OUT, { recursive: true });
  for (const k of Object.keys(process.env)) if (droppedEnvKey(k)) delete process.env[k];

  const taken = new Set<number>();
  const API_PORT = await pickPort("api-port", taken);
  const WS_PORT = await pickPort("ws-port", taken);
  const WEB_PORT = await pickPort("web-port", taken);
  const ORIGIN = `http://localhost:${WEB_PORT}`;
  const API = `http://127.0.0.1:${API_PORT}`;
  summary.ports = { api: API_PORT, ws: WS_PORT, web: WEB_PORT };

  const SCRATCH_DIRS = ["data/secrets", "knowledge", "icons", "internal", "bin", "home", "tmux", "worktrees", "repo", "tmp", "vite-cache", "xdg/config", "xdg/cache", "xdg/data", "xdg/state", "xdg/runtime"];
  for (const d of SCRATCH_DIRS) mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
  console.log(`run ${RUN}: scratch ${SCRATCH}, out ${OUT}`);
  console.log(`ports: collector ${API_PORT}, ws ${WS_PORT}, console ${WEB_PORT}`);

  const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
  writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  const token = readFileSync(TOKEN_FILE, "utf8").trim();

  const SCRATCH_BIN = join(SCRATCH, "bin");
  // Only absolute PATH entries, none holding a `claude`: a relative one would resolve against each child's own cwd.
  const SCRATCH_PATH = [
    SCRATCH_BIN,
    ...(process.env.PATH ?? "").split(":").filter((dir) => dir.startsWith("/") && !existsSync(join(dir, "claude"))),
  ].join(":");

  // The collector runs the multiplexer by bare name for its own calls; the
  // shim first on its PATH pins those to this run's socket with -S.
  const whichTmux = Bun.which("tmux");
  if (!whichTmux) throw new Error("no binary on PATH is named tmux");
  realTmux = realpathSync(whichTmux);
  if (realTmux === SCRATCH || realTmux.startsWith(`${SCRATCH}/`)) throw new Error(`the multiplexer binary resolves into the run dir (${realTmux})`);
  const tmuxShim = join(SCRATCH_BIN, "tmux");
  writeFileSync(tmuxShim, `#!/bin/sh\nexec '${realTmux}' -S '${TMUX_SOCK}' "$@"\n`);
  chmodSync(tmuxShim, 0o755);

  const scratchEnv: Record<string, string> = {
    ...inheritedEnv(),
    TERM: process.env.TERM || "xterm-256color",
    PATH: SCRATCH_PATH,
    HOME: join(SCRATCH, "home"),
    XDG_CONFIG_HOME: join(SCRATCH, "xdg/config"),
    XDG_CACHE_HOME: join(SCRATCH, "xdg/cache"),
    XDG_DATA_HOME: join(SCRATCH, "xdg/data"),
    XDG_STATE_HOME: join(SCRATCH, "xdg/state"),
    XDG_RUNTIME_DIR: join(SCRATCH, "xdg/runtime"),
    TMPDIR: join(SCRATCH, "tmp"),
    TMP: join(SCRATCH, "tmp"),
    TEMP: join(SCRATCH, "tmp"),
    TMUX_TMPDIR: join(SCRATCH, "tmux"),
    DB_PATH,
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    COLLECTOR_PORT: String(API_PORT),
    WS_PORT: String(WS_PORT),
    KNOWLEDGE_DIR: join(SCRATCH, "knowledge"),
    ICONS_DIR: join(SCRATCH, "icons"),
    STANDUP_PROJECTS_PATH: join(SCRATCH, "projects.toml"),
    STANDUP_INTERNAL_ROOT: join(SCRATCH, "internal"),
    STANDUP_WORKTREE_ROOT: join(SCRATCH, "worktrees"),
    STANDUP_PERSONA_COALESCE_S: "1",
    STANDUP_WEB_URL: `${ORIGIN}/`,
    STANDUP_PERSONA_STUB_TURNS: "1",
  };
  const RELOCATED = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] as const;

  // Pre-flight: nothing is spawned until every guard holds.
  {
    const inRun = (p: string) => resolve(p).startsWith(`${SCRATCH}/`);
    if (!SCRATCH.startsWith("/tmp/")) throw new Error(`the run dir ${SCRATCH} is not under /tmp`);
    for (const port of [API_PORT, WS_PORT, WEB_PORT, Number(scratchEnv.COLLECTOR_PORT), Number(scratchEnv.WS_PORT)]) {
      if (refusedPort(port)) throw new Error(`port ${port} belongs to the live install`);
    }
    if (new URL(API).port !== String(API_PORT) || new URL(ORIGIN).port !== String(WEB_PORT)) throw new Error("API or ORIGIN is not on this run's ports");
    if (scratchEnv.STANDUP_PERSONA_STUB_TURNS !== "1") throw new Error("the scratch collector would run real Persona turns");
    for (const sock of [TMUX_SOCK, WORKERS_SOCK]) if (!inRun(sock)) throw new Error(`the socket ${sock} is outside the run dir`);
    const entries = scratchEnv.PATH!.split(":");
    const relative = entries.filter((dir) => !dir.startsWith("/"));
    if (relative.length) throw new Error(`the scratch PATH has relative entries: ${relative.join(", ")}`);
    const firstTmux = entries.findIndex((dir) => existsSync(join(dir, "tmux")));
    if (entries[firstTmux] !== SCRATCH_BIN) throw new Error(`${SCRATCH_BIN} is not ahead of every PATH entry holding the multiplexer`);
    const resolved = Bun.spawnSync(["sh", "-c", "command -v tmux"], { env: scratchEnv, cwd: COLLECTOR_DIR }).stdout.toString().trim();
    if (resolved !== tmuxShim) throw new Error(`the scratch PATH resolves the multiplexer to ${resolved || "nothing"}, not the shim`);
    const agent = Bun.spawnSync(["sh", "-c", "command -v claude || true"], { env: scratchEnv, cwd: COLLECTOR_DIR }).stdout.toString().trim();
    if (agent) throw new Error(`an agent binary resolves to ${agent} on the scratch PATH`);
    for (const [name, env] of [["scratch children", scratchEnv], ["this process (vite)", process.env]] as const) {
      const leaked = Object.keys(env).filter(droppedEnvKey);
      if (leaked.length) throw new Error(`${name} env still carries ${leaked.join(", ")}`);
    }
    for (const k of [...RELOCATED, "TMUX_TMPDIR", "DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_PROJECTS_PATH", "STANDUP_INTERNAL_ROOT", "STANDUP_WORKTREE_ROOT"]) {
      if (!inRun(scratchEnv[k]!)) throw new Error(`${k} ${scratchEnv[k]} is outside the run dir`);
    }
  }
  // This process hosts vite and Playwright's driver, which make their temp and profile dirs under its own TMPDIR and HOME.
  // The installed browsers are found by their own path (read-only), as the relocated HOME has none.
  if (process.env.HOME && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.env.HOME, ".cache/ms-playwright");
  for (const k of RELOCATED) process.env[k] = scratchEnv[k];

  const git = (...args: string[]): void => {
    const res = Bun.spawnSync(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], {
      cwd: join(SCRATCH, "repo"),
      env: scratchEnv,
    });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(SCRATCH, "repo/README.md"), "scratch repo for the job filter check\n");
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

  // ── Scratch collector ──
  stillRunning();
  const collectorErr = join(SCRATCH, "collector.err.log");
  collector = Bun.spawn([BUN, "--no-env-file", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, "collector.log")),
    stderr: Bun.file(collectorErr),
  });
  console.log(`  collector pid ${collector.pid}`);
  for (let i = 0; ; i++) {
    stillRunning();
    if (collector.exitCode !== null || collector.signalCode !== null) throw new Error(`scratch collector exited (${collector.exitCode ?? collector.signalCode})`);
    if (i >= 240) throw new Error("scratch collector never came up");
    const up = await fetch(`${API}/api/projects`).then(() => true, () => false);
    if (up) break;
    await Bun.sleep(250);
  }
  // The collector decides on stub turns itself (only with its own DB_PATH): its log says which it chose.
  {
    let said = "";
    for (let i = 0; i < 40 && !said.includes("every turn answers with a scripted reply"); i++) {
      said = existsSync(collectorErr) ? readFileSync(collectorErr, "utf8") : "";
      if (said.includes("Ignoring STANDUP_PERSONA_STUB_TURNS")) break;
      await Bun.sleep(250);
    }
    if (!said.includes("every turn answers with a scripted reply")) throw new Error("the scratch collector did not confirm stub turns in its log");
  }

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-standup-owner-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { status: res.status, json };
  };

  /**
   * The scratch collector's own DB (DB_PATH, inside the run dir), already
   * migrated by it. A plain handle, waiting out the collector's writes for up
   * to 5s rather than failing on them.
   */
  const scratchDb = (): Database => {
    if (!resolve(DB_PATH).startsWith(`${SCRATCH}/`)) throw new Error(`${DB_PATH} is outside the run dir`);
    if (!db) {
      db = new Database(DB_PATH);
      db.exec("PRAGMA busy_timeout = 5000");
    }
    return db;
  };

  /**
   * The owner line Persona's turn reads for message `messageId`: the
   * collector's formatUserMessage over the message's inbox item, once a (stub)
   * turn has consumed it. Also the stored message's job tags.
   */
  const turnLineFor = async (messageId: string) => {
    const d = scratchDb();
    for (let i = 0; i < 240; i++) {
      const row = d
        .query("SELECT id FROM persona_inbox WHERE kind = 'user_message' AND json_extract(payload_json, '$.messageId') = ? LIMIT 1")
        .get(messageId) as { id: string } | null;
      const item = row ? getPersonaInboxItem(d, row.id) : null;
      if (item && item.status === "done") {
        const storedTags = d.query("SELECT job_id, source FROM persona_message_jobs WHERE message_id = ?").all(messageId) as { job_id: string; source: string }[];
        return { line: formatUserMessage(item, item.owner), storedTags };
      }
      await Bun.sleep(250);
    }
    throw new Error(`message ${messageId} was never consumed by a Persona turn`);
  };

  /** Waits until the thread holds a Persona reply after `seq`, so the turn's own writes are done. */
  const replyStoredAfter = async (threadId: string, seq: number) => {
    for (let i = 0; i < 120; i++) {
      const res = await call("GET", `/api/persona/messages?threadId=${encodeURIComponent(threadId)}&afterSeq=${seq}`);
      if ((res.json.messages as Json[] | undefined)?.some((m) => m.role === "persona")) return;
      await Bun.sleep(250);
    }
    throw new Error(`no Persona reply after seq ${seq}`);
  };

  // ── Fixtures ──
  const jobIds: Record<string, string> = {};
  let owner = "";
  await step("untagged owner message is consumed by a stub Persona turn", async () => {
    const res = await call("POST", "/api/persona/messages", { text: "Morning! Anything on fire? MSG-hello" });
    if (res.status >= 300) throw new Error(`send -> ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
    const message = res.json.message as Json;
    const thread = scratchDb().query("SELECT owner FROM persona_threads WHERE id = ?").get(message?.threadId) as { owner: string } | null;
    owner = thread?.owner ?? "";
    if (!owner) throw new Error(`no thread ${message?.threadId} in the scratch DB`);
    const { line } = await turnLineFor(message.id);
    await replyStoredAfter(message.threadId, message.seq);
    return `owner ${owner}: ${line}`;
  });
  await step("three jobs written to the scratch DB, the third closed as cancelled", async () => {
    const d = scratchDb();
    const threadId = getOrCreatePersonaConsoleThread(d, owner).id;
    for (const j of JOBS) jobIds[j.key] = createPersonaJob(d, { owner, threadId, title: j.title, goal: j.goal }).id;
    updatePersonaJob(d, jobIds.gamma!, { status: "cancelled", outcome: "Superseded by the dashboard" });
    const listed = await call("GET", "/api/persona/jobs");
    const statuses = Object.fromEntries((listed.json.jobs as Json[]).map((j) => [j.title, j.status]));
    summary.jobs = { ids: jobIds, statuses };
    if (statuses[JOBS[2]!.title] !== "cancelled" || statuses[JOBS[0]!.title] !== "active") throw new Error(`jobs read back as ${JSON.stringify(statuses)}`);
    return JSON.stringify(statuses);
  });
  await step("one owner message tagged to each job", async () => {
    for (const j of JOBS) {
      const res = await call("POST", "/api/persona/messages", { text: `Where are we on ${j.key}? MSG-seed${j.key}`, jobId: jobIds[j.key] });
      if (res.status >= 300) throw new Error(`send ${j.key} -> ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
      await turnLineFor(res.json.message.id);
      await replyStoredAfter(res.json.message.threadId, res.json.message.seq);
    }
  });

  // ── The console ──
  stillRunning();
  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: String(API_PORT),
    SCRATCH_WS_PORT: String(WS_PORT),
    SCRATCH_WEB_PORT: String(WEB_PORT),
  });
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  // No HMR or file watching: an edit elsewhere in the tree must not reload the page mid-run.
  vite = await createServer({
    configFile: join(import.meta.dir, "vite.scratch.config.ts"),
    cacheDir: join(SCRATCH, "vite-cache"),
    logLevel: "warn",
    server: { hmr: false, watch: null },
  });
  stillRunning();
  await vite!.listen();

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  stillRunning();
  browser = await chromium.launch({ env: scratchEnv });

  const alpha = JOBS[0]!;
  const alphaId = () => jobIds.alpha!;

  for (const themeName of ["dark", "light"] as const) {
    stillRunning();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const host = new URL(url).host;
      return host === `localhost:${WEB_PORT}` || url.startsWith("blob:") || url.startsWith("data:") ? route.continue() : route.abort();
    });
    await context.addInitScript((t) => window.localStorage.setItem("standup.theme", t), themeName);
    const expiry = String(Math.floor(Date.now() / 1000) + 600);
    const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
    const login = await context.newPage();
    await login.goto(`${ORIGIN}/__standup/login?code=${code}`);
    await login.close();

    const page: Page = await context.newPage();
    page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  console error: ${m.text().slice(0, 200)}`);
    });
    const shot = async (name: string, fn?: (path: string) => Promise<unknown>) => {
      const path = join(OUT, name);
      await (fn ? fn(path) : page.screenshot({ path }));
      summary.screenshots[name] = path;
    };
    const composer = page.locator('[data-testid="persona-composer"]');
    const textarea = composer.locator("textarea");
    const chip = page.locator('[data-testid="composer-route-chip"]');
    const tagsParam = () => new URL(page.url()).searchParams.get("tags");
    const sendViaEnter = async (text: string) => {
      await textarea.fill(text);
      const sent = page.waitForRequest((r) => r.url().endsWith("/api/persona/messages") && r.method() === "POST", { timeout: 30000 });
      await textarea.press("Enter");
      const req = await sent;
      const body = req.postDataJSON() as Json;
      const res = await req.response();
      if (!res || res.status() >= 300) throw new Error(`send -> ${res?.status()} ${(await res?.text())?.slice(0, 200)}`);
      const messageId = ((await res.json()) as Json).message?.id as string;
      return { body, messageId };
    };
    const stubReplies = () => page.evaluate(() => document.body.innerText.split("stub reply").length - 1);

    await page.goto(`${ORIGIN}/persona`);
    await composer.waitFor({ timeout: 30000 });
    await page.getByText("Where are we on gamma?", { exact: false }).first().waitFor({ timeout: 30000 });

    await step(`${themeName}: page renders with data-theme=${themeName}`, async () => {
      const applied = await page.evaluate(() => document.documentElement.dataset.theme);
      if (applied !== themeName) throw new Error(`data-theme is ${applied}`);
    });

    await step(`${themeName}: filter popover lists All, Active and Recently closed`, async () => {
      await page.locator('[data-testid="job-filter-button"]').click();
      const popover = page.locator('[data-testid="job-filter-popover"]');
      await popover.waitFor({ timeout: 10000 });
      await popover.locator('[data-testid="job-filter-all"]').waitFor({ timeout: 5000 });
      // innerText applies the section labels' text-transform, so labels match without case.
      const text = (await popover.innerText()).replace(/\s+/g, " ");
      const lower = text.toLowerCase();
      for (const want of ["All", "Active", "Recently closed", ...JOBS.map((j) => j.title)]) {
        if (!lower.includes(want.toLowerCase())) throw new Error(`popover lacks "${want}": ${text.slice(0, 300)}`);
      }
      const closedAt = lower.indexOf("recently closed");
      if (closedAt > lower.indexOf(JOBS[2]!.title.toLowerCase()) || closedAt < lower.indexOf(JOBS[0]!.title.toLowerCase()) || closedAt < lower.indexOf(JOBS[1]!.title.toLowerCase())) {
        throw new Error(`gamma is not under Recently closed: ${text.slice(0, 300)}`);
      }
      await shot(`jobfilter-${themeName}-1-filter-open.png`);
      return text.slice(0, 240);
    });

    await step(`${themeName}: picking one job filters the thread (?tags, filter bar)`, async () => {
      const before = await page.locator("[data-message-id]").count();
      await page.locator(`[data-testid="job-filter-option"][data-job-id="${alphaId()}"]`).click();
      await page.waitForFunction((id) => new URL(location.href).searchParams.get("tags") === id, alphaId(), { timeout: 10000 });
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="job-filter-bar"]').waitFor({ timeout: 10000 });
      await page.getByText("Where are we on alpha?", { exact: false }).first().waitFor({ timeout: 10000 });
      await page.waitForFunction(() => !document.body.innerText.includes("Where are we on beta?"), null, { timeout: 10000 }).catch(() => {});
      const others = await page.getByText("Where are we on beta?", { exact: false }).count();
      const after = await page.locator("[data-message-id]").count();
      await shot(`jobfilter-${themeName}-2-filtered.png`);
      if (others > 0) throw new Error("beta's message still shows in alpha's filter");
      if (!(after < before)) throw new Error(`message count ${before} -> ${after}`);
      return `?tags=${tagsParam()}, messages ${before} -> ${after}`;
    });

    await step(`${themeName}: reload keeps the filter and the route chip`, async () => {
      await page.reload();
      await composer.waitFor({ timeout: 30000 });
      if (tagsParam() !== alphaId()) throw new Error(`?tags is ${tagsParam()} after reload`);
      await page.locator('[data-testid="job-filter-bar"]').waitFor({ timeout: 10000 });
      await chip.waitFor({ timeout: 10000 });
      // The chip appears once the jobs list knows the job; it reads its title.
      await chip.getByText(alpha.title).waitFor({ timeout: 15000 }).catch(() => {});
      const chipText = (await chip.innerText()).replace(/\s+/g, " ").trim();
      const placeholder = await textarea.getAttribute("placeholder");
      if (!chipText.includes(alpha.title) || !chipText.includes(alphaId().slice(0, 8))) throw new Error(`chip reads "${chipText}"`);
      if (placeholder !== `Message Persona about ${alpha.title}…`) throw new Error(`placeholder is "${placeholder}"`);
      await shot(`jobfilter-${themeName}-3-route-chip.png`);
      await shot(`jobfilter-${themeName}-3-route-chip-composer.png`, (path) => composer.screenshot({ path }));
      summary[`${themeName}Chip`] = { chipText, placeholder };
      return `chip "${chipText}", placeholder "${placeholder}"`;
    });

    const routedMarker = `MSG-${themeName}routed`;
    await step(`${themeName}: a send with the chip carries jobId, is stored tagged, and the turn line has [re job]`, async () => {
      const text = `Please rerun the suite with retries off ${routedMarker}`;
      const repliesBefore = await stubReplies();
      const { body, messageId } = await sendViaEnter(text);
      if (body.jobId !== alphaId()) throw new Error(`POST body jobId is ${body.jobId}`);
      const { line, storedTags } = await turnLineFor(messageId);
      summary.lines[`${themeName}Routed`] = { messageId, line, storedTags, postBody: body };
      if (!storedTags.some((t) => t.job_id === alphaId() && t.source === "explicit")) throw new Error(`stored tags ${JSON.stringify(storedTags)}`);
      const want = ` [re job ${alphaId()} "${alpha.title}"] ${text}`;
      if (!line.includes(want)) throw new Error(`line "${line}" lacks "${want}"`);
      await page.waitForFunction((n) => document.body.innerText.split("stub reply").length - 1 > n, repliesBefore, { timeout: 30000 });
      await shot(`jobfilter-${themeName}-4-routed-sent.png`);
      return line;
    });

    const plainMarker = `MSG-${themeName}plain`;
    await step(`${themeName}: the chip's × clears ?tags and the next send is untagged`, async () => {
      await chip.getByRole("button").click();
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("tags"), null, { timeout: 10000 });
      await chip.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      if ((await chip.count()) !== 0) throw new Error("route chip still shows");
      await shot(`jobfilter-${themeName}-5-cleared.png`);
      const text = `Unrelated: lunch at noon? ${plainMarker}`;
      const { body, messageId } = await sendViaEnter(text);
      if (body.jobId !== undefined) throw new Error(`POST body carries jobId ${body.jobId}`);
      const { line, storedTags } = await turnLineFor(messageId);
      summary.lines[`${themeName}Plain`] = { messageId, line, storedTags, postBody: body };
      if (line.includes("[re job")) throw new Error(`line "${line}" is tagged`);
      if (storedTags.some((t) => t.source === "explicit")) throw new Error(`stored explicit tags ${JSON.stringify(storedTags)}`);
      if (!line.endsWith(text)) throw new Error(`line "${line}" does not end with the text`);
      return line;
    });

    await context.close();
  }
} catch (err) {
  fatal = err;
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await cleanup();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed${fatal ? " (aborted)" : ""}; summary at ${join(OUT, "jobfilter-summary.json")}`);
process.exit(failed || fatal ? 1 : 0);
