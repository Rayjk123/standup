#!/usr/bin/env bun
/*
 * End-to-end check that the Persona thread can't stay stale, on a throwaway
 * install: a scratch collector with its own data dir, owner token and ports,
 * the console's dev server proxied to it, and a headless browser signed in
 * with a login code minted from that scratch token. Persona's turns run
 * fake-claude.ts, which answers through the real Persona tool route.
 *
 * The console's socket reaches the collector through a TCP relay that can go
 * silent: it stops forwarding in both directions on the connections it holds
 * without closing them, the way a socket behind a tunnel or proxy dies when a
 * laptop sleeps. New connections pass normally.
 *
 *   bun packages/web/e2e/live-gaps.repro.ts --scratch /tmp/x --playwright /path/to/node_modules/playwright \
 *     [--web-port 5323] [--api-port 5321] [--ws-port 5322] [--relay-port 5324] [--out /tmp/x/shots]
 *
 * Cases: (a) a reply on an open connection; (b) a reply posted while the
 * socket is silently dead; (c) a reply posted across a collector restart,
 * before the browser's socket is back. Each reports how long the reply took
 * to show. Requests the page makes off its own origin are aborted.
 */
import { createHmac, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Socket, Subprocess } from "bun";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const SCRATCH = resolve(arg("scratch"));
const PLAYWRIGHT = arg("playwright");
const WEB_PORT = arg("web-port", "5323");
const API_PORT = arg("api-port", "5321");
const WS_PORT = arg("ws-port", "5322");
const RELAY_PORT = arg("relay-port", "5324");
const OUT = arg("out", join(SCRATCH, "shots"));
const ORIGIN = `http://localhost:${WEB_PORT}`;
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");

if (!SCRATCH.startsWith("/tmp/")) throw new Error("the scratch dir must live under /tmp");
// The live install's console, collector, socket and test-console ports.
const LIVE_PORTS = new Set(["5173", "7777", "7778", "5199"]);
for (const p of [WEB_PORT, API_PORT, WS_PORT, RELAY_PORT]) {
  if (LIVE_PORTS.has(p)) throw new Error(`port ${p} belongs to the live install`);
  const free = await fetch(`http://127.0.0.1:${p}/`).then(
    () => false,
    () => true
  );
  if (!free) throw new Error(`port ${p} is already in use`);
}
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin"]) mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(SCRATCH, "projects.toml"), "");

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = (await Bun.file(TOKEN_FILE).text()).trim();

const shim = join(SCRATCH, "bin/claude");
writeFileSync(shim, `#!/bin/sh\nexec bun ${join(import.meta.dir, "fake-claude.ts")} "$@"\n`);
chmodSync(shim, 0o755);

// Loopback only, and nothing that reaches Slack or ntfy, whatever the caller's shell sets.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "STANDUP_BIND_HOST" && !k.startsWith("SLACK_") && !k.startsWith("NTFY_"))
);
const scratchEnv = {
  ...inherited,
  PATH: `${join(SCRATCH, "bin")}:${process.env.PATH}`,
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
};

let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, `collector-${Date.now()}.log`)),
    stderr: "inherit",
  });
  console.log(`  collector pid ${collector.pid}`);
}
async function waitForHttp(): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (collector?.exitCode !== null || collector.signalCode !== null) {
      throw new Error(`scratch collector exited (${collector?.exitCode ?? collector?.signalCode})`);
    }
    try {
      await fetch(`http://127.0.0.1:${API_PORT}/api/projects`);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("scratch collector never came up");
}

/*
 * The relay between the dev server and the collector's socket. `silence()`
 * stops forwarding on every connection it holds, in both directions, and
 * never closes them; connections opened afterwards forward normally.
 */
type Pair = { client: Socket<Pair>; upstream?: Socket<{ pair: Pair }>; silent: boolean; queued: Uint8Array[] };
const pairs = new Set<Pair>();
const relay = Bun.listen<Pair>({
  hostname: "127.0.0.1",
  port: Number(RELAY_PORT),
  socket: {
    async open(client) {
      const pair: Pair = { client, silent: false, queued: [] };
      client.data = pair;
      pairs.add(pair);
      try {
        pair.upstream = await Bun.connect<{ pair: Pair }>({
          hostname: "127.0.0.1",
          port: Number(WS_PORT),
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
        client.end();
      }
    },
    data(client, chunk) {
      const pair = client.data;
      if (pair.silent) return;
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
const silence = (): number => {
  let n = 0;
  for (const pair of pairs) {
    if (!pair.silent) n++;
    pair.silent = true;
  }
  return n;
};

type Vite = { listen(): Promise<unknown>; close(): Promise<void> };
let vite: Vite | undefined;
let browser: { close(): Promise<void> } | undefined;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  if (collector && collector.exitCode === null) {
    collector.kill("SIGTERM");
    await collector.exited;
  }
  await vite?.close().catch(() => {});
  relay.stop(true);
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

const results: { label: string; ok: boolean; ms: number }[] = [];
try {
  startCollector();
  await waitForHttp();
  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: API_PORT,
    SCRATCH_WS_PORT: RELAY_PORT,
    SCRATCH_WEB_PORT: WEB_PORT,
  });
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  const server: Vite = await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn" });
  vite = server;
  await server.listen();

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  const chrome = await chromium.launch();
  browser = chrome;
  const context = await chrome.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().startsWith("[ws]")) console.log(`  browser ${m.type()}: ${m.text().slice(0, 160)}`);
  });
  let catchUps = 0;
  page.on("request", (req) => {
    if (/\/api\/persona\/messages\?.*afterSeq=/.test(req.url())) catchUps++;
  });
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).host;
    return host === `localhost:${WEB_PORT}` ? route.continue() : route.abort();
  });

  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  await page.goto(`${ORIGIN}/__standup/login?code=${code}`);
  await page.locator("[data-testid=persona-thread]").waitFor({ timeout: 20000 });

  // Straight to the collector, as a Slack message or another tab would: nothing the page itself did.
  const sendDirect = async (text: string) => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/persona/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-standup-owner-token": token },
      body: JSON.stringify({ text, idempotencyKey: crypto.randomUUID() }),
    });
    console.log(`  sent ${text} (direct): ${res.status}`);
  };
  const shot = (label: string) => page.screenshot({ path: join(OUT, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
  const expectShown = async (label: string, needle: string, since: number, ms: number) => {
    const ok = await page
      .getByText(needle)
      .first()
      .waitFor({ timeout: ms })
      .then(() => true)
      .catch(() => false);
    const took = Date.now() - since;
    results.push({ label, ok, ms: took });
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: "${needle}" after ${(took / 1000).toFixed(1)}s`);
    await shot(label);
  };

  const run = Date.now().toString(36);
  console.log("(a) on an open connection");
  let t = Date.now();
  await sendDirect(`MSG-a${run}`);
  await expectShown("a-open-connection", `echo MSG-a${run}`, t, 20000);

  console.log("(b) the socket goes silent: no close, nothing forwarded either way");
  console.log(`  silenced ${silence()} relay connection(s)`);
  await Bun.sleep(1000);
  t = Date.now();
  const catchUpsBefore = catchUps;
  await sendDirect(`MSG-b${run}`);
  // The reader comes back to the window a few seconds later, well inside the
  // socket's ping + pong timeout (25s), so only a catch-up can show it this soon.
  await Bun.sleep(3000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expectShown("b-silently-dead-socket", `echo MSG-b${run}`, t, 60000);
  const bTook = results[results.length - 1]!.ms;
  console.log(`  catch-up reads meanwhile: ${catchUps - catchUpsBefore}`);
  results.push({ label: "b-shown-before-the-heartbeat-could", ok: bTook < 15000, ms: bTook });

  console.log("(c) a collector restart, the reply posted before the browser's socket is back");
  collector!.kill("SIGTERM");
  await collector!.exited;
  console.log("  collector stopped");
  await Bun.sleep(1500);
  startCollector();
  await waitForHttp();
  t = Date.now();
  await sendDirect(`MSG-c${run}`);
  await expectShown("c-across-restart", `echo MSG-c${run}`, t, 60000);

  console.log("(d) live again after all that");
  t = Date.now();
  await sendDirect(`MSG-d${run}`);
  await expectShown("d-live-after", `echo MSG-d${run}`, t, 20000);

  // Duplicates or misordering would show as a repeated or out-of-order reply.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter((el) => el.children.length === 0 && /^echo MSG-[a-d]/.test(el.textContent ?? ""))
      .map((el) => el.textContent!.trim())
  );
  const expected = ["a", "b", "c", "d"].map((x) => `echo MSG-${x}${run}`);
  const inOrder = JSON.stringify(order) === JSON.stringify(expected);
  results.push({ label: "no duplicates, in order", ok: inOrder, ms: 0 });
  console.log(`${inOrder ? "PASS" : "FAIL"} no duplicates, in order: ${JSON.stringify(order)}`);
  await context.close();
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
