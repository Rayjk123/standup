#!/usr/bin/env bun
/**
 * Screenshots the web console's Review tab against fixture data.
 *
 *   bun scripts/review-tab-screenshot.ts [--out-dir /tmp/review-tab-shots]
 *
 * Starts the packages/web Vite dev server with vite.screenshot.config.ts (no
 * /api or /ws proxy) on a free port picked from 5300–5399, and drives headless
 * Chromium against it with every /api request answered from
 * review-fixtures.ts and the /ws socket closed unanswered. Any request that
 * leaves the Vite origin is aborted and fails the run, so no collector is
 * contacted. Only the Vite process the script spawned is stopped. Media URLs
 * are served from assets generated on the
 * fly: PNGs rendered from small HTML mockups, and a webm recorded from an
 * animated page. Writes review-list-desktop.png and review-detail-desktop.png
 * (desktop only; UI work is not validated on mobile), then stops Vite.
 *
 * Playwright is not a repo dependency: it is loaded from a scratch install at
 * STANDUP_PLAYWRIGHT_DIR (default /tmp/standup-pw). When that install is
 * missing the script prints the one-time setup commands and exits 2.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { Subprocess } from "bun";
import type { ReviewPacketDetail } from "@standup/shared";
import {
  DETAIL_ID,
  fixtureDetail,
  fixtureSummaries,
  pendingSummaries,
} from "../packages/web/src/components/review/review-fixtures";

const DEFAULT_PLAYWRIGHT_DIR = "/tmp/standup-pw";
const INSTALL_HINT =
  "mkdir -p /tmp/standup-pw && cd /tmp/standup-pw && bun init -y && bun add playwright && bunx playwright install chromium";
const DEFAULT_OUT_DIR = "/tmp/review-tab-shots";
/** Ports the script may bind; ports outside this range belong to live services. */
const PORT_RANGE = { min: 5300, max: 5399 } as const;

const ROOT = resolve(import.meta.dir, "..");
const WEB_DIR = join(ROOT, "packages", "web");

// Playwright is resolved at runtime from a scratch install, so its types are not available here.
type Any = any;

function resolvePlaywright(dir: string): string | null {
  if (!existsSync(join(dir, "package.json"))) return null;
  try {
    return createRequire(join(dir, "package.json")).resolve("playwright");
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): { outDir: string } {
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out-dir") outDir = resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument ${arg}`);
  }
  return { outDir };
}

/** Binds and releases a port without connecting to it, so a live listener is never probed. */
function portIsFree(port: number): boolean {
  try {
    const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** A free port from PORT_RANGE, scanning from a random offset. */
function pickPort(): number {
  const span = PORT_RANGE.max - PORT_RANGE.min + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = PORT_RANGE.min + ((start + i) % span);
    if (portIsFree(port)) return port;
  }
  throw new Error(`no free port in ${PORT_RANGE.min}–${PORT_RANGE.max}`);
}

async function startVite(port: number): Promise<{ proc: Subprocess; url: string; stderr: () => string }> {
  if (port < PORT_RANGE.min || port > PORT_RANGE.max) throw new Error(`refusing port ${port} outside ${PORT_RANGE.min}–${PORT_RANGE.max}`);
  const vite = join(WEB_DIR, "node_modules", ".bin", "vite");
  const config = join(WEB_DIR, "vite.screenshot.config.ts");
  const proc = Bun.spawn([vite, "--config", config, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: WEB_DIR,
    stdout: "ignore",
    stderr: "pipe",
  });
  let errText = "";
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      errText += decoder.decode(value);
    }
  })();
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`vite exited (${proc.exitCode}): ${errText.slice(-2000)}`);
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) return { proc, url, stderr: () => errText };
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`vite did not start on ${url}: ${errText.slice(-2000)}`);
}

const MOCKUP_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; background: #12141a; color: #e7e9ef; }
  .bar { height: 44px; background: #1a1d25; border-bottom: 1px solid #2f3543; display: flex; align-items: center; gap: 14px; padding: 0 16px; }
  .brand { color: #f59e32; font: 700 13px ui-monospace, monospace; letter-spacing: .2em; }
  .tab { color: #8b90a0; font-size: 13px; } .tab.on { color: #e7e9ef; background: #262a35; padding: 4px 10px; border-radius: 5px; }
  .card { background: #1a1d25; border: 1px solid #2f3543; border-radius: 8px; padding: 12px; margin: 10px; }
  .t { font-weight: 600; font-size: 15px; } .m { color: #8b90a0; font-size: 12px; margin-top: 6px; font-family: ui-monospace, monospace; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font: 700 11px sans-serif; text-transform: uppercase; }
  .add { color: #4fd39a; background: #4fd39a17; } .del { color: #ff5c72; background: #ff5c7217; }
  pre { font: 13px/1.5 ui-monospace, monospace; padding: 8px 12px; }
  .btn { display: block; text-align: center; padding: 12px; border-radius: 7px; font-weight: 700; margin: 8px 12px; }
`;

const LIST_MOCKUP = `<style>${MOCKUP_CSS}</style>
  <div class="bar"><span class="brand">STANDUP</span><span class="tab">Work</span><span class="tab on">Review 2</span><span class="tab">Projects</span></div>
  <div style="display:flex">
    <div style="width:330px">
      <div class="card" style="border-color:#f59e32"><div class="t">Add the Review tab</div><div class="m">standup/review-tab@9c41f2e · 12m ago · 🖼 3 ▶ 1</div>
        <span class="pill" style="color:#ff5c72;background:#ff5c721f;margin-top:8px">Pending</span></div>
      <div class="card"><div class="t">Raise the dedup threshold</div><div class="m">standup/kb-dedup@4be1907 · 3h ago · 🖼 1</div>
        <span class="pill" style="color:#ff5c72;background:#ff5c721f;margin-top:8px">Pending</span></div>
      <div class="card"><div class="t">Back off the cron</div><div class="m">orchard/cron-backoff@e07a3d9 · 18h ago</div>
        <span class="pill" style="color:#f59e0b;background:#f59e0b1f;margin-top:8px">Changes requested</span></div>
    </div>
    <div style="flex:1;padding:22px"><div style="font-size:22px;font-weight:700">Add the Review tab for human sign-off</div>
      <div class="m">INTENT</div><p style="margin-top:6px;color:#c9ccd6">Gives the human_review stage a place to be decided.</p></div>
  </div>`;

const DETAIL_MOCKUP = `<style>${MOCKUP_CSS}</style>
  <div class="bar"><span class="brand">STANDUP</span><span class="tab on">Review</span></div>
  <div style="padding:18px 22px">
    <div class="m">WHAT CHANGED</div>
    <div class="card" style="margin:10px 0;padding:0;overflow:hidden">
      <div style="padding:8px 12px;background:#262a35;font:13px ui-monospace,monospace">packages/web/src/components/Console.tsx <span style="color:#8b90a0">@@ -61,7 +61,7 @@</span></div>
      <pre><span style="color:#5b606e">@@ -61,7 +61,7 @@</span>
<span class="del">-const VIEWS = ["persona", "schedules", "work", "activity"]</span>
<span class="add">+const VIEWS = ["persona", "schedules", "work", "review", "activity"]</span>
 function SessionShortLink() {</pre>
    </div>
    <div class="m">VALIDATION</div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
      <pre class="card" style="margin:0;flex:1">POST /api/reviews/rp-7f3a2c/approve</pre><span style="color:#f59e32;font-size:20px">→</span>
      <pre class="card" style="margin:0;flex:1">200 OK { "status": "approved" }</pre>
    </div>
  </div>`;

const DECISION_MOCKUP = `<style>${MOCKUP_CSS}</style>
  <div style="position:absolute;bottom:0;left:0;right:0;background:#1a1d25;border-top:1px solid #2f3543;padding:14px 16px;display:flex;gap:12px;align-items:center">
    <div style="flex:1;height:52px;border:1px solid #2f3543;border-radius:6px;background:#12141a;color:#5b606e;padding:8px 10px;font-size:14px">Comment (required to request changes)</div>
    <div class="btn" style="border:1px solid #f59e0b;color:#f59e0b;width:160px;margin:0">Request changes</div>
    <div class="btn" style="background:#4fd39a;color:#12141a;width:120px;margin:0">Approve</div>
  </div>`;

const ANIMATION_HTML = `<style>
  body { margin: 0; background: #12141a; color: #e7e9ef; font-family: system-ui, sans-serif; overflow: hidden; }
  .stage { position: relative; width: 640px; height: 360px; }
  .title { position: absolute; top: 28px; left: 32px; font-size: 26px; font-weight: 700; }
  .sub { position: absolute; top: 70px; left: 32px; color: #8b90a0; font-size: 16px; }
  .track { position: absolute; top: 170px; left: 32px; right: 32px; height: 8px; background: #262a35; border-radius: 4px; }
  .dot { position: absolute; top: 150px; left: 32px; width: 48px; height: 48px; border-radius: 24px; background: #4fd39a;
    animation: slide 2.2s ease-in-out infinite alternate; box-shadow: 0 0 24px #4fd39a88; }
  .stages { position: absolute; top: 230px; left: 32px; right: 32px; display: flex; justify-content: space-between; font-size: 15px; color: #8b90a0; }
  @keyframes slide { from { left: 32px; background: #ff5c72; } to { left: 560px; background: #4fd39a; } }
</style>
<div class="stage"><div class="title">Approve → pipeline completes</div><div class="sub">human_review stage walkthrough</div>
  <div class="track"></div><div class="dot"></div>
  <div class="stages"><span>coding</span><span>validation</span><span>human_review</span><span>complete</span></div></div>`;

interface Assets {
  images: Record<string, Buffer>;
  video: Buffer;
}

async function renderPng(browser: Any, html: string, width: number, height: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent(html);
    return await page.screenshot({ type: "png" });
  } finally {
    await page.close();
  }
}

async function recordWebm(browser: Any, dir: string): Promise<Buffer> {
  const size = { width: 640, height: 360 };
  const context = await browser.newContext({ viewport: size, recordVideo: { dir, size } });
  const page = await context.newPage();
  await page.setContent(ANIMATION_HTML);
  await page.waitForTimeout(2600);
  const video = page.video();
  await context.close();
  const path = await video.path();
  return readFileSync(path);
}

async function buildAssets(browser: Any, scratch: string): Promise<Assets> {
  const [list, detail, decision] = await Promise.all([
    renderPng(browser, LIST_MOCKUP, 960, 600),
    renderPng(browser, DETAIL_MOCKUP, 960, 600),
    renderPng(browser, DECISION_MOCKUP, 960, 240),
  ]);
  const video = await recordWebm(browser, scratch);
  return { images: { "m-list": list, "m-detail": detail, "m-decision": decision }, video };
}

function detailFor(id: string): ReviewPacketDetail | null {
  if (id === DETAIL_ID) return fixtureDetail;
  const summary = fixtureSummaries.find((s) => s.id === id);
  if (!summary) return null;
  return { ...fixtureDetail, ...summary, media: [], comments: [] };
}

/** Requests the browser tried to send off the Vite origin; each was aborted. */
const offOrigin: string[] = [];

/**
 * Aborts every request and socket that leaves `origin`, recording it in
 * offOrigin so main() fails the run. Registered before mockApi so the
 * same-origin fixture routes take precedence.
 */
async function confineToOrigin(context: Any, origin: string): Promise<void> {
  await context.route(
    (url: URL) => url.origin !== origin,
    (route: Any) => {
      offOrigin.push(route.request().url());
      return route.abort("blockedbyclient");
    }
  );
  await context.routeWebSocket(
    (url: URL) => new URL(url.href.replace(/^ws/, "http")).origin !== origin,
    (ws: Any) => {
      offOrigin.push(ws.url());
      ws.close();
    }
  );
}

/** Answers every same-origin /api request from fixtures; nothing reaches a collector. */
async function mockApi(context: Any, assets: Assets, base: string): Promise<void> {
  const origin = new URL(base);
  const emptyLists = new Set([
    "/api/projects",
    "/api/sessions",
    "/api/checkpoints",
    "/api/asks/pending",
    "/api/launches",
    "/api/tickets",
    "/api/task-runs",
    "/api/review-findings",
  ]);
  await context.routeWebSocket((url: URL) => url.pathname === "/ws" && url.port === origin.port, (ws: Any) => ws.close());
  await context.route(
    (url: URL) => url.origin === origin.origin && url.pathname.startsWith("/api/"),
    async (route: Any) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      const media = path.match(/^\/api\/reviews\/([^/]+)\/media\/([^/]+)$/);
      if (media) {
        const mediaId = decodeURIComponent(media[2]);
        if (mediaId === "m-walkthrough") return route.fulfill({ status: 200, contentType: "video/webm", body: assets.video });
        const png = assets.images[mediaId];
        return png ? route.fulfill({ status: 200, contentType: "image/png", body: png }) : json({ error: "no media" }, 404);
      }
      if (path === "/api/reviews") {
        return json({ reviews: url.searchParams.get("status") === "all" ? fixtureSummaries : pendingSummaries });
      }
      if (path === "/api/reviews/pending-count") return json({ count: pendingSummaries.length });
      const decide = path.match(/^\/api\/reviews\/([^/]+)\/(approve|request-changes)$/);
      if (decide && request.method() === "POST") {
        const review = detailFor(decodeURIComponent(decide[1]));
        if (!review) return json({ error: "review not found" }, 404);
        const status = decide[2] === "approve" ? "approved" : "changes_requested";
        return json({ review: { ...review, status, decidedBy: "owner", decidedAt: new Date().toISOString() } });
      }
      const one = path.match(/^\/api\/reviews\/([^/]+)$/);
      if (one) {
        const review = detailFor(decodeURIComponent(one[1]));
        return review ? json({ review }) : json({ error: "review not found" }, 404);
      }
      if (emptyLists.has(path)) return json([]);
      return json({ error: "not mocked" }, 404);
    }
  );
}

/** Waits until every <img> has decoded and every <video> has its first frame, nudging a metadata-only preload to decode one. */
async function waitForMedia(page: Any): Promise<void> {
  await page.waitForFunction(
    () => [...document.querySelectorAll("img")].every((img) => img.complete && img.naturalWidth > 0),
    undefined,
    { timeout: 15_000 }
  );
  await page.evaluate(async () => {
    const videos = [...document.querySelectorAll("video")];
    await Promise.all(
      videos.map(
        (v) =>
          new Promise<void>((done) => {
            if (v.readyState >= 2) return done();
            const timer = setTimeout(() => {
              v.currentTime = 0.4;
            }, 1500);
            v.addEventListener(
              "loadeddata",
              () => {
                clearTimeout(timer);
                done();
              },
              { once: true }
            );
          })
      )
    );
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll("video")].every((v) => v.readyState >= 2),
    undefined,
    { timeout: 15_000 }
  );
}

/** Grows the viewport to the detail pane's full scroll height so a screenshot captures all of it. */
async function expandToDetail(page: Any, width: number): Promise<void> {
  const height = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=review-detail-scroll]") as HTMLElement;
    return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight);
  });
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(300);
  await waitForMedia(page);
}

/** Fails when the page scrolls sideways — content wider than the viewport. */
async function assertNoHorizontalOverflow(page: Any, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll("[data-testid=review-detail-scroll], [data-testid=review-detail]")].filter(
      (el) => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1
    );
    return { doc: doc.scrollWidth - doc.clientWidth, panes: wide.length };
  });
  if (overflow.doc > 1 || overflow.panes > 0) {
    throw new Error(`${label}: horizontal overflow (document +${overflow.doc}px, ${overflow.panes} overflowing panes)`);
  }
}

async function shoot(page: Any, outDir: string, name: string, fullPage = false): Promise<string> {
  const path = join(outDir, name);
  await page.screenshot({ path, fullPage });
  console.log(path);
  return path;
}

async function main(): Promise<void> {
  const { outDir } = parseArgs(process.argv.slice(2));
  const dir = process.env.STANDUP_PLAYWRIGHT_DIR?.trim() || DEFAULT_PLAYWRIGHT_DIR;
  const entry = resolvePlaywright(dir);
  if (!entry) {
    console.error(`[review-tab-screenshot] Playwright not found in ${dir}. One-time setup:`);
    console.error(`  ${INSTALL_HINT}`);
    process.exit(2);
  }
  const port = pickPort();
  console.log(`[review-tab-screenshot] vite port ${port}`);
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "review-tab-shots-"));

  let vite: Awaited<ReturnType<typeof startVite>> | null = null;
  let browser: Any = null;
  const stopVite = () => {
    if (vite && vite.proc.exitCode === null) vite.proc.kill();
  };
  process.on("SIGINT", () => {
    stopVite();
    process.exit(130);
  });

  try {
    vite = await startVite(port);
    const { chromium } = await import(entry);
    browser = await chromium.launch({ headless: true });
    const assets = await buildAssets(browser, scratch);
    const base = vite.url;

    // Desktop.
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await confineToOrigin(desktop, base);
    await mockApi(desktop, assets, base);
    const dPage = await desktop.newPage();
    await dPage.goto(`${base}/review`, { waitUntil: "load" });
    await dPage.waitForSelector("[data-testid=review-card]", { timeout: 20_000 });
    await assertNoHorizontalOverflow(dPage, "list");
    await shoot(dPage, outDir, "review-list-desktop.png");
    await dPage.click(`[data-testid=review-card] >> nth=0`);
    await dPage.waitForSelector("[data-testid=review-detail]");
    await dPage.waitForSelector("[data-testid=review-tab-badge]");
    await waitForMedia(dPage);
    await assertNoHorizontalOverflow(dPage, "detail");
    await expandToDetail(dPage, 1280);
    await shoot(dPage, outDir, "review-detail-desktop.png", true);
    await desktop.close();
    if (offOrigin.length > 0) throw new Error(`requests left the Vite origin: ${offOrigin.join(", ")}`);
    console.log(`[review-tab-screenshot] off-origin requests: 0`);
  } catch (err) {
    if (vite) console.error(`[review-tab-screenshot] vite stderr:\n${vite.stderr().slice(-2000)}`);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopVite();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[review-tab-screenshot] ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
