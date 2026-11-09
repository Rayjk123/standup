#!/usr/bin/env bun
/**
 * Capture a PNG of a local web page with headless Chromium.
 *
 *   bun scripts/pipeline-screenshot.ts <url> [--out <absolute .png path>]
 *     [--width 1440] [--height 900] [--full-page] [--wait-for <css selector>] [--wait-ms N]
 *   bun scripts/pipeline-screenshot.ts --record <url> [--out <absolute .webm path>] ...
 *
 * --record (first argument) records a short desktop WebM of the page loading
 * with its timing marks burned in instead; see pipeline-recording.ts.
 *
 * Only local pages are shot: http(s) on localhost / 127.0.0.1 / [::1] (any
 * port), data: URLs, and file: URLs under the screenshot roots (os.tmpdir(),
 * /tmp, STANDUP_SCREENSHOT_ROOTS). Every request in the browser context
 * (subresources, redirects, popups, WebSockets) is held to the same rule,
 * service workers are blocked, popups are closed, and Chromium resolves no
 * host name but localhost, so the capture can't carry page content to a
 * remote host.
 *
 * Without --out the PNG goes to /tmp/standup-screenshots-<uid>/, created 0700.
 * The output directory must be owned by the current user, not group- or
 * world-writable, not a symlink, and not inside the Standup install this script
 * belongs to. The capture is written to a fresh name in that directory and
 * renamed onto the output path, so a symlink planted at the output path is
 * replaced rather than written through.
 *
 * Playwright is not a repo dependency: it is loaded from a per-user install at
 * STANDUP_PLAYWRIGHT_DIR (default ${XDG_CACHE_HOME:-~/.cache}/standup/playwright),
 * which must be owned by the current user, not group- or world-writable and not
 * reached through a symlink. When that install is missing the script prints the
 * one-time setup command and exits 2:
 *
 *   bun scripts/pipeline-screenshot.ts --setup
 *
 * creates that directory 0700 and installs Playwright and Chromium into it,
 * running Bun with a fixed argv and environment. On success the script prints
 * the absolute path of the written PNG.
 */

import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "fs";
import { createRequire } from "module";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { collectorPortSet } from "../packages/shared/src/topology";

export interface ScreenshotArgs {
  url: string;
  /** Absent: a timestamped file in defaultOutDir(). */
  out?: string;
  width: number;
  height: number;
  fullPage: boolean;
  waitFor?: string;
  waitMs: number;
}

/** The narrowest viewport shot: UI work is validated on desktop only. */
export const MIN_DESKTOP_WIDTH = 1024;

const USAGE =
  "usage: bun scripts/pipeline-screenshot.ts URL [--out ABSOLUTE_PNG_PATH] " +
  "[--width 1440] [--height 900] [--full-page] [--wait-for CSS_SELECTOR] [--wait-ms N]";

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/** The per-user Playwright install: `${XDG_CACHE_HOME:-~/.cache}/standup/playwright`. */
export function defaultPlaywrightDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const cache = env.XDG_CACHE_HOME?.trim();
  return join(cache && isAbsolute(cache) ? cache : join(home, ".cache"), "standup", "playwright");
}

/** This script's own path. */
export function scriptPath(): string {
  return fileURLToPath(import.meta.url);
}

/** The Standup install this script belongs to: the realpath of the directory above `scripts/`. */
export function installRoot(scriptDir: string = dirname(scriptPath())): string {
  return realpathSync(resolve(scriptDir, ".."));
}

/** The one-time setup command that installs Playwright and Chromium into `dir` (see runSetup). */
export function installHint(dir: string, script: string = scriptPath()): string {
  return `bun ${JSON.stringify(script)} --setup   # installs Playwright and Chromium into ${dir}`;
}

/**
 * The environment the setup steps run in `dir` with: only what locates the
 * user, the cache and the network, so nothing set around the call (BUN_*,
 * NODE_*, npm_config_*, PLAYWRIGHT_BROWSERS_PATH) changes what is installed or
 * where, plus a package cache of the toolchain's own (`<dir>/.bun-cache`).
 */
export function setupEnv(dir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  const cache = env.XDG_CACHE_HOME?.trim();
  if (cache && isAbsolute(cache)) out.XDG_CACHE_HOME = cache;
  out.BUN_INSTALL_CACHE_DIR = join(dir, ".bun-cache");
  return out;
}

/**
 * The setup steps, each Bun's own argv run in the Playwright dir: a package,
 * Playwright in it, then Chromium. Playwright is copied in rather than
 * hard-linked from a package cache, so its files share no inode with one.
 */
export const SETUP_STEPS: readonly (readonly string[])[] = [
  ["init", "-y"],
  ["add", "--backend=copyfile", "playwright"],
  ["x", "playwright", "install", "chromium"],
];

/**
 * `--setup`: creates the Playwright dir 0700 when missing, checks it as the
 * capture does (unsafeDirReason), and runs SETUP_STEPS in it with this Bun,
 * no shell and setupEnv(). Returns the exit code.
 */
export function runSetup(dir: string, bun: string = process.execPath): number {
  const link = userSymlinkOn(dir);
  const created = !link && !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unsafe = link ? `${link} is a symlink` : unsafeDirReason(dir, currentUid(), created ? 0o700 : undefined);
  if (unsafe) {
    console.error(`[pipeline-screenshot] refusing to set up Playwright: ${unsafe}`);
    return 1;
  }
  for (const step of SETUP_STEPS) {
    const r = spawnSync(bun, [...step], { cwd: dir, env: setupEnv(dir), stdio: "inherit", shell: false });
    if (r.status !== 0) {
      console.error(`[pipeline-screenshot] setup step \`bun ${step.join(" ")}\` failed (${r.error?.message ?? `exit ${r.status}`})`);
      return 1;
    }
  }
  console.log(dir);
  return 0;
}

/** The default output directory: `/tmp/standup-screenshots-<uid>`. */
export function defaultOutDir(uid: number = currentUid()): string {
  return `/tmp/standup-screenshots-${uid}`;
}

/**
 * The first symlink on the way to `path` (itself or a directory above it)
 * that root doesn't own, or null. A link root owns (`/home/u -> /data/home/u`)
 * is the system's layout; one owned by anyone else can be repointed by them.
 */
export function userSymlinkOn(path: string): string | null {
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() && st.uid !== 0) return p;
    } catch {
      // A missing component links nowhere.
    }
    if (p === dirname(p)) return null;
  }
}

/**
 * Why `dir` is unsafe to load code from or write into, or null when it is
 * fine: it must be a directory owned by `uid` with no group/world write bit,
 * reached through no symlink but root's own (userSymlinkOn); `exactMode`
 * additionally requires exactly that permission mode.
 */
export function unsafeDirReason(dir: string, uid: number = currentUid(), exactMode?: number): string | null {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return `${dir} does not exist`;
  }
  const link = userSymlinkOn(dir);
  if (link) return `${link} is a symlink`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (uid >= 0 && st.uid !== uid) return `${dir} is owned by uid ${st.uid}, not the current user (${uid})`;
  const mode = st.mode & 0o777;
  if (mode & 0o022) return `${dir} is group- or world-writable (mode ${mode.toString(8).padStart(3, "0")})`;
  if (exactMode !== undefined && mode !== exactMode) {
    return `${dir} has mode ${mode.toString(8).padStart(3, "0")}, expected ${exactMode.toString(8).padStart(3, "0")}`;
  }
  return null;
}

/** Realpaths of the screenshot roots: os.tmpdir(), /tmp and STANDUP_SCREENSHOT_ROOTS (colon-separated). */
export function screenshotRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  for (const c of [tmpdir(), "/tmp", ...(env.STANDUP_SCREENSHOT_ROOTS ?? "").split(":")]) {
    const trimmed = c.trim();
    if (!trimmed || !isAbsolute(trimmed)) continue;
    try {
      roots.add(realpathSync(trimmed));
    } catch {
      // A root that doesn't exist allows nothing.
    }
  }
  return [...roots];
}

function isUnder(path: string, root: string): boolean {
  if (root === sep) return path.startsWith(sep);
  return path === root || path.startsWith(root + sep);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why a loopback URL's port is off limits, or null: the collector's ports
 * (public HTTP and WebSocket, which the gateway serves, and each slot's),
 * which trust a caller on loopback. The console's own port stays reachable.
 */
function collectorPortRefusal(url: URL, blocked: ReadonlySet<number>): string | null {
  const port = Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80));
  return blocked.has(port) ? `port ${port} is Standup's collector, which the capture can't reach` : null;
}

/**
 * Why `raw` may not be loaded, or null when it may: http(s) only on a
 * loopback host and not on the collector's ports (`blocked`), data: URLs, and
 * file: URLs whose realpath is under `roots`.
 */
export function urlRefusal(raw: string, roots: string[] = screenshotRoots(), blocked: ReadonlySet<number> = collectorPortSet()): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a valid URL`;
  }
  switch (url.protocol) {
    case "http:":
    case "https:":
      return LOCAL_HOSTS.has(url.hostname.toLowerCase())
        ? collectorPortRefusal(url, blocked)
        : `${url.host} is not local — only localhost, 127.0.0.1 and [::1] pages can be captured`;
    case "data:":
    case "blob:":
    case "about:":
      return null;
    case "file:": {
      let real: string;
      try {
        real = realpathSync(fileURLToPath(url));
      } catch {
        return `${raw} does not exist`;
      }
      return roots.some((r) => isUnder(real, r)) ? null : `${raw} is outside the screenshot roots (${roots.join(", ") || "none"})`;
    }
    default:
      return `${url.protocol} URLs can't be captured`;
  }
}

/**
 * Why a WebSocket to `raw` may not be opened, or null when it may: ws(s)
 * only on a loopback host and not on the collector's ports (`blocked`).
 */
export function webSocketRefusal(raw: string, blocked: ReadonlySet<number> = collectorPortSet()): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a valid URL`;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return `${url.protocol} WebSockets can't be opened`;
  return LOCAL_HOSTS.has(url.hostname.toLowerCase())
    ? collectorPortRefusal(url, blocked)
    : `${url.host} is not local — only localhost, 127.0.0.1 and [::1] WebSockets can be opened`;
}

/**
 * Chromium flags that back up the request guard below the page: every host
 * name except localhost resolves to nothing (IP literals bypass the resolver,
 * which the route guard covers), and WebRTC can't send UDP outside a proxy.
 */
export const CHROMIUM_ARGS: readonly string[] = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

/** Context options that keep service workers from serving or fetching outside the route guard. */
export const CONTEXT_OPTIONS = { serviceWorkers: "block" } as const;

interface GuardRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface GuardWebSocketRoute {
  url(): string;
  close(): Promise<void> | void;
  connectToServer(): unknown;
}

export interface GuardPage {
  close(): Promise<void>;
}

/** The slice of a Playwright BrowserContext the guard uses. */
export interface GuardContext {
  route(url: string, handler: (route: GuardRoute) => Promise<void> | void): Promise<void>;
  routeWebSocket(url: RegExp, handler: (ws: GuardWebSocketRoute) => Promise<void> | void): Promise<void>;
  on(event: "page", handler: (page: GuardPage) => void): unknown;
}

/**
 * Hold every request made in `context` (any page, popup, redirect,
 * subresource or WebSocket) to the local-only rule, and close every page
 * other than the one `isCapturePage` accepts. `onRefused` hears each refusal.
 */
export async function installNetworkGuard(
  context: GuardContext,
  roots: string[],
  isCapturePage: (page: GuardPage) => boolean,
  onRefused: (url: string, reason: string) => void = () => {}
): Promise<void> {
  const blocked = collectorPortSet();
  await context.route("**/*", (route) => {
    const url = route.request().url();
    const reason = urlRefusal(url, roots, blocked);
    if (!reason) return route.continue();
    onRefused(url, reason);
    return route.abort();
  });
  await context.routeWebSocket(/.*/, (ws) => {
    const reason = webSocketRefusal(ws.url(), blocked);
    if (!reason) {
      ws.connectToServer();
      return;
    }
    onRefused(ws.url(), reason);
    return ws.close();
  });
  context.on("page", (page) => {
    if (!isCapturePage(page)) void page.close();
  });
}

function positiveInt(flag: string, raw: string | undefined, allowZero = false): number {
  if (raw === undefined) throw new Error(`${flag} needs a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`${flag} must be a ${allowZero ? "non-negative" : "positive"} integer, got "${raw}"`);
  return n;
}

/** Parse argv (without the bun/script prefix). Throws an Error with a user-facing message on bad input. */
export function parseArgs(argv: string[]): ScreenshotArgs {
  let url: string | undefined;
  let out: string | undefined;
  let width = 1440;
  let height = 900;
  let fullPage = false;
  let waitFor: string | undefined;
  let waitMs = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        out = argv[++i];
        if (out === undefined) throw new Error("--out needs a value");
        break;
      case "--width":
        width = positiveInt(arg, argv[++i]);
        // UI work is validated on desktop only; phone and tablet widths are refused.
        if (width < MIN_DESKTOP_WIDTH) throw new Error(`--width must be at least ${MIN_DESKTOP_WIDTH} (desktop only), got ${width}`);
        break;
      case "--height":
        height = positiveInt(arg, argv[++i]);
        break;
      case "--full-page":
        fullPage = true;
        break;
      case "--wait-for":
        waitFor = argv[++i];
        if (!waitFor) throw new Error("--wait-for needs a CSS selector");
        break;
      case "--wait-ms":
        waitMs = positiveInt(arg, argv[++i], true);
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        if (url !== undefined) throw new Error(`unexpected extra argument "${arg}"`);
        url = arg;
    }
  }

  if (!url) throw new Error("missing URL");
  if (out !== undefined) {
    if (!isAbsolute(out)) throw new Error(`--out must be an absolute path, got "${out}"`);
    if (!out.toLowerCase().endsWith(".png")) throw new Error(`--out must end in .png, got "${out}"`);
    out = resolve(out);
  }
  return { url, out, width, height, fullPage, waitFor, waitMs };
}

/**
 * The directory `out` is written into, created when missing (0700) and
 * checked: owned by the current user, not group/world-writable, and exactly
 * 0700 when it is the default output directory. Throws with the reason.
 */
export function prepareOutDir(out: string, uid: number = currentUid()): string {
  const dir = dirname(out);
  const isDefault = dir === defaultOutDir(uid);
  const link = userSymlinkOn(dir);
  if (link) throw new Error(`refusing to write the screenshot: ${link} is a symlink`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const reason = unsafeDirReason(dir, uid, isDefault ? 0o700 : undefined);
  if (reason) throw new Error(`refusing to write the screenshot: ${reason}`);
  return dir;
}

/**
 * Why the capture may not be saved at `out`, or null when it may: its
 * directory (prepared, so it exists) must not resolve into the Standup install
 * `root`, and an existing `out` must be a regular file, not a symlink.
 */
export function checkOutPath(out: string, root: string = installRoot()): string | null {
  if (/^\/(?:proc|dev)(?:\/|$)/.test(resolve(out))) return `${out} is under /proc or /dev, which may stand for any other place`;
  // The nearest dir that exists, resolved, plus the parts not made yet: where the output would land.
  let existing = dirname(out);
  const rest: string[] = [];
  let dir: string | null = null;
  for (;;) {
    try {
      dir = join(realpathSync(existing), ...rest);
      break;
    } catch {
      if (dirname(existing) === existing) break;
      rest.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  if (dir === null) return `${dirname(out)} does not exist`;
  if (isUnder(dir, root)) return `${out} is inside the Standup install (${root})`;
  const st = lstatSync(out, { throwIfNoEntry: false });
  if (st && !st.isFile()) return `${out} exists and is not a regular file`;
  return null;
}

/** A fresh name in the directory of `out` to write the capture to before placeOutput moves it into place. */
export function stagingPath(out: string): string {
  const dot = out.lastIndexOf(".");
  const ext = dot > out.lastIndexOf(sep) ? out.slice(dot) : "";
  return join(dirname(out), `.capture-${randomUUID()}${ext}`);
}

/**
 * Moves the written capture `staged` onto `out` with rename(2), which replaces
 * a directory entry rather than following it: a symlink planted at `out` after
 * the checks is replaced, not written through. Refuses (and removes `staged`)
 * when `out` is anything but a regular file or absent.
 */
export function placeOutput(staged: string, out: string): void {
  const st = lstatSync(out, { throwIfNoEntry: false });
  if (st && !st.isFile()) {
    rmSync(staged, { force: true });
    throw new Error(`refusing to write the capture: ${out} exists and is not a regular file`);
  }
  renameSync(staged, out);
}

/** Resolve the playwright entry point inside the install dir, or null when it is not installed. */
export function resolvePlaywright(dir: string): string | null {
  if (!existsSync(join(dir, "package.json"))) return null;
  try {
    return createRequire(join(dir, "package.json")).resolve("playwright");
  } catch {
    return null;
  }
}

function fail(message: string, code = 1): never {
  console.error(`[pipeline-screenshot] ${message}`);
  process.exit(code);
}

/** The Playwright install the helper loads: STANDUP_PLAYWRIGHT_DIR, or defaultPlaywrightDir(). */
export function playwrightDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STANDUP_PLAYWRIGHT_DIR?.trim() || defaultPlaywrightDir(env);
}

/**
 * Why Playwright may not be loaded from `dir`, or null when it may (or when
 * nothing is there yet): a symlink at it or above it (userSymlinkOn), even a
 * dangling one, or an unsafe directory (unsafeDirReason).
 */
export function playwrightDirRefusal(dir: string, uid: number = currentUid()): string | null {
  const link = userSymlinkOn(dir);
  if (link) return `${link} is a symlink`;
  return existsSync(dir) ? unsafeDirReason(dir, uid) : null;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--setup") {
    if (process.argv.length !== 3) fail("--setup takes no other arguments");
    process.exit(runSetup(playwrightDir()));
  }
  if (process.argv[2] === "--record") {
    const { recordMain } = await import("./pipeline-recording");
    return recordMain(process.argv.slice(3));
  }
  let args: ScreenshotArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[pipeline-screenshot] ${(err as Error).message}`);
    console.error(USAGE);
    process.exit(1);
  }

  const roots = screenshotRoots();
  const refusal = urlRefusal(args.url, roots);
  if (refusal) fail(`refusing ${args.url}: ${refusal}`);

  const dir = playwrightDir();
  const unsafe = playwrightDirRefusal(dir);
  if (unsafe) fail(`refusing to load Playwright: ${unsafe}. Use a private directory (mkdir -m 700) owned by you.`);
  const entry = resolvePlaywright(dir);
  if (!entry) {
    console.error(`[pipeline-screenshot] Playwright not found in ${dir}. One-time setup:`);
    console.error(`  ${installHint(dir)}`);
    console.error("(set STANDUP_PLAYWRIGHT_DIR to use a different install)");
    process.exit(2);
  }

  const out = args.out ?? join(defaultOutDir(), `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  // Checked before any dir is made, and again once it exists.
  const early = checkOutPath(out);
  if (early) fail(`refusing to write the screenshot: ${early}`);
  try {
    prepareOutDir(out);
  } catch (err) {
    fail((err as Error).message);
  }
  const outRefusal = checkOutPath(out);
  if (outRefusal) fail(`refusing to write the screenshot: ${outRefusal}`);
  const staged = stagingPath(out);

  const { chromium } = await import(entry);
  const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_ARGS] });
  try {
    const context = await browser.newContext({ ...CONTEXT_OPTIONS, viewport: { width: args.width, height: args.height } });
    let capturePage: GuardPage | null = null;
    await installNetworkGuard(context, roots, (p) => capturePage === null || p === capturePage, (url, reason) =>
      console.error(`[pipeline-screenshot] blocked ${url}: ${reason}`)
    );
    const page = await context.newPage();
    capturePage = page;
    await page.goto(args.url, { waitUntil: "load" });
    if (args.waitFor) await page.waitForSelector(args.waitFor);
    if (args.waitMs > 0) await page.waitForTimeout(args.waitMs);
    await page.screenshot({ path: staged, fullPage: args.fullPage });
    placeOutput(staged, out);
  } finally {
    rmSync(staged, { force: true });
    await browser.close();
  }
  console.log(out);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[pipeline-screenshot] ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
