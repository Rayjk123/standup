#!/usr/bin/env bun
/*
 * MANUAL, OWNER-RUN live check — not part of any automated suite; the owner
 * runs it by hand. Guardrails: the scratch collector gets an environment built
 * from scratch (no TMUX/TMUX_PANE, Slack, ntfy, Persona/worker credentials,
 * bind host or STANDUP_FFMPEG); HOME, DB_PATH, TMUX_TMPDIR, the owner token,
 * knowledge, icons, projects, internal and worktree roots all live in the run
 * dir; the live install's ports (7777, 7778, 5173, 5199, 7787–7858) are
 * refused; every tmux call goes to a private server on <run dir>/tmux.sock via
 * a PATH shim, and teardown kills only that server; the browser reaches only
 * the scratch console. The run installs no ffmpeg; one already on PATH is
 * left alone and reported, and videos then take the frames path.
 *
 * Live check of the owner sending images to Persona, on a throwaway install:
 * a scratch collector with its own data dir, owner token, project, tmux server
 * and ports; the console's dev server proxied to it; and headless Chromium
 * (1440×900) signed in with a login code minted from the scratch token. Every
 * `claude` the collector runs is fake-claude.ts, which records each Persona
 * turn (argv, exact stdin, a summary of its content blocks) under the run's
 * turns/ directory and replies with the image blocks it was shown.
 *
 *   bun packages/web/e2e/owner-media.live.ts --out <dir> [--keep]
 *     [--playwright /path/to/node_modules/playwright] [--api-port N --ws-port N --web-port N]
 *
 * Playwright comes from --playwright, else $STANDUP_PLAYWRIGHT, else
 * /tmp/standup-pw/node_modules/playwright. Ports are picked free at run time
 * unless given; the live install's ports are refused. Everything the run
 * writes lives in /tmp/standup-owner-media-<run>, removed at the end (kept
 * with --keep). Fixtures are made by the run itself: a PNG scene rendered and
 * screenshotted by Playwright, the same bytes named as an MP4, and an 11 MiB
 * "PNG" of zeros.
 *
 * The flow, in the Persona view's console thread:
 *   1  attach the scene with the picker, preview in the tray   -> owner-media-1-composer-image-preview.png
 *   2  send it with text; the sent image loads, Persona replies -> owner-media-2-sent-image-and-reply.png
 *   3  attach the mismatched MP4 and the oversize PNG together  -> owner-media-3-rejections.png
 *   4  paste an image into the textarea, then drop one on the composer
 * Then the captured turns, the stored attachment (whole and a byte range) and
 * the upload API's answers for the two refused files are written to
 * <out>/owner-media-summary.json, with the image turn's exact stdin in
 * <out>/turn-image.stdin.jsonl. The exit code is non-zero on any failure.
 */
import { createHash, createHmac, randomBytes } from "crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Subprocess } from "bun";
import type { Browser, Page } from "playwright";

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const SCRATCH = `/tmp/standup-owner-media-${RUN}`;
const OUT = resolve(opt("out") ?? `/tmp/standup-owner-media-out-${RUN}`);
const KEEP = process.argv.includes("--keep");
const PLAYWRIGHT = opt("playwright") ?? process.env.STANDUP_PLAYWRIGHT ?? "/tmp/standup-pw/node_modules/playwright";
const WEB_DIR = resolve(import.meta.dir, "..");
const COLLECTOR_DIR = resolve(WEB_DIR, "../collector");
const BUN = process.execPath;

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
// caller's Persona and worker credentials, its tmux server, an ffmpeg override,
// and a bind host that would take the scratch collector off loopback.
const DROPPED_ENV = new Set([
  "STANDUP_PERSONA",
  "STANDUP_WORKER_TOKEN_FILE",
  "STANDUP_PERSONAL_AWS_ACCOUNTS",
  "STANDUP_FFMPEG",
  "TMUX",
  "TMUX_PANE",
  "STANDUP_BIND_HOST",
]);
const droppedEnvKey = (k: string) => DROPPED_ENV.has(k) || k.startsWith("SLACK_") || k.startsWith("NTFY_");
// The only settings a child of this run takes from the caller's environment;
// everything else a child sees is set below, pointing into the run dir.
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
const ORIGIN = `http://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

if (existsSync(SCRATCH)) throw new Error(`${SCRATCH} already exists`);
mkdirSync(SCRATCH, { mode: 0o700 });
for (const d of ["data/secrets", "knowledge", "icons", "internal", "bin", "home", "tmux", "worktrees", "repo", "turns", "media"]) {
  mkdirSync(join(SCRATCH, d), { recursive: true, mode: 0o700 });
}
mkdirSync(OUT, { recursive: true });
console.log(`run ${RUN}: scratch ${SCRATCH}, out ${OUT}`);
console.log(`ports: collector ${API_PORT}, ws ${WS_PORT}, console ${WEB_PORT}`);

const TOKEN_FILE = join(SCRATCH, "data/secrets/owner.token");
writeFileSync(TOKEN_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
const token = readFileSync(TOKEN_FILE, "utf8").trim();
const TURNS = join(SCRATCH, "turns");
const MEDIA = join(SCRATCH, "media");

const SCRATCH_BIN = join(SCRATCH, "bin");
const claudeShim = join(SCRATCH_BIN, "claude");
writeFileSync(claudeShim, `#!/bin/sh\nexec ${BUN} ${join(import.meta.dir, "fake-claude.ts")} "$@"\n`);
chmodSync(claudeShim, 0o755);

// Every tmux call of this run, the scratch collector's included, goes to a
// private server on this socket: the collector runs plain `tmux`, which the
// shim first on its PATH pins to the socket.
const TMUX_SOCK = join(SCRATCH, "tmux.sock");
const whichTmux = Bun.which("tmux");
if (!whichTmux) throw new Error("tmux is not on PATH");
const REAL_TMUX = realpathSync(whichTmux);
if (REAL_TMUX === SCRATCH || REAL_TMUX.startsWith(`${SCRATCH}/`)) throw new Error(`tmux resolves into the run dir (${REAL_TMUX})`);
const tmuxShim = join(SCRATCH_BIN, "tmux");
writeFileSync(tmuxShim, `#!/bin/sh\nexec ${REAL_TMUX} -S ${TMUX_SOCK} "$@"\n`);
chmodSync(tmuxShim, 0o755);

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
  STANDUP_PERSONA_COALESCE_S: "1",
  STANDUP_WEB_URL: `${ORIGIN}/`,
  STANDUP_FAKE_CLAUDE_CAPTURE: TURNS,
};

// Pre-flight: no tmux call of this run can reach the default socket, no
// process of this run carries a dropped setting, and no ffmpeg is reachable.
{
  const inRun = (p: string) => resolve(p).startsWith(`${SCRATCH}/`);
  if (!inRun(TMUX_SOCK)) throw new Error(`the tmux socket ${TMUX_SOCK} is outside the run dir`);
  if (!inRun(scratchEnv.TMUX_TMPDIR!)) throw new Error(`TMUX_TMPDIR ${scratchEnv.TMUX_TMPDIR} is outside the run dir`);
  const entries = scratchEnv.PATH!.split(":");
  const firstTmux = entries.findIndex((dir) => dir && existsSync(join(dir, "tmux")));
  if (entries[firstTmux] !== SCRATCH_BIN) throw new Error(`${SCRATCH_BIN} is not ahead of every PATH entry holding tmux`);
  const resolved = Bun.spawnSync(["sh", "-c", "command -v tmux"], { env: scratchEnv }).stdout.toString().trim();
  if (resolved !== tmuxShim) throw new Error(`tmux on the scratch PATH resolves to ${resolved || "nothing"}, not the shim`);
  for (const [name, env] of [["scratch children", scratchEnv], ["this process (vite)", process.env]] as const) {
    const leaked = Object.keys(env).filter(droppedEnvKey);
    if (leaked.length) throw new Error(`${name} env still carries ${leaked.join(", ")}`);
  }
  for (const k of ["HOME", "TMUX_TMPDIR", "DB_PATH", "STANDUP_OWNER_TOKEN_FILE", "KNOWLEDGE_DIR", "ICONS_DIR", "STANDUP_PROJECTS_PATH", "STANDUP_INTERNAL_ROOT", "STANDUP_WORKTREE_ROOT", "STANDUP_FAKE_CLAUDE_CAPTURE"]) {
    if (!inRun(scratchEnv[k]!)) throw new Error(`${k} ${scratchEnv[k]} is outside the run dir`);
  }
  const ffmpeg = Bun.which("ffmpeg", { PATH: scratchEnv.PATH! });
  if (ffmpeg) console.log(`  note: ffmpeg found at ${ffmpeg}; video would take the frames path`);
}

/** The real tmux, on this run's private socket only. */
function privateTmux(...args: string[]) {
  return Bun.spawnSync([REAL_TMUX, "-S", TMUX_SOCK, ...args], { env: scratchEnv });
}

function git(...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], {
    cwd: join(SCRATCH, "repo"),
    env: scratchEnv,
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}
git("init", "-q", "-b", "main");
writeFileSync(join(SCRATCH, "repo/README.md"), "scratch repo for the owner media check\n");
git("add", "README.md");
git("commit", "-q", "-m", "initial");

const PROJECT = "e2e";
writeFileSync(
  join(SCRATCH, "projects.toml"),
  [
    "[[project]]",
    `id = "${PROJECT}"`,
    `name = "${PROJECT}"`,
    `repos = ["${join(SCRATCH, "repo")}"]`,
    `branch = "main"`,
    `worktreeRoot = "${join(SCRATCH, "worktrees")}"`,
    "bypassPermissions = false",
    "",
  ].join("\n")
);

// ── Scratch collector ───────────────────────────────────────────────────────

let collector: Subprocess | undefined;
function startCollector(): void {
  collector = Bun.spawn([BUN, "run", "src/index.ts"], {
    cwd: COLLECTOR_DIR,
    env: scratchEnv,
    stdout: Bun.file(join(SCRATCH, `collector-${Date.now()}.log`)),
    stderr: Bun.file(join(SCRATCH, `collector-${Date.now()}.err.log`)),
  });
  console.log(`  collector pid ${collector.pid}`);
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
  if (collector && collector.exitCode === null && collector.signalCode === null) {
    collector.kill("SIGTERM");
    await collector.exited;
  }
}

// ── Collector API ──────────────────────────────────────────────────────────

type Json = Record<string, any>;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-standup-owner-token": token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

// ── Results ────────────────────────────────────────────────────────────────

const checks: { check: string; ok: boolean; detail?: string }[] = [];
function record(check: string, ok: boolean, detail?: string): void {
  checks.push({ check, ok, ...(detail ? { detail } : {}) });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${check}${detail ? `: ${detail}` : ""}`);
}
async function step(check: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn();
    record(check, true, detail || undefined);
    return true;
  } catch (err) {
    record(check, false, String(err instanceof Error ? err.message : err).split("\n")[0]);
    return false;
  }
}
const summary: Json = { run: RUN, ports: { api: API_PORT, ws: WS_PORT, web: WEB_PORT }, screenshots: {} };

let browser: Browser | undefined;
let vite: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  await browser?.close().catch(() => {});
  await stopCollector().catch(() => {});
  await vite?.close().catch(() => {});
  privateTmux("kill-server");
  try {
    mkdirSync(join(OUT, "owner-media-logs"), { recursive: true });
    for (const f of readdirSync(SCRATCH)) if (f.startsWith("collector-")) cpSync(join(SCRATCH, f), join(OUT, "owner-media-logs", f));
  } catch {
    // The logs are a convenience; the summary is already written.
  }
  if (!KEEP && !OUT.startsWith(`${SCRATCH}/`)) rmSync(SCRATCH, { recursive: true, force: true });
  else console.log(`kept ${SCRATCH}`);
};
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(code)));
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const SCENE_HTML = `<!doctype html><html><body style="margin:0;width:1200px;height:750px;background:#f4f1ea;font-family:sans-serif">
<h1 style="margin:0;padding:28px 40px;font-size:44px;color:#222">Standup owner upload test</h1>
<svg width="1200" height="620" xmlns="http://www.w3.org/2000/svg">
  <circle cx="250" cy="300" r="180" fill="#d62828"/>
  <rect x="500" y="140" width="300" height="300" fill="#1d4ed8"/>
  <polygon points="1000,120 1160,460 840,460" fill="#facc15" stroke="#a16207" stroke-width="4"/>
</svg></body></html>`;

let fatal: unknown;
try {
  startCollector();
  await waitForHttp();

  Object.assign(process.env, {
    STANDUP_OWNER_TOKEN_FILE: TOKEN_FILE,
    SCRATCH_API_PORT: String(API_PORT),
    SCRATCH_WS_PORT: String(WS_PORT),
    SCRATCH_WEB_PORT: String(WEB_PORT),
  });
  const { createServer } = await import(join(WEB_DIR, "node_modules/vite/dist/node/index.js"));
  // No HMR or file watching: an edit elsewhere in the tree must not reload the page mid-run.
  vite = await createServer({
    configFile: join(import.meta.dir, "vite.scratch.config.ts"),
    logLevel: "warn",
    server: { hmr: false, watch: null },
  });
  await vite!.listen();

  const { chromium } = (await import(PLAYWRIGHT)) as typeof import("playwright");
  browser = await chromium.launch({ env: scratchEnv });

  // The scene, rendered offline and screenshotted at 1200×750.
  const scenePath = join(MEDIA, "test-scene.png");
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 750 } });
    await ctx.route("**/*", (route) => route.abort());
    const p = await ctx.newPage();
    await p.setContent(SCENE_HTML);
    await p.screenshot({ path: scenePath });
    await ctx.close();
  }
  const sceneBytes = readFileSync(scenePath);
  const sceneSha = createHash("sha256").update(sceneBytes).digest("hex");
  const mismatchedPath = join(MEDIA, "clip-really-a-png.mp4");
  writeFileSync(mismatchedPath, sceneBytes);
  const hugePath = join(MEDIA, "huge.png");
  {
    const huge = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge, 0);
    writeFileSync(hugePath, huge);
  }
  summary.fixtures = {
    scene: { path: scenePath, bytes: sceneBytes.length, sha256: sceneSha, width: sceneBytes.readUInt32BE(16), height: sceneBytes.readUInt32BE(20) },
    mismatched: { path: mismatchedPath, bytes: sceneBytes.length, sentAs: "video/mp4" },
    huge: { path: hugePath, bytes: 11 * 1024 * 1024 },
  };

  // ── The console ──
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route("**/*", (route) => {
    const host = new URL(route.request().url()).host;
    const url = route.request().url();
    return host === `localhost:${WEB_PORT}` || url.startsWith("blob:") || url.startsWith("data:") ? route.continue() : route.abort();
  });
  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const code = `${expiry}.${createHmac("sha256", token).update(`login:${expiry}`).digest("hex")}`;
  const login = await context.newPage();
  await login.goto(`${ORIGIN}/__standup/login?code=${code}`);
  await login.close();

  const page: Page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  PAGE ERROR: ${err.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  console error: ${m.text().slice(0, 200)}`);
  });
  await page.goto(`${ORIGIN}/persona`);
  const composer = page.locator('[data-testid="persona-composer"]');
  await composer.waitFor({ timeout: 30000 });
  const textarea = composer.locator("textarea");
  const input = page.locator('[data-testid="persona-attach-input"]');
  const sendButton = composer.getByRole("button", { name: "Send", exact: true });
  const trayItems = page.locator('[data-testid="persona-upload"]');
  const shot = async (name: string) => {
    const path = join(OUT, name);
    await page.screenshot({ path });
    summary.screenshots[name] = path;
  };
  const removeAll = async () => {
    for (let i = 0; i < 10 && (await trayItems.count()) > 0; i++) {
      await trayItems.first().locator('button[aria-label^="Remove "]').click();
      await Bun.sleep(150);
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="persona-upload"]').length === 0, null, { timeout: 10000 });
  };
  const sendWith = async (text: string) => {
    await textarea.fill(text);
    const sent = page.waitForResponse((r) => r.url().endsWith("/api/persona/messages") && r.request().method() === "POST", { timeout: 30000 });
    await sendButton.click();
    const res = await sent;
    const json = (await res.json()) as Json;
    if (res.status() >= 300) throw new Error(`send -> ${res.status()} ${JSON.stringify(json).slice(0, 200)}`);
    return json.message as Json;
  };

  // 1. Image through the picker.
  let imageAttachmentId = "";
  let imageMessageId = "";
  await step("image upload reaches ready with a preview", async () => {
    const uploaded = page.waitForResponse((r) => r.url().endsWith("/api/persona/uploads") && r.request().method() === "POST", { timeout: 30000 });
    await input.setInputFiles(scenePath);
    const res = await uploaded;
    const json = (await res.json()) as Json;
    summary.imageUploadResponse = { status: res.status(), attachment: json.attachment };
    imageAttachmentId = json.attachment?.id ?? "";
    if (res.status() !== 201 || !imageAttachmentId) throw new Error(`upload -> ${res.status()} ${JSON.stringify(json).slice(0, 200)}`);
    await page.locator('[data-testid="persona-upload"][data-status="ready"]').first().waitFor({ timeout: 30000 });
    await page.waitForFunction(
      () => {
        const img = document.querySelector('[data-testid="persona-upload"][data-status="ready"] img') as HTMLImageElement | null;
        return !!img && img.complete && img.naturalWidth > 0;
      },
      null,
      { timeout: 10000 }
    );
    await textarea.fill("What's in this picture? MEDIA-1");
    await shot("owner-media-1-composer-image-preview.png");
    return `attachment ${imageAttachmentId}`;
  });
  await step("image sent: the stored image loads inline and Persona replies", async () => {
    const message = await sendWith("What's in this picture? MEDIA-1");
    imageMessageId = message.id;
    summary.imageMessage = { id: message.id, attachments: message.attachments };
    await page.waitForFunction(
      ([mid, aid]) => {
        const img = document.querySelector(`[data-message-id="${mid}"] [data-attachment-id="${aid}"] img`) as HTMLImageElement | null;
        return !!img && img.complete && img.naturalWidth > 0 && !img.src.startsWith("blob:");
      },
      [imageMessageId, imageAttachmentId] as const,
      { timeout: 30000 }
    );
    const src = await page.locator(`[data-message-id="${imageMessageId}"] [data-attachment-id="${imageAttachmentId}"] img`).first().evaluate((img) => ({
      src: (img as HTMLImageElement).src,
      naturalWidth: (img as HTMLImageElement).naturalWidth,
      naturalHeight: (img as HTMLImageElement).naturalHeight,
    }));
    summary.imageRendered = src;
    const reply = page.getByText("Got your message with 1 image block(s)", { exact: false }).first();
    await reply.waitFor({ timeout: 60000 });
    summary.imageReplyText = (await reply.textContent())?.trim();
    await reply.scrollIntoViewIfNeeded();
    await shot("owner-media-2-sent-image-and-reply.png");
    return `img ${src.naturalWidth}×${src.naturalHeight} from ${new URL(src.src).pathname}`;
  });

  // 3. Two refused files at once.
  await step("mismatched MP4 and oversize PNG are refused with error chips", async () => {
    await input.setInputFiles([
      { name: "clip-really-a-png.mp4", mimeType: "video/mp4", buffer: sceneBytes },
      { name: "huge.png", mimeType: "image/png", buffer: readFileSync(hugePath) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="persona-upload"][data-status="error"]').length === 2, null, { timeout: 30000 });
    const errors = await page.locator('[data-testid="persona-upload"][data-status="error"]').evaluateAll((els) =>
      els.map((el) => ({
        name: el.querySelector("span")?.textContent ?? "",
        error: el.querySelector('[data-testid="persona-upload-error"]')?.textContent ?? "",
      }))
    );
    summary.uiRejections = errors;
    await shot("owner-media-3-rejections.png");
    await removeAll();
    return errors.map((e) => `${e.name}: ${e.error}`).join(" | ");
  });

  // 4. Paste and drop. The page fetches the scene from a route this script
  // serves, and builds the File from the response's blob.
  const SCENE_URL = `${ORIGIN}/__owner-media/test-scene.png`;
  await page.route(SCENE_URL, (route) => route.fulfill({ status: 200, contentType: "image/png", body: sceneBytes }));
  const fileHandle = async (name: string) =>
    page.evaluateHandle(
      async ([url, n]) => {
        const blob = await (await fetch(url)).blob();
        const dt = new DataTransfer();
        dt.items.add(new File([blob], n, { type: "image/png" }));
        return dt;
      },
      [SCENE_URL, name] as const
    );
  summary.paste = { ok: await step("paste attaches an image", async () => {
    const dt = await fileHandle("pasted.png");
    await textarea.evaluate((el, d) => {
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d as DataTransfer, bubbles: true, cancelable: true }));
    }, dt);
    await page.locator('[data-testid="persona-upload"][data-status="ready"]').first().waitFor({ timeout: 30000 });
    const name = await trayItems.first().locator("span").first().textContent();
    await removeAll();
    return `ready tray item "${name}", removed`;
  }) };
  summary.drop = { ok: await step("drop attaches an image", async () => {
    const dt = await fileHandle("dropped.png");
    await composer.evaluate((el, d) => {
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { dataTransfer: d as DataTransfer, bubbles: true, cancelable: true }));
      }
    }, dt);
    await page.locator('[data-testid="persona-upload"][data-status="ready"]').first().waitFor({ timeout: 30000 });
    const name = await trayItems.first().locator("span").first().textContent();
    const zoneGone = (await page.locator('[data-testid="persona-drop-zone"]').count()) === 0;
    await removeAll();
    return `ready tray item "${name}", drop zone cleared: ${zoneGone}, removed`;
  }) };

  // ── The API side ──
  await step("upload API refuses the two files", async () => {
    const mismatched = await call("POST", "/api/persona/uploads", { name: "clip-really-a-png.mp4", mimeType: "video/mp4", dataBase64: sceneBytes.toString("base64") });
    const huge = await call("POST", "/api/persona/uploads", { name: "huge.png", mimeType: "image/png", dataBase64: readFileSync(hugePath).toString("base64") });
    summary.apiRejections = {
      "clip-really-a-png.mp4": { status: mismatched.status, error: mismatched.json.error },
      "huge.png": { status: huge.status, error: huge.json.error },
    };
    if (mismatched.status < 400 || huge.status < 400) throw new Error(JSON.stringify(summary.apiRejections));
    return `${mismatched.status} / ${huge.status}`;
  });
  await step("stored image is served whole and by range", async () => {
    const whole = await fetch(`${API}/api/persona/attachments/${imageAttachmentId}`, { headers: { "x-standup-owner-token": token } });
    const body = new Uint8Array(await whole.arrayBuffer());
    const ranged = await fetch(`${API}/api/persona/attachments/${imageAttachmentId}`, { headers: { "x-standup-owner-token": token, range: "bytes=0-99" } });
    const part = new Uint8Array(await ranged.arrayBuffer());
    summary.attachmentGet = {
      whole: {
        status: whole.status,
        contentType: whole.headers.get("content-type"),
        contentLength: whole.headers.get("content-length"),
        bytes: body.length,
        sha256MatchesFixture: createHash("sha256").update(body).digest("hex") === sceneSha,
      },
      range: {
        status: ranged.status,
        contentRange: ranged.headers.get("content-range"),
        contentLength: ranged.headers.get("content-length"),
        bytes: part.length,
        matchesFixturePrefix: Buffer.from(part).equals(sceneBytes.subarray(0, 100)),
      },
    };
    const g = summary.attachmentGet;
    if (g.whole.status !== 200 || !g.whole.sha256MatchesFixture || g.range.status !== 206 || g.range.bytes !== 100 || !g.range.matchesFixturePrefix) {
      throw new Error(JSON.stringify(g));
    }
    return `200 ${g.whole.contentType} ${g.whole.bytes} B; 206 ${g.range.contentRange}`;
  });

  // ── The captured turns ──
  await step("Persona's image turn was stream-json with the image block", async () => {
    const files = readdirSync(TURNS).filter((f) => /^turn-\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const turns = files.map((f) => {
      const t = JSON.parse(readFileSync(join(TURNS, f), "utf8")) as { argv: string[]; stdinRaw: string; contentSummary: Json[] };
      const streamJson = t.argv.includes("--input-format") && t.argv[t.argv.indexOf("--input-format") + 1] === "stream-json";
      const prompt = streamJson ? (t.contentSummary.find((b) => b.type === "text")?.text ?? "") : t.stdinRaw;
      const lines = String(prompt).split("\n");
      const ownerLines = lines.filter((l) => /· msg /.test(l) && l.startsWith("- [") || /^\s+- attachment \d+:/.test(l));
      const images = t.contentSummary
        .map((b, i, all) => (b.type === "image" ? { media_type: b.media_type, base64Length: b.base64Length, label: String(all[i - 1]?.text ?? "").replace(/^\[|\]$/g, "") } : null))
        .filter(Boolean);
      return {
        file: f,
        streamJson,
        imageBlocks: images.length,
        images,
        contentTypes: t.contentSummary.map((b) => b.type),
        ownerAttachmentLines: ownerLines,
        notShownLines: lines.filter((l) => /not shown|ffmpeg/i.test(l)),
      };
    });
    summary.turns = turns;
    const imageTurn = turns.find((t) => t.imageBlocks > 0);
    if (!imageTurn) throw new Error(`no turn carried an image block (${turns.length} turns)`);
    copyFileSync(join(TURNS, imageTurn.file.replace(/\.json$/, ".stdin.jsonl")), join(OUT, "turn-image.stdin.jsonl"));
    summary.imageTurnStdin = join(OUT, "turn-image.stdin.jsonl");
    if (!imageTurn.streamJson) throw new Error(`${imageTurn.file} had image blocks without --input-format stream-json`);
    const line = imageTurn.ownerAttachmentLines.find((l) => l.includes(imageAttachmentId));
    if (!line || !line.includes("file: ")) throw new Error(`no attachment line naming ${imageAttachmentId} with its file`);
    if (!imageTurn.ownerAttachmentLines.some((l) => l.includes(`msg ${imageMessageId.slice(0, 4)}`) || l.includes(imageMessageId))) {
      throw new Error(`no owner line referencing msg ${imageMessageId}`);
    }
    return `${imageTurn.file}: ${imageTurn.imageBlocks} image block(s) ${imageTurn.images.map((i: any) => `${i.media_type} [${i.label}]`).join(", ")}`;
  });
} catch (err) {
  fatal = err;
  console.error(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  summary.checks = checks;
  summary.fatal = fatal ? String(fatal) : undefined;
  writeFileSync(join(OUT, "owner-media-summary.json"), JSON.stringify(summary, null, 2));
  await cleanup();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed${fatal ? " (aborted)" : ""}; summary at ${join(OUT, "owner-media-summary.json")}`);
process.exit(failed || fatal ? 1 : 0);
