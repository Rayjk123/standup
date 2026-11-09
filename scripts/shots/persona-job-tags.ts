#!/usr/bin/env bun
/**
 * Screenshots the Persona console's job-tag UI against fixture data.
 *
 *   bun scripts/shots/persona-job-tags.ts [--out-dir /tmp/persona-job-tags-shots]
 *
 * Builds packages/web once with scripts/shots/vite.shots.config.ts into a
 * scratch directory, serves that build from a static server on the first free
 * port in 5300–5399, and drives headless Chromium against it. The build is a
 * snapshot taken at start, so edits to the source tree while the run is in
 * progress cannot change what the browser loads. Every /api request is
 * answered by `fixtureResponse` (persona-job-tags.fixtures.ts) and the /ws
 * socket is answered in-page with a hello-ok frame naming the owner. Any
 * request that leaves the server's origin is aborted and fails the run, so no
 * collector is contacted. Only the server this script started is stopped.
 *
 * Writes desktop-{thread-chips,filter-popover,filtered,drawer-messages-link}.png
 * and mobile-{thread-chips,filter-sheet,filtered,drawer-messages-link}.png.
 * Each shot is taken after asserting the chips, filter and drawer render as the
 * fixtures dictate, so a broken render fails the run. A failing step saves
 * failure-<step>.png in the output directory and names the step in the error.
 *
 * Playwright is not a repo dependency: it is loaded from a scratch install at
 * STANDUP_PLAYWRIGHT_DIR (default /tmp/standup-pw). When that install is
 * missing the script prints the one-time setup commands and exits 2.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join, normalize, resolve, sep } from "path";
import { JOB, MSG, fixtureResponse, helloOk } from "./persona-job-tags.fixtures";

const DEFAULT_PLAYWRIGHT_DIR = "/tmp/standup-pw";
const INSTALL_HINT =
  "mkdir -p /tmp/standup-pw && cd /tmp/standup-pw && bun init -y && bun add playwright && bunx playwright install chromium";
const DEFAULT_OUT_DIR = "/tmp/persona-job-tags-shots";
/** Ports the script may bind; ports outside this range belong to live services. */
const PORT_RANGE = { min: 5300, max: 5399 } as const;
/** Ports never used even inside the range. */
const RESERVED_PORTS = new Set([5173, 5199, 7777]);
/** How long one wait for a rendered element may take. */
const WAIT_MS = 20_000;
const BUILD_TIMEOUT_MS = 180_000;

const ROOT = resolve(import.meta.dir, "..", "..");
const WEB_DIR = join(ROOT, "packages", "web");
const CONFIG = join(import.meta.dir, "vite.shots.config.ts");
const TAG = "[persona-job-tags]";

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

/** The first free port in PORT_RANGE. */
export function pickPort(): number {
  for (let port = PORT_RANGE.min; port <= PORT_RANGE.max; port++) {
    if (!RESERVED_PORTS.has(port) && portIsFree(port)) return port;
  }
  throw new Error(`no free port in ${PORT_RANGE.min}–${PORT_RANGE.max}`);
}

/** Builds packages/web into `distDir` with the shots config; throws with vite's output on failure. */
async function buildApp(distDir: string): Promise<void> {
  const vite = join(WEB_DIR, "node_modules", ".bin", "vite");
  const proc = Bun.spawn(
    [vite, "build", "--config", CONFIG, "--outDir", distDir, "--emptyOutDir", "--logLevel", "warn"],
    { cwd: WEB_DIR, stdout: "pipe", stderr: "pipe" }
  );
  const timer = setTimeout(() => proc.kill(), BUILD_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0 || !existsSync(join(distDir, "index.html"))) {
    throw new Error(`vite build failed (exit ${code}):\n${(out + err).slice(-4000)}`);
  }
}

/**
 * Serves the build in `distDir` on 127.0.0.1:`port`, falling back to
 * index.html for client routes. /api and /ws answer 404: the browser's routes
 * answer those, so a request reaching here was missed by the fixtures.
 */
export function serveBuild(distDir: string, port: number) {
  if (port < PORT_RANGE.min || port > PORT_RANGE.max || RESERVED_PORTS.has(port)) {
    throw new Error(`refusing port ${port}`);
  }
  const root = resolve(distDir);
  const index = join(root, "index.html");
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/api/") || pathname === "/ws") {
        reachedServer.push(`${req.method} ${pathname}`);
        return Response.json({ error: "not served by the shots server" }, { status: 404 });
      }
      let decoded = pathname;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        // A malformed escape names no file; serve the app shell.
      }
      const file = resolve(root, normalize(decoded).replace(/^[/\\]+/, ""));
      if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
        return new Response(Bun.file(file));
      }
      return new Response(Bun.file(index), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  });
}

/** Requests the browser tried to send off the server's origin; each was aborted. */
const offOrigin: string[] = [];
/** /api or /ws requests that got past the browser routes to the static server. */
export const reachedServer: string[] = [];
/** /api requests no fixture covers; each got the fixtures' empty default. */
const unmocked = new Set<string>();
/** Uncaught page errors and console errors, reported after the run. */
const pageErrors: string[] = [];

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

/** Answers every same-origin /api request from `fixtureResponse` and the /ws socket with hello-ok. */
async function mockApi(context: Any, base: string): Promise<void> {
  const origin = new URL(base);
  await context.routeWebSocket(
    (url: URL) => url.pathname === "/ws" && url.port === origin.port,
    (ws: Any) => {
      ws.onMessage(() => {});
      ws.send(JSON.stringify(helloOk));
    }
  );
  await context.route(
    (url: URL) => url.origin === origin.origin && url.pathname.startsWith("/api/"),
    async (route: Any) => {
      const request = route.request();
      const url = new URL(request.url());
      const res = fixtureResponse(request.method(), url) ?? { status: 200, json: {}, unmocked: true as const };
      if (res.unmocked) unmocked.add(`${request.method()} ${url.pathname}${url.search}`);
      return route.fulfill({ status: res.status, contentType: "application/json", body: JSON.stringify(res.json) });
    }
  );
}

function watch(page: Any, label: string): void {
  page.on("pageerror", (e: Error) => pageErrors.push(`[${label}] ${e.message}`));
  page.on("console", (m: Any) => {
    if (m.type() === "error") pageErrors.push(`[${label}] console.error: ${m.text()}`);
  });
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

/** Waits for `locator`, failing with `what` rather than a bare Playwright timeout. */
async function waitVisible(locator: Any, what: string, timeout = WAIT_MS): Promise<void> {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
  } catch {
    throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
  }
}

/**
 * Runs one named step. On failure saves failure-<label>-<step>.png in `outDir`
 * and rethrows with the step, the page URL, the screenshot path and the page
 * errors so far.
 */
async function step<T>(page: Any, outDir: string, label: string, name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const shot = join(outDir, `failure-${label}-${name}.png`);
    const saved = await page
      .screenshot({ path: shot, fullPage: true })
      .then(() => shot)
      .catch((e: Error) => `(screenshot failed: ${e.message})`);
    const errors = pageErrors.length > 0 ? `\n  page errors:\n    ${pageErrors.join("\n    ")}` : "";
    throw new Error(
      `step ${label}/${name} failed at ${page.url()}: ${(err as Error).message}\n  screenshot: ${saved}${errors}`
    );
  }
}

/** Loads `path` and waits until the Persona view has rendered the thread from fixtures. */
async function gotoReady(page: Any, base: string, path: string): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  await waitVisible(page.locator("[data-message-id]"), `a thread message row on ${path} (app never left "Loading")`);
}

const chipsOf = (page: Any, messageId: string) =>
  page.locator(`[data-message-id="${messageId}"] [data-testid=message-job-tag]`);

async function sourcesOf(page: Any, messageId: string): Promise<string[]> {
  return chipsOf(page, messageId).evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-source") ?? ""));
}

/** Waits for the multi-job reply's chips, then checks every tagged message carries the fixture's chips. */
async function assertThreadChips(page: Any): Promise<void> {
  await waitVisible(chipsOf(page, MSG.personaMulti), `job chips on ${MSG.personaMulti}`);
  const multi = await sourcesOf(page, MSG.personaMulti);
  assert(multi.length === 3, `multi-job reply has 3 chips (got ${multi.length})`);
  assert(multi.includes("declared") && multi.includes("inferred"), `multi-job reply mixes sources (${multi})`);
  const inferred = await sourcesOf(page, MSG.ownerInferred);
  assert(inferred.length === 2 && inferred.every((s) => s === "inferred"), `owner question has 2 inferred chips (${inferred})`);
  const explicit = await sourcesOf(page, MSG.ownerExplicit);
  assert(explicit.length === 1 && explicit[0] === "explicit", `"re job" message has 1 explicit chip (${explicit})`);
  const slack = await sourcesOf(page, MSG.slackDone);
  assert(slack.length === 1 && slack[0] === "declared", `Slack done reply has 1 declared chip (${slack})`);
  for (const id of [MSG.ownerUntagged, MSG.ownerUntagged2, MSG.personaUntagged]) {
    assert((await chipsOf(page, id).count()) === 0, `${id} has no chips`);
  }
  await page.waitForTimeout(300);
}

/** Checks the filter bar shows and the thread is narrowed to the job-tags job's three messages. */
async function assertFiltered(page: Any): Promise<void> {
  const bar = page.locator("[data-testid=job-filter-bar]");
  await waitVisible(bar, "the job filter bar");
  await waitVisible(bar.filter({ hasText: "Showing 3 messages for" }), `the filter bar to read "Showing 3 messages for"`);
  const chips = await page.locator("[data-testid=job-filter-chip]").count();
  assert(chips === 1, `filter bar shows 1 job chip (got ${chips})`);
  await waitVisible(chipsOf(page, MSG.ownerExplicit), `job chips on ${MSG.ownerExplicit} in the filtered view`);
  const rows: string[] = await page
    .locator("[data-message-id]")
    .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("data-message-id") ?? ""));
  for (const id of [MSG.ownerExplicit, MSG.personaAck, MSG.personaMulti]) {
    assert(rows.includes(id), `filtered view shows ${id} (rows: ${rows})`);
  }
  for (const id of [MSG.slackDone, MSG.ownerUntagged, MSG.ownerInferred, MSG.ownerUntagged2, MSG.personaUntagged]) {
    assert(!rows.includes(id), `filtered view hides ${id} (rows: ${rows})`);
  }
  await page.waitForTimeout(300);
}

/** Opens the job drawer by deep link and checks its "Messages in thread (3)" link. */
async function openDrawer(page: Any, base: string): Promise<void> {
  await gotoReady(page, base, `/persona?job=${JOB.jobTags}`);
  const link = page.locator("[data-testid=job-drawer-messages]");
  await waitVisible(link, "the drawer's Messages in thread link");
  try {
    await link.filter({ hasText: "Messages in thread (3)" }).waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new Error(`drawer link reads "${(await link.textContent()) ?? ""}", expected "Messages in thread (3)"`);
  }
  await link.scrollIntoViewIfNeeded();
  // Lets the drawer's slide-in transition finish.
  await page.waitForTimeout(400);
}

/** Opens the job filter and checks it lists the four tagged jobs in the expected variant. */
async function openFilter(page: Any, variant: "popover" | "sheet", tap: boolean): Promise<void> {
  const button = page.locator("[data-testid=job-filter-button]");
  await waitVisible(button, "the Filter by job button");
  if (tap) await button.tap();
  else await button.click();
  const panel = page.locator("[data-testid=job-filter-popover]");
  await waitVisible(panel, "the job filter panel");
  const got = await panel.getAttribute("data-variant");
  assert(got === variant, `filter opens as a ${variant} (got ${got})`);
  const options = await page.locator("[data-testid=job-filter-option]").count();
  assert(options === 4, `filter lists the 4 tagged jobs (got ${options})`);
  await page.waitForTimeout(300);
}

async function shoot(page: Any, outDir: string, name: string): Promise<string> {
  const path = join(outDir, name);
  await page.screenshot({ path });
  console.log(path);
  return path;
}

async function runViewport(
  browser: Any,
  base: string,
  outDir: string,
  label: "desktop" | "mobile",
  options: Record<string, unknown>
): Promise<void> {
  // Headless Chromium reports a light OS; the shots are of the dark console.
  const context = await browser.newContext({ colorScheme: "dark", ...options });
  await confineToOrigin(context, base);
  await mockApi(context, base);
  const page = await context.newPage();
  watch(page, label);
  const mobile = label === "mobile";

  try {
    await step(page, outDir, label, "thread-chips", async () => {
      await gotoReady(page, base, "/persona");
      await assertThreadChips(page);
      await page.locator(`[data-message-id="${MSG.personaMulti}"]`).scrollIntoViewIfNeeded();
      await shoot(page, outDir, `${label}-thread-chips.png`);
    });

    await step(page, outDir, label, mobile ? "filter-sheet" : "filter-popover", async () => {
      await openFilter(page, mobile ? "sheet" : "popover", mobile);
      await shoot(page, outDir, `${label}-${mobile ? "filter-sheet" : "filter-popover"}.png`);
    });

    await step(page, outDir, label, "filtered", async () => {
      await gotoReady(page, base, `/persona?tags=${JOB.jobTags}`);
      await assertFiltered(page);
      await shoot(page, outDir, `${label}-filtered.png`);
    });

    await step(page, outDir, label, "drawer-messages-link", async () => {
      await openDrawer(page, base);
      await shoot(page, outDir, `${label}-drawer-messages-link.png`);
    });
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const { outDir } = parseArgs(process.argv.slice(2));
  const dir = process.env.STANDUP_PLAYWRIGHT_DIR?.trim() || DEFAULT_PLAYWRIGHT_DIR;
  const entry = resolvePlaywright(dir);
  if (!entry) {
    console.error(`${TAG} Playwright not found in ${dir}. One-time setup:`);
    console.error(`  ${INSTALL_HINT}`);
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const distDir = mkdtempSync(join(tmpdir(), "persona-job-tags-build-"));

  let server: ReturnType<typeof serveBuild> | null = null;
  let browser: Any = null;
  const cleanup = () => {
    server?.stop(true);
    server = null;
    rmSync(distDir, { recursive: true, force: true });
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    console.log(`${TAG} building packages/web into ${distDir}`);
    await buildApp(distDir);
    const port = pickPort();
    server = serveBuild(distDir, port);
    const base = `http://127.0.0.1:${port}`;
    console.log(`${TAG} serving the build on ${base}`);
    const { chromium } = await import(entry);
    browser = await chromium.launch({ headless: true });
    await runViewport(browser, base, outDir, "desktop", { viewport: { width: 1440, height: 900 } });
    await runViewport(browser, base, outDir, "mobile", {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    if (offOrigin.length > 0) throw new Error(`requests left the server's origin: ${offOrigin.join(", ")}`);
    console.log(`${TAG} off-origin requests: 0`);
    if (reachedServer.length > 0) console.log(`${TAG} requests the fixtures missed:\n  ${reachedServer.join("\n  ")}`);
    if (unmocked.size > 0) console.log(`${TAG} unmocked /api requests:\n  ${[...unmocked].join("\n  ")}`);
    if (pageErrors.length > 0) console.log(`${TAG} page errors:\n  ${pageErrors.join("\n  ")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    cleanup();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`${TAG} ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
