#!/usr/bin/env bun
/*
 * Measures how fast the console's Persona view loads, on a throwaway install:
 * a scratch collector with its own data dir, owner token and ports (Slack and
 * ntfy env removed), the console served either by the vite dev server or from
 * a production build, and a headless browser signed in with a login code
 * minted from the scratch token. Before the collector starts, its DB is seeded
 * with a heavy owner's history (seed-realistic.ts); a Persona reply posted
 * after that (from fake-claude.ts) is the newest message, the render the clock
 * stops on.
 *
 *   bun packages/web/e2e/load-time.measure.ts --scratch /tmp/x --playwright /path/to/node_modules/playwright \
 *     --mode dev|prod [--dist <prebuilt dist>] [--runs 5] [--web-port N] [--api-port N] [--ws-port N] \
 *     [--throttle tunnel] [--screenshots /tmp/x/shots] [--json /tmp/x/result.json] [--budgets] [--serve-only] \
 *     [--seed default|none] [--seed-sessions N] [--seed-messages N] [--seed-jobs N] ... (see SEED_FLAGS;
 *     --seed-transcripts 0 seeds no session transcripts)
 *
 * A port left out is a free one picked in 30000-31999. console-perf.ts (`bun run perf:console`) runs this
 * with a scratch dir, Playwright and the budgets found for it.
 *
 * Per load it reports, on the page's own clock from navigation start:
 *   shellPaintMs     the frame the console shell ([data-testid=console-shell]) is first in (shellDomMs: its
 *                    insertion), next to first-contentful-paint (fcpMs, which the "Loading..." screen may be);
 *   composerReadyMs  the Persona composer's text box ([data-testid=persona-composer] textarea) is usable:
 *                    visible (checkVisibility), neither disabled nor readOnly, and the element hit at its
 *                    centre (elementFromPoint), so nothing covers it;
 *   latestMessagesMs the newest Persona message is visible: an element whose text holds it passes
 *                    checkVisibility (on a load that starts with the kept view, keptAtStart, that can be the
 *                    kept copy; personaReadMs is the server's thread);
 *   personaUsableMs  the later of composerReadyMs and latestMessagesMs; a load where either never comes
 *                    (within 60 s) has none;
 *   helloMs/helloKb  the WS hello-ok snapshot's arrival and size;
 * and the requests made before latestMessagesMs (the waterfall). Over the cold loads that started with no
 * kept view it reports personaVisibleMs (latestMessagesMs) and personaUsableMs, each's median and worst.
 * JS coverage is taken on one extra cold load, outside those numbers.
 *
 * --budgets holds the run to load-budgets.ts: the WORST cold no-kept-view personaUsableMs (every load must
 * be usable within budget; one with no personaUsableMs fails), the hello-ok frame's bytes, and the bodies
 * of GET /api/launches and of the Board's first read as the signed-in console receives them, each parsed as
 * the JSON it should be. It prints a `PASS <metric>: ...` or `FAIL <metric>: ...` line per budget. The byte
 * budgets are for the default seed volumes, so --budgets refuses any --seed flag that changes them.
 *
 * The run exits 1 on a breached budget, a failed live-update check, a page error, or a measurement that
 * threw (`FAIL measurement: <message>`, after whatever budget lines it had already computed).
 *
 * --serve-only seeds, starts the scratch collector and the console, prints the console URL, a sign-in URL
 * and the collector's pid, and stays up until SIGINT or SIGTERM, then stops what it started. It measures
 * nothing and needs no --playwright.
 *
 * prod builds the app with serve.ts (or serves --dist as it is) behind vite
 * preview. Each run is a cold load: a new browser context with an empty cache
 * and the sign-in cookie, the way a hard refresh starts. It reports, at the
 * moment the Persona reply first renders, the requests made and bytes
 * transferred, plus the JS coverage of what loaded, then a warm reload. With
 * --screenshots it also opens every tab by URL in its own cold context and
 * shoots it. The browser resolves no host but localhost.
 */
import { createHmac, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { Subprocess } from "bun";
import type { Browser, BrowserContext, Page } from "playwright";
import { WORKER_TMUX_SOCKET_SUBPATH } from "@standup/shared";
import { mintLoginCode } from "../owner-proxy";
import {
  BOARD_FIRST_PAGE_BUDGET_BYTES,
  BOARD_FIRST_PAGE_PATH,
  budgetLine,
  HELLO_OK_BUDGET_BYTES,
  LAUNCHES_BUDGET_BYTES,
  PERSONA_USABLE_BUDGET_MS,
  type BudgetCheck,
} from "./load-budgets";
import {
  DEFAULT_VOLUMES,
  NO_VOLUMES,
  realUnderTmp,
  refuseLiveInstall,
  refuseSymlink,
  requireOwnedDir,
  seedRealistic,
  type SeedVolumes,
} from "./seed-realistic";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
const optional = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** The range a port left unset is picked from, clear of the live install's ports. */
const PICK_PORTS_FROM = 30000;
const PICK_PORTS_TO = 31999;

/** A port nothing on 127.0.0.1 holds, in PICK_PORTS_FROM..PICK_PORTS_TO and not in `taken`. */
function pickFreePort(taken: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = PICK_PORTS_FROM + Math.floor(Math.random() * (PICK_PORTS_TO - PICK_PORTS_FROM + 1));
    if (taken.has(String(candidate))) continue;
    try {
      const listener = Bun.listen({ hostname: "127.0.0.1", port: candidate, socket: { data() {} } });
      listener.stop(true);
      return String(candidate);
    } catch {
      // Held by something else: try another.
    }
  }
  throw new Error(`no free port in ${PICK_PORTS_FROM}-${PICK_PORTS_TO}`);
}

/** A port flag as its canonical decimal string, so "05173" and "5173" are the same port; unset, a free one. */
const port = (name: string, taken: Set<string>): string => {
  const value = optional(name);
  if (value === undefined) return pickFreePort(taken);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`--${name} ${value} is not a port`);
  return String(n);
};

const SERVE_ONLY = flag("serve-only");
/** How long --serve-only's sign-in URL stays usable: long enough to set up a recording. */
const SERVE_ONLY_LOGIN_TTL_S = 12 * 60 * 60;
const BUDGETS = flag("budgets");
const SCRATCH_ARG = resolve(arg("scratch"));
const PLAYWRIGHT = SERVE_ONLY ? "" : arg("playwright");
const MODE = arg("mode");
const DIST = optional("dist");
const RUNS = Number(arg("runs", "5"));
const takenPorts = new Set<string>();
const WEB_PORT = port("web-port", takenPorts);
takenPorts.add(WEB_PORT);
const API_PORT = port("api-port", takenPorts);
takenPorts.add(API_PORT);
const WS_PORT = port("ws-port", takenPorts);
const SHOTS = optional("screenshots");
// --throttle tunnel emulates reaching the console through a tunnel rather
// than loopback: 40 ms round trips and 4 MB/s down, 1 MB/s up.
const THROTTLE = optional("throttle") === "tunnel" ? { latencyMs: 40, downBytesPerS: 4 * 1024 * 1024, upBytesPerS: 1024 * 1024 } : undefined;
const JSON_OUT = optional("json");
// --seed default|none picks the base volumes; --seed-<name> overrides one.
const SEED_FLAGS: Record<string, keyof SeedVolumes> = {
  "seed-projects": "projects",
  "seed-sessions": "sessions",
  "seed-active-sessions": "activeSessions",
  "seed-checkpoints-per-session": "checkpointsPerSession",
  "seed-asks": "asks",
  "seed-pending-asks": "pendingAsks",
  "seed-messages": "messages",
  "seed-jobs": "jobs",
  "seed-approvals": "approvals",
  "seed-pending-approvals": "pendingApprovals",
  "seed-launches": "launches",
  "seed-tickets": "tickets",
  "seed-days": "days",
  "seed-events-per-session": "eventsPerSession",
  "seed-transcripts": "transcripts",
};
const SEED = arg("seed", "default");
if (SEED !== "default" && SEED !== "none") throw new Error("--seed is default or none");
const VOLUMES: SeedVolumes = { ...(SEED === "none" ? NO_VOLUMES : DEFAULT_VOLUMES) };
for (const [flag, key] of Object.entries(SEED_FLAGS)) {
  const value = optional(flag);
  if (value === undefined) continue;
  if (!/^\d+$/.test(value)) throw new Error(`--${flag} takes a count`);
  VOLUMES[key] = Number(value);
}
// The byte budgets are sizes at the default volumes: any other seed would pass or fail them for nothing.
const changedVolumes = (Object.keys(DEFAULT_VOLUMES) as (keyof SeedVolumes)[]).filter((k) => VOLUMES[k] !== DEFAULT_VOLUMES[k]);
if (BUDGETS && changedVolumes.length) {
  console.log(`FAIL budgets: --budgets needs the default seed volumes; this run changes ${changedVolumes.join(", ")}`);
  process.exit(1);
}
const ORIGIN = `http://localhost:${WEB_PORT}`;
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const CONFIG = join(import.meta.dir, "vite.loadtime.config.ts");

if (MODE !== "dev" && MODE !== "prod") throw new Error("--mode is dev or prod");
// The live install's console, collector, socket and test-console ports.
const LIVE_PORTS = new Set(["5173", "7777", "7778", "5199", "15173"]);
for (const p of [WEB_PORT, API_PORT, WS_PORT]) {
  if (LIVE_PORTS.has(p)) throw new Error(`port ${p} belongs to the live install`);
  // Refused means free; an answer, or a connection that never answers, means taken.
  const free = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(2000) }).then(
    () => false,
    (err: unknown) => !(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
  );
  if (!free) throw new Error(`port ${p} is already in use`);
}

// The scratch dir, by its real path: under the real /tmp, a directory of this
// user's (no symlink), as is its data dir. Every directory in it is checked
// the same way before anything is written there.
realUnderTmp(SCRATCH_ARG);
refuseSymlink(SCRATCH_ARG);
mkdirSync(SCRATCH_ARG, { recursive: true, mode: 0o700 });
requireOwnedDir(SCRATCH_ARG);
const SCRATCH = realUnderTmp(SCRATCH_ARG);
for (const d of ["data", "data/secrets", "knowledge", "icons", "internal", "bin", "home", "tmux"]) {
  const dir = join(SCRATCH, d);
  refuseSymlink(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  requireOwnedDir(dir);
}
const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");

// Loopback only, no Slack or ntfy, none of the calling session's Persona or
// worker identity, Claude config, embedding provider or AWS credentials, tmux
// on a scratch socket dir, and none of the live install's settings (ports,
// paths, data dirs): nothing this run does reaches anyone or anything outside
// the scratch dir. Dropped from this process too, which hosts the console's
// server.
const LIVE_SETTINGS = new Set([
  "DB_PATH",
  "COLLECTOR_PORT",
  "WS_PORT",
  "KNOWLEDGE_DIR",
  "ICONS_DIR",
  "TMUX",
  "TMUX_PANE",
  "TMUX_TMPDIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
]);
const ISOLATED_PREFIXES = ["STANDUP_", "SLACK_", "NTFY_", "EMBEDDING_", "AWS_"];
const isolated = (k: string) => LIVE_SETTINGS.has(k) || ISOLATED_PREFIXES.some((p) => k.startsWith(p));
for (const k of Object.keys(process.env)) if (isolated(k)) delete process.env[k];
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !isolated(k)));
const SCRATCH_HOME = join(SCRATCH, "home");
const scratchEnv: Record<string, string | undefined> = {
  ...inherited,
  PATH: `${join(SCRATCH, "bin")}:${process.env.PATH}`,
  // Every homedir()-derived default (data dir, knowledge, icons, memory
  // ingest) lands in the scratch dir rather than the owner's home.
  HOME: SCRATCH_HOME,
  // Any tmux the collector runs starts its own server on a socket in here.
  TMUX_TMPDIR: join(SCRATCH, "tmux"),
  // Headroom no host has, so the scratch collector never launches a worker.
  STANDUP_HOST_MIN_FREE_MB: "999999999",
  DB_PATH: join(SCRATCH, "data/standup.db"),
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  COLLECTOR_PORT: API_PORT,
  WS_PORT,
  KNOWLEDGE_DIR: join(SCRATCH, "knowledge"),
  ICONS_DIR: join(SCRATCH, "icons"),
  STANDUP_PROJECTS_PATH: join(SCRATCH, "projects.toml"),
  STANDUP_INTERNAL_ROOT: join(SCRATCH, "internal"),
  STANDUP_PERSONA_COALESCE_S: "1",
  STANDUP_WEB_URL: `${ORIGIN}/`,
  // Listening on loopback only, with no gateway, review tunnels or daily
  // digest: the collector serves the console and nothing else.
  STANDUP_BIND_HOST: "127.0.0.1",
  STANDUP_GATEWAY: "0",
  STANDUP_REVIEW_TUNNELS: "0",
  STANDUP_DIGEST: "0",
};
// Every path the collector writes really resolves inside the scratch dir:
// the directories by their real path, the files through their directory's
// real path and never through a symlink of their own.
for (const k of ["HOME", "TMUX_TMPDIR", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_INTERNAL_ROOT"]) {
  const real = realUnderTmp(scratchEnv[k] ?? "");
  if (!real.startsWith(`${SCRATCH}/`)) throw new Error(`${k}=${scratchEnv[k]} resolves to ${real}, outside the scratch dir ${SCRATCH}`);
  requireOwnedDir(real);
}
for (const k of ["DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "STANDUP_PROJECTS_PATH"]) {
  const file = resolve(scratchEnv[k] ?? "");
  const dir = realpathSync(dirname(file));
  if (dir !== SCRATCH && !dir.startsWith(`${SCRATCH}/`)) throw new Error(`${k}=${file} is in ${dir}, outside the scratch dir ${SCRATCH}`);
  refuseSymlink(file);
}
// And neither the database nor HOME is, or holds, the live install's data dir.
refuseLiveInstall(scratchEnv.DB_PATH!);
refuseLiveInstall(scratchEnv.HOME!);

writeFileSync(scratchEnv.STANDUP_PROJECTS_PATH!, "");
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = (await Bun.file(TOKEN_FILE).text()).trim();

const shim = join(SCRATCH, "bin/claude");
refuseSymlink(shim);
writeFileSync(shim, `#!/bin/sh\nexec bun ${join(import.meta.dir, "fake-claude.ts")} "$@"\n`);
chmodSync(shim, 0o755);
// Any tmux the scratch collector runs goes to a server on a socket file in the
// scratch dir (-S): never the shared default server or a named one beside it.
const TMUX_SOCKET = join(SCRATCH, "tmux/sock");
const whichTmux = Bun.which("tmux", { PATH: process.env.PATH ?? "" });
const realTmux = whichTmux ? realpathSync(whichTmux) : null;
if (realTmux?.startsWith(`${SCRATCH}/`)) throw new Error(`tmux resolves into the scratch dir (${realTmux})`);
if (realTmux) {
  const tmuxShim = join(SCRATCH, "bin/tmux");
  refuseSymlink(tmuxShim);
  writeFileSync(tmuxShim, `#!/bin/sh\nexec ${realTmux} -S ${TMUX_SOCKET} "$@"\n`);
  chmodSync(tmuxShim, 0o755);
}
// The collector runs its workers on its own socket under its data dir (its
// own -S, which wins over the shim's), so cleanup stops that server as well.
const TMUX_SOCKETS = [TMUX_SOCKET, join(dirname(scratchEnv.DB_PATH!), WORKER_TMUX_SOCKET_SUBPATH)];
/** Stops the run's own tmux servers, by socket path, if the collector started any. */
const killScratchTmux = () => {
  if (!realTmux) return;
  for (const socket of TMUX_SOCKETS) {
    if (existsSync(socket)) Bun.spawnSync([realTmux, "-S", socket, "kill-server"], { env: scratchEnv, stderr: "ignore" });
  }
};

let collector: Subprocess | undefined;
let closeWeb: (() => Promise<void>) | undefined;
let browser: Browser | undefined;
let cleaning: Promise<void> | undefined;
/** Stops the browser, the collector (waiting for it to exit), the console's server and tmux; once. */
const cleanup = () =>
  (cleaning ??= (async () => {
    await browser?.close().catch(() => {});
    if (collector && collector.exitCode === null) {
      collector.kill("SIGTERM");
      await collector.exited;
    }
    await closeWeb?.().catch(() => {});
    killScratchTmux();
  })());
const onSignal: Record<"SIGINT" | "SIGTERM", () => void> = {
  SIGINT: () => void cleanup().finally(() => process.exit(130)),
  SIGTERM: () => void cleanup().finally(() => process.exit(143)),
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, onSignal[signal]);
/**
 * vite's servers add signal handlers that exit the process at once, ahead of
 * cleanup; dropping them leaves the exit to cleanup, after the collector has
 * exited, so whoever removes the scratch dir next finds nothing still in it.
 */
const keepOnlyOwnSignalHandlers = () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) if (listener !== onSignal[signal]) process.off(signal, listener);
  }
  // vite also exits on stdin's end (outside CI), which would skip the budgets.
  process.stdin.removeAllListeners("end");
};
/** Whether `pid` is gone or only a zombie waiting to be reaped. */
const exitedPid = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
};
// Any other way out still takes the collector and its tmux servers down,
// waiting (up to 10 s) for the collector to exit.
process.on("exit", () => {
  if (collector && collector.exitCode === null) {
    collector.kill("SIGTERM");
    for (let i = 0; i < 100 && !exitedPid(collector.pid); i++) Bun.sleepSync(100);
  }
  killScratchTmux();
});

/** One request made by the time the newest message rendered, from resource timing. */
interface WaterfallEntry {
  path: string;
  initiator: string;
  startMs: number;
  durationMs: number;
  /** Bytes over the wire (0 from the HTTP cache), and the decoded body. */
  transferKb: number;
  bodyKb: number;
}

interface Load {
  /**
   * ms from navigation start to the newest Persona message's first render. On
   * a load that starts with the kept view this can be the kept copy's paint,
   * ahead of the server's thread (personaReadMs).
   */
  latestMessagesMs?: number;
  /** A kept Persona view was in localStorage at document start. */
  keptAtStart: boolean;
  /** The console shell's insertion, and the frame it is first in. */
  shellDomMs?: number;
  shellPaintMs?: number;
  /** first-contentful-paint, whatever painted first. */
  fcpMs?: number;
  /** The Persona composer's text box is visible, writable and not covered. */
  composerReadyMs?: number;
  /** The later of composerReadyMs and latestMessagesMs: the view can be read and written in. */
  personaUsableMs?: number;
  /** The first /api/persona/messages response ended: the server's thread is in hand. */
  personaReadMs?: number;
  /** The WS hello-ok snapshot: when it arrived and its size. */
  helloMs?: number;
  helloKb?: number;
  helloBytes?: number;
  /** The path and query of the first board list read the page sent, by the time it went quiet. */
  boardFirstPath?: string;
  waterfall: WaterfallEntry[];
  /** Requests (the document included) and bytes transferred by that moment. */
  requests: number;
  kb: number;
  scripts: number;
  scriptKb: number;
  /** Requests and KB once the page went quiet (idle prefetches included). */
  settledRequests: number;
  settledKb: number;
  /** JS loaded by the first render and how much of it ran. */
  jsKb?: number;
  jsUsedPct?: number;
}

const median = (xs: (number | undefined)[]): number | null => {
  const known = xs.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  return known.length ? known[Math.floor(known.length / 2)]! : null;
};

const output: Record<string, unknown> = { mode: MODE, dist: DIST ?? null, runs: RUNS, throttle: THROTTLE ?? null };
/** --budgets: one PASS or FAIL line per budget, as each is measured. */
const budgetLines: string[] = [];
/** FAIL lines outside the budgets: the live-update check, page errors, a measurement that threw. */
const runFailures: string[] = [];
try {
  // The console's owner is the collector's host user (hostUserAlias); the
  // seeded console thread must be that owner's to be the one the page opens.
  const owner = scratchEnv.STANDUP_HOST_USER?.trim() || scratchEnv.USER?.trim() || "local";
  const seeded = seedRealistic(scratchEnv.DB_PATH!, owner, VOLUMES, { home: SCRATCH_HOME });
  output.seed = { preset: SEED, owner, volumes: VOLUMES, ...seeded };
  console.log(`seeded ${scratchEnv.DB_PATH} for ${owner} in ${seeded.ms} ms: ${JSON.stringify(seeded.counts)}, avg message ${seeded.avgMessageChars} chars`);

  collector = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, `collector-${Date.now()}.log`)),
    stderr: "inherit",
  });
  for (let i = 0; ; i++) {
    if (collector.exitCode !== null) throw new Error(`scratch collector exited (${collector.exitCode})`);
    if (i > 240) throw new Error("scratch collector never came up");
    const up = await fetch(`http://127.0.0.1:${API_PORT}/api/projects`).then(() => true, () => false);
    if (up) break;
    await Bun.sleep(250);
  }

  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: API_PORT,
    SCRATCH_WS_PORT: WS_PORT,
    SCRATCH_WEB_PORT: WEB_PORT,
  });
  const vite = await import("vite");
  if (MODE === "dev") {
    const server = await vite.createServer({ configFile: CONFIG, logLevel: "warn" });
    await server.listen();
    closeWeb = () => server.close();
  } else if (DIST) {
    const server = await vite.preview({ configFile: CONFIG, logLevel: "warn", build: { outDir: resolve(DIST) } });
    closeWeb = () => server.close();
  } else {
    const { serveConsole } = await import("../serve");
    const served = await serveConsole({ configFile: CONFIG, outDir: join(SCRATCH, "dist"), watch: false, logLevel: "warn" });
    closeWeb = () => served.close();
  }
  keepOnlyOwnSignalHandlers();

  // One Persona reply for the clock to stop on.
  const probe = `MSG-probe${Date.now().toString(36)}`;
  const posted = await fetch(`http://127.0.0.1:${API_PORT}/api/persona/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-standup-owner-token": token },
    body: JSON.stringify({ text: probe, idempotencyKey: crypto.randomUUID() }),
  });
  if (!posted.ok) throw new Error(`seeding the Persona thread failed: ${posted.status}`);
  const needle = `echo ${probe}`;
  for (let i = 0; ; i++) {
    if (i > 120) throw new Error("the seeded Persona reply never arrived");
    const body = await fetch(`http://127.0.0.1:${API_PORT}/api/persona/messages`, {
      headers: { "x-standup-owner-token": token },
    }).then((r) => r.text());
    if (body.includes(needle)) break;
    await Bun.sleep(500);
  }

  if (SERVE_ONLY) {
    const login = `${ORIGIN}/__standup/login?code=${mintLoginCode(token, Date.now(), SERVE_ONLY_LOGIN_TTL_S)}`;
    console.log(`console: ${ORIGIN}/persona`);
    console.log(`sign-in: ${login}`);
    console.log(`collector pid: ${collector.pid} (api 127.0.0.1:${API_PORT}, ws 127.0.0.1:${WS_PORT}), scratch ${SCRATCH}`);
    console.log("serving until SIGINT or SIGTERM");
    // The signal handlers above stop everything and exit.
    await new Promise<never>(() => {});
  }

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  // Chromium resolves no host but localhost, so nothing leaves the machine.
  // (A page.route() interceptor would do the same but turns the HTTP cache
  // off, and the warm reload measures that cache.)
  // Signals go through cleanup(), which closes the browser itself; Playwright's
  // own handlers would exit the process before the collector is stopped.
  browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  const login = await browser.newContext();
  const loginPage = await login.newPage();
  await loginPage.goto(`${ORIGIN}/__standup/login?code=${code}`);
  const cookies = await login.cookies();
  await login.close();
  if (!cookies.length) throw new Error("sign-in set no cookie");

  const errors: string[] = [];
  const helloFrameBytes = new Map<Page, number>();
  /** The localStorage keys the console keeps its Persona view under. */
  const KEPT_PREFIX = "standup:personaSnapshot";
  /** Set in sessionStorage just before a reload that must start without the kept view. */
  const CLEAR_KEPT_FLAG = "loadtime:clearKept";
  async function coldContext(): Promise<{ context: BrowserContext; page: Page }> {
    // Measures the dark console; headless Chromium reports a light OS.
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await context.addCookies(cookies);
    // Stamps, on the page's own clock, the first moment the shell, the enabled
    // composer and the newest message are in the DOM, plus the hello-ok
    // frame. Mutations are checked once per frame, so the stamp is the frame
    // the change paints in and a long thread's text isn't rescanned for
    // every node React inserts.
    await context.addInitScript(({ text, keptPrefix, clearFlag }: { text: string; keptPrefix: string; clearFlag: string }) => {
      const w = window as unknown as { __marks: Record<string, number> };
      const marks: Record<string, number> = (w.__marks = {});
      // A load flagged (just before its reload) to start without the kept
      // Persona view drops it here, at document start: after the previous
      // page's unload could have written it, before any app code reads it.
      // keptAtStart records whether the app then found one (1) or not (0).
      const keptKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(keptPrefix));
      if (sessionStorage.getItem(clearFlag)) {
        sessionStorage.removeItem(clearFlag);
        for (const k of keptKeys()) localStorage.removeItem(k);
      }
      marks.keptAtStart = keptKeys().length > 0 ? 1 : 0;
      const stamp = (name: string, t = performance.now()) => {
        if (marks[name] === undefined) marks[name] = t;
      };
      let queued = false;
      const queueCheck = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(check);
      };
      const shown = (el: Element | null | undefined): el is Element =>
        !!el && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getClientRects().length > 0;
      // Usable: visible, writable, and what a click at its centre lands on.
      const usableBox = (box: HTMLTextAreaElement): boolean => {
        if (box.disabled || box.readOnly || !shown(box)) return false;
        const r = box.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (hit === box || box.contains(hit));
      };
      // Visible: an element whose text holds the newest message passes
      // checkVisibility. The cheap whole-page text test runs first, so the
      // XPath scan runs only once the text is in.
      const messageShown = (): boolean => {
        if (!document.body?.textContent?.includes(text)) return false;
        const literal = JSON.stringify(text);
        const find = (xpath: string) => {
          const found = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const nodes: Node[] = [];
          for (let i = 0; i < found.snapshotLength; i++) nodes.push(found.snapshotItem(i)!);
          return nodes;
        };
        // A text node that holds it whole, else the innermost elements whose text does.
        const inText = find(`.//text()[contains(., ${literal})]`).map((n) => n.parentElement);
        const holders = inText.length ? inText : find(`.//*[contains(., ${literal}) and not(*[contains(., ${literal})])]`);
        return holders.some((el) => shown(el as Element | null));
      };
      const check = () => {
        queued = false;
        if (marks.shellPaint === undefined && document.querySelector('[data-testid="console-shell"]')) stamp("shellPaint");
        let pending = false;
        if (marks.composerReady === undefined) {
          const box = document.querySelector<HTMLTextAreaElement>('[data-testid="persona-composer"] textarea');
          if (box && usableBox(box)) stamp("composerReady");
          else if (box) pending = true;
        }
        if (marks.latestMessages === undefined) {
          if (messageShown()) stamp("latestMessages");
          else if (document.body?.textContent?.includes(text)) pending = true;
        }
        // In the DOM but not yet usable or visible (laid out, uncovered): look again next frame.
        if (pending) queueCheck();
      };
      new MutationObserver(() => {
        if (marks.shellDom === undefined && document.querySelector('[data-testid="console-shell"]')) stamp("shellDom");
        queueCheck();
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["disabled", "readonly", "hidden", "class", "style"],
      });
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          super(...args);
          this.addEventListener("message", (e: MessageEvent) => {
            if (marks.hello === undefined && typeof e.data === "string" && e.data.startsWith('{"type":"hello-ok"')) {
              stamp("hello");
              marks.helloBytes = new TextEncoder().encode(e.data).length;
            }
          });
        }
      };
    }, { text: needle, keptPrefix: KEPT_PREFIX, clearFlag: CLEAR_KEPT_FLAG });
    const page = await context.newPage();
    page.on("pageerror", (err) => errors.push(err.message));
    // The hello-ok frame's size as the browser received it, beside the page's own count.
    page.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString("utf8");
        if (!helloFrameBytes.has(page) && text.startsWith('{"type":"hello-ok"')) helloFrameBytes.set(page, Buffer.byteLength(text));
      });
    });
    if (THROTTLE) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: THROTTLE.latencyMs,
        downloadThroughput: THROTTLE.downBytesPerS,
        uploadThroughput: THROTTLE.upBytesPerS,
      });
    }
    return { context, page };
  }

  type Totals = { requests: number; kb: number; scripts: number; scriptKb: number };
  const totals = (page: Page, until?: number) =>
    page.evaluate((until?: number) => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceResourceTiming | undefined;
      const res = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
        (r) => until === undefined || r.responseEnd <= until
      );
      const scripts = res.filter((r) => r.initiatorType === "script" || r.initiatorType === "link" || /\.(m?js|tsx?|jsx)(\?|$)/.test(r.name));
      const kb = (rs: PerformanceResourceTiming[]) => rs.reduce((n, r) => n + r.transferSize, 0) / 1024;
      return {
        requests: res.length + 1,
        kb: kb(res) + (nav?.transferSize ?? 0) / 1024,
        scripts: scripts.length,
        scriptKb: kb(scripts),
      };
    }, until) as Promise<Totals>;

  async function load(page: Page, how: "goto" | "reload", coverage: boolean): Promise<Load> {
    if (coverage) await page.coverage.startJSCoverage({ resetOnNavigation: true });
    helloFrameBytes.delete(page);
    if (how === "goto") await page.goto(`${ORIGIN}/persona`, { waitUntil: "commit" });
    else await page.reload({ waitUntil: "commit" });
    // A mark that never comes leaves its time unset: the load is reported, and
    // fails the budget, rather than ending the run.
    const marked = (name: string, timeout: number) =>
      page
        .waitForFunction((n) => (window as unknown as { __marks?: Record<string, number> }).__marks?.[n] !== undefined, name, { timeout })
        .then(
          () => true,
          () => false
        );
    await marked("latestMessages", 60000);
    // The composer's mark can land after the message's.
    await marked("composerReady", 10000);
    const timing = await page.evaluate(() => {
      const marks = (window as unknown as { __marks: Record<string, number> }).__marks;
      const fcp = performance.getEntriesByName("first-contentful-paint")[0];
      const until = marks.latestMessages ?? performance.now();
      const waterfall = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((r) => r.startTime <= until)
        .map((r) => {
          const url = new URL(r.name);
          return {
            path: url.pathname + url.search,
            initiator: r.initiatorType,
            startMs: Math.round(r.startTime),
            durationMs: Math.round(r.duration),
            transferKb: Math.round((r.transferSize / 1024) * 10) / 10,
            bodyKb: Math.round((r.decodedBodySize / 1024) * 10) / 10,
          };
        });
      // The server's first answer for the thread, whether or not the page
      // painted from its kept copy before it.
      const read = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(
        (r) => new URL(r.name).pathname === "/api/persona/messages"
      );
      return { marks, fcpMs: fcp?.startTime, waterfall, personaReadMs: read?.responseEnd };
    });
    const { marks } = timing;
    const firstPersonaMs: number | undefined = marks.latestMessages;
    const at = await totals(page, firstPersonaMs);
    let jsKb: number | undefined;
    let jsUsedPct: number | undefined;
    if (coverage) {
      const entries = await page.coverage.stopJSCoverage();
      let total = 0;
      let used = 0;
      for (const e of entries) {
        if (!e.url.startsWith(ORIGIN)) continue;
        total += e.source?.length ?? 0;
        // Block coverage: the outermost range of each function counts once.
        for (const fn of e.functions) {
          if (!fn.isBlockCoverage || fn.ranges.length === 0) continue;
          const [outer, ...inner] = fn.ranges;
          if (fn.functionName === "" && outer!.startOffset === 0) continue;
          let size = outer!.count > 0 ? outer!.endOffset - outer!.startOffset : 0;
          for (const r of inner) if (r.count === 0) size -= r.endOffset - r.startOffset;
          used += Math.max(0, size);
        }
      }
      jsKb = total / 1024;
      jsUsedPct = total ? Math.min(100, (used / total) * 100) : 0;
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    const settled = await totals(page);
    const boardFirstPath = await page.evaluate(() => {
      const read = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(
        (r) => new URL(r.name).pathname === "/api/board/tasks"
      );
      if (!read) return undefined;
      const url = new URL(read.name);
      return url.pathname + url.search;
    });
    const round = (x: number | undefined) => (x === undefined ? undefined : Math.round(x));
    const helloBytes = helloFrameBytes.get(page) ?? marks.helloBytes;
    return {
      latestMessagesMs: round(firstPersonaMs),
      keptAtStart: marks.keptAtStart === 1,
      shellDomMs: round(marks.shellDom),
      shellPaintMs: round(marks.shellPaint),
      fcpMs: round(timing.fcpMs),
      composerReadyMs: round(marks.composerReady),
      personaUsableMs:
        marks.composerReady === undefined || firstPersonaMs === undefined ? undefined : Math.round(Math.max(marks.composerReady, firstPersonaMs)),
      personaReadMs: round(timing.personaReadMs),
      helloMs: round(marks.hello),
      helloKb: helloBytes === undefined ? undefined : Math.round(helloBytes / 1024),
      helloBytes,
      boardFirstPath,
      waterfall: timing.waterfall,
      requests: at.requests,
      kb: Math.round(at.kb),
      scripts: at.scripts,
      scriptKb: Math.round(at.scriptKb),
      settledRequests: settled.requests,
      settledKb: Math.round(settled.kb),
      jsKb: jsKb === undefined ? undefined : Math.round(jsKb),
      jsUsedPct: jsUsedPct === undefined ? undefined : Math.round(jsUsedPct),
    };
  }

  // A warm-up load: the dev server transforms and caches modules on first
  // request, which no later load in the owner's install pays again.
  {
    const { context, page } = await coldContext();
    await load(page, "goto", false);
    await context.close();
  }
  // Cold: an empty HTTP cache and storage. Warm: a reload with both, the way
  // the owner reopens the console. Warm, no kept view: a reload with the HTTP
  // cache but without the Persona view the console keeps in localStorage, so
  // the thread has to come from the network.
  const cold: Load[] = [];
  const warm: Load[] = [];
  const warmNoKept: Load[] = [];
  for (let i = 0; i < RUNS; i++) {
    const { context, page } = await coldContext();
    cold.push(await load(page, "goto", false));
    warm.push(await load(page, "reload", false));
    await page.evaluate((flag) => sessionStorage.setItem(flag, "1"), CLEAR_KEPT_FLAG);
    warmNoKept.push(await load(page, "reload", false));
    await context.close();
  }
  // JS coverage slows the load it is taken on, so it gets a cold load of its own.
  let coverageLoad: Load;
  {
    const { context, page } = await coldContext();
    coverageLoad = await load(page, "goto", true);
    await context.close();
  }
  const summary = (loads: Load[]) => ({
    shellPaintMs: median(loads.map((l) => l.shellPaintMs)),
    shellDomMs: median(loads.map((l) => l.shellDomMs)),
    fcpMs: median(loads.map((l) => l.fcpMs)),
    composerReadyMs: median(loads.map((l) => l.composerReadyMs)),
    latestMessagesMs: median(loads.map((l) => l.latestMessagesMs)),
    personaUsableMs: median(loads.map((l) => l.personaUsableMs)),
    personaReadMs: median(loads.map((l) => l.personaReadMs)),
    helloMs: median(loads.map((l) => l.helloMs)),
    helloKb: median(loads.map((l) => l.helloKb)),
    requests: median(loads.map((l) => l.requests)),
    kb: median(loads.map((l) => l.kb)),
    scripts: median(loads.map((l) => l.scripts)),
    scriptKb: median(loads.map((l) => l.scriptKb)),
    settledRequests: median(loads.map((l) => l.settledRequests)),
    settledKb: median(loads.map((l) => l.settledKb)),
    keptAtStart: loads.filter((l) => l.keptAtStart).length,
  });
  output.cold = { median: summary(cold), runs: cold };
  output.warm = { median: summary(warm), runs: warm };
  output.warmNoKept = { median: summary(warmNoKept), runs: warmNoKept };
  output.coverage = { jsKb: coverageLoad.jsKb, jsUsedPct: coverageLoad.jsUsedPct };
  console.log(`mode=${MODE}${DIST ? ` dist=${DIST}` : ""}${THROTTLE ? " throttle=tunnel" : ""}`);
  // latestMessagesMs on a load that found a kept view can be that copy's
  // paint; personaReadMs is when the server's thread arrived.
  const paintLine = (loads: Load[]) => {
    const s = summary(loads);
    return (
      `    latestMessagesMs ${s.latestMessagesMs} ms, personaReadMs ${s.personaReadMs} ms; kept view at start in ${s.keptAtStart}/${loads.length} loads` +
      (s.keptAtStart ? " (latestMessagesMs may be the kept view's paint, not the server's thread)" : "")
    );
  };
  console.log(`  cold (median of ${RUNS}):`, JSON.stringify(summary(cold)));
  console.log(paintLine(cold));
  console.log(`  warm reload (median):`, JSON.stringify(summary(warm)));
  console.log(paintLine(warm));
  console.log(`  warm reload, no kept view (median):`, JSON.stringify(summary(warmNoKept)));
  console.log(paintLine(warmNoKept));
  console.log(`  JS at first render (a separate cold load): ${coverageLoad.jsKb} KB loaded, ${coverageLoad.jsUsedPct}% executed`);
  const printWaterfall = (label: string, l: Load) => {
    console.log(`  ${label} waterfall before the newest message (${l.latestMessagesMs} ms; hello-ok ${l.helloKb ?? "?"} KB at ${l.helloMs ?? "?"} ms):`);
    for (const w of l.waterfall) {
      console.log(`    ${String(w.startMs).padStart(5)} +${String(w.durationMs).padStart(4)} ms  ${String(w.transferKb).padStart(7)} KB wire  ${String(w.bodyKb).padStart(7)} KB body  ${w.initiator.padEnd(14)} ${w.path}`);
    }
  };
  printWaterfall("cold[0]", cold[0]!);
  printWaterfall("warm[0]", warm[0]!);

  // The Persona view on a cold load that found no kept view: the thread had
  // to come from the server.
  const coldNoKept = cold.filter((l) => !l.keptAtStart);
  const worst = (xs: (number | undefined)[]): number | null => {
    const known = xs.filter((x): x is number => x !== undefined);
    return known.length ? Math.max(...known) : null;
  };
  const visible = coldNoKept.map((l) => l.latestMessagesMs);
  const usable = coldNoKept.map((l) => l.personaUsableMs);
  const persona = {
    loads: coldNoKept.length,
    keptAtStart: cold.length - coldNoKept.length,
    personaVisibleMs: { median: median(visible), worst: worst(visible) },
    personaUsableMs: { median: median(usable), worst: worst(usable), unmeasured: usable.filter((x) => x === undefined).length },
    composerReadyMs: median(coldNoKept.map((l) => l.composerReadyMs)),
    helloKb: median(coldNoKept.map((l) => l.helloKb)),
  };
  output.persona = persona;
  console.log(
    `  persona, cold with no kept view (${persona.loads} loads): personaVisibleMs median ${persona.personaVisibleMs.median} worst ${persona.personaVisibleMs.worst} ms, ` +
      `personaUsableMs median ${persona.personaUsableMs.median} worst ${persona.personaUsableMs.worst} ms` +
      `${persona.personaUsableMs.unmeasured ? ` (never usable on ${persona.personaUsableMs.unmeasured})` : ""}, composerReadyMs median ${persona.composerReadyMs} ms, helloKb ${persona.helloKb}`
  );

  if (BUDGETS) {
    // Every cold load must be usable within budget: the gate is the worst one,
    // and a load that never became usable fails it outright.
    const metric = "personaUsableMs";
    if (!coldNoKept.length) budgetLines.push(`FAIL ${metric}: no cold load started without a kept view (${cold.length} loads)`);
    else if (persona.personaUsableMs.unmeasured) {
      budgetLines.push(`FAIL ${metric}: not measured on ${persona.personaUsableMs.unmeasured} of ${coldNoKept.length} loads`);
    } else {
      const { worst: w, median: m } = persona.personaUsableMs;
      const over = usable.filter((x) => x! > PERSONA_USABLE_BUDGET_MS).length;
      budgetLines.push(
        `${w! <= PERSONA_USABLE_BUDGET_MS ? "PASS" : "FAIL"} ${metric}: worst ${w} ms (median ${m}, ${over} of ${coldNoKept.length} loads over) ` +
          `${w! <= PERSONA_USABLE_BUDGET_MS ? "<=" : ">"} ${PERSONA_USABLE_BUDGET_MS} ms`
      );
    }

    // The two REST bodies as the signed-in console receives them, through
    // its own proxy, each read as the JSON it should be; the hello-ok frame
    // as the cold loads received it.
    const { context, page } = await coldContext();
    await page.goto(`${ORIGIN}/persona`, { waitUntil: "domcontentloaded" });
    const body = (path: string, shape: "list" | "board") =>
      page.evaluate(
        async ({ path, shape }) => {
          const r = await fetch(path);
          const text = await r.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return { status: r.status, bytes: 0, shapeError: "the body is not JSON" };
          }
          const board = parsed as { scope?: unknown; tasks?: unknown } | null;
          // The seed fills both, so an empty answer (an auth or scoping slip)
          // measures nothing and fails rather than passing at a few bytes.
          const ok =
            shape === "list"
              ? Array.isArray(parsed) && parsed.length > 0
              : !!board && typeof board === "object" && typeof board.scope === "string" && Array.isArray(board.tasks) && board.tasks.length > 0;
          return {
            status: r.status,
            bytes: new TextEncoder().encode(text).length,
            shapeError: ok ? undefined : `the body is not ${shape === "list" ? "a non-empty JSON array" : "{scope, tasks} with tasks"}`,
          };
        },
        { path, shape }
      );
    const launches = await body("/api/launches", "list");
    const boardFirst = await body(BOARD_FIRST_PAGE_PATH, "board");
    await context.close();
    const helloBytes = median(coldNoKept.map((l) => l.helloBytes));
    const check = (metric: string, value: number | null, budget: number, unit: BudgetCheck["unit"], unmeasured?: string) => {
      if (value === null || unmeasured) budgetLines.push(`FAIL ${metric}: ${unmeasured ?? "not measured"}`);
      else budgetLines.push(budgetLine({ metric, value, budget, unit }));
    };
    const problem = (path: string, read: { status: number; shapeError?: string }) =>
      read.status !== 200 ? `GET ${path} answered ${read.status}` : read.shapeError ? `GET ${path}: ${read.shapeError}` : undefined;
    check("helloOkBytes", helloBytes, HELLO_OK_BUDGET_BYTES, "bytes");
    check("launchesBytes", launches.bytes, LAUNCHES_BUDGET_BYTES, "bytes", problem("/api/launches", launches));
    check("boardFirstPageBytes", boardFirst.bytes, BOARD_FIRST_PAGE_BUDGET_BYTES, "bytes", problem(BOARD_FIRST_PAGE_PATH, boardFirst));
    // The board budget holds for the read the console actually sends first.
    const firstPaths = new Set(coldNoKept.map((l) => l.boardFirstPath ?? "(none)"));
    for (const path of firstPaths) {
      if (path !== BOARD_FIRST_PAGE_PATH) budgetLines.push(`FAIL boardFirstPath: the console read ${path} first, the budget is for ${BOARD_FIRST_PAGE_PATH}`);
    }
  }

  // The console mid-load, on a cold load: Persona's and the snapshot's reads
  // are held, so the shell, the composer and the skeletons are what shows.
  // Holding them is the only interception in the run (page.route turns the
  // HTTP cache off, and this load measures nothing).
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const { context, page } = await coldContext();
    const held: (() => void)[] = [];
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      (route) => new Promise<void>((release) => held.push(() => void route.continue().catch(() => {}).finally(release)))
    );
    await page.routeWebSocket("/ws", () => {});
    await page.goto(`${ORIGIN}/persona`, { waitUntil: "commit" });
    await page.locator('[data-testid="persona-thread-loading"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="persona-composer"]').waitFor({ timeout: 30000 });
    const file = join(SHOTS, "persona-mid-load.png");
    await page.screenshot({ path: file });
    output.midLoadScreenshot = file;
    console.log(`  mid-load (reads held): shell, composer and skeletons -> ${file}`);
    for (const release of held) release();
    await context.close();
  }

  // Live updates still flow on the served page: a message sent after load
  // arrives over /ws, with no reload.
  {
    const { context, page } = await coldContext();
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(new URL(ws.url()).pathname));
    await load(page, "goto", false);
    const live = `MSG-live${Date.now().toString(36)}`;
    const sent = await page.evaluate(async (text) => {
      const r = await fetch("/api/persona/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, idempotencyKey: crypto.randomUUID() }),
      });
      return r.status;
    }, live);
    const ok = await page
      .getByText(`echo ${live}`)
      .first()
      .waitFor({ timeout: 30000 })
      .then(() => true, () => false);
    output.liveUpdate = { sent, ok, sockets };
    console.log(`  ${ok ? "PASS" : "FAIL"} live update: sent ${sent}, reply "echo ${live}" rendered without a reload; sockets ${sockets.join(", ")}`);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "live-update.png") });
    await context.close();
    if (!ok) runFailures.push(`FAIL liveUpdate: sent ${sent}, the reply never rendered without a reload (sockets ${sockets.join(", ") || "none"})`);
  }

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const routes = ["/persona", "/schedules", "/board", "/board?workers=1", "/review", "/projects", "/knowledge", "/you", "/you/cost"];
    const tabs: Record<string, unknown>[] = [];
    for (const route of routes) {
      const { context, page } = await coldContext();
      const before = errors.length;
      const chunks: string[] = [];
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (path.startsWith("/assets/") && path.endsWith(".js")) chunks.push(path.slice("/assets/".length));
      });
      await page.goto(`${ORIGIN}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const text = await page.evaluate(() => document.body.innerText);
      const stillLoading = (await page.locator('[data-testid="view-loading"], [data-testid="view-error"]').count()) > 0;
      const file = join(SHOTS, `tab${route.replace(/\//g, "-")}.png`);
      await page.screenshot({ path: file });
      tabs.push({ route, ok: errors.length === before && !stillLoading && text.trim().length > 0, chunks, screenshot: file });
      await context.close();
    }
    output.tabs = tabs;
    for (const t of tabs) console.log(`  ${t.ok ? "PASS" : "FAIL"} ${t.route}: ${(t.chunks as string[]).length} js chunk(s) -> ${t.screenshot}`);
  }
  output.pageErrors = errors;
  if (errors.length) runFailures.push(`FAIL pageErrors: ${errors.length} (${errors.slice(0, 5).join(" | ")})`);
} catch (err) {
  runFailures.push(`FAIL measurement: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await cleanup();
}
const tabsFailed = ((output.tabs as { ok: boolean }[] | undefined) ?? []).some((t) => !t.ok);
if (BUDGETS) {
  output.budgets = budgetLines;
  console.log("budgets (packages/web/e2e/load-budgets.ts):");
  for (const line of budgetLines) console.log(`  ${line}`);
}
output.failures = runFailures;
for (const line of runFailures) console.log(`  ${line}`);
const failed = tabsFailed || runFailures.length > 0 || budgetLines.some((l) => l.startsWith("FAIL")) || (BUDGETS && budgetLines.length === 0);
console.log(failed ? "console load check: FAIL" : "console load check: PASS");
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(output, null, 2));
process.exit(failed ? 1 : 0);
