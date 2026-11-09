#!/usr/bin/env bun
/*
 * Persona chat live-update harness: measures how long a Persona message takes
 * from being stored to rendering in an open console tab, and whether any ever
 * fails to show without a reload, across the conditions a long-lived tab meets.
 *
 *   env -u TMUX -u TMUX_PANE bun packages/web/e2e/persona-live.harness.ts \
 *     [--playwright /path/to/node_modules/playwright] [--out /dir] [--keep] [--only a,b,...]
 *
 * Isolation (each point is checked at start-up, and the run stops if one fails):
 *  1. Non-live ports only: collector 5341, socket 5342, console 5343, relay
 *     5344. 5173, 7777, 7778 and 5199 (the live install's) are refused, and
 *     every port must be free.
 *  2. Everything lives in a scratch dir under /tmp (/tmp/standup-plive-<run>):
 *     DB_PATH, HOME, the owner token, knowledge, icons, the internal and
 *     worktree roots and the projects file. Nothing reads or writes
 *     ~/.local/share/standup; a child inherits only PATH, USER, LOGNAME, SHELL,
 *     LANG, LC_*, TZ and TERM from the caller, never a Slack, ntfy, Persona,
 *     worker-token or tmux setting.
 *  3. tmux runs only as `tmux -L standup-plive-<run>`, through a shim first on
 *     the scratch PATH, with TMUX and TMUX_PANE unset. This harness never runs
 *     tmux kill-server, kill-session or kill-window, pkill, killall or
 *     systemctl; it signals only the collector PIDs it spawned itself.
 *  4. No agent runs. The scratch collector runs with
 *     STANDUP_PERSONA_STUB_TURNS=1, so every Persona turn is answered in
 *     process with a scripted reply ("stub reply" and random hex words): no
 *     model, no spawned process, no tool calls. No `claude` is reachable at
 *     all: every PATH directory holding one is dropped from the scratch PATH,
 *     and the run stops if `command -v claude` finds anything. Messages are
 *     driven through the scratch collector's own API with the scratch owner
 *     token: owner messages are POSTed, Persona replies come from the stub
 *     turn (an owner turn, and a wake_persona schedule's Run now).
 *
 * Conditions (each posts messages while it holds, then checks they render):
 *   steady   an open, healthy connection
 *   restart  the collector killed and restarted with the tab open; a message
 *            posted as soon as its HTTP answers, before the socket is back
 *   drop     every socket connection closed and new ones refused for 6s, a
 *            message posted meanwhile
 *   silent   the socket stops forwarding both ways without closing (a proxy
 *            or tunnel that lost its upstream)
 *   handoff  a restart whose Persona resync meets the draining collector's
 *            503 {"error":"draining"} (answered by the page's network layer
 *            for 3s), then frames lost on a socket that still looks fine;
 *            fails if the console then shows "draining" as Persona's state
 *   hmr      the dev server hot-updates App.tsx, liveSocket.ts and persona.ts
 *            into the open tab (what every merge does to the live console)
 *   frozen   the tab frozen (Page lifecycle "frozen", as Chrome does to a
 *            background tab) for 20s while messages post, then resumed
 *
 * For every message: stored (its createdAt) → rendered (a MutationObserver in
 * the page) in ms. A message counts as live within LIVE_MS, late after that,
 * and missed when it hasn't rendered after MISSED_MS (longer than the 30s
 * catch-up). Any page reload or navigation after boot fails the run. Results go
 * to <out>/persona-live.json; screenshots to <out>. Exit code 1 on any missed
 * message or reload.
 */
import { createHmac, randomBytes, randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Socket, Subprocess } from "bun";
import type { Page } from "playwright";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const RUN = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const SCRATCH = `/tmp/standup-plive-${RUN}`;
const OUT = resolve(opt("out") ?? join(SCRATCH, "out"));
const KEEP = process.argv.includes("--keep");
const ONLY = opt("only")?.split(",");
const PLAYWRIGHT = opt("playwright") ?? process.env.STANDUP_PLAYWRIGHT ?? "/tmp/standup-pw/node_modules/playwright";
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const BUN = process.execPath;
const TMUX_NAME = `standup-plive-${RUN}`;

const API_PORT = 5341;
const WS_PORT = 5342;
const WEB_PORT = 5343;
const RELAY_PORT = 5344;
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const LIVE_MS = 2_000;
const MISSED_MS = 45_000;

// ── Isolation checks ────────────────────────────────────────────────────────

const LIVE_PORTS = [5173, 7777, 7778, 5199];
for (const port of [API_PORT, WS_PORT, WEB_PORT, RELAY_PORT]) {
  if (LIVE_PORTS.includes(port)) throw new Error(`port ${port} belongs to the live install`);
  const taken = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(s) { s.end(); }, error() {} } }).then(
    () => true,
    () => false
  );
  if (taken) throw new Error(`port ${port} is already in use`);
}
if (process.env.TMUX || process.env.TMUX_PANE) throw new Error("run under `env -u TMUX -u TMUX_PANE`");
if (existsSync(SCRATCH)) throw new Error(`${SCRATCH} already exists`);
mkdirSync(SCRATCH, { mode: 0o700 });
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin", "home", "worktrees", "repo"]) {
  mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
}
mkdirSync(OUT, { recursive: true });

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = (await Bun.file(TOKEN_FILE).text()).trim();

const BIN = join(SCRATCH, "bin");
const whichTmux = Bun.which("tmux");
if (!whichTmux) throw new Error("tmux is not on PATH");
const REAL_TMUX = realpathSync(whichTmux);
writeFileSync(join(BIN, "tmux"), `#!/bin/sh\nexec ${REAL_TMUX} -L ${TMUX_NAME} "$@"\n`);
chmodSync(join(BIN, "tmux"), 0o755);
writeFileSync(join(SCRATCH, "projects.toml"), "");
// No `claude` anywhere on the scratch PATH: a directory holding one is left out.
const scratchPath = [BIN, ...(process.env.PATH ?? "").split(":").filter((dir) => dir && !existsSync(join(dir, "claude")))].join(":");

const INHERITED = ["USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"];
const scratchEnv: Record<string, string> = {
  ...Object.fromEntries(INHERITED.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]))),
  PATH: scratchPath,
  STANDUP_PERSONA_STUB_TURNS: "1",
  HOME: join(SCRATCH, "home"),
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
  STANDUP_WEB_URL: `${ORIGIN}/`,
};
{
  const inRun = (p: string) => resolve(p).startsWith(`${SCRATCH}/`);
  for (const k of ["HOME", "DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_PROJECTS_PATH", "STANDUP_INTERNAL_ROOT", "STANDUP_WORKTREE_ROOT"]) {
    if (!inRun(scratchEnv[k]!)) throw new Error(`${k} is outside the scratch dir`);
  }
  const leaked = Object.keys(scratchEnv).filter((k) => k.startsWith("SLACK_") || k.startsWith("NTFY_") || k.startsWith("TMUX") || k === "STANDUP_PERSONA");
  if (leaked.length) throw new Error(`scratch env carries ${leaked.join(", ")}`);
  if (scratchEnv.STANDUP_PERSONA_STUB_TURNS !== "1") throw new Error("the scratch collector must run with STANDUP_PERSONA_STUB_TURNS=1");
  const tmux = Bun.spawnSync(["sh", "-c", "command -v tmux"], { env: scratchEnv }).stdout.toString().trim();
  if (tmux !== join(BIN, "tmux")) throw new Error(`tmux resolves to ${tmux || "nothing"}, not the shim`);
  const claude = Bun.spawnSync(["sh", "-c", "command -v claude || true"], { env: scratchEnv }).stdout.toString().trim();
  if (claude) throw new Error(`claude resolves to ${claude} on the scratch PATH`);
  for (const tool of ["bun", "git"]) {
    if (!Bun.spawnSync(["sh", "-c", `command -v ${tool}`], { env: scratchEnv }).stdout.toString().trim()) throw new Error(`${tool} isn't on the scratch PATH`);
  }
}
console.log(`run ${RUN}: scratch ${SCRATCH}, out ${OUT}, tmux -L ${TMUX_NAME}`);

// ── Scratch collector (only PIDs spawned here are ever signalled) ──────────

let collector: Subprocess | undefined;
let collectorErrLog = "";
function startCollector(): void {
  collectorErrLog = join(SCRATCH, `collector-${Date.now()}.err.log`);
  // --no-env-file: a .env in the collector dir must not add settings the scratch env leaves out.
  collector = Bun.spawn([BUN, "--no-env-file", "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, `collector-${Date.now()}.log`)),
    stderr: Bun.file(collectorErrLog),
  });
  console.log(`  collector pid ${collector.pid}`);
}
/** Waits for the collector's HTTP, then stops the run unless it reported scripted turns. */
async function waitForHttp(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (collector?.exitCode !== null || collector.signalCode !== null) throw new Error("scratch collector exited");
    const up = await fetch(`${API}/api/persona/state`, { headers: { "x-standup-owner-token": token } }).then(
      (r) => r.ok,
      () => false
    );
    if (up) {
      if (!(await Bun.file(collectorErrLog).text()).includes("STANDUP_PERSONA_STUB_TURNS=1")) {
        await stopCollector();
        throw new Error("the scratch collector didn't report scripted Persona turns; stopped it");
      }
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("scratch collector never came up");
}
async function stopCollector(): Promise<void> {
  const own = collector;
  if (own && own.exitCode === null && own.signalCode === null) {
    own.kill("SIGTERM");
    await own.exited;
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
      if (refusing) return void client.end();
      pairs.add(pair);
      try {
        pair.upstream = await Bun.connect<{ pair: Pair }>({
          hostname: "127.0.0.1",
          port: WS_PORT,
          data: { pair },
          socket: {
            data: (up, chunk) => void (up.data.pair.silent || up.data.pair.client.write(chunk)),
            close: (up) => void (up.data.pair.silent || up.data.pair.client.end()),
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
      pairs.delete(client.data);
      if (!client.data.silent) client.data.upstream?.end();
    },
    error() {},
  },
});
const silence = () => {
  for (const pair of pairs) pair.silent = true;
};
const drop = () => {
  refusing = true;
  for (const pair of [...pairs]) {
    pairs.delete(pair);
    pair.client.end();
    pair.upstream?.end();
  }
};

// ── Driving the scratch collector's API ─────────────────────────────────────

type Row = { id: string; role: string; text: string; createdAt: string; threadId: string; seq: number };
const ownerHeaders = { "content-type": "application/json", "x-standup-owner-token": token };
async function newestRows(): Promise<Row[]> {
  const res = await fetch(`${API}/api/persona/messages?limit=50`, { headers: ownerHeaders }).catch(() => null);
  if (!res?.ok) return [];
  return ((await res.json()) as { messages: Row[] }).messages;
}
const known = new Set<string>();
async function markKnown(): Promise<void> {
  for (const r of await newestRows()) known.add(r.id);
}
/** Persona rows stored since the last call, waiting up to `ms` for at least `count`. */
async function awaitPersonaRows(count: number, ms = 30_000): Promise<Row[]> {
  const found: Row[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && found.length < count) {
    for (const r of await newestRows()) {
      if (known.has(r.id)) continue;
      known.add(r.id);
      if (r.role === "persona") found.push(r);
    }
    if (found.length < count) await Bun.sleep(100);
  }
  return found;
}
async function postOwner(text: string): Promise<Row> {
  const res = await fetch(`${API}/api/persona/messages`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ text, idempotencyKey: randomUUID() }),
  });
  if (!res.ok) throw new Error(`POST /api/persona/messages: ${res.status} ${await res.text()}`);
  const row = ((await res.json()) as { message: Row }).message;
  known.add(row.id);
  return row;
}
let scheduleId: string | null = null;
async function runSchedule(): Promise<void> {
  if (!scheduleId) {
    const res = await fetch(`${API}/api/persona/schedules`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ title: "harness wake", cron: "0 0 1 1 *", kind: "wake_persona", note: "harness schedule run" }),
    });
    if (!res.ok) throw new Error(`create schedule: ${res.status} ${await res.text()}`);
    scheduleId = ((await res.json()) as { schedule: { id: string } }).schedule.id;
  }
  const res = await fetch(`${API}/api/persona/schedules/${scheduleId}/run`, { method: "POST", headers: ownerHeaders });
  if (!res.ok) throw new Error(`run schedule: ${res.status} ${await res.text()}`);
}

// ── The run ─────────────────────────────────────────────────────────────────

type Result = { condition: string; path: string; text: string; storedAt: number; renderedAt: number | null; ms: number | null; verdict: "live" | "late" | "missed" };
const results: Result[] = [];
let navigations = 0;
const stuckOnDraining: boolean[] = [];
let bannerShown: boolean | null = null;
type Vite = { listen(): Promise<unknown>; close(): Promise<void>; moduleGraph: { getModuleByUrl(url: string): Promise<unknown> }; reloadModule(m: unknown): Promise<void> };
let vite: Vite | undefined;
let browser: { close(): Promise<void> } | undefined;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  await stopCollector();
  await vite?.close().catch(() => {});
  relay.stop(true);
  if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true });
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

/** Waits for each row to render and records stored → rendered. */
async function expectRendered(page: Page, condition: string, path: string, rows: Row[]): Promise<void> {
  const keyOf = (r: Row) => r.text.match(/MARK-[a-z0-9]+|stub reply [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/)?.[0] ?? r.text.trim();
  const keys = rows.map(keyOf);
  const deadline = Date.now() + MISSED_MS;
  const seen = new Map<string, number>();
  while (Date.now() < deadline && seen.size < keys.length) {
    const got = (await page.evaluate(() => (window as unknown as { __seen: Record<string, number> }).__seen).catch(() => ({}))) as Record<string, number>;
    for (const k of keys) if (got[k]) seen.set(k, got[k]);
    if (seen.size < keys.length) await Bun.sleep(100);
  }
  for (const r of rows) {
    const storedAt = Date.parse(r.createdAt);
    const renderedAt = seen.get(keyOf(r)) ?? null;
    const ms = renderedAt === null ? null : renderedAt - storedAt;
    const verdict = ms === null ? "missed" : ms <= LIVE_MS ? "live" : "late";
    results.push({ condition, path, text: r.text.slice(0, 60), storedAt, renderedAt, ms, verdict });
    console.log(`  ${verdict.toUpperCase().padEnd(6)} ${condition}/${path}: ${ms === null ? "not rendered" : `${ms}ms`}  "${r.text.slice(0, 40)}"`);
    if (verdict === "missed") await page.screenshot({ path: join(OUT, `missed-${condition}-${path}.png`) }).catch(() => {});
  }
}

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
  vite = (await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn" })) as Vite;
  await vite.listen();

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  const chrome = await chromium.launch();
  browser = chrome;
  const context = await chrome.newContext({ viewport: { width: 1440, height: 900 } });
  // Every message key the page shows, with when it first showed.
  await context.addInitScript(() => {
    const w = window as unknown as { __seen: Record<string, number> };
    w.__seen = {};
    const check = () => {
      const text = document.body?.textContent ?? "";
      for (const key of text.match(/MARK-[a-z0-9]+|stub reply [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/g) ?? []) {
        if (!w.__seen[key]) w.__seen[key] = Date.now();
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const page = await context.newPage();
  const logLines: string[] = [];
  page.on("console", (m) => {
    if (m.text().startsWith("[ws]") || m.type() === "error") logLines.push(`${new Date().toISOString()} ${m.type()}: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (err) => logLines.push(`${new Date().toISOString()} pageerror: ${err.message}`));
  await page.route("**/*", (route) => (new URL(route.request().url()).host === `localhost:${WEB_PORT}` ? route.continue() : route.abort()));

  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  await page.goto(`${ORIGIN}/__standup/login?code=${code}`);
  // The first exchange creates the console thread the page then shows.
  await postOwner(`MARK-boot${RUN} hello`);
  await awaitPersonaRows(1);
  await page.getByText(`MARK-boot${RUN}`).first().waitFor({ timeout: 30_000 });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await markKnown();
  const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {});

  /** One owner message and the Persona reply to it, then a schedule run's reply. */
  const exercise = async (condition: string, opts: { schedule?: boolean } = {}) => {
    const owner = await postOwner(`MARK-${condition.replace(/[^a-z0-9]/g, "")}${randomBytes(3).toString("hex")} owner message`);
    const replies = await awaitPersonaRows(1);
    await expectRendered(page, condition, "owner-message", [owner]);
    await expectRendered(page, condition, "owner-turn-reply", replies);
    if (opts.schedule) {
      await runSchedule();
      await expectRendered(page, condition, "schedule-run-reply", await awaitPersonaRows(1));
    }
  };
  const want = (name: string) => !ONLY || ONLY.includes(name);

  if (want("steady")) {
    console.log("steady: an open, healthy connection");
    await exercise("steady", { schedule: true });
    await shot("steady");
  }

  if (want("restart")) {
    console.log("restart: the collector killed and restarted with the tab open");
    await stopCollector();
    await Bun.sleep(300);
    await shot("restart-reconnecting");
    await Bun.sleep(1200);
    startCollector();
    await waitForHttp();
    await exercise("restart", { schedule: true });
    await shot("restart-after");
  }

  if (want("drop")) {
    console.log("drop: every socket closed and new ones refused for 6s");
    drop();
    const owner = await postOwner(`MARK-drop${randomBytes(3).toString("hex")} posted while the stream is down`);
    const replies = await awaitPersonaRows(1);
    // The console says it is reconnecting once the socket has been down 3s.
    await Bun.sleep(4500);
    bannerShown = await page.getByTestId("connection-banner").isVisible();
    console.log(`  reconnecting banner shown while the stream is down: ${bannerShown}`);
    await shot("drop-reconnecting");
    await Bun.sleep(1500);
    refusing = false;
    await expectRendered(page, "drop", "owner-message", [owner]);
    await expectRendered(page, "drop", "owner-turn-reply", replies);
    await exercise("drop-after");
    await shot("drop-after");
  }

  if (want("silent")) {
    console.log("silent: the socket stops forwarding without closing");
    silence();
    await Bun.sleep(500);
    await exercise("silent");
    await shot("silent-after");
  }

  if (want("handoff")) {
    console.log("handoff: a restart whose resync meets the draining collector's 503, then frames lost on a socket that looks fine");
    const drainingAnswer = (route: { fulfill(r: object): Promise<void> }) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "x-standup-draining": "refused" },
        body: JSON.stringify({ error: "draining" }),
      });
    await page.route("**/api/persona/**", drainingAnswer);
    await stopCollector();
    await Bun.sleep(300);
    startCollector();
    await waitForHttp();
    await Bun.sleep(3000);
    await shot("handoff-during-drain");
    await page.unroute("**/api/persona/**", drainingAnswer);
    await Bun.sleep(1500);
    // Read as "Persona is disabled", the drain would swap the composer for a note.
    const stuck = !(await page.getByPlaceholder("Ask Persona for anything…").isVisible());
    stuckOnDraining.push(stuck);
    console.log(`  composer gone after the drain (Persona read as disabled): ${stuck}`);
    silence();
    await exercise("handoff");
    await shot("handoff-after");
  }

  if (want("hmr")) {
    console.log("hmr: App.tsx, liveSocket.ts and persona.ts hot-updated into the open tab");
    for (const url of ["/src/lib/persona.ts", "/src/hooks/liveSocket.ts", "/src/App.tsx"]) {
      const mod = await vite.moduleGraph.getModuleByUrl(url);
      if (mod) await vite.reloadModule(mod);
      else console.log(`  ${url} isn't in the module graph`);
    }
    await Bun.sleep(1500);
    await exercise("hmr");
    await shot("hmr-after");
  }

  if (want("frozen")) {
    console.log("frozen: the tab frozen for 20s while messages post");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const owner = await postOwner(`MARK-frozen${randomBytes(3).toString("hex")} posted while the tab is frozen`);
    const replies = await awaitPersonaRows(1);
    await Bun.sleep(20_000);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await expectRendered(page, "frozen", "owner-message", [owner]);
    await expectRendered(page, "frozen", "owner-turn-reply", replies);
    await exercise("frozen-after");
    await shot("frozen-after");
  }

  writeFileSync(join(OUT, "browser-console.log"), logLines.join("\n") + "\n");
} finally {
  await cleanup();
}

const missed = results.filter((r) => r.verdict === "missed");
const late = results.filter((r) => r.verdict === "late");
const ms = results.flatMap((r) => (r.ms === null ? [] : [r.ms])).sort((a, b) => a - b);
const pct = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] : null);
const stuck = stuckOnDraining.some(Boolean);
const summary = { run: RUN, messages: results.length, live: results.length - missed.length - late.length, late: late.length, missed: missed.length, navigations, stuckOnDraining: stuck, reconnectingBanner: bannerShown, p50: pct(50), p95: pct(95), max: ms.at(-1) ?? null };
writeFileSync(join(OUT, "persona-live.json"), JSON.stringify({ summary, results }, null, 2));
console.log(`\n${JSON.stringify(summary)}`);
process.exit(missed.length > 0 || navigations > 0 || stuck || bannerShown === false ? 1 : 0);
