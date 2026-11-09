#!/usr/bin/env bun
/*
 * End-to-end check that the Persona view updates live, before and after a
 * collector restart, on a throwaway install: a scratch collector with its own
 * data dir, owner token and ports, the console's dev server proxied to it, and
 * a headless browser signed in with a login code minted from that scratch
 * token. Persona's turns run fake-claude.ts, which answers through the real
 * Persona tool route.
 *
 *   bun packages/web/e2e/live-updates.repro.ts --scratch /tmp/x --playwright /path/to/node_modules/playwright \
 *     [--web-port 5313] [--api-port 5311] [--ws-port 5312] [--screenshots /tmp/x/shots]
 *
 * Cases: (a) a reply and an ask_user question on an open connection; (b) an
 * approval card; (c) both after a restart, and items created while the browser
 * is still disconnected, which must be backfilled on reconnect. Requests the
 * page makes off its own origin are aborted.
 */
import { createHmac, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Subprocess } from "bun";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const SCRATCH = resolve(arg("scratch"));
const PLAYWRIGHT = arg("playwright");
const WEB_PORT = arg("web-port", "5313");
const API_PORT = arg("api-port", "5311");
const WS_PORT = arg("ws-port", "5312");
const SHOTS = arg("screenshots", join(SCRATCH, "shots"));
const ORIGIN = `http://localhost:${WEB_PORT}`;
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");

if (!SCRATCH.startsWith("/tmp/")) throw new Error("the scratch dir must live under /tmp");
// The live install's console, collector, socket and test-console ports.
const LIVE_PORTS = new Set(["5173", "7777", "7778", "5199"]);
for (const p of [WEB_PORT, API_PORT, WS_PORT]) {
  if (LIVE_PORTS.has(p)) throw new Error(`port ${p} belongs to the live install`);
  const free = await fetch(`http://127.0.0.1:${p}/`).then(
    () => false,
    () => true
  );
  if (!free) throw new Error(`port ${p} is already in use`);
}
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin"]) mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(SCRATCH, "projects.toml"), "");

// The scratch install's owner token, minted here so the collector adopts it.
const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = (await Bun.file(TOKEN_FILE).text()).trim();

const shim = join(SCRATCH, "bin/claude");
writeFileSync(shim, `#!/bin/sh\nexec bun ${join(import.meta.dir, "fake-claude.ts")} "$@"\n`);
chmodSync(shim, 0o755);

const { STANDUP_BIND_HOST: _bindHost, ...inherited } = process.env;
// Loopback only, whatever the caller's shell sets.
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
  STANDUP_PERSONA_HOLD: "open_job",
  STANDUP_WEB_URL: `${ORIGIN}/`,
  SLACK_BOT_TOKEN: "",
  SLACK_APP_TOKEN: "",
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
/** Waits for this run's own collector to answer; fails if it exited (e.g. its port was taken). */
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

type Vite = { listen(): Promise<unknown>; close(): Promise<void>; moduleGraph: any; reloadModule(m: unknown): Promise<void> };
let vite: Vite | undefined;
let browser: { close(): Promise<void> } | undefined;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  if (collector && collector.exitCode === null) {
    collector.kill("SIGTERM");
    await collector.exited;
  }
  await vite?.close().catch(() => {});
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

const results: { label: string; ok: boolean }[] = [];
try {
startCollector();
await waitForHttp();
// The dev server runs in this process so the run can push HMR updates, as a
// merge into the install does to an open console.
Object.assign(process.env, {
  STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
  SCRATCH_API_PORT: API_PORT,
  SCRATCH_WS_PORT: WS_PORT,
  SCRATCH_WEB_PORT: WEB_PORT,
});
const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
const server: Vite = await createServer({ configFile: join(import.meta.dir, "vite.scratch.config.ts"), logLevel: "warn" });
vite = server;
await server.listen();
async function hmr(...files: string[]): Promise<void> {
  for (const file of files) {
    const mods = server.moduleGraph.getModulesByFile(resolve(WEB_DIR, file));
    for (const mod of mods ?? []) await server.reloadModule(mod);
    console.log(`  hmr ${file}: ${mods?.size ?? 0} module(s)`);
  }
}

const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
const chrome = await chromium.launch();
browser = chrome;
{
  const page = await chrome.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().startsWith("[ws]")) console.log(`  browser ${m.type()}: ${m.text().slice(0, 160)}`);
  });
  // Counts the page's open collector sockets: one is healthy, more means a
  // replaced connection was never closed.
  await page.addInitScript(() => {
    const open = new Set<WebSocket>();
    const Native = window.WebSocket;
    class Counted extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).endsWith("/ws")) {
          this.addEventListener("open", () => open.add(this));
          this.addEventListener("close", () => open.delete(this));
        }
      }
    }
    window.WebSocket = Counted as typeof WebSocket;
    (window as unknown as { __liveSockets: () => number }).__liveSockets = () => open.size;
  });
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).host;
    return host === `localhost:${WEB_PORT}` ? route.continue() : route.abort();
  });

  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  await page.goto(`${ORIGIN}/__standup/login?code=${code}`);
  await page.locator("[data-testid=persona-thread]").waitFor({ timeout: 20000 });

  const send = async (text: string, direct = false) => {
    const status = direct
      ? (
          await fetch(`http://127.0.0.1:${API_PORT}/api/persona/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-standup-owner-token": token },
            body: JSON.stringify({ text, idempotencyKey: crypto.randomUUID() }),
          })
        ).status
      : await page.evaluate(async (text) => {
          const r = await fetch("/api/persona/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, idempotencyKey: crypto.randomUUID() }),
          });
          return r.status;
        }, text);
    console.log(`  sent ${text}${direct ? " (direct)" : ""}: ${status}`);
  };
  const expectLive = async (label: string, needle: string, ms = 20000) => {
    const ok = await page
      .getByText(needle)
      .first()
      .waitFor({ timeout: ms })
      .then(() => true)
      .catch(() => false);
    results.push({ label, ok });
    // A page whose main thread is stuck can't answer an evaluate.
    const responsive = await Promise.race([page.evaluate(() => true), Bun.sleep(3000).then(() => false)]);
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: "${needle}"${responsive ? "" : " (page unresponsive)"}`);
    if (responsive) await page.screenshot({ path: join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
  };
  const restart = async (downMs: number, during?: () => Promise<void>) => {
    collector!.kill("SIGTERM");
    await collector!.exited;
    console.log(`  collector stopped; down ${downMs}ms`);
    await Bun.sleep(downMs);
    startCollector();
    await waitForHttp();
    await during?.();
  };

  const sockets = () => page.evaluate(() => (window as unknown as { __liveSockets: () => number }).__liveSockets());
  const report = async (when: string) => console.log(`  open /ws sockets ${when}: ${await sockets()}`);
  const turnGapMs = 4000;

  const run = Date.now().toString(36);
  await report("after load");
  console.log("(a)/(b) on an open connection");
  await send(`MSG-a${run}`);
  await expectLive("a: reply", `echo MSG-a${run}`);
  await send(`ASK-a${run}`);
  await expectLive("a: ask_user question", `question ASK-a${run}?`);
  await send(`JOB-b${run}`);
  await expectLive("b: approval card", `scratch repro JOB-b${run}`);
  await send(`MSG-b${run}`);
  await expectLive("b: reply after an approval card", `echo MSG-b${run}`);

  console.log("(c) restart, then new traffic");
  await restart(2000);
  await page.waitForTimeout(5000);
  await report("after restart");
  await send(`MSG-c${run}`);
  await expectLive("c: reply after restart", `echo MSG-c${run}`);
  await send(`JOB-c${run}`);
  await expectLive("c: approval after restart", `scratch repro JOB-c${run}`);

  console.log("(c) backfill: created while the browser is still disconnected");
  // Created right after the collector is back but before the browser's next
  // retry; a run whose socket already reconnected doesn't test backfill.
  await restart(12000, async () => {
    const before = await sockets();
    await send(`ASK-g${run}`, true);
    await Bun.sleep(turnGapMs);
    await send(`JOB-g${run}`, true);
    if (before !== 0) console.log(`  note: the browser had ${before} socket(s) open when the backfill items were created`);
  });
  await expectLive("c: backfilled ask_user", `question ASK-g${run}?`, 45000);
  await expectLive("c: backfilled approval", `scratch repro JOB-g${run}`, 45000);

  console.log("(d) an HMR update and a restart, as a merge into the install does");
  await hmr("../shared/src/types.ts", "src/hooks/useWebSocket.ts", "src/App.tsx");
  await page.waitForTimeout(3000);
  await report("after hmr");
  await restart(2000);
  await page.waitForTimeout(8000);
  await report("after hmr + restart");
  await send(`ASK-d${run}`);
  await expectLive("d: ask_user after hmr + restart", `question ASK-d${run}?`);
  await Bun.sleep(turnGapMs);
  await send(`JOB-d${run}`);
  await expectLive("d: approval after hmr + restart", `scratch repro JOB-d${run}`);
  await send(`MSG-d${run}`);
  await expectLive("d: reply after that approval", `echo MSG-d${run}`);
}
} finally {
  await cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
