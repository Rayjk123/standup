#!/usr/bin/env bun
/*
 * The Board staying live in the console's production build, end to end in a
 * browser, against a collector stand-in defined here: an HTTP stub serving the
 * board list, its version counter and empty lists for everything else, and a
 * WebSocket stub that answers the console's hello and pushes board:task
 * frames. The build is served the way the install serves it (vite build, then
 * vite preview with the same chunking and cache headers), proxying /api and
 * /ws to the stubs. Nothing here talks to a real collector.
 *
 *   bun packages/web/e2e/board-live.e2e.ts --scratch /tmp/x --playwright /path/to/node_modules/playwright \
 *     [--web-port 6843] [--api-port 6841] [--ws-port 6842] [--video-dir /tmp/x/video] [--shots /tmp/x/shots]
 *
 * Cases, in one recorded session: (1) the Board renders on first navigation
 * from another tab; (2) cards move columns as frames arrive; (3) a dropped
 * socket reconnects and resyncs a move made while it was down; (4) a move
 * whose frame was lost shows after the catch-up's version check, read once;
 * (5) a rebuilt console is noticed and a reload offered. Through all of that
 * the page must never reload. Then (6) a tab switch on the old build reloads
 * onto the new one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { ServerWebSocket } from "bun";
import type { BoardTaskWithConflicts, HelloOkPayload, WsMessage } from "@standup/shared";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const SCRATCH = resolve(arg("scratch"));
const PLAYWRIGHT = arg("playwright");
const WEB_PORT = Number(arg("web-port", "6843"));
const API_PORT = Number(arg("api-port", "6841"));
const WS_PORT = Number(arg("ws-port", "6842"));
const VIDEO_DIR = arg("video-dir", join(SCRATCH, "video"));
const SHOTS = arg("shots", join(SCRATCH, "shots"));
const ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const WEB_DIR = resolve(import.meta.dir, "..");
const OUT_DIR = join(SCRATCH, "dist");

if (!SCRATCH.startsWith("/tmp/")) throw new Error("the scratch dir must live under /tmp");
const LIVE_PORTS = new Set([5173, 7777, 7778, 5199, 15173]);
for (const p of [WEB_PORT, API_PORT, WS_PORT]) {
  if (LIVE_PORTS.has(p)) throw new Error(`port ${p} belongs to the live install`);
}
for (const d of [VIDEO_DIR, SHOTS]) mkdirSync(d, { recursive: true, mode: 0o700 });

// ---- The collector stand-in ------------------------------------------------

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const card = (id: string, title: string, status: BoardTaskWithConflicts["status"], over: Partial<BoardTaskWithConflicts> = {}): BoardTaskWithConflicts => ({
  id,
  source: "job",
  sourceId: id.replace(/^job:/, ""),
  owner: "owner",
  title,
  status,
  links: {},
  areas: { files: [], packages: ["packages/web"] },
  createdAt: at(90),
  updatedAt: at(5),
  ...over,
});

const board = new Map<string, BoardTaskWithConflicts>();
for (const t of [
  card("job:live", "Board tab live updates", "coding", { goal: "Cards move as work moves" }),
  card("job:docs", "Docs editor shared links", "validation"),
  card("job:floor", "Floor: fewer holds for scratch work", "in_review"),
  card("job:resync", "Reconnect resync for Persona", "queued"),
  card("job:done", "Gateway restart hold", "done", { updatedAt: at(60) }),
]) {
  board.set(t.id, t);
}
let version = 1;
// When each list read and each hello-ok was served, by the clock.
const listReads: number[] = [];
const hellos: number[] = [];
let versionHeld = false;
let helloCountAtHold = 0;

/** Changes a card in the stub's store, as a collector write would, bumping the version. */
function move(id: string, patch: Partial<BoardTaskWithConflicts>): BoardTaskWithConflicts {
  const next = { ...board.get(id)!, ...patch, updatedAt: new Date().toISOString() };
  board.set(id, next);
  version++;
  return next;
}

const LISTS = ["/api/projects", "/api/sessions", "/api/checkpoints", "/api/asks/pending", "/api/launches", "/api/tickets", "/api/task-runs", "/api/review-findings"];

const api = Bun.serve({
  hostname: "127.0.0.1",
  port: API_PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // While "restarting" the collector answers no board reads either; and the
    // version stays held until the list has been read after a new socket's
    // hello-ok, so only the reconnect's own re-read can bring the board back.
    if (!accepting && path.startsWith("/api/board/")) return Response.json({ error: "restarting" }, { status: 503 });
    if (versionHeld && path === "/api/board/version") return Response.json({ error: "restarting" }, { status: 503 });
    if (path === "/api/board/version") return Response.json({ version: `stub.${version}` });
    if (path === "/api/board/tasks") {
      if (url.searchParams.get("closedBefore")) return Response.json({ tasks: [], scope: "user", more: false });
      listReads.push(Date.now());
      // With the version held, the catch-up can't ask for the list, so a read
      // after a hello-ok is the reconnect's resync; the hold ends with it.
      if (versionHeld && accepting && hellos.length > helloCountAtHold) versionHeld = false;
      return Response.json({ tasks: [...board.values()], scope: "user", closedMore: false, version: `stub.${version}` });
    }
    if (path === "/api/reviews/pending-count") return Response.json({ count: 0 });
    if (path === "/api/reviews") return Response.json({ reviews: [] });
    if (LISTS.includes(path)) return Response.json([]);
    return Response.json({ error: "not in the stub" }, { status: 404 });
  },
});

const sockets = new Set<ServerWebSocket<unknown>>();
let accepting = true;
let epochN = 0;
const ws = Bun.serve({
  hostname: "127.0.0.1",
  port: WS_PORT,
  fetch(req, server) {
    if (!accepting) return new Response("down", { status: 503 });
    return server.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      hellos.push(Date.now());
      const hello: HelloOkPayload = {
        protocolVersion: 1,
        serverSeq: 0,
        user: "owner",
        epoch: `stub-${++epochN}`,
        snapshot: { projects: [], sessions: [], checkpoints: [], asks: [], launches: [], tickets: [], actors: [] },
      };
      socket.send(JSON.stringify({ type: "hello-ok", payload: hello, timestamp: new Date().toISOString() }));
    },
    message(socket, data) {
      if (data === "ping") socket.send("pong");
    },
    close(socket) {
      sockets.delete(socket);
    },
  },
});

/** Sends a board:task frame for `task` to every open console, as the board does to its owner. */
function push(task: BoardTaskWithConflicts): void {
  const frame: WsMessage = { type: "board:task", payload: { task }, timestamp: new Date().toISOString() } as WsMessage;
  for (const s of sockets) s.send(JSON.stringify(frame));
}

// ---- The console, built and served as the install serves it ----------------

const { build, preview } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
const react = (await import(join(WEB_DIR, "node_modules/@vitejs/plugin-react/dist/index.js"))).default;
const { manualChunks } = await import(join(WEB_DIR, "chunks.ts"));
const { cacheHeaders } = await import(join(WEB_DIR, "static-assets.ts"));
console.log("building the console…");
await build({
  root: WEB_DIR,
  configFile: false,
  logLevel: "warn",
  plugins: [react()],
  build: { outDir: OUT_DIR, emptyOutDir: true, rollupOptions: { output: { manualChunks } } },
});
const proxy = {
  "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
  "/ws": { target: `ws://127.0.0.1:${WS_PORT}`, ws: true, changeOrigin: true },
};
const served = await preview({
  root: WEB_DIR,
  configFile: false,
  logLevel: "warn",
  plugins: [{ name: "cache-headers", configurePreviewServer: (s: { middlewares: { use(fn: unknown): void } }) => void s.middlewares.use(cacheHeaders(() => OUT_DIR)) }],
  build: { outDir: OUT_DIR },
  preview: { host: "127.0.0.1", port: WEB_PORT, strictPort: true, proxy },
});
console.log(`console on ${ORIGIN}`);

// ---- The browser -------------------------------------------------------------

const results: { label: string; ok: boolean; detail: string }[] = [];
const record = (label: string, ok: boolean, detail: string) => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
};

const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
const browser = await chromium.launch();
let videoPath: string | undefined;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 860 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 860 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).host;
    return host === `127.0.0.1:${WEB_PORT}` ? route.continue() : route.abort();
  });
  // A document load (a reload) — unlike a route change, which framenavigated also reports.
  let loads = 0;
  page.on("load", () => loads++);

  /** A caption pinned over the page, so the recording says what each step is. */
  const caption = (text: string) =>
    page.evaluate((t) => {
      let el = document.getElementById("e2e-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "e2e-caption";
        el.setAttribute(
          "style",
          "position:fixed;left:16px;bottom:16px;z-index:99999;padding:8px 12px;border-radius:6px;background:#1f6feb;color:#fff;font:600 13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none"
        );
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
  const inColumn = (status: string, id: string) =>
    page.locator(`[data-testid="board-column-${status}"] [data-testid="board-card-${id}"]`);
  const waitIn = async (status: string, id: string, timeout = 8000) => {
    try {
      await inColumn(status, id).waitFor({ timeout });
      return true;
    } catch {
      return false;
    }
  };

  // (1) First load on another tab, then the Board on first navigation.
  await page.goto(`${ORIGIN}/review`);
  await page.waitForLoadState("networkidle").catch(() => {});
  // A marker on the window: any reload wipes it.
  await page.evaluate(() => ((window as unknown as { __e2eDocument: string }).__e2eDocument = "first-load"));
  const booted = loads;
  await caption("1. Console loaded on Review — opening the Board for the first time");
  await page.waitForTimeout(1200);
  await page.locator('a[href="/board"]').first().click();
  const rendered = (await waitIn("coding", "job:live")) && (await waitIn("in_review", "job:floor"));
  record("board renders on first navigation", rendered, `cards in their columns on first open; ${await page.getByTestId("board-count").textContent()}`);
  await caption("1. Board rendered on first navigation — no refresh");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SHOTS, "board-first-navigation.png") });

  // (2) Live frames move cards.
  await caption("2. Collector pushes board:task — card moves Coding → Validation");
  push(move("job:live", { status: "validation" }));
  const movedOnce = await waitIn("validation", "job:live", 3000);
  await page.waitForTimeout(1500);
  await caption("2. …and Validation → In review");
  push(move("job:live", { status: "in_review", waitingOn: "owner review" }));
  const movedTwice = await waitIn("in_review", "job:live", 3000);
  record("frames move the card in place", movedOnce && movedTwice, "coding → validation → in_review from two board:task frames");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SHOTS, "board-frame-moved.png") });

  // (3) A dropped socket: the card moves while it is down; the reconnect resyncs it.
  await caption("3. Socket dropped — a card moves while the console is disconnected");
  const helloBefore = epochN;
  accepting = false;
  versionHeld = true;
  helloCountAtHold = hellos.length;
  for (const s of [...sockets]) s.close(1012, "restart");
  move("job:resync", { status: "coding" });
  await page.waitForTimeout(2500);
  const stillQueued = (await inColumn("queued", "job:resync").count()) === 1;
  const backAt = Date.now();
  accepting = true;
  await caption("3. Collector back — the console reconnects and resyncs");
  const resynced = await waitIn("coding", "job:resync", 20000);
  const reconnected = epochN > helloBefore && sockets.size > 0;
  // The first list read after the outage came after the new socket's hello-ok: it is the reconnect's resync.
  const helloAt = hellos.find((t) => t >= backAt);
  const firstRead = listReads.find((t) => t >= backAt);
  const viaHello = helloAt !== undefined && firstRead !== undefined && firstRead >= helloAt;
  record(
    "reconnect resyncs a move made while down",
    stillQueued && resynced && reconnected && viaHello,
    `queued while down (${stillQueued}); a new socket said hello (${epochN - helloBefore}); first read after it (${viaHello}); coding (${resynced})`
  );
  await page.waitForTimeout(1500);

  // (4) A frame lost on a socket that still looks connected: the version catch-up shows it.
  await caption("4. A move whose frame is lost — the catch-up's version check reads it back");
  const readsBefore = listReads.length;
  move("job:docs", { status: "done" });
  const caughtUp = await waitIn("done", "job:docs", 6000);
  // Two more catch-up rounds: the version now matches, so nothing more is read.
  await page.waitForTimeout(4500);
  const rereads = listReads.length - readsBefore;
  record("a lost frame shows after the version catch-up", caughtUp && rereads === 1, `validation → done with no frame; ${rereads} list re-read(s)`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SHOTS, "board-resynced.png") });

  // (5) The console is rebuilt under the open page: it offers a reload.
  await caption("5. The console is rebuilt under the open page — it offers a reload");
  const indexPath = join(OUT_DIR, "index.html");
  const index = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, index.replace(/\/assets\/index-[\w-]+\.js/, "/assets/index-rebuilt0.js"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  let offered = true;
  try {
    await page.getByTestId("build-update-banner").waitFor({ timeout: 8000 });
  } catch {
    offered = false;
  }
  record("a rebuilt console offers a reload", offered, "banner shown; the page stays put until a tab switch or Reload");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SHOTS, "board-build-update.png") });

  const marker = await page.evaluate(() => (window as unknown as { __e2eDocument?: string }).__e2eDocument);
  record("the page never reloaded", loads === booted && marker === "first-load", `${loads} document load(s), window marker ${marker ?? "gone"}`);

  // (6) With the rebuild noticed, switching tabs lands on the current build.
  await caption("6. Switching tabs on the old build reloads onto the new one");
  // The "new build" the reload lands on is the real one, served again.
  writeFileSync(indexPath, index);
  await page.waitForTimeout(1200);
  await page.locator('a[href="/board"]').first().waitFor();
  await page.locator('a[href="/review"]').first().click();
  let reloaded = true;
  try {
    await page.waitForFunction(() => !(window as unknown as { __e2eDocument?: string }).__e2eDocument, undefined, { timeout: 8000 });
    // The reloaded page is a working console, on the tab it switched to.
    await page.locator('a[href="/board"]').first().waitFor({ timeout: 8000 });
  } catch {
    reloaded = false;
  }
  const landedOn = new URL(page.url()).pathname;
  record("a tab switch on the old build reloads", reloaded && loads > booted && landedOn.startsWith("/review"), `${loads - booted} reload(s); the console came back up on ${landedOn}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await caption(results.every((r) => r.ok) ? "All checks passed" : "Some checks failed");
  await page.waitForTimeout(1500);
  videoPath = await page.video()?.path();
  await context.close();
} finally {
  await browser.close();
  await served.close?.();
  api.stop(true);
  ws.stop(true);
}

console.log(JSON.stringify({ video: videoPath, shots: SHOTS, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
