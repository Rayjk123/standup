/**
 * The recording mode of the screenshot helper: a short desktop screen
 * recording (WebM) of a local page loading, with the load's timing marks
 * burned into the video.
 *
 *   bun scripts/pipeline-screenshot.ts --record <url> [--out <absolute .webm path>]
 *     [--login-url <url>] [--cold] [--preset persona] [--mark "<label>=<css selector>"]...
 *     [--until <css selector>] [--duration-ms N] [--timeout-ms 15000] [--tail-ms 1200]
 *     [--width 1280] [--height 800] [--no-overlay]
 *
 * Every recording is a cold load: the page is recorded in a fresh browser
 * context with no cookies but the login's, no storage, and the HTTP cache
 * off (the network guard's request routing turns it off, and so does CDP).
 * `--cold` is accepted to say so. --login-url is opened first in a separate,
 * unrecorded context; only its cookies are carried into the recorded one.
 *
 * The viewport is desktop-sized (1024–1280 wide, 600–800 tall) and the video
 * is the viewport's size. Marks are measured in the page and reported to
 * the helper as they happen: navigation start, first paint, first contentful
 * paint, and each --mark, reached on the first animation frame its selector
 * matches a rendered element. A later full navigation (a redirect, an auth
 * bounce) adds a "navigation → <path>" mark and keeps the marks already
 * reached. All times are ms since the first document's navigation start.
 *
 * The overlay (top right, in a closed shadow root so page selectors never
 * reach inside it) shows the running clock and every mark. It is drawn only
 * after the page's own first contentful paint, so it never counts as the
 * page's paint; until then the video shows the page as it is.
 *
 * Recording stops --tail-ms after the stop condition: --duration-ms elapsed;
 * else the --until selector matched and every --mark was reached; else every
 * --mark reached; else 5000 ms. Whatever happens it stops at --timeout-ms (at
 * most 30000), keeping the video and exiting 3 when the condition was not
 * met; a page that didn't load (a connection error, an HTTP error status, a
 * browser error page) exits 4. Nothing reached after the stop counts, so the
 * overlay drawn at the stop is never taken for the page's paint. --preset persona adds the Persona console's marks: "composer
 * interactive" and "latest messages rendered".
 *
 * Every page, request and WebSocket is held to the helper's local-only rule.
 * On success it prints a JSON summary: the video path, its size, and the marks.
 */

import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, resolve } from "path";
import { REVIEW_VIDEO_MAX_BYTES } from "../packages/shared/src/review";
import {
  CHROMIUM_ARGS,
  CONTEXT_OPTIONS,
  checkOutPath,
  defaultOutDir,
  installHint,
  installNetworkGuard,
  placeOutput,
  playwrightDir,
  playwrightDirRefusal,
  prepareOutDir,
  resolvePlaywright,
  screenshotRoots,
  stagingPath,
  urlRefusal,
} from "./pipeline-screenshot";
import type { GuardPage } from "./pipeline-screenshot";

export interface RecordingMark {
  label: string;
  selector: string;
}

export interface RecordingArgs {
  url: string;
  /** Absent: a timestamped file in defaultOutDir(). */
  out?: string;
  loginUrl?: string;
  marks: RecordingMark[];
  until?: string;
  durationMs?: number;
  timeoutMs: number;
  tailMs: number;
  width: number;
  height: number;
  overlay: boolean;
}

/** Desktop viewport bounds; the video is recorded at the viewport's size. */
export const RECORDING_LIMITS = {
  minWidth: 1024,
  maxWidth: 1280,
  minHeight: 600,
  maxHeight: 800,
  maxTimeoutMs: 30_000,
  /** Long enough for the stopped overlay to reach the video. */
  minTailMs: 300,
  maxTailMs: 5_000,
} as const;

const DEFAULT_STOP_MS = 5_000;

/** Marks for a cold load of the Persona console. */
export const PERSONA_MARKS: readonly RecordingMark[] = [
  { label: "composer interactive", selector: "[data-testid=persona-composer] textarea:not([disabled])" },
  { label: "latest messages rendered", selector: "[data-message-id]" },
];

const PRESETS: Record<string, readonly RecordingMark[]> = { persona: PERSONA_MARKS };

export const RECORD_USAGE =
  "usage: bun scripts/pipeline-screenshot.ts --record URL [--out ABSOLUTE_WEBM_PATH] [--login-url URL] " +
  "[--cold] [--preset persona] [--mark LABEL=CSS_SELECTOR]... [--until CSS_SELECTOR] [--duration-ms N] " +
  "[--timeout-ms 15000] [--tail-ms 1200] [--width 1280] [--height 800] [--no-overlay]";

function intFlag(flag: string, raw: string | undefined, min: number, max: number): number {
  if (raw === undefined) throw new Error(`${flag} needs a value`);
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer from ${min} to ${max}, got "${raw}"`);
  return n;
}

function parseMark(raw: string | undefined): RecordingMark {
  const at = raw?.indexOf("=") ?? -1;
  const label = at > 0 ? raw!.slice(0, at).trim() : "";
  const selector = at > 0 ? raw!.slice(at + 1).trim() : "";
  if (!label || !selector) throw new Error(`--mark takes LABEL=CSS_SELECTOR, got "${raw ?? ""}"`);
  if (label.length > 60) throw new Error(`--mark label "${label}" is longer than 60 characters`);
  if (label === "navigation start" || label.startsWith("navigation →") || label === "first paint" || label === "first contentful paint") {
    throw new Error(`--mark label "${label}" is a built-in mark`);
  }
  return { label, selector };
}

/** Parse the recording mode's argv (after --record). Throws an Error with a user-facing message on bad input. */
export function parseRecordArgs(argv: string[]): RecordingArgs {
  let url: string | undefined;
  let out: string | undefined;
  let loginUrl: string | undefined;
  const marks: RecordingMark[] = [];
  let until: string | undefined;
  let durationMs: number | undefined;
  let timeoutMs = 15_000;
  let tailMs = 1_200;
  let width: number = RECORDING_LIMITS.maxWidth;
  let height: number = RECORDING_LIMITS.maxHeight;
  let overlay = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        out = argv[++i];
        if (out === undefined) throw new Error("--out needs a value");
        break;
      case "--login-url":
        loginUrl = argv[++i];
        if (!loginUrl) throw new Error("--login-url needs a value");
        break;
      case "--cold":
        // Every recording is a cold load; the flag only says so.
        break;
      case "--preset": {
        const name = argv[++i];
        const preset = name ? PRESETS[name] : undefined;
        if (!preset) throw new Error(`--preset must be one of ${Object.keys(PRESETS).join(", ")}, got "${name ?? ""}"`);
        marks.push(...preset);
        break;
      }
      case "--mark":
        marks.push(parseMark(argv[++i]));
        break;
      case "--until":
        until = argv[++i];
        if (!until) throw new Error("--until needs a CSS selector");
        break;
      case "--duration-ms":
        durationMs = intFlag(arg, argv[++i], 1, RECORDING_LIMITS.maxTimeoutMs);
        break;
      case "--timeout-ms":
        timeoutMs = intFlag(arg, argv[++i], 1_000, RECORDING_LIMITS.maxTimeoutMs);
        break;
      case "--tail-ms":
        tailMs = intFlag(arg, argv[++i], RECORDING_LIMITS.minTailMs, RECORDING_LIMITS.maxTailMs);
        break;
      case "--width":
        width = intFlag(arg, argv[++i], RECORDING_LIMITS.minWidth, RECORDING_LIMITS.maxWidth);
        break;
      case "--height":
        height = intFlag(arg, argv[++i], RECORDING_LIMITS.minHeight, RECORDING_LIMITS.maxHeight);
        break;
      case "--no-overlay":
        overlay = false;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
        if (url !== undefined) throw new Error(`unexpected extra argument "${arg}"`);
        url = arg;
    }
  }

  if (!url) throw new Error("missing URL");
  const seen = new Set<string>();
  for (const m of marks) {
    if (seen.has(m.label)) throw new Error(`mark "${m.label}" is given twice`);
    seen.add(m.label);
  }
  if (durationMs !== undefined && durationMs > timeoutMs) timeoutMs = durationMs;
  if (out !== undefined) {
    if (!isAbsolute(out)) throw new Error(`--out must be an absolute path, got "${out}"`);
    if (!out.toLowerCase().endsWith(".webm")) throw new Error(`--out must end in .webm (Playwright records WebM), got "${out}"`);
    out = resolve(out);
  }
  return { url, out, loginUrl, marks, until, durationMs, timeoutMs, tailMs, width, height, overlay };
}

/** A mark reached: ms since the first document's navigation start. */
export interface ReachedMark {
  label: string;
  ms: number;
}

/** What the recording has seen so far: the marks reached, and whether --until matched. */
export interface RecordingState {
  marks: ReachedMark[];
  untilMet: boolean;
}

/** What a document reports through the binding: a mark (ms since its own timeOrigin) or --until matching. */
export interface PageReport {
  origin: number;
  path: string;
  label?: string;
  ms?: number;
  until?: boolean;
}

/** The binding the overlay script reports through. */
export const REPORT_BINDING = "__standupRecordingReport";

/**
 * The init script run in every top-level document of the recorded context.
 * It reports navigation start, the paint entries and each selector mark (ms
 * since this document's timeOrigin) through REPORT_BINDING as they happen,
 * and, when `overlay` is set, draws the clock and the marks in a closed
 * shadow root once the page has painted content of its own. The helper
 * hands a later document the marks earlier ones reached with `carry`.
 */
export function overlayScript(opts: { marks: RecordingMark[]; until?: string; overlay: boolean; title: string }): string {
  const cfg = JSON.stringify({ marks: opts.marks, until: opts.until ?? null, overlay: opts.overlay, title: opts.title, binding: REPORT_BINDING });
  return `(() => {
  if (window.top !== window || window.__standupRecording) return;
  const cfg = ${cfg};
  const origin = performance.timeOrigin;
  const path = location.pathname;
  const report = (payload) => {
    try {
      const fn = window[cfg.binding];
      if (typeof fn === "function") fn(Object.assign({ origin, path }, payload)).catch(() => {});
    } catch {}
  };
  // offset: this document's start, in ms after the first document's.
  const state = { marks: [], carried: [], offset: 0, untilMet: false, stoppedAt: null, painted: false };
  Object.defineProperty(window, "__standupRecording", { value: state });
  let host = null, clock = null, list = null;
  const fmt = (ms) => String(Math.round(ms)).padStart(5, " ") + " ms";
  const shown = () => {
    const all = state.carried.slice();
    for (const m of state.marks) {
      // A later document's own navigation start arrives among the carried marks, labelled by the helper.
      if (m.label === "navigation start" && state.offset > 0) continue;
      if (!all.some((c) => c.label === m.label)) all.push({ label: m.label, ms: m.ms + state.offset });
    }
    return all.sort((a, b) => a.ms - b.ms);
  };
  const render = () => {
    if (!list) return;
    list.textContent = "";
    for (const m of shown()) {
      const row = document.createElement("div");
      row.textContent = fmt(m.ms) + "  " + m.label;
      list.appendChild(row);
    }
    const waiting = pending.filter((p) => !state.carried.some((c) => c.label === p.label)).map((p) => p.label);
    if (cfg.until && !state.untilMet) waiting.push("until");
    if (waiting.length > 0) {
      const row = document.createElement("div");
      row.className = "wait";
      row.textContent = "        waiting: " + waiting.join(", ");
      list.appendChild(row);
    }
  };
  const record = (label, ms) => {
    // Nothing reached after the stop counts: the overlay drawn at the stop
    // must never be taken for the page's own paint.
    if (state.stoppedAt !== null && ms >= state.stoppedAt) return;
    if (state.marks.some((m) => m.label === label)) return;
    const at = Math.max(0, Math.round(ms));
    state.marks.push({ label, ms: at });
    report({ label, ms: at });
    render();
  };
  const pending = cfg.marks.slice();
  record("navigation start", 0);
  try {
    new PerformanceObserver((entries) => {
      for (const e of entries.getEntries()) {
        if (state.stoppedAt !== null && e.startTime >= state.stoppedAt) continue;
        if (e.name === "first-contentful-paint") state.painted = true;
        record(e.name === "first-paint" ? "first paint" : "first contentful paint", e.startTime);
      }
    }).observe({ type: "paint", buffered: true });
  } catch {}
  const rendered = (sel) => {
    try {
      const el = document.querySelector(sel);
      return !!el && el.getClientRects().length > 0;
    } catch {
      return false;
    }
  };
  const HOST_STYLE = "all:initial !important;display:block !important;position:fixed !important;top:8px !important;" +
    "right:8px !important;left:auto !important;bottom:auto !important;z-index:2147483647 !important;" +
    "pointer-events:none !important;opacity:1 !important;visibility:visible !important;transform:none !important";
  const mount = () => {
    // Drawn only once the page has painted content of its own (or the
    // recording stopped), so the overlay's text is never the page's FCP.
    if (!cfg.overlay || host || !document.documentElement) return;
    if (!state.painted && state.stoppedAt === null) return;
    host = document.createElement("standup-recording-overlay");
    host.setAttribute("style", HOST_STYLE);
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ".box{background:rgba(8,10,14,.82);color:#e8edf3;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;" +
      "padding:7px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.18);white-space:pre;min-width:220px}" +
      ".title{color:#ff6b6b;font-weight:600}.clock{font-size:15px;font-weight:600;margin:2px 0 4px}.wait{color:#9aa4b2}";
    const box = document.createElement("div");
    box.className = "box";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "\\u25CF REC  " + cfg.title;
    clock = document.createElement("div");
    clock.className = "clock";
    list = document.createElement("div");
    box.append(title, clock, list);
    root.append(style, box);
    document.documentElement.appendChild(host);
    render();
  };
  const frame = () => {
    const now = performance.now();
    for (let i = 0; i < pending.length; ) {
      if (rendered(pending[i].selector)) {
        const [m] = pending.splice(i, 1);
        record(m.label, now);
      } else i++;
    }
    if (cfg.until && !state.untilMet && rendered(cfg.until)) {
      state.untilMet = true;
      report({ until: true });
      render();
    }
    mount();
    if (host && !host.isConnected && document.documentElement) document.documentElement.appendChild(host);
    if (clock) {
      const t = (state.stoppedAt ?? now) + state.offset;
      clock.textContent = "t = " + fmt(t).trim() + (state.stoppedAt !== null ? "  (stopped)" : "");
    }
    requestAnimationFrame(frame);
  };
  state.carry = (offset, carried) => {
    state.offset = offset;
    state.carried = carried;
    render();
  };
  // Returns the stop time as an epoch ms (timeOrigin + stoppedAt) for the helper's timeline.
  state.stop = () => {
    if (state.stoppedAt === null) state.stoppedAt = performance.now();
    mount();
    return origin + state.stoppedAt;
  };
  requestAnimationFrame(frame);
})();`;
}

/** Whether the recording may stop: the duration elapsed, or --until matched and every mark was reached. */
export function stopConditionMet(args: Pick<RecordingArgs, "durationMs" | "until" | "marks">, state: RecordingState, elapsedMs: number): boolean {
  if (args.durationMs !== undefined) return elapsedMs >= args.durationMs;
  const allMarks = args.marks.every((m) => state.marks.some((r) => r.label === m.label));
  if (args.until) return state.untilMet && allMarks;
  if (args.marks.length > 0) return allMarks;
  return elapsedMs >= DEFAULT_STOP_MS;
}

/** The labels of --marks (and "until") the recording never reached. */
export function unreachedMarks(args: Pick<RecordingArgs, "until" | "marks">, state: RecordingState): string[] {
  const missing = args.marks.filter((m) => !state.marks.some((r) => r.label === m.label)).map((m) => m.label);
  if (args.until && !state.untilMet) missing.push(`until ${args.until}`);
  return missing;
}

/**
 * Collects the reports of every document the recording loads into one
 * timeline, measured from the first document's navigation start: the first
 * time a label is reached wins, and each later document's navigation start
 * becomes "navigation → <path>".
 */
export class MarkTimeline {
  private base: number | null = null;
  private readonly origins: number[] = [];
  private readonly reached = new Map<string, number>();
  private untilMet = false;
  private stoppedAt: number | null = null;

  /** Most documents and labels one recording keeps; reports past them are dropped. */
  static readonly MAX_DOCUMENTS = 32;
  static readonly MAX_LABELS = 64;

  /**
   * Records `report`; returns true when it comes from a document not seen
   * before. The first document seen is the start of the timeline: a report
   * from an earlier origin, or of anything reached after stop(), is dropped.
   */
  add(report: unknown): boolean {
    if (!report || typeof report !== "object") return false;
    const r = report as Partial<PageReport>;
    if (typeof r.origin !== "number" || !Number.isFinite(r.origin) || typeof r.path !== "string") return false;
    if (this.base !== null && r.origin < this.base) return false;
    const fresh = !this.origins.includes(r.origin);
    if (fresh) {
      if (this.origins.length >= MarkTimeline.MAX_DOCUMENTS) return false;
      this.origins.push(r.origin);
      if (this.base === null) this.base = r.origin;
    }
    if (r.until === true && this.stoppedAt === null) this.untilMet = true;
    if (typeof r.label === "string" && typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0) {
      const at = r.origin + r.ms;
      if (this.stoppedAt !== null && at >= this.stoppedAt) return fresh;
      const label = (r.label === "navigation start" ? this.navigationLabel(r.origin, r.path) : r.label).slice(0, 120);
      const prior = this.reached.get(label);
      if (prior === undefined && this.reached.size >= MarkTimeline.MAX_LABELS) return fresh;
      if (prior === undefined || at < prior) this.reached.set(label, at);
    }
    return fresh;
  }

  /** Stops the timeline at `epochMs`: nothing reached at or after it is recorded. */
  stop(epochMs: number): void {
    if (this.stoppedAt === null) this.stoppedAt = epochMs;
  }

  /** "navigation start" for the first document; "navigation → <path>" for later ones, numbered when a path repeats. */
  private navigationLabel(origin: number, path: string): string {
    const index = [...this.origins].sort((a, b) => a - b).indexOf(origin);
    if (index <= 0) return "navigation start";
    const label = `navigation → ${path.slice(0, 80)}`;
    return this.reached.has(label) ? `${label} (${index + 1})` : label;
  }

  /** ms from the first document's start to `origin`. */
  offsetOf(origin: number): number {
    return this.base === null ? 0 : Math.max(0, Math.round(origin - this.base));
  }

  state(): RecordingState {
    const base = this.base ?? 0;
    const marks = [...this.reached.entries()]
      .map(([label, at]) => ({ label, ms: Math.max(0, Math.round(at - base)) }))
      .sort((a, b) => a.ms - b.ms);
    return { marks, untilMet: this.untilMet };
  }
}

/** A response the recorded page received: its status, and whether it was the main frame's document. */
export interface DocumentResponse {
  status: number;
  navigation: boolean;
  mainFrame: boolean;
}

/**
 * Why `response` means the page didn't load, or null: an HTTP error status
 * on a main-frame document, whether it answered the first navigation or a
 * later one (a JS or meta-refresh redirect).
 */
export function navigationError(response: DocumentResponse): string | null {
  return response.navigation && response.mainFrame && response.status >= 400 ? `HTTP ${response.status}` : null;
}

const TIMED_OUT = Symbol("timed out");

/** `promise`, or TIMED_OUT once `ms` pass first. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((r) => (timer = setTimeout(() => r(TIMED_OUT), Math.max(0, ms))));
  const settled: Promise<T | typeof TIMED_OUT> = promise.catch(() => TIMED_OUT);
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}

function fail(message: string, code = 1): never {
  console.error(`[pipeline-recording] ${message}`);
  process.exit(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the recording mode with its argv (after --record). */
export async function recordMain(argv: string[]): Promise<void> {
  let args: RecordingArgs;
  try {
    args = parseRecordArgs(argv);
  } catch (err) {
    console.error(`[pipeline-recording] ${(err as Error).message}`);
    console.error(RECORD_USAGE);
    process.exit(1);
  }

  const roots = screenshotRoots();
  for (const url of [args.url, ...(args.loginUrl ? [args.loginUrl] : [])]) {
    const refusal = urlRefusal(url, roots);
    if (refusal) fail(`refusing ${url}: ${refusal}`);
  }

  const dir = playwrightDir();
  const unsafe = playwrightDirRefusal(dir);
  if (unsafe) fail(`refusing to load Playwright: ${unsafe}`);
  const entry = resolvePlaywright(dir);
  if (!entry) {
    console.error(`[pipeline-recording] Playwright not found in ${dir}. One-time setup:`);
    console.error(`  ${installHint(dir)}`);
    process.exit(2);
  }

  const out = args.out ?? join(defaultOutDir(), `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`);
  // Checked before any dir is made, and again once it exists.
  const early = checkOutPath(out);
  if (early) fail(early);
  try {
    prepareOutDir(out);
  } catch (err) {
    fail((err as Error).message);
  }
  const outRefusal = checkOutPath(out);
  if (outRefusal) fail(outRefusal);

  // Playwright writes the raw video into a private temp dir, and the finished
  // file is staged beside `out`; both are removed however the run ends, an
  // interrupt included.
  const rawDir = mkdtempSync(join(tmpdir(), "standup-recording-"));
  const staged = stagingPath(out);
  const cleanup = () => {
    rmSync(rawDir, { recursive: true, force: true });
    rmSync(staged, { force: true });
  };
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const timeline = new MarkTimeline();
  let met = false;
  /** Why the page didn't load, when it didn't: the video then shows an error, not the page. */
  let loadError: string | null = null;
  // Every wait, the login included, is bounded by --timeout-ms: a page that
  // never answers or never yields its main thread still ends the run on time.
  const started = Date.now();
  const left = () => Math.max(0, args.timeoutMs - (Date.now() - started));
  try {
    const { chromium } = await import(entry);
    const browser = await chromium.launch({ headless: true, args: [...CHROMIUM_ARGS] });
    let disconnected = false;
    browser.on("disconnected", () => (disconnected = true));
    const viewport = { width: args.width, height: args.height };
    const blocked = (url: string, reason: string) => console.error(`[pipeline-recording] blocked ${url}: ${reason}`);
    try {
      let cookies: unknown[] = [];
      if (args.loginUrl) {
        const login = await browser.newContext({ ...CONTEXT_OPTIONS, viewport });
        let loginPage: GuardPage | null = null;
        await installNetworkGuard(login, roots, (p) => loginPage === null || p === loginPage, blocked);
        const page = await login.newPage();
        loginPage = page;
        await page.goto(args.loginUrl, { waitUntil: "load", timeout: Math.max(1, left()) });
        cookies = await login.cookies();
        await login.close();
      }

      const context = await browser.newContext({
        ...CONTEXT_OPTIONS,
        viewport,
        deviceScaleFactor: 1,
        recordVideo: { dir: rawDir, size: viewport },
      });
      if (cookies.length > 0) await context.addCookies(cookies);
      let capturePage: GuardPage | null = null;
      await installNetworkGuard(context, roots, (p) => capturePage === null || p === capturePage, blocked);
      type Page = { evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>; mainFrame: () => unknown };
      let recorded: Page | null = null;
      await context.exposeBinding(REPORT_BINDING, (source: { page?: unknown; frame?: unknown }, report: unknown) => {
        // Only the recorded page's top-level documents report; an iframe or popup can't move the timeline.
        if (!recorded || source.page !== capturePage || source.frame !== recorded.mainFrame()) return;
        if (!timeline.add(report)) return;
        // A later document is handed what the earlier ones reached, so its overlay shows the whole timeline.
        const origin = (report as PageReport).origin;
        const offset = timeline.offsetOf(origin);
        if (offset === 0) return;
        const carried = timeline.state().marks;
        void within(
          recorded.evaluate(
            (a: { offset: number; carried: ReachedMark[] }) =>
              (globalThis as unknown as { __standupRecording?: { carry?: (o: number, c: ReachedMark[]) => void } }).__standupRecording?.carry?.(a.offset, a.carried),
            { offset, carried }
          ),
          1_000
        );
      });
      await context.addInitScript({
        content: overlayScript({ marks: args.marks, until: args.until, overlay: args.overlay, title: "cold load" }),
      });
      const page = await context.newPage();
      capturePage = page;
      recorded = page;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

      type Response = { status(): number; request(): { isNavigationRequest(): boolean }; frame(): unknown };
      // Every main-frame document is checked, so a page that loads and then
      // navigates to an error page fails as surely as one that errors at once.
      page.on("response", (response: Response) => {
        let mainFrame = false;
        try {
          mainFrame = response.frame() === page.mainFrame();
        } catch {
          // A response whose frame is already gone is no main-frame document.
        }
        const why = navigationError({ status: response.status(), navigation: response.request().isNavigationRequest(), mainFrame });
        if (why && !loadError) loadError = why;
      });
      const navStarted = Date.now();
      const navigated = page
        .goto(args.url, { waitUntil: "commit", timeout: Math.max(1, left()) })
        .then((response: { status(): number } | null) => {
          const status = response?.status() ?? 0;
          if (status >= 400 && !loadError) loadError = `HTTP ${status}`;
        })
        .catch((err: Error) => {
          // A timeout is the page being slow, which the recording shows; anything else means it never loaded.
          if (err.name !== "TimeoutError") loadError = err.message.split("\n")[0]!;
        });
      await within(navigated, left());
      while (left() > 0 && !disconnected && !loadError) {
        if (stopConditionMet(args, timeline.state(), Date.now() - navStarted)) {
          met = true;
          break;
        }
        await sleep(Math.min(50, left()));
      }
      if (disconnected) throw new Error("the browser closed before the recording finished");
      // The page's own stop time ends the timeline, so the JSON and the
      // overlay agree on what was reached; the helper's clock is the fallback.
      const pageStop = await within(
        page.evaluate(() => (globalThis as unknown as { __standupRecording?: { stop?: () => number } }).__standupRecording?.stop?.()),
        500
      );
      timeline.stop(typeof pageStop === "number" && Number.isFinite(pageStop) ? pageStop : Date.now());
      await sleep(args.tailMs);
      const finalUrl = String((page as unknown as { url(): string }).url());
      if (!loadError && finalUrl.startsWith("chrome-error://")) loadError = "the page ended on a browser error page";
      if (disconnected) throw new Error("the browser closed before the recording finished");
      const video = page.video();
      await context.close();
      if (!video) throw new Error("Playwright produced no video");
      await video.saveAs(staged);
    } finally {
      await browser.close();
    }
    // The finished file replaces `out` by rename, which never follows a symlink at `out`.
    placeOutput(staged, out);
  } finally {
    cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  const bytes = statSync(out).size;
  const state = timeline.state();
  const missing = unreachedMarks(args, state);
  console.log(JSON.stringify({ out, bytes, viewport: { width: args.width, height: args.height }, marks: state.marks, ...(missing.length ? { unreached: missing } : {}) }, null, 2));
  if (bytes > REVIEW_VIDEO_MAX_BYTES) {
    console.error(`[pipeline-recording] ${out} is ${bytes} bytes, over the ${REVIEW_VIDEO_MAX_BYTES}-byte review video limit; record a shorter span`);
    process.exit(1);
  }
  if (loadError) {
    console.error(`[pipeline-recording] ${args.url} did not load (${loadError}); the video shows that, not the page`);
    process.exit(4);
  }
  if (!met) {
    console.error(`[pipeline-recording] stopped at --timeout-ms ${args.timeoutMs} before the stop condition held${missing.length ? ` (not reached: ${missing.join(", ")})` : ""}; the video was kept`);
    process.exit(3);
  }
}
