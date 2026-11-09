#!/usr/bin/env bun
/*
 * Live check that the console's Review tab badge follows the owner's pending
 * count without a reload: a review packet submitted through the real worker
 * route turns it 0 → 1, and the owner approving it through the real decision
 * route turns it 1 → 0. Runs on a throwaway install: the real collector with
 * its own data dir, owner token, project, git repo and ports; the console's
 * dev server proxied to it; headless Chromium recording a video.
 *
 *   bun packages/web/e2e/review-badge.live.ts --scratch /tmp/<dir> --out <dir>
 *     [--label before|after] [--auth unsigned|signed]
 *     [--playwright /path/to/node_modules/playwright]
 *     [--api-port N --ws-port N --web-port N] [--keep]
 *
 * No worker is launched: the launch a worker would submit from is seeded into
 * the scratch DB (a running worktree launch over a scratch git repo, its
 * session registered through the real SessionStart hook, its review token's
 * hash on the launch row), so the submission goes through the real
 * `POST /api/reviews/submit` with `x-standup-worker-token`.
 *
 * `--auth unsigned` (the default) opens the console without the login code,
 * so its socket carries no owner token and proves no Persona: the socket a
 * `review:updated` frame never reaches. `--auth signed` signs in first.
 * `--auth tunnel` signs in through a relay that rewrites Host to the console's
 * own, as a tunnel in front of the console does: the page's reads carry the
 * session cookie, but its socket upgrade's Origin no longer matches Host, so
 * the console's proxy forwards no token and the socket proves no Persona.
 *
 * Writes <out>/result-<label>.json, <out>/review-badge-<label>.webm and
 * <out>/<label>-{0-initial,1-submitted,2-approved}.png. Exits non-zero when the
 * badge did not change within 10s of either trigger, or the page reloaded or
 * navigated.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { Subprocess } from "bun";
import type { Browser, BrowserContext, Page } from "playwright";
import { attachSessionToLaunch, createLaunch, createStore, getSession, setLaunchReviewTokenHash } from "../../store/src/index.ts";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const SCRATCH_ARG = opt("scratch");
if (!SCRATCH_ARG) throw new Error("--scratch /tmp/<dir> is required");
const SCRATCH = resolve(SCRATCH_ARG);
if (!SCRATCH.startsWith("/tmp/") || SCRATCH === "/tmp/") throw new Error(`--scratch ${SCRATCH} must be a directory under /tmp/`);
const OUT_ARG = opt("out");
if (!OUT_ARG) throw new Error("--out <dir> is required");
const OUT = resolve(OUT_ARG);
if (OUT === SCRATCH || OUT.startsWith(`${SCRATCH}/`)) throw new Error("--out must not lie inside --scratch");
const LABEL = opt("label") ?? "after";
if (!/^[a-z0-9-]+$/i.test(LABEL)) throw new Error(`--label ${LABEL} must be letters, digits or dashes`);
const AUTH = opt("auth") ?? "unsigned";
if (AUTH !== "unsigned" && AUTH !== "signed" && AUTH !== "tunnel") throw new Error("--auth must be unsigned, signed or tunnel");
const KEEP = process.argv.includes("--keep");
const PLAYWRIGHT = opt("playwright") ?? process.env.STANDUP_PLAYWRIGHT ?? "/tmp/standup-pw/node_modules/playwright";
// A Chromium binary to use instead of the one this Playwright version downloads.
const CHROMIUM = opt("chromium");
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const BUN = process.execPath;
const LIMIT_MS = 10_000;

// The live install's console, collector, socket and test-console ports, and the range its second collectors use.
const REFUSED_PORTS = [7777, 7778, 5173, 5199];
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
// caller's Persona and worker credentials, its multiplexer server, and a bind host
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
// The only settings a child of this run takes from the caller's environment.
const INHERITED_ENV = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"] as const;
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(INHERITED_ENV.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
}
// Before vite or Playwright is loaded: the dev server runs in this process.
for (const k of Object.keys(process.env)) if (droppedEnvKey(k)) delete process.env[k];

const taken = new Set<number>();
const API_PORT = await pickPort("api-port", taken);
const WS_PORT = await pickPort("ws-port", taken);
const WEB_PORT = await pickPort("web-port", taken);
const TUNNEL_PORT = AUTH === "tunnel" ? await pickPort("tunnel-port", taken) : null;
const ORIGIN = `http://localhost:${WEB_PORT}`;
// Where the browser loads the console: the dev server, or the relay in front of it.
const PAGE_ORIGIN = TUNNEL_PORT ? `http://localhost:${TUNNEL_PORT}` : ORIGIN;
const API = `http://127.0.0.1:${API_PORT}`;

if (existsSync(SCRATCH)) throw new Error(`${SCRATCH} already exists`);
mkdirSync(SCRATCH, { recursive: true, mode: 0o700 });
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin", "home", "tmux", "worktrees", "transcripts", "repo"]) {
  mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
}
mkdirSync(OUT, { recursive: true });
console.log(`label ${LABEL}, auth ${AUTH}: scratch ${SCRATCH}, out ${OUT}`);
console.log(`ports: collector ${API_PORT}, ws ${WS_PORT}, console ${WEB_PORT}`);

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const ownerToken = readFileSync(TOKEN_FILE, "utf8").trim();

// No worker runs, but any multiplexer call the collector makes goes to a
// private server under the run dir: the shim first on its PATH names the socket.
const SCRATCH_BIN = join(SCRATCH, "bin");
const TMUX_SOCK = join(SCRATCH, "data", "tmux", "workers");
mkdirSync(dirname(TMUX_SOCK), { recursive: true, mode: 0o700 });
const whichTmux = Bun.which("tmux");
const REAL_TMUX = whichTmux ? realpathSync(whichTmux) : null;
const tmuxShim = join(SCRATCH_BIN, "tmux");
writeFileSync(tmuxShim, REAL_TMUX ? `#!/bin/sh\nexec ${REAL_TMUX} -S ${TMUX_SOCK} "$@"\n` : "#!/bin/sh\nexit 1\n");
chmodSync(tmuxShim, 0o755);
// Nor does any `claude` run: one that tried would fail at once.
const claudeShim = join(SCRATCH_BIN, "claude");
writeFileSync(claudeShim, "#!/bin/sh\necho 'no claude in the review-badge harness' >&2\nexit 1\n");
chmodSync(claudeShim, 0o755);

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
  STANDUP_WEB_URL: `${ORIGIN}/`,
};

// Pre-flight: every path a child is pointed at lives in the run dir, the
// scratch PATH resolves the multiplexer to the shim, and no child carries a
// dropped setting.
{
  const inRun = (p: string) => resolve(p).startsWith(`${SCRATCH}/`);
  for (const k of ["HOME", "TMUX_TMPDIR", "DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_PROJECTS_PATH", "STANDUP_INTERNAL_ROOT", "STANDUP_WORKTREE_ROOT"]) {
    if (!inRun(scratchEnv[k]!)) throw new Error(`${k} ${scratchEnv[k]} is outside the run dir`);
  }
  const resolved = Bun.spawnSync(["sh", "-c", "command -v tmux"], { env: scratchEnv }).stdout.toString().trim();
  if (resolved !== tmuxShim) throw new Error(`the scratch PATH resolves the multiplexer to ${resolved || "nothing"}, not the shim`);
  for (const [name, env] of [["scratch children", scratchEnv], ["this process (vite)", process.env]] as const) {
    const leaked = Object.keys(env).filter(droppedEnvKey);
    if (leaked.length) throw new Error(`${name} env still carries ${leaked.join(", ")}`);
  }
}

// A repo whose feature branch holds one commit past main: the change the
// seeded launch's packet describes, read by the collector from the checkout.
const REPO = join(SCRATCH, "repo");
function git(...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], { cwd: REPO, env: scratchEnv });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}
git("init", "-q", "-b", "main");
writeFileSync(join(REPO, "README.md"), "scratch repo for the review-badge harness\n");
git("add", "README.md");
git("commit", "-q", "-m", "initial");
git("checkout", "-q", "-b", "feature/badge");
writeFileSync(join(REPO, "feature.txt"), "the change under review\n");
git("add", "feature.txt");
git("commit", "-q", "-m", "feature");

const PROJECT = "rtb";
writeFileSync(
  join(SCRATCH, "projects.toml"),
  [
    "[[project]]",
    `id = "${PROJECT}"`,
    `name = "${PROJECT}"`,
    `repos = ["${REPO}"]`,
    `branch = "main"`,
    `worktreeRoot = "${join(SCRATCH, "worktrees")}"`,
    "bypassPermissions = false",
    "",
  ].join("\n")
);

// ── Scratch collector, stopped only by its own pid ─────────────────────────

const COLLECTOR_PID = join(SCRATCH, "collector.pid");
let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn([BUN, "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, "collector.log")),
    stderr: Bun.file(join(SCRATCH, "collector.err.log")),
  });
  writeFileSync(COLLECTOR_PID, String(collector.pid));
  console.log(`  collector pid ${collector.pid} (${COLLECTOR_PID})`);
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
  if (!existsSync(COLLECTOR_PID)) return;
  const pid = Number(readFileSync(COLLECTOR_PID, "utf8").trim());
  if (!collector || collector.pid !== pid || collector.exitCode !== null || collector.signalCode !== null) return;
  process.kill(pid, "SIGTERM");
  const exited = await Promise.race([collector.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!exited) {
    process.kill(pid, "SIGKILL");
    await collector.exited;
  }
}

// ── Collector API ──────────────────────────────────────────────────────────

type Json = Record<string, any>;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
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
async function must(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Json> {
  const res = await call(method, path, body, headers);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
  return res.json;
}
const OWNER = { "x-standup-owner-token": ownerToken };

/**
 * The launch a worker would submit from: its session registered through the
 * SessionStart hook in the repo, then a running worktree launch of the host's
 * over that checkout, holding the session and the hash of a review token.
 */
async function seedLaunch(host: string): Promise<{ launchId: string; sessionId: string; workerToken: string }> {
  const sessionId = randomUUID();
  const transcript = join(SCRATCH, "transcripts", `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    JSON.stringify({ type: "user", uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(), cwd: REPO, message: { role: "user", content: "seeded worker" } }) + "\n"
  );
  await must("POST", "/hook", { session_id: sessionId, cwd: REPO, transcript_path: transcript, hook_event_name: "SessionStart", source: "startup" }, OWNER);
  const launchId = `rtb-${randomBytes(4).toString("hex")}`;
  const workerToken = randomBytes(32).toString("hex");
  const store = createStore(scratchEnv.DB_PATH!);
  try {
    store.db.exec("PRAGMA busy_timeout = 5000");
    if (!getSession(store.db, sessionId)) throw new Error(`the SessionStart hook registered no session ${sessionId}`);
    createLaunch(store.db, {
      id: launchId,
      kind: "worktree",
      projectId: PROJECT,
      task: "review-badge harness change",
      worktreePath: REPO,
      branch: "feature/badge",
      baseBranch: "main",
      status: "running",
      requester: host,
      launchedBy: host,
    });
    attachSessionToLaunch(store.db, launchId, sessionId);
    setLaunchReviewTokenHash(store.db, launchId, createHash("sha256").update(workerToken, "utf8").digest("hex"));
  } finally {
    store.close();
  }
  const tokenDir = join(SCRATCH, "data/worker-tokens");
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(tokenDir, launchId), workerToken, { mode: 0o600 });
  return { launchId, sessionId, workerToken };
}

// ── Browser ────────────────────────────────────────────────────────────────

/**
 * Runs in the page before its own scripts: a boot marker a reload would
 * replace, and a log of every change of the Review tab badge's text, stamped
 * with this machine's clock.
 */
function pageHarness(): void {
  const w = window as any;
  const changes: Array<{ at: number; text: string | null }> = [];
  let last: string | null | undefined;
  const watch = () => {
    const el = document.querySelector('[data-testid="review-tab-badge"]');
    const text = el ? (el.textContent ?? "").trim() : null;
    if (text !== last) {
      last = text;
      changes.push({ at: Date.now(), text });
    }
  };
  new MutationObserver(watch).observe(document, { childList: true, subtree: true, characterData: true });
  w.__rtb = { boot: `${Date.now()}-${Math.random()}`, changes: () => changes.slice() };
}

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let vite: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
let tunnel: ReturnType<typeof Bun.serve> | undefined;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  tunnel?.stop(true);
  await vite?.close().catch(() => {});
  await stopCollector().catch((err) => console.error(`stopping the collector: ${String(err)}`));
  try {
    mkdirSync(join(OUT, `logs-${LABEL}`), { recursive: true });
    for (const f of readdirSync(SCRATCH)) if (f.startsWith("collector")) cpSync(join(SCRATCH, f), join(OUT, `logs-${LABEL}`, f));
  } catch {
    // The logs are a convenience; the result is already written.
  }
  if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true });
  else console.log(`kept ${SCRATCH}`);
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

/**
 * A tunnel in front of the console: forwards every request and socket to the
 * dev server with Host rewritten to the dev server's own, and everything else
 * the browser sent (cookie, Origin, Sec-Fetch-*) unchanged.
 */
type TunnelSocket = { path: string; headers: Record<string, string>; upstream?: WebSocket; queued: Array<string | Uint8Array> };
function startTunnel(port: number): ReturnType<typeof Bun.serve> {
  const forwardHeaders = (headers: Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (!["host", "connection", "upgrade", "content-length", "accept-encoding"].includes(key) && !key.startsWith("sec-websocket-")) out[key] = value;
    });
    return out;
  };
  return Bun.serve<TunnelSocket, never>({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = `${url.pathname}${url.search}`;
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return server.upgrade(req, { data: { path, headers: forwardHeaders(req.headers), queued: [] } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const headers = { ...forwardHeaders(req.headers), "accept-encoding": "identity" };
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const res = await fetch(`${ORIGIN}${path}`, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined, redirect: "manual" });
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(res.body, { status: res.status, headers: out });
    },
    websocket: {
      open(ws) {
        const upstream = new WebSocket(`ws://localhost:${WEB_PORT}${ws.data.path}`, { headers: ws.data.headers } as unknown as string[]);
        ws.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.onopen = () => {
          for (const m of ws.data.queued) upstream.send(m);
          ws.data.queued = [];
        };
        upstream.onmessage = (ev) => ws.send(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
        upstream.onclose = (ev) => ws.close(ev.code === 1005 ? 1000 : ev.code, ev.reason);
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
        else ws.data.queued.push(message);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });
}

type Step = { name: string; expected: string | null; triggeredAt: number; changedAt: number | null; ms: number | null; ok: boolean; detail?: string };
const result: Json = {
  label: LABEL,
  auth: AUTH,
  ports: { api: API_PORT, ws: WS_PORT, web: WEB_PORT, tunnel: TUNNEL_PORT },
  limitMs: LIMIT_MS,
  probes: {},
  steps: [] as Step[],
  reviewList: {},
  navigations: [] as string[],
  reloaded: false,
  screenshots: [] as string[],
  video: null as string | null,
};
let fatal: unknown;
let page: Page | undefined;
try {
  startCollector();
  await waitForHttp();
  const host = scratchEnv.USER ?? "";
  if (!host) throw new Error("USER is unset: the scratch collector has no host to own the review");

  // The unsigned console's view: what a loopback request with no identity
  // header and no owner token is answered, and the signed-in view's.
  const unsignedCount = await call("GET", "/api/reviews/pending-count");
  const ownerCount = await call("GET", "/api/reviews/pending-count", undefined, OWNER);
  result.probes = { unsignedPendingCount: unsignedCount, ownerPendingCount: ownerCount };
  console.log(`  pending-count unsigned -> ${unsignedCount.status} ${JSON.stringify(unsignedCount.json)}; owner -> ${ownerCount.status} ${JSON.stringify(ownerCount.json)}`);

  const seeded = await seedLaunch(host);
  console.log(`  seeded launch ${seeded.launchId}, session ${seeded.sessionId}`);

  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: String(API_PORT),
    SCRATCH_WS_PORT: String(WS_PORT),
    SCRATCH_WEB_PORT: String(WEB_PORT),
  });
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  // No HMR or file watching: an edit elsewhere in the tree must not reload the page mid-run.
  vite = await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn", server: { hmr: false, watch: null } });
  await vite!.listen();
  if (TUNNEL_PORT) tunnel = startTunnel(TUNNEL_PORT);

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  browser = await chromium.launch({ env: scratchEnv, ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const viewport = { width: 1280, height: 800 };
  context = await browser.newContext({ viewport, recordVideo: { dir: OUT, size: viewport } });
  await context.addInitScript(pageHarness);
  await context.route("**/*", (route) => {
    const h = new URL(route.request().url()).host;
    return h === new URL(PAGE_ORIGIN).host ? route.continue() : route.abort();
  });
  if (AUTH !== "unsigned") {
    const expiry = String(Math.floor(Date.now() / 1000) + 600);
    const code = `${expiry}.${createHmac("sha256", ownerToken).update(`login:${expiry}`).digest("hex")}`;
    const login = await context.newPage();
    await login.goto(`${PAGE_ORIGIN}/__standup/login?code=${code}`);
    await login.close();
  }

  page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().startsWith("[ws]")) console.log(`  console ${m.type()}: ${m.text().slice(0, 200)}`);
  });
  let booted = false;
  page.on("framenavigated", (frame) => {
    if (booted && frame === page!.mainFrame()) result.navigations.push(frame.url());
  });
  // Every frame type the page's socket receives, so the result shows which review frames reached it.
  const frameTypes: string[] = [];
  result.frameTypes = frameTypes;
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      try {
        const type = JSON.parse(String(payload)).type;
        if (typeof type === "string" && type.startsWith("review")) frameTypes.push(type);
      } catch {
        // A non-JSON frame (the pong) names no type.
      }
    })
  );
  await page.goto(`${PAGE_ORIGIN}/`);
  const boot = (await page.evaluate(() => (window as any).__rtb.boot)) as string;
  booted = true;
  // The console is up and its socket connected before anything changes.
  await page.locator('a[href="/review"]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const pageCount = await page.evaluate(async () => {
    const r = await fetch("/api/reviews/pending-count");
    return { status: r.status, body: await r.text() };
  });
  result.probes.pagePendingCount = pageCount;
  console.log(`  page's own pending-count -> ${pageCount.status} ${pageCount.body.slice(0, 160)}`);

  const badge = page.locator('[data-testid="review-tab-badge"]');
  const shot = async (name: string) => {
    const path = join(OUT, `${LABEL}-${name}.png`);
    await page!.screenshot({ path });
    result.screenshots.push(path);
  };
  const initialBadge = (await badge.count()) ? ((await badge.first().textContent()) ?? "").trim() : null;
  result.initialBadge = initialBadge;
  console.log(`  initial badge: ${initialBadge ?? "absent"}`);
  await shot("0-initial");

  /** Waits for the badge to read `expected` (null: gone), and when the page saw it change. */
  const waitBadge = async (name: string, expected: string | null, triggeredAt: number): Promise<Step> => {
    const deadline = triggeredAt + LIMIT_MS;
    for (;;) {
      const changes = (await page!.evaluate(() => (window as any).__rtb.changes())) as Array<{ at: number; text: string | null }>;
      const hit = changes.find((c) => c.at >= triggeredAt && c.text === expected);
      if (hit) return { name, expected, triggeredAt, changedAt: hit.at, ms: hit.at - triggeredAt, ok: true };
      if (Date.now() > deadline) {
        const now = (await badge.count()) ? ((await badge.first().textContent()) ?? "").trim() : null;
        return { name, expected, triggeredAt, changedAt: null, ms: null, ok: false, detail: `badge reads ${now ?? "absent"} after ${LIMIT_MS}ms` };
      }
      await Bun.sleep(50);
    }
  };

  // ── Submit through the real worker route ──
  const submittedAt = Date.now();
  const submit = await must(
    "POST",
    "/api/reviews/submit",
    {
      session_id: seeded.sessionId,
      cwd: REPO,
      packet: {
        title: `RTB-${LABEL} badge packet`,
        intent: "A packet whose arrival the Review tab badge must show without a reload.",
        changes: [{ area: "feature", bullets: ["adds feature.txt"], files: ["feature.txt"] }],
        validation: { samples: [], tests: { summary: "harness packet" } },
        risks: { risks: [], questions: [] },
        links: [],
      },
    },
    { "x-standup-worker-token": seeded.workerToken }
  );
  console.log(`  submitted packet ${submit.packetId} (${submit.status})`);
  result.packet = submit;
  const submitStep = await waitBadge("submit", "1", submittedAt);
  result.steps.push(submitStep);
  console.log(`  ${submitStep.ok ? "PASS" : "FAIL"} badge 1 after submit${submitStep.ms !== null ? ` in ${submitStep.ms}ms` : ` — ${submitStep.detail}`}`);
  await shot("1-submitted");
  // Holds each state on screen long enough to read in the recording.
  await page.waitForTimeout(2500);

  // ── Approve through the real owner route ──
  const approvedAt = Date.now();
  const approve = await must("POST", `/api/reviews/${submit.packetId}/approve`, {}, OWNER);
  console.log(`  approved (${JSON.stringify(approve).slice(0, 120)})`);
  const approveStep = await waitBadge("approve", null, approvedAt);
  result.steps.push(approveStep);
  console.log(`  ${approveStep.ok ? "PASS" : "FAIL"} badge gone after approve${approveStep.ms !== null ? ` in ${approveStep.ms}ms` : ` — ${approveStep.detail}`}`);
  await shot("2-approved");
  await page.waitForTimeout(2500);

  const bootNow = (await page.evaluate(() => (window as any).__rtb?.boot).catch(() => undefined)) as string | undefined;
  result.reloaded = bootNow !== boot;
  result.badgeChanges = await page.evaluate(() => (window as any).__rtb.changes());

  // ── The Review list, opened in-app, for the record ──
  await page.evaluate(() => {
    history.pushState({}, "", "/review");
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  });
  await page.waitForTimeout(1500);
  const cards = await page.locator('[data-testid="review-card"]').count();
  result.reviewList = { cards, note: AUTH === "unsigned" ? "the list is read over HTTP, which an unsigned page is refused" : "" };
  await shot("3-review-list");
} catch (err) {
  fatal = err;
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  const video = page?.video();
  await context?.close().catch(() => {});
  context = undefined;
  if (video) {
    try {
      const raw = await video.path();
      const named = join(OUT, `review-badge-${LABEL}.webm`);
      renameSync(raw, named);
      result.video = named;
    } catch (err) {
      console.error(`video: ${String(err)}`);
    }
  }
  result.fatal = fatal ? String(fatal) : null;
  const steps = result.steps as Step[];
  // In-app route changes (the console's own redirects) are recorded but are not
  // reloads; the boot marker is what tells a reload apart.
  result.pass = !fatal && steps.length === 2 && steps.every((s) => s.ok) && !result.reloaded;
  writeFileSync(join(OUT, `result-${LABEL}.json`), JSON.stringify(result, null, 2));
  await cleanup();
}
console.log(`\n${result.pass ? "PASS" : "FAIL"} (${LABEL}): ${(result.steps as Step[]).map((s) => `${s.name} ${s.ok ? `${s.ms}ms` : "timeout"}`).join(", ")}; result at ${join(OUT, `result-${LABEL}.json`)}`);
process.exit(result.pass ? 0 : 1);
